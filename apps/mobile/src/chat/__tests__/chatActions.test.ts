import { describe, expect, it, vi } from 'vitest'
import type { SqliteMailStore, SyncedChat, SyncedChatOutgoing, UpdateChatRequest } from '@tresso/core'
import { ApiError } from '@/auth/session'
import { ChatActions, outcomeUnknown, REUSE_ID_MS, UNSURE_PREFIX } from '@/chat/chatActions'
import type { PhoneChatApi } from '@/chat/chatApi'
import { chat, copyWith, deferred, reply } from './fixtures'

const NOW = Date.parse('2026-11-13T10:31:00.000Z')
/** Ids across every setUp, as a device never makes one twice. */
let ids = 0

function setUp(store: SqliteMailStore, api: Partial<PhoneChatApi> = {}, start = NOW) {
  let now = start
  const changed = vi.fn()
  const errors: string[] = []
  const full: PhoneChatApi = {
    queueReply: vi.fn(async (chatId: string, request: { id: string; text: string }) => reply(request.id, chatId, { text: request.text, createdAt: new Date(now).toISOString() })),
    cancelReply: vi.fn(async () => undefined),
    retryReply: vi.fn(async (id: string) => reply(id, 'c1', { status: 'waiting' })),
    updateChat: vi.fn(async (id: string, request: UpdateChatRequest) => chat(id, { readThrough: request.readThrough ?? null })),
    ...api,
  }
  const actions = new ChatActions({
    store: () => store,
    api: full,
    now: () => now,
    newId: () => `0193a1c2-0000-7000-8000-${String(++ids).padStart(12, '0')}`,
    changed,
    onError: (what) => errors.push(what),
  })
  return { actions, api: full, changed, errors, later: (ms: number) => (now += ms) }
}

async function outgoingOf(store: SqliteMailStore, chatId: string): Promise<SyncedChatOutgoing[]> {
  return (await store.chatPage(chatId, { limit: 50 }))?.outgoing ?? []
}

describe('ChatActions', () => {
  describe('send', () => {
    it('shows the reply as waiting at once, stores the server row once queued, and lets go of it once the copy has it', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const answer = deferred<SyncedChatOutgoing>()
      const { actions, api, changed } = setUp(store, { queueReply: vi.fn(() => answer.promise) })

      const sending = actions.send(chat('c1'), '  On my way  ')

      await vi.waitFor(() => expect(actions.shown('c1', [])).toHaveLength(1))
      const shown = actions.shown('c1', [])
      expect(shown[0]).toMatchObject({ status: 'waiting', text: 'On my way', chatId: 'c1' })
      expect(api.queueReply).toHaveBeenCalledWith('c1', { id: shown[0]!.id, text: 'On my way' })
      expect(await outgoingOf(store, 'c1')).toEqual([])

      answer.resolve(reply(shown[0]!.id, 'c1', { text: 'On my way', status: 'waiting' }))
      await sending

      const stored = await outgoingOf(store, 'c1')
      expect(stored.map((row) => row.id)).toEqual([shown[0]!.id])
      expect(changed).toHaveBeenCalled()
      actions.settle('c1', stored)
      expect(actions.shown('c1', []), 'The overlay let go once the copy had it.').toEqual([])
    })

    it('takes the reply back when the server refuses it, and stores nothing', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const refusal = new ApiError(422, 'This chat is left out.', { text: 'Too long.' })
      const { actions } = setUp(store, { queueReply: vi.fn(async () => Promise.reject(refusal)) })

      await expect(actions.send(chat('c1'), 'Hello')).rejects.toBe(refusal)

      expect(actions.shown('c1', [])).toEqual([])
      expect(await outgoingOf(store, 'c1')).toEqual([])
    })

    it('sends the same text again under the same id when no answer came, so the server never queues it twice', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const queueReply = vi.fn(async (): Promise<SyncedChatOutgoing> => Promise.reject(new TypeError('Network request failed')))
      const { actions, later } = setUp(store, { queueReply })

      await expect(actions.send(chat('c1'), 'Hello')).rejects.toThrow('Network request failed')
      await expect(actions.send(chat('c1'), 'Hello ')).rejects.toThrow()
      await expect(actions.send(chat('c1'), 'Something else')).rejects.toThrow()
      later(REUSE_ID_MS)
      await expect(actions.send(chat('c1'), 'Something else')).rejects.toThrow()

      const ids = queueReply.mock.calls.map((call) => (call as unknown as [string, { id: string }])[1].id)
      expect(ids[1]).toBe(ids[0])
      expect(ids[2]).not.toBe(ids[1])
      expect(ids[3], 'An id older than the server takes is never used again.').not.toBe(ids[2])
    })

    it('takes a server error or a timeout as a send that may have gone out, and sends the same text under the same id', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const answers = [new ApiError(502, 'Bad Gateway'), new ApiError(504, 'Gateway Timeout'), new ApiError(408, 'Request Timeout')]
      const queueReply = vi.fn(async (): Promise<SyncedChatOutgoing> => Promise.reject(answers.shift()))
      const { actions } = setUp(store, { queueReply })

      for (let i = 0; i < 3; i++) {
        await expect(actions.send(chat('c1'), 'Hello')).rejects.toThrow()
      }

      const ids = new Set(queueReply.mock.calls.map((call) => (call as unknown as [string, { id: string }])[1].id))
      expect(ids.size).toBe(1)
      expect(outcomeUnknown(new ApiError(500, 'x'))).toBe(true)
      expect(outcomeUnknown(new ApiError(422, 'x'))).toBe(false)
      expect(outcomeUnknown(new ApiError(429, 'x'))).toBe(false)
      expect(outcomeUnknown(new TypeError('Network request failed'))).toBe(true)
    })

    it('reuses the id of a send without an answer after the app was closed', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const before = setUp(store, { queueReply: vi.fn(async (): Promise<SyncedChatOutgoing> => Promise.reject(new TypeError('Network request failed'))) })
      await expect(before.actions.send(chat('c1'), 'On my way')).rejects.toThrow()
      const kept = JSON.parse((await store.chatMeta(UNSURE_PREFIX + 'c1')) ?? '{}') as { id?: string; hash?: string }
      expect(kept.id).toBeDefined()
      expect(JSON.stringify(kept)).not.toContain('On my way')

      // The app was closed: a new session of the same copy, a minute later.
      const after = setUp(store, {}, NOW + 60_000)
      const queued = await after.actions.send(chat('c1'), 'On my way')
      expect(queued.id).toBe(kept.id)
      expect(await store.chatMeta(UNSURE_PREFIX + 'c1')).toBeNull()

      // The same text again on purpose: a new reply.
      const again = await after.actions.send(chat('c1'), 'On my way')
      expect(again.id).not.toBe(kept.id)
    })

    it('never swallows the same text sent on purpose after a relaunch once the delta has the reply that timed out', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const before = setUp(store, { queueReply: vi.fn(async (): Promise<SyncedChatOutgoing> => Promise.reject(new TypeError('Network request failed'))) })
      await expect(before.actions.send(chat('c1'), 'ok')).rejects.toThrow()
      const kept = JSON.parse((await store.chatMeta(UNSURE_PREFIX + 'c1')) ?? '{}') as { id: string }

      // The app was killed; the delta brings the reply: it was queued and sent after all.
      await store.putChatOutgoing([reply(kept.id, 'c1', { text: 'ok', status: 'sent', sentAt: new Date(NOW).toISOString() })])
      const after = setUp(store, {}, NOW + 60_000)
      const queued = await after.actions.send(chat('c1'), 'ok')

      expect(queued.id).not.toBe(kept.id)
      expect(after.api.queueReply).toHaveBeenCalledWith('c1', { id: queued.id, text: 'ok' })
    })

    it('forgets the kept send when a later run of the app sees the delta bring that reply', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const before = setUp(store, { queueReply: vi.fn(async (): Promise<SyncedChatOutgoing> => Promise.reject(new TypeError('Network request failed'))) })
      await expect(before.actions.send(chat('c1'), 'ok')).rejects.toThrow()
      const kept = JSON.parse((await store.chatMeta(UNSURE_PREFIX + 'c1')) ?? '{}') as { id: string }

      const after = setUp(store, {}, NOW + 60_000)
      after.actions.settle('c1', [reply(kept.id, 'c1', { text: 'ok' })])

      await vi.waitFor(async () => expect(await store.chatMeta(UNSURE_PREFIX + 'c1')).toBeNull())
    })

    it('forgets a send without an answer when the delta brings that reply, so the same text later is a new reply', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const queueReply = vi.fn(async (): Promise<SyncedChatOutgoing> => Promise.reject(new TypeError('Network request failed')))
      const { actions, api } = setUp(store, { queueReply })
      await expect(actions.send(chat('c1'), 'On my way')).rejects.toThrow()
      const first = (queueReply.mock.calls[0] as unknown as [string, { id: string }])[1].id

      actions.settle('c1', [reply(first, 'c1', { text: 'On my way' })])
      await vi.waitFor(async () => expect(await store.chatMeta(UNSURE_PREFIX + 'c1')).toBeNull())
      api.queueReply = vi.fn(async (chatId: string, request: { id: string; text: string }) => reply(request.id, chatId, { text: request.text }))
      const second = await actions.send(chat('c1'), 'On my way')

      expect(second.id).not.toBe(first)
    })

    it('makes a new id after the server answered, also with a refusal', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const queueReply = vi.fn(async (): Promise<SyncedChatOutgoing> => Promise.reject(new ApiError(429, 'Too many WhatsApp replies at once.')))
      const { actions } = setUp(store, { queueReply })

      await expect(actions.send(chat('c1'), 'Hello')).rejects.toThrow()
      await expect(actions.send(chat('c1'), 'Hello')).rejects.toThrow()

      const ids = queueReply.mock.calls.map((call) => (call as unknown as [string, { id: string }])[1].id)
      expect(ids[1]).not.toBe(ids[0])
    })

    it('never sends a text core refuses', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const { actions, api } = setUp(store)

      await expect(actions.send(chat('c1'), '   ')).rejects.toThrow()
      await expect(actions.send(chat('c1'), 'x'.repeat(4097))).rejects.toThrow('A reply can have at most 4,096 characters.')
      await expect(actions.send(chat('c1'), 'bell\u0007')).rejects.toThrow('The reply cannot contain control characters.')
      expect(api.queueReply).not.toHaveBeenCalled()
    })
  })

  describe('cancel', () => {
    it('hides a waiting reply at once, and marks it cancelled in the copy once the server removed it', async () => {
      const waiting = reply('r1', 'c1')
      const store = await copyWith({ chats: [chat('c1')], outgoing: [waiting] })
      const answer = deferred<void>()
      const { actions } = setUp(store, { cancelReply: vi.fn(() => answer.promise) })

      const cancelling = actions.cancel(waiting)
      expect(actions.shown('c1', [waiting])).toEqual([])

      answer.resolve()
      await cancelling
      const stored = await outgoingOf(store, 'c1')
      expect(stored[0]?.status).toBe('cancelled')
      expect(actions.shown('c1', [waiting]), 'Hidden until the copy has it as cancelled.').toEqual([])
      actions.settle('c1', stored)
      expect(actions.shown('c1', stored).map((row) => row.status), 'The copy hides it now (the timeline leaves cancelled replies out).').toEqual(['cancelled'])
    })

    it('shows the reply again when the Mac took it meanwhile', async () => {
      const waiting = reply('r1', 'c1')
      const store = await copyWith({ chats: [chat('c1')], outgoing: [waiting] })
      const taken = new ApiError(409, 'This reply is being sent or was sent; it can no longer be cancelled.', {}, null, 'already_going_out')
      const { actions } = setUp(store, { cancelReply: vi.fn(async () => Promise.reject(taken)) })

      await expect(actions.cancel(waiting)).rejects.toBe(taken)

      expect(actions.shown('c1', [waiting])).toEqual([waiting])
      expect((await outgoingOf(store, 'c1'))[0]?.status).toBe('waiting')
    })

    it('counts a reply the server no longer has as gone', async () => {
      const failed = reply('r1', 'c1', { status: 'failed', error: 'refused' })
      const store = await copyWith({ chats: [chat('c1')], outgoing: [failed] })
      const { actions } = setUp(store, { cancelReply: vi.fn(async () => Promise.reject(new ApiError(404, 'Reply not found.'))) })

      await actions.cancel(failed)

      expect((await outgoingOf(store, 'c1'))[0]?.status).toBe('cancelled')
    })
  })

  describe('retry', () => {
    it('shows a failed reply as waiting at once and stores what the server answered', async () => {
      const failed = reply('r1', 'c1', { status: 'failed', error: 'bridge_stopped' })
      const store = await copyWith({ chats: [chat('c1')], outgoing: [failed] })
      const answer = deferred<SyncedChatOutgoing>()
      const { actions } = setUp(store, { retryReply: vi.fn(() => answer.promise) })

      const retrying = actions.retry(failed)
      expect(actions.shown('c1', [failed])[0]).toMatchObject({ status: 'waiting', error: null })

      answer.resolve({ ...failed, status: 'waiting', error: null })
      await retrying
      const stored = await outgoingOf(store, 'c1')
      expect(stored[0]).toMatchObject({ status: 'waiting', error: null })
      actions.settle('c1', stored)
      expect(actions.shown('c1', [failed])[0], 'Let go once the copy no longer has it as failed.').toMatchObject({ status: 'failed' })
    })

    it('shows the reply as not sent again when the server refuses', async () => {
      const failed = reply('r1', 'c1', { status: 'failed', error: 'unconfirmed' })
      const store = await copyWith({ chats: [chat('c1')], outgoing: [failed] })
      const { actions } = setUp(store, { retryReply: vi.fn(async () => Promise.reject(new TypeError('Network request failed'))) })

      await expect(actions.retry(failed)).rejects.toThrow()

      expect(actions.shown('c1', [failed])).toEqual([failed])
    })
  })

  describe('markRead', () => {
    it('reads the chat through its last message in the copy, then on the server', async () => {
      const unread = chat('c1')
      const store = await copyWith({ chats: [unread] })
      const answer = deferred<SyncedChat>()
      const updateChat = vi.fn(() => answer.promise)
      const { actions } = setUp(store, { updateChat })

      const reading = actions.markRead(unread)
      await vi.waitFor(() => expect(updateChat).toHaveBeenCalledWith('c1', { readThrough: unread.lastMessageAt }))
      expect((await store.chatByJid(unread.chatAccountId, unread.jid))?.readThrough).toBe(unread.lastMessageAt)

      answer.resolve({ ...unread, readThrough: unread.lastMessageAt })
      await expect(reading).resolves.toBe(true)
    })

    it('puts the read back when the server does not take it', async () => {
      const unread = chat('c1')
      const store = await copyWith({ chats: [unread] })
      const { actions, errors } = setUp(store, { updateChat: vi.fn(async () => Promise.reject(new ApiError(503, 'Unavailable'))) })

      await expect(actions.markRead(unread)).resolves.toBe(false)

      expect((await store.chatByJid(unread.chatAccountId, unread.jid))?.readThrough).toBe(unread.readThrough)
      expect(errors).toEqual(['Reading the chat on the server failed'])
    })

    it('does not ask again for a read the server refused, until the chat is looked at again or a newer message came', async () => {
      const unread = chat('c1')
      const store = await copyWith({ chats: [unread] })
      const updateChat = vi.fn(async (): Promise<SyncedChat> => Promise.reject(new TypeError('Network request failed')))
      const { actions } = setUp(store, { updateChat })

      await actions.markRead(unread)
      await actions.markRead(unread)
      await actions.markRead(unread)
      expect(updateChat).toHaveBeenCalledTimes(1)

      actions.lookedAt('c1')
      await actions.markRead(unread)
      expect(updateChat).toHaveBeenCalledTimes(2)

      await store.putChats([{ ...unread, lastMessageAt: '2026-11-13T10:20:00.000Z' }])
      await actions.markRead(unread)
      expect(updateChat, 'A newer message is read again.').toHaveBeenCalledTimes(3)
    })

    it('waits for Retry-After before reading again, also when the chat is looked at again', async () => {
      const unread = chat('c1')
      const store = await copyWith({ chats: [unread] })
      const updateChat = vi.fn(async (): Promise<SyncedChat> => Promise.reject(new ApiError(429, 'Too many requests.', {}, 30_000)))
      const { actions, later } = setUp(store, { updateChat })

      await actions.markRead(unread)
      actions.lookedAt('c1')
      await actions.markRead(unread)
      expect(updateChat).toHaveBeenCalledTimes(1)

      later(30_000)
      await actions.markRead(unread)
      expect(updateChat).toHaveBeenCalledTimes(2)
    })

    it('waits for Retry-After also when a newer message came meanwhile', async () => {
      const unread = chat('c1')
      const store = await copyWith({ chats: [unread] })
      const updateChat = vi.fn(async (): Promise<SyncedChat> => Promise.reject(new ApiError(429, 'Too many requests.', {}, 60_000)))
      const { actions, later } = setUp(store, { updateChat })

      await actions.markRead(unread)
      later(5_000)
      await store.putChats([{ ...unread, lastMessageAt: '2026-11-13T10:20:00.000Z' }])
      await actions.markRead(unread)
      expect(updateChat).toHaveBeenCalledTimes(1)

      later(55_000)
      await actions.markRead(unread)
      expect(updateChat, 'A newer message is read once the wait passed.').toHaveBeenCalledTimes(2)
    })

    it('asks nothing for a chat that is read through already, left out, or not on the phone', async () => {
      const read = chat('c1', { readThrough: '2026-11-13T10:14:00.000Z' })
      const leftOut = chat('c2', { jid: '31600000002@s.whatsapp.net', leftOut: true })
      const store = await copyWith({ chats: [read, leftOut] })
      const { actions, api } = setUp(store)

      await expect(actions.markRead(read)).resolves.toBe(false)
      await expect(actions.markRead(leftOut)).resolves.toBe(false)
      await expect(actions.markRead(chat('c3', { jid: '31600000003@s.whatsapp.net' }))).resolves.toBe(false)
      expect(api.updateChat).not.toHaveBeenCalled()
    })

    it('reads a chat never read before', async () => {
      const never = chat('c1', { readThrough: null })
      const store = await copyWith({ chats: [never] })
      const { actions, api } = setUp(store)

      await expect(actions.markRead(never)).resolves.toBe(true)
      expect(api.updateChat).toHaveBeenCalledWith('c1', { readThrough: never.lastMessageAt })
    })
  })

  it('forgets every change under way for the next user', async () => {
    const store = await copyWith({ chats: [chat('c1')] })
    const { actions } = setUp(store, { queueReply: vi.fn(() => new Promise<SyncedChatOutgoing>(() => {})) })
    void actions.send(chat('c1'), 'Hello')
    await vi.waitFor(() => expect(actions.shown('c1', [])).toHaveLength(1))

    actions.clear()

    expect(actions.shown('c1', [])).toEqual([])
  })
})
