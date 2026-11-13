import { beforeEach, describe, expect, it } from 'vitest'
import { ChatApiError, SqliteMailStore, type ChangePage, type SyncedChatOutgoing } from '@tresso/core'
import { memorySql } from '@tresso/core/testing/sql'
import { ChatActionError, serverChatActions, type ServerChatActions } from '@/stores/chatActions'
import { ACCOUNT_ID, FakeChatServer } from './chatServerFixture'
import { DIRECT, NOW } from './chatFixtures'

const CHAT_ID = `chat-${DIRECT}`
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('the server chat actions ("All my devices")', () => {
  let server: FakeChatServer
  let store: SqliteMailStore
  let actions: ServerChatActions
  let pulls: number

  async function reply(id: string): Promise<SyncedChatOutgoing | undefined> {
    return (await store.chatPage(CHAT_ID, { limit: 1 }))?.outgoing.find((row) => row.id === id)
  }

  beforeEach(async () => {
    server = new FakeChatServer()
    store = await SqliteMailStore.open(await memorySql())
    await server.connect({ deviceId: '0193a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b', deviceName: 'Mac', address: null, displayName: null, includeGroups: true, notify: false })
    await server.relayMessages(ACCOUNT_ID, {
      deviceId: '0193a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b',
      firstImport: false,
      chats: [{ jid: DIRECT, name: 'Bram', kind: 'direct' }],
      messages: [{ chatJid: DIRECT, waId: 'A1', fromMe: false, sender: null, text: 'Hello', sentAt: new Date(NOW - 60_000).toISOString(), media: null }],
    })
    await server.deliver(store)
    server.calls.length = 0
    pulls = 0
    actions = serverChatActions({ api: server, store: () => store, now: () => NOW, pulled: () => void pulls++ })
  })

  it('shows a reply at once as waiting, queues it with a UUIDv7, and takes the server row', async () => {
    let answer!: () => void
    server.held.set('queueReply', new Promise<void>((resolve) => (answer = resolve)))
    const sending = actions.send(CHAT_ID, '  On my way  ')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [shown] = (await store.chatPage(CHAT_ID, { limit: 1 }))!.outgoing
    expect(shown).toMatchObject({ status: 'waiting', text: 'On my way', chatAccountId: ACCOUNT_ID, createdAt: new Date(NOW).toISOString() })
    expect(shown!.id).toMatch(UUID_V7)
    answer()
    const queued = await sending
    expect(server.callsOf('queueReply')).toEqual([[CHAT_ID, { id: shown!.id, text: 'On my way' }]])
    expect(await reply(shown!.id)).toEqual(queued)
    expect(pulls).toBe(1)
  })

  it('checks the text first, and takes a refused reply back out of the chat', async () => {
    await expect(actions.send(CHAT_ID, '   ')).rejects.toMatchObject({ code: 'empty' })
    expect(server.callsOf('queueReply')).toEqual([])

    server.fail('queueReply', new ChatApiError(429, 'Slow down', null, 60_000))
    const error = await actions.send(CHAT_ID, 'On my way').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ChatActionError)
    expect((error as Error).message, 'The real wait, rounded up.').toBe('Too many WhatsApp replies at once. Wait a minute, then try again.')
    const rows = (await store.chatPage(CHAT_ID, { limit: 1 }))!.outgoing
    expect(rows.map((row) => row.status)).toEqual(['cancelled'])

    // No answer: it may have been queued all the same, so the error carries the id to send it again with.
    server.fail('queueReply', new TypeError('Failed to fetch'))
    const unsure = await actions.send(CHAT_ID, 'Again').catch((caught: unknown) => caught)
    expect(unsure).toMatchObject({ code: 'unsure', replyId: expect.stringMatching(UUID_V7) })
    expect((unsure as Error).message).toBe('Tresso could not tell whether your Tresso server took this reply; it may already be queued. Sending it again sends it once.')
  })

  it('cancels a waiting reply at once and puts it back when the server refuses', async () => {
    const queued = await actions.send(CHAT_ID, 'On my way')
    server.fail('cancelReply', new ChatApiError(409, 'Going out', 'already_going_out'))
    await expect(actions.cancel(CHAT_ID, queued.id)).rejects.toThrow('The reply is already going out.')
    expect(await reply(queued.id)).toMatchObject({ status: 'waiting' })

    await actions.cancel(CHAT_ID, queued.id)
    expect(await reply(queued.id)).toMatchObject({ status: 'cancelled' })
    expect(server.outgoing.has(queued.id)).toBe(false)

    // Gone on the server already: what the user wanted.
    const other = await actions.send(CHAT_ID, 'Second')
    server.fail('cancelReply', new ChatApiError(404, 'Not found'))
    await actions.cancel(CHAT_ID, other.id)
    expect(await reply(other.id)).toMatchObject({ status: 'cancelled' })
  })

  it('keeps a cancel until the delta removed the reply, then lets it go', async () => {
    const queued = await actions.send(CHAT_ID, 'On my way')
    await actions.cancel(CHAT_ID, queued.id)
    expect(actions.cancelsKept()).toBe(1)
    await actions.send(CHAT_ID, 'Second')
    expect(actions.cancelsKept(), 'The copy still holds it (cancelled) until the delta says.').toBe(1)

    const empty = { hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], dailyBriefs: [] }
    await store.apply({ ...empty, cursor: 99, deleted: [{ type: 'chatOutgoing', id: queued.id }] } as unknown as ChangePage)
    expect(await reply(queued.id)).toBeUndefined()
    await actions.send(CHAT_ID, 'Third')

    expect(actions.cancelsKept()).toBe(0)
  })

  it('never cancels a reply going out, and asks nothing for it', async () => {
    const queued = await actions.send(CHAT_ID, 'On my way')
    await store.putChatOutgoing([{ ...queued, status: 'sending' }])
    server.calls.length = 0
    await expect(actions.cancel(CHAT_ID, queued.id)).rejects.toMatchObject({ code: 'already_going_out' })
    expect(server.calls).toEqual([])
  })

  it('tries a failed reply again, put back as failed when the server refuses', async () => {
    const queued = await actions.send(CHAT_ID, 'On my way')
    const failed: SyncedChatOutgoing = { ...queued, status: 'failed', error: 'unconfirmed' }
    server.outgoing.set(queued.id, failed)
    await store.putChatOutgoing([failed])

    server.fail('retryReply', new ChatApiError(500, 'Broken'))
    await expect(actions.retry(CHAT_ID, queued.id)).rejects.toThrow('Your Tresso server could not take this change just now. Try again.')
    expect(await reply(queued.id)).toEqual(failed)

    await actions.retry(CHAT_ID, queued.id)
    expect(await reply(queued.id)).toMatchObject({ status: 'waiting', error: null })
    await expect(actions.retry(CHAT_ID, queued.id)).rejects.toMatchObject({ code: 'not_failed' })
  })

  it('changes the chat state at once, forward only, and puts it back when the server refuses', async () => {
    const lastMessageAt = new Date(NOW - 60_000).toISOString()
    await actions.setState(CHAT_ID, { readThrough: lastMessageAt, archivedThrough: lastMessageAt })
    expect(server.callsOf('updateChat')).toEqual([[CHAT_ID, { readThrough: lastMessageAt, archivedThrough: lastMessageAt }]])
    expect((await store.chatByJid(ACCOUNT_ID, DIRECT))?.archivedThrough).toBe(lastMessageAt)

    // An older time changes nothing and asks nothing.
    await actions.setState(CHAT_ID, { readThrough: new Date(NOW - 120_000).toISOString() })
    expect(server.callsOf('updateChat')).toHaveLength(1)

    server.fail('updateChat', new ChatApiError(403, 'Forbidden'))
    await expect(actions.setState(CHAT_ID, { leftOut: true })).rejects.toThrow('This session of Tresso may not change WhatsApp chats. Sign out and in again.')
    expect((await store.chatByJid(ACCOUNT_ID, DIRECT))?.leftOut).toBe(false)

    await actions.setState(CHAT_ID, { archivedThrough: null })
    expect(server.lastCall('updateChat')!).toEqual([CHAT_ID, { archivedThrough: null }])
    expect((await store.chatByJid(ACCOUNT_ID, DIRECT))?.archivedThrough).toBeNull()
  })

  it('leaves a row the delta changed meanwhile as the delta says, also when the server refused', async () => {
    let answer!: () => void
    server.held.set('updateChat', new Promise<void>((resolve) => (answer = resolve)))
    server.fail('updateChat', new TypeError('Failed to fetch'))
    const changing = actions.setState(CHAT_ID, { leftOut: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const chat = (await store.chatByJid(ACCOUNT_ID, DIRECT))!
    // Another device read it meanwhile, and the delta brought that.
    await store.putChats([{ ...chat, readThrough: new Date(NOW).toISOString() }])
    answer()
    await expect(changing).rejects.toMatchObject({ code: 'offline' })
    // The refused field goes back; the one the delta brought stays.
    expect(await store.chatByJid(ACCOUNT_ID, DIRECT)).toMatchObject({ leftOut: false, readThrough: new Date(NOW).toISOString() })
  })

  it('puts each refused change back to what the server last confirmed, not to what an earlier refused change showed', async () => {
    const lastMessageAt = new Date(NOW - 60_000).toISOString()
    let answerFirst!: () => void
    server.held.set('updateChat', new Promise<void>((resolve) => (answerFirst = resolve)))
    server.fail('updateChat', new ChatApiError(500, 'Broken'), true)
    const first = actions.setState(CHAT_ID, { readThrough: lastMessageAt }).catch((caught: unknown) => caught)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = actions.setState(CHAT_ID, { archivedThrough: lastMessageAt }).catch((caught: unknown) => caught)
    await new Promise((resolve) => setTimeout(resolve, 0))
    answerFirst()
    await first
    await second
    expect(await store.chatByJid(ACCOUNT_ID, DIRECT)).toMatchObject({ readThrough: null, archivedThrough: null })
  })

  it('sends a reply again under the id of an unsure try, so the server queues it once', async () => {
    // The server stored the first, but its answer was lost on the way back (a proxy's 502).
    const original = server.queueReply.bind(server)
    server.queueReply = async (chatId, request) => {
      const row = await original(chatId, request)
      if (server.callsOf('queueReply').length === 1) {
        throw new ChatApiError(502, 'Bad gateway')
      }
      return row
    }
    const first = await actions.send(CHAT_ID, 'On my way').catch((caught: unknown) => caught)
    const id = (first as ChatActionError).replyId!
    expect(first).toMatchObject({ code: 'unsure' })
    await actions.send(CHAT_ID, 'On my way', id)
    expect([...server.outgoing.values()].map((row) => row.text)).toEqual(['On my way'])

    // Too old to queue now and maybe queued before: never made new.
    server.queueReply = original
    server.fail('queueReply', new ChatApiError(422, 'Invalid', null, null, { id: '' }))
    await expect(actions.send(CHAT_ID, 'Second', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99')).rejects.toMatchObject({ code: 'maybe_queued' })
  })
})
