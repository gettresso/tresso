import { describe, expect, it, vi } from 'vitest'
import { fileFingerprint, type SqliteMailStore, type SyncedChat, type SyncedChatOutgoing, type UpdateChatRequest } from '@tresso/core'
import { ApiError } from '@/auth/session'
import { ChatActions, OLD_UNSURE_FILE_PREFIX, outcomeUnknown, ReplyCancelled, REUSE_ID_MS, UNSURE_FILES, UNSURE_PREFIX, unsureFileKey } from '@/chat/chatActions'
import { AttachHeld } from '@/chat/texts'
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
    requestMedia: vi.fn(async (messageId: string) => ({ messageId, kind: 'image' as const, name: null, size: null, state: 'requested' as const, error: null, access: null, url: null })),
    media: vi.fn(async (messageId: string) => ({ messageId, kind: 'image' as const, name: null, size: null, state: 'stored' as const, error: null, access: 'allowed' as const, url: `https://api.test/content/chat-media/${messageId}` })),
    unscannedMediaLink: vi.fn(async (messageId: string) => ({ messageId, kind: 'image' as const, name: null, size: null, state: 'stored' as const, error: null, access: 'confirm' as const, url: `https://api.test/content/chat-media/${messageId}?unscanned=1` })),
    uploadFile: vi.fn(async (chatId: string, uploadId: string) => ({ id: uploadId, chatId, size: 31 })),
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

    it('takes a reply the user cancelled before its queueing answered as cancelled, which the server kept', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const answer = deferred<SyncedChatOutgoing>()
      const { actions, api } = setUp(store, { queueReply: vi.fn(() => answer.promise) })

      const sending = actions.send(chat('c1'), 'On my way')
      await vi.waitFor(() => expect(actions.shown('c1', [])).toHaveLength(1))
      const shown = actions.shown('c1', [])[0]!
      await actions.cancel(shown)
      expect(api.cancelReply).toHaveBeenCalledWith(shown.id)
      answer.reject(new ApiError(409, 'This reply was cancelled.', {}, null, 'cancelled'))

      await expect(sending).rejects.toBeInstanceOf(ReplyCancelled)
      expect(actions.shown('c1', [])).toEqual([])
      expect(await store.chatMeta(UNSURE_PREFIX + 'c1'), 'Nothing to send again.').toBeNull()
    })

    it('takes a cancelled reply whose queueing got no answer as cancelled, and the same text again as a new reply', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const answer = deferred<SyncedChatOutgoing>()
      const queueReply = vi.fn<PhoneChatApi['queueReply']>(() => answer.promise)
      const { actions, api } = setUp(store, { queueReply })

      const sending = actions.send(chat('c1'), 'On my way')
      await vi.waitFor(() => expect(actions.shown('c1', [])).toHaveLength(1))
      await actions.cancel(actions.shown('c1', [])[0]!)
      answer.reject(new TypeError('Network request failed'))
      await expect(sending).rejects.toBeInstanceOf(ReplyCancelled)
      expect(await store.chatMeta(UNSURE_PREFIX + 'c1'), 'Nothing kept to send again.').toBeNull()

      api.queueReply = vi.fn(async (chatId: string, request: { id: string; text: string }) => reply(request.id, chatId, { text: request.text }))
      const again = await actions.send(chat('c1'), 'On my way')
      expect(again.id).not.toBe(queueReply.mock.calls[0]![1].id)
    })

    describe('a text reply cancelled while its queueing runs, when the queueing gets no answer', () => {
      /** Sends `On my way` with the queueing and the cancel each waiting for the test; the user cancels meanwhile. */
      async function cancelWhileQueueing() {
        const store = await copyWith({ chats: [chat('c1')] })
        const queueing = deferred<SyncedChatOutgoing>()
        const cancelling = deferred<void>()
        const queueReply = vi.fn<PhoneChatApi['queueReply']>(() => queueing.promise)
        const { actions } = setUp(store, { queueReply, cancelReply: vi.fn(() => cancelling.promise) })
        const sending = actions.send(chat('c1'), 'On my way').catch((error: unknown) => error)
        await vi.waitFor(() => expect(actions.shown('c1', [])).toHaveLength(1))
        const cancel = actions.cancel(actions.shown('c1', [])[0]!).catch((error: unknown) => error)
        const id = queueReply.mock.calls[0]![1].id
        return { store, queueing, cancelling, sending, cancel, id }
      }
      const unsureId = async (store: SqliteMailStore) => (JSON.parse((await store.chatMeta(UNSURE_PREFIX + 'c1')) ?? '{}') as { id?: string }).id

      it('keeps it unsure when both fail, the queueing first: the text goes back and it may have been sent', async () => {
        const { store, queueing, cancelling, sending, cancel, id } = await cancelWhileQueueing()
        queueing.reject(new TypeError('Network request failed'))
        await new Promise((resolve) => setTimeout(resolve, 0))
        cancelling.reject(new TypeError('Network request failed'))

        const sent = await sending
        expect(sent, 'Not taken as cancelled before the cancel was confirmed.').not.toBeInstanceOf(ReplyCancelled)
        expect(outcomeUnknown(sent)).toBe(true)
        expect(await cancel).toBeInstanceOf(TypeError)
        expect(await unsureId(store), 'The same text again is the same reply, sent once.').toBe(id)
      })

      it('keeps it unsure when both fail, the cancel first', async () => {
        const { store, queueing, cancelling, sending, cancel, id } = await cancelWhileQueueing()
        cancelling.reject(new TypeError('Network request failed'))
        expect(await cancel).toBeInstanceOf(TypeError)
        queueing.reject(new TypeError('Network request failed'))

        expect(await sending).not.toBeInstanceOf(ReplyCancelled)
        expect(await unsureId(store)).toBe(id)
      })

      it('takes it as cancelled once the server confirms the cancel after the queueing failed', async () => {
        const { store, queueing, cancelling, sending, cancel } = await cancelWhileQueueing()
        queueing.reject(new TypeError('Network request failed'))
        await new Promise((resolve) => setTimeout(resolve, 0))
        cancelling.resolve()

        expect(await sending).toBeInstanceOf(ReplyCancelled)
        expect(await cancel).toBeUndefined()
        expect(await store.chatMeta(UNSURE_PREFIX + 'c1')).toBeNull()
      })
    })

    it('forgets the unsure send of a reply the user cancels, so the same text is a new reply', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const { actions, api } = setUp(store, { queueReply: vi.fn(async (): Promise<SyncedChatOutgoing> => Promise.reject(new TypeError('Network request failed'))) })
      await expect(actions.send(chat('c1'), 'On my way')).rejects.toThrow()
      const kept = JSON.parse((await store.chatMeta(UNSURE_PREFIX + 'c1')) ?? '{}') as { id: string }

      // The reply shows (the server took it after all); the user cancels it before the copy settled the unsure send.
      await actions.cancel(reply(kept.id, 'c1', { text: 'On my way' }))

      await vi.waitFor(async () => expect(await store.chatMeta(UNSURE_PREFIX + 'c1')).toBeNull())
      api.queueReply = vi.fn(async (chatId: string, request: { id: string; text: string }) => reply(request.id, chatId, { text: request.text }))
      expect((await actions.send(chat('c1'), 'On my way')).id).not.toBe(kept.id)
    })

    it('never takes a refusal as cancelled for a reply the user did not cancel', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const refusal = new ApiError(409, 'This reply was cancelled.', {}, null, 'cancelled')
      const { actions } = setUp(store, { queueReply: vi.fn(async () => Promise.reject(refusal)) })

      await expect(actions.send(chat('c1'), 'On my way')).rejects.toBe(refusal)
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

    it('shows a hidden reply again when the copy has it as sent (a cancel the relay overtook)', async () => {
      const waiting = reply('r1', 'c1')
      const store = await copyWith({ chats: [chat('c1')], outgoing: [waiting] })
      const answer = deferred<void>()
      const { actions } = setUp(store, { cancelReply: vi.fn(() => answer.promise) })

      const cancelling = actions.cancel(waiting)
      answer.resolve()
      await cancelling
      const sent = reply('r1', 'c1', { status: 'sent', sentAt: new Date(NOW).toISOString() })
      actions.settle('c1', [sent])

      expect(actions.shown('c1', [sent])).toEqual([sent])
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

  describe('files', () => {
    const PLAN = { uri: 'file:///cache/plan.pdf', name: 'plan.pdf', size: 31, lastModified: 1 }
    type Upload = PhoneChatApi['uploadFile']

    /** An upload that waits until released, and stops when its signal is aborted, as the phone's uploader does. */
    function heldUpload(): { upload: Upload; release: () => void } {
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      const upload: Upload = vi.fn(async (chatId, uploadId, _file, options) => {
        await Promise.race([
          held,
          new Promise<never>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled.', 'AbortError')), { once: true })),
        ])
        return { id: uploadId, chatId, size: 31 }
      })
      return { upload, release }
    }

    it('uploads the file from its place on the phone, shows it as uploading, then queues a reply that carries it', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const { upload, release } = heldUpload()
      const { actions, api } = setUp(store, { uploadFile: upload })

      const sending = actions.sendFile(chat('c1'), PLAN)
      await vi.waitFor(() => expect(actions.shown('c1', [])).toHaveLength(1))
      const shown = actions.shown('c1', [])[0]!
      expect(actions.uploadOf(shown.id)).toEqual({ phase: 'uploading', progress: 0 })
      expect(api.queueReply).not.toHaveBeenCalled()
      release()
      const queued = await sending

      const [[chatId, uploadId, file]] = vi.mocked(upload).mock.calls
      expect([chatId, file]).toEqual(['c1', { uri: 'file:///cache/plan.pdf' }])
      expect(api.queueReply).toHaveBeenCalledWith('c1', { id: queued.id, text: '', file: { uploadId, name: 'plan.pdf' } })
      expect(actions.uploadOf(queued.id)).toBeNull()
      expect((await outgoingOf(store, 'c1')).map((row) => row.id)).toEqual([queued.id])
    })

    it('stops an upload on Cancel and queues nothing', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const { upload } = heldUpload()
      const { actions, api } = setUp(store, { uploadFile: upload })

      const sending = actions.sendFile(chat('c1'), PLAN)
      await vi.waitFor(() => expect(actions.shown('c1', [])).toHaveLength(1))
      await actions.cancel(actions.shown('c1', [])[0]!)

      await expect(sending).rejects.toMatchObject({ name: 'FileNotSent', cancelled: true, phase: 'upload' })
      expect(api.queueReply).not.toHaveBeenCalled()
      expect(api.cancelReply, 'Nothing reached the server to cancel.').not.toHaveBeenCalled()
      expect(actions.shown('c1', [])).toEqual([])
    })

    it('cancels on the server at once a reply that was being queued when Cancel came', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const answer = deferred<SyncedChatOutgoing>()
      const { actions, api } = setUp(store, { queueReply: vi.fn(() => answer.promise) })

      const sending = actions.sendFile(chat('c1'), PLAN)
      await vi.waitFor(() => expect(api.queueReply).toHaveBeenCalled())
      const shown = actions.shown('c1', [])[0]!
      await actions.cancel(shown)
      expect(api.cancelReply, 'Before the queueing answered.').toHaveBeenCalledWith(shown.id)
      answer.resolve(reply(shown.id, 'c1', { text: '' }))

      await expect(sending).rejects.toMatchObject({ cancelled: true, maybeSent: false })
      expect(api.cancelReply).toHaveBeenCalledTimes(1)
      expect(actions.shown('c1', [])).toEqual([])
    })

    it('takes a queueing refused as cancelled after the cancel as the cancel having worked', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const answer = deferred<SyncedChatOutgoing>()
      const { actions, api } = setUp(store, { queueReply: vi.fn(() => answer.promise) })

      const sending = actions.sendFile(chat('c1'), PLAN)
      await vi.waitFor(() => expect(api.queueReply).toHaveBeenCalled())
      await actions.cancel(actions.shown('c1', [])[0]!)
      answer.reject(new ApiError(409, 'This reply was cancelled.', {}, null, 'cancelled'))

      await expect(sending).rejects.toMatchObject({ cancelled: true, maybeSent: false })
      expect(api.cancelReply).toHaveBeenCalledTimes(1)
    })

    it('cancels again once the queueing answered when the first cancel got no answer, also after an unsure queueing', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const answer = deferred<SyncedChatOutgoing>()
      const cancelReply = vi.fn<PhoneChatApi['cancelReply']>().mockRejectedValueOnce(new TypeError('Network request failed')).mockResolvedValue(undefined)
      const { actions, api } = setUp(store, { queueReply: vi.fn(() => answer.promise), cancelReply })

      const sending = actions.sendFile(chat('c1'), PLAN)
      await vi.waitFor(() => expect(api.queueReply).toHaveBeenCalled())
      const shown = actions.shown('c1', [])[0]!
      await actions.cancel(shown)
      answer.reject(new TypeError('Network request failed'))

      await expect(sending).rejects.toMatchObject({ cancelled: true, maybeSent: false })
      expect(cancelReply.mock.calls).toEqual([[shown.id], [shown.id]])
      expect(await store.chatMeta(UNSURE_FILES), 'Nothing kept to send again.').toBeNull()
    })

    it('says a file may still be sent when no cancel was confirmed, and keeps the queued reply in the chat', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const answer = deferred<SyncedChatOutgoing>()
      const { actions, api } = setUp(store, { queueReply: vi.fn(() => answer.promise), cancelReply: vi.fn(async () => Promise.reject(new TypeError('Network request failed'))) })

      const sending = actions.sendFile(chat('c1'), PLAN)
      await vi.waitFor(() => expect(api.queueReply).toHaveBeenCalled())
      const shown = actions.shown('c1', [])[0]!
      await actions.cancel(shown)
      answer.resolve(reply(shown.id, 'c1', { text: '', file: { name: 'plan.pdf', size: 31 } }))

      await expect(sending).rejects.toMatchObject({ cancelled: true, maybeSent: true })
      expect(actions.shown('c1', []).map((row) => [row.id, row.status])).toEqual([[shown.id, 'waiting']])
      expect((await outgoingOf(store, 'c1')).map((row) => row.id)).toEqual([shown.id])
    })

    it('holds Attach after too many files until the server\'s Retry-After passed', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const uploadFile = vi.fn<PhoneChatApi['uploadFile']>().mockRejectedValueOnce(new ApiError(429, 'Too many files.', {}, 30_000))
      uploadFile.mockImplementation(async (chatId, uploadId) => ({ id: uploadId, chatId, size: 31 }))
      const { actions, later } = setUp(store, { uploadFile })

      await expect(actions.sendFile(chat('c1'), PLAN)).rejects.toMatchObject({ phase: 'upload' })
      expect(actions.attachHeld()).toBe(30_000)
      await expect(actions.sendFile(chat('c1'), PLAN)).rejects.toMatchObject({ phase: 'upload' })
      expect(uploadFile, 'Nothing is asked while held.').toHaveBeenCalledTimes(1)

      later(30_000)
      expect(actions.attachHeld()).toBeNull()
      await actions.sendFile(chat('c1'), PLAN)
      expect(uploadFile).toHaveBeenCalledTimes(2)
    })

    it('holds Attach after too many replies on the queueing of a file, and says the real wait', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const { actions } = setUp(store, { queueReply: vi.fn(async (): Promise<SyncedChatOutgoing> => Promise.reject(new ApiError(429, 'Too many WhatsApp replies at once.', {}, 90_000))) })

      const failure = await actions.sendFile(chat('c1'), PLAN).catch((error: unknown) => error)

      expect(failure).toMatchObject({ phase: 'queue', unsure: false })
      expect((failure as { reason: unknown }).reason).toBeInstanceOf(AttachHeld)
      expect(((failure as { reason: Error }).reason).message).toBe('Too many files sent at once. Wait 2 minutes, then attach it again.')
      expect(actions.attachHeld()).toBe(90_000)
    })

    it('removes the per-file values an earlier build kept, the first time it reads the unsure files', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      await store.setChatMeta(`${OLD_UNSURE_FILE_PREFIX}c1:abc`, '{}')
      await store.setChatMeta(`${OLD_UNSURE_FILE_PREFIX}c1`, '{}')
      const { actions } = setUp(store)

      await actions.sendFile(chat('c1'), PLAN)

      expect(await store.chatMeta(`${OLD_UNSURE_FILE_PREFIX}c1:abc`)).toBeNull()
      expect(await store.chatMeta(`${OLD_UNSURE_FILE_PREFIX}c1`)).toBeNull()
    })

    it('keeps an unsure file per chat and file, so another file sent meanwhile leaves it alone', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const queueReply = vi.fn<PhoneChatApi['queueReply']>(async () => Promise.reject(new ApiError(502, 'Bad Gateway')))
      const { actions } = setUp(store, { queueReply })
      const other = { ...PLAN, uri: 'file:///cache/other.pdf', name: 'other.pdf', lastModified: 2 }

      await expect(actions.sendFile(chat('c1'), PLAN)).rejects.toMatchObject({ unsure: true })
      await expect(actions.sendFile(chat('c1'), other)).rejects.toMatchObject({ unsure: true })
      await expect(actions.sendFile(chat('c1'), PLAN)).rejects.toThrow()

      const replies = queueReply.mock.calls.map((call) => call[1].id)
      expect(replies[2], 'The first file again is the first reply.').toBe(replies[0])
      expect(replies[1]).not.toBe(replies[0])
    })

    it('stops every file on its way at sign-out', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const { upload } = heldUpload()
      const { actions, api } = setUp(store, { uploadFile: upload })

      const sending = actions.sendFile(chat('c1'), PLAN)
      await vi.waitFor(() => expect(actions.shown('c1', [])).toHaveLength(1))
      actions.clear()

      await expect(sending).rejects.toMatchObject({ cancelled: true })
      expect(api.queueReply).not.toHaveBeenCalled()
    })

    it('sends the same file again under the same ids when the queueing got no answer, also after the app was closed', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const queueReply = vi.fn<PhoneChatApi['queueReply']>(async () => Promise.reject(new ApiError(502, 'Bad Gateway')))
      const first = setUp(store, { queueReply })

      await expect(first.actions.sendFile(chat('c1'), PLAN)).rejects.toMatchObject({ phase: 'queue', unsure: true })
      expect(first.actions.shown('c1', [])).toEqual([])
      const kept = await store.chatMeta(UNSURE_FILES)
      expect(Object.keys(JSON.parse(kept ?? '{}') as object)).toEqual([unsureFileKey('c1', fileFingerprint(PLAN.name, PLAN.size, PLAN.lastModified))])
      expect(kept, 'Never the file name.').not.toContain('plan.pdf')

      const again = setUp(store, { queueReply })
      await expect(again.actions.sendFile(chat('c1'), PLAN)).rejects.toThrow()
      const uploads = [...vi.mocked(first.api.uploadFile).mock.calls, ...vi.mocked(again.api.uploadFile).mock.calls].map((call) => call[1])
      const replies = queueReply.mock.calls.map((call) => call[1].id)
      expect(uploads[1]).toBe(uploads[0])
      expect(replies[1]).toBe(replies[0])

      // Another file (or the same one changed) is another reply.
      await expect(again.actions.sendFile(chat('c1'), { ...PLAN, lastModified: 2 })).rejects.toThrow()
      expect(queueReply.mock.calls[2]![1].id).not.toBe(replies[0])
    })

    it('removes unsure files once the delta has their reply or their time passed, also those of other files', async () => {
      const store = await copyWith({ chats: [chat('c1'), chat('c2', { jid: '31600000002@s.whatsapp.net' })] })
      const queueReply = vi.fn<PhoneChatApi['queueReply']>(async () => Promise.reject(new ApiError(502, 'Bad Gateway')))
      const { actions, later } = setUp(store, { queueReply })
      const other = { ...PLAN, name: 'other.pdf', lastModified: 2 }
      await expect(actions.sendFile(chat('c1'), PLAN)).rejects.toThrow()
      await expect(actions.sendFile(chat('c1'), other)).rejects.toThrow()
      await expect(actions.sendFile(chat('c2', { jid: '31600000002@s.whatsapp.net' }), PLAN)).rejects.toThrow()
      const kept = async () => Object.keys(JSON.parse((await store.chatMeta(UNSURE_FILES)) ?? '{}') as object).sort()
      expect(await kept()).toHaveLength(3)

      // The delta brings the reply of the first: its entry goes, the others stay.
      const first = queueReply.mock.calls[0]![1].id
      actions.settle('c1', [reply(first, 'c1', { text: '' })])
      await vi.waitFor(async () => expect(await kept()).toEqual([unsureFileKey('c1', fileFingerprint(other.name, other.size, other.lastModified)), unsureFileKey('c2', fileFingerprint(PLAN.name, PLAN.size, PLAN.lastModified))].sort()))

      // Their time passed: every one goes, whichever chat is read.
      later(10 * 60 * 1000)
      actions.settle('c1', [])
      await vi.waitFor(async () => expect(await store.chatMeta(UNSURE_FILES)).toBeNull())
    })

    it('makes new ids once the copy has the reply, or after a refusal', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const queueReply = vi.fn<PhoneChatApi['queueReply']>(async () => Promise.reject(new ApiError(502, 'Bad Gateway')))
      const { actions } = setUp(store, { queueReply })
      await expect(actions.sendFile(chat('c1'), PLAN)).rejects.toThrow()
      const firstId = queueReply.mock.calls[0]![1].id
      await store.putChatOutgoing([reply(firstId, 'c1', { text: '' })])

      queueReply.mockImplementation(async () => Promise.reject(new ApiError(422, 'Upload it again.', { 'file.uploadId': 'Upload it again.' })))
      await expect(actions.sendFile(chat('c1'), PLAN)).rejects.toMatchObject({ phase: 'queue', unsure: false })
      const secondId = queueReply.mock.calls[1]![1].id
      expect(secondId, 'The copy has the first: this is a new reply.').not.toBe(firstId)
      await expect(actions.sendFile(chat('c1'), PLAN)).rejects.toThrow()
      expect(queueReply.mock.calls[2]![1].id, 'A refusal is final.').not.toBe(secondId)
    })

    it('says an upload that failed queued nothing', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const { actions, api } = setUp(store, { uploadFile: vi.fn(async () => Promise.reject(new ApiError(413, 'Files waiting for your Mac take up more than 1024 MB.', {}, null, 'too_much_waiting'))) })

      await expect(actions.sendFile(chat('c1'), PLAN)).rejects.toMatchObject({ phase: 'upload', unsure: false, cancelled: false })
      expect(api.queueReply).not.toHaveBeenCalled()
    })

    it('refuses a file larger than 100 MB before anything is uploaded', async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const { actions, api } = setUp(store)

      await expect(actions.sendFile(chat('c1'), { ...PLAN, size: 100 * 1024 * 1024 + 1 })).rejects.toMatchObject({ phase: 'upload' })
      expect(api.uploadFile).not.toHaveBeenCalled()
    })

    it("asks the Mac for a file, and gives a checked one's link or an unchecked one's only when accepted", async () => {
      const store = await copyWith({ chats: [chat('c1')] })
      const { actions, api } = setUp(store)

      await actions.requestFile('m1')
      expect(api.requestMedia).toHaveBeenCalledWith('m1')
      await expect(actions.fileLink('m1')).resolves.toBe('https://api.test/content/chat-media/m1')
      await expect(actions.fileLink('m1', true)).resolves.toBe('https://api.test/content/chat-media/m1?unscanned=1')
      expect(api.unscannedMediaLink).toHaveBeenCalledTimes(1)
    })
  })
})
