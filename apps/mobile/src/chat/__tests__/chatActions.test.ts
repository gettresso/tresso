import { describe, expect, it, vi } from 'vitest'
import type { SqliteMailStore, SyncedChat, SyncedChatOutgoing, UpdateChatRequest } from '@tresso/core'
import { ApiError } from '@/auth/session'
import { ChatActions, REUSE_ID_MS } from '@/chat/chatActions'
import type { PhoneChatApi } from '@/chat/chatApi'
import { chat, copyWith, deferred, reply } from './fixtures'

const NOW = Date.parse('2026-11-13T10:31:00.000Z')

function setUp(store: SqliteMailStore, api: Partial<PhoneChatApi> = {}) {
  let now = NOW
  let ids = 0
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

      const shown = actions.shown('c1', [])
      expect(shown).toHaveLength(1)
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
    expect(actions.shown('c1', [])).toHaveLength(1)

    actions.clear()

    expect(actions.shown('c1', [])).toEqual([])
  })
})
