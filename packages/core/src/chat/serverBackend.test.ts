import { beforeEach, describe, expect, it } from 'vitest'
import { chat, chatAccount } from '../store/contract'
import { memorySql } from '../store/memorySql'
import { SqliteMailStore } from '../store/sqlite'
import {
  ChatApiError,
  RELAY_MAX_BYTES,
  RELAY_MAX_CHATS,
  RELAY_MAX_MESSAGES,
  type ChatApi,
  type RelayClaimResponse,
  type RelayImportResponse,
  type RelayMessagesRequest,
  type RelayResultRequest,
  type RelayStatusRequest,
} from './api'
import { LOCAL_CURSOR, LocalChatBackend } from './localBackend'
import { ChatRelay, ChatRelayRetryLater, ChatRelayStopped, RELAY_ERROR_DELAY, type BridgePage, type ChatBridge, type IncomingChat, type IncomingMessage, type RelayCursor } from './relay'
import { RELAY_MIN_BATCH_BYTES, ServerChatBackend, jsonBytes, removeServerChatCursor, serverCursorKey } from './serverBackend'
import type { BridgeRow, SyncedChatOutgoing } from './types'

const ACCOUNT = '0193b000-0000-7000-8000-00000000000a'
const DEVICE = '0193a000-0000-7000-8000-000000000001'
const OTHER_DEVICE = '0193a000-0000-7000-8000-000000000002'
const DIRECT = '31612345678@s.whatsapp.net'
const OTHER = '31687654321@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'
const NOW = Date.parse('2026-11-12T10:00:00Z')
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

function incoming(waId: string, chatJid: string, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return { chatJid, waId, fromMe: false, sender: null, text: `Text ${waId}`, sentAt: iso(-1), media: null, ...extra }
}

function directChat(jid: string, name: string | null = 'Kim'): IncomingChat {
  return { jid, name, kind: 'direct' }
}

function utf8(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

type Call =
  | { kind: 'messages'; accountId: string; request: RelayMessagesRequest }
  | { kind: 'claim'; accountId: string; deviceId: string }
  | { kind: 'result'; accountId: string; outgoingId: string; request: RelayResultRequest }
  | { kind: 'status'; accountId: string; request: RelayStatusRequest }

/**
 * A fake server for the relay endpoints: it stores messages by chat and WhatsApp id (`known` the second time), and
 * every endpoint can be made to fail through `fail`.
 */
class FakeChatApi implements ChatApi {
  readonly calls: Call[] = []
  readonly stored = new Set<string>()
  relayDevice = DEVICE
  /** Answers a batch instead of the fake's own storing when it returns a response or throws. */
  onMessages: ((request: RelayMessagesRequest) => RelayImportResponse | undefined) | null = null
  failClaim: unknown = null
  failResult: unknown = null
  failStatus: unknown = null
  claimable: RelayClaimResponse[] = []
  /** Replies claimed: by id, the token and the device that claimed, and the result taken. */
  readonly claims = new Map<string, { token: string; device: string; result: 'sending' | 'sent' | 'failed' }>()

  accounts(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }
  connect(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }
  updateAccount(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }
  removeAccount(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }
  queueReply(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }
  cancelReply(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }
  retryReply(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }
  updateChat(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }

  relayStatus(accountId: string, request: RelayStatusRequest): Promise<{ relay: 'active' }> {
    this.calls.push({ kind: 'status', accountId, request })
    if (this.failStatus !== null) {
      return Promise.reject(this.failStatus)
    }
    return this.relayCheck(request.deviceId) ?? Promise.resolve({ relay: 'active' })
  }

  relayMessages(accountId: string, request: RelayMessagesRequest): Promise<RelayImportResponse> {
    // What a real client sends: the request as JSON.
    const sent = JSON.parse(JSON.stringify(request)) as RelayMessagesRequest
    this.calls.push({ kind: 'messages', accountId, request: sent })
    try {
      const answer = this.onMessages?.(sent)
      if (answer !== undefined) {
        return Promise.resolve(answer)
      }
    } catch (error) {
      return Promise.reject(error)
    }
    const refused = this.relayCheck(request.deviceId)
    if (refused !== null) {
      return refused
    }
    if (utf8(sent) > RELAY_MAX_BYTES) {
      return Promise.reject(new ChatApiError(413, 'Too large.', 'too_large'))
    }
    if (sent.messages.length > RELAY_MAX_MESSAGES || sent.chats.length > RELAY_MAX_CHATS) {
      return Promise.reject(new ChatApiError(422, 'Too many.'))
    }
    const results = sent.messages.map((message) => {
      const key = `${message.chatJid}\n${message.waId}`
      if (this.stored.has(key)) {
        return 'known' as const
      }
      this.stored.add(key)
      return 'stored' as const
    })
    return Promise.resolve(counted(results))
  }

  claimReply(accountId: string, request: { deviceId: string }): Promise<RelayClaimResponse | null> {
    this.calls.push({ kind: 'claim', accountId, deviceId: request.deviceId })
    if (this.failClaim !== null) {
      return Promise.reject(this.failClaim)
    }
    const refused = this.relayCheck(request.deviceId)
    if (refused !== null) {
      return refused
    }
    const next = this.claimable.shift()
    if (next === undefined) {
      return Promise.resolve(null)
    }
    this.claims.set(next.id, { token: next.claimToken, device: request.deviceId, result: 'sending' })
    return Promise.resolve(next)
  }

  /** As ChatQueue::report: a former relay may still report `sent: true` for its own claim; anything else of it is 409. */
  reportReply(accountId: string, outgoingId: string, request: RelayResultRequest): Promise<SyncedChatOutgoing> {
    this.calls.push({ kind: 'result', accountId, outgoingId, request })
    if (this.failResult !== null) {
      return Promise.reject(this.failResult)
    }
    const fromRelay = request.deviceId === this.relayDevice
    const claim = this.claims.get(outgoingId)
    if (claim === undefined) {
      return Promise.reject(fromRelay ? new ChatApiError(404, 'Not found.') : notTheRelay())
    }
    const theClaim = claim.token === request.claimToken && (fromRelay || claim.device === request.deviceId)
    if (theClaim && (fromRelay || request.sent) && claim.result === 'sending') {
      claim.result = request.sent ? 'sent' : 'failed'
      return Promise.resolve(outgoingRow(outgoingId, claim.result))
    }
    if ((request.sent && claim.result === 'sent') || (!request.sent && claim.result === 'failed')) {
      return Promise.resolve(outgoingRow(outgoingId, claim.result))
    }
    return Promise.reject(fromRelay ? new ChatApiError(409, 'Final.', 'result_final') : notTheRelay())
  }

  messageCalls(): RelayMessagesRequest[] {
    return this.calls.flatMap((call) => (call.kind === 'messages' ? [call.request] : []))
  }

  private relayCheck(deviceId: string): Promise<never> | null {
    return deviceId === this.relayDevice ? null : Promise.reject(notTheRelay())
  }
}

function notTheRelay(): ChatApiError {
  return new ChatApiError(409, 'Another device relays this WhatsApp account now.', 'not_the_relay')
}

function counted(results: RelayImportResponse['results']): RelayImportResponse {
  const count = (result: string) => results.filter((value) => value === result).length
  return { stored: count('stored'), known: count('known'), leftOut: count('left_out'), refused: count('refused'), results }
}

function outgoingRow(id: string, status: 'sent' | 'failed'): SyncedChatOutgoing {
  return { id, chatId: 'c1', chatAccountId: ACCOUNT, text: 'Reply', status, error: status === 'failed' ? 'refused' : null, createdAt: iso(-5), claimedAt: iso(-1), sentAt: status === 'sent' ? iso(0) : null }
}

describe('ServerChatBackend', () => {
  let store: SqliteMailStore
  let api: FakeChatApi
  let backend: ServerChatBackend

  beforeEach(async () => {
    store = await SqliteMailStore.open(await memorySql())
    await store.putChatAccount(chatAccount(ACCOUNT, { relayDeviceId: DEVICE, includeGroups: true }))
    api = new FakeChatApi()
    backend = new ServerChatBackend({ api, store, accountId: ACCOUNT, deviceId: DEVICE, importSince: NOW - 30 * 24 * 60 * 60_000 })
  })

  describe('ingest', () => {
    it('sends at most 200 messages a call, each call with the chats of its messages, and sums the counts', async () => {
      const messages = Array.from({ length: 450 }, (_, i) => incoming(`M${i}`, i % 2 === 0 ? DIRECT : OTHER))

      const counts = await backend.ingest([directChat(DIRECT), directChat(OTHER, null)], messages, false)

      expect(counts).toEqual({ stored: 450, known: 0, leftOut: 0, refused: 0 })
      const calls = api.messageCalls()
      expect(calls.map((call) => call.messages.length)).toEqual([200, 200, 50])
      expect(calls.flatMap((call) => call.messages.map((message) => message.waId))).toEqual(messages.map((message) => message.waId))
      for (const call of calls) {
        expect(call.chats.map((relayed) => relayed.jid).sort()).toEqual([...new Set(call.messages.map((message) => message.chatJid))].sort())
        expect(call).toMatchObject({ deviceId: DEVICE, firstImport: false })
      }
      expect(calls[0]!.chats).toEqual([
        { jid: DIRECT, name: 'Kim', kind: 'direct' },
        { jid: OTHER, name: null, kind: 'direct' },
      ])
    })

    it('never puts more than 200 chats in a call', async () => {
      const jids = Array.from({ length: 250 }, (_, i) => `316${String(10_000_000 + i)}@s.whatsapp.net`)

      await backend.ingest(
        jids.map((jid) => directChat(jid)),
        jids.map((jid, i) => incoming(`M${i}`, jid)),
        false,
      )

      expect(api.messageCalls().map((call) => [call.messages.length, call.chats.length])).toEqual([
        [200, 200],
        [50, 50],
      ])
    })

    it('sends only the fields the server takes, in its shape', async () => {
      const message = incoming('G1', GROUP, { sender: { id: '31611111111', name: 'Ana' }, media: { kind: 'image', name: 'photo.jpg', size: 1234 }, text: 'caption' })

      await backend.ingest([{ jid: GROUP, name: 'Team', kind: 'group' }], [{ ...message, extra: 'not sent' } as IncomingMessage], false)

      expect(api.messageCalls()[0]).toEqual({
        deviceId: DEVICE,
        firstImport: false,
        chats: [{ jid: GROUP, name: 'Team', kind: 'group' }],
        messages: [
          { chatJid: GROUP, waId: 'G1', fromMe: false, sender: { id: '31611111111', name: 'Ana' }, text: 'caption', sentAt: iso(-1), media: { kind: 'image', name: 'photo.jpg', size: 1234 } },
        ],
      })
    })

    it('builds batches by the UTF-8 size of their JSON, within 8 MB', async () => {
      // 65,536 characters of 3 bytes each and a 4-byte emoji: 196 KB a message, so 200 would be 39 MB.
      const text = `${'€'.repeat(65_534)}😀`
      const messages = Array.from({ length: 120 }, (_, i) => incoming(`B${i}`, DIRECT, { text }))

      const counts = await backend.ingest([directChat(DIRECT)], messages, false)

      expect(counts.stored).toBe(120)
      const calls = api.messageCalls()
      expect(calls.length).toBeGreaterThan(2)
      for (const call of calls) {
        expect(utf8(call)).toBeLessThanOrEqual(RELAY_MAX_BYTES)
      }
      // Full batches: the next message would not have fitted.
      const one = utf8(calls[0]!.messages[0])
      expect(utf8(calls[0]) + one + 1).toBeGreaterThan(RELAY_MAX_BYTES)
    })

    it('counts UTF-8 bytes as TextEncoder does, also for escapes and lone surrogates', () => {
      for (const value of ['plain', 'é€😀', 'line\nbreak "quoted" \\', '\u0000\u001f', '\ud800 lone', 'pair 😀 \udc00']) {
        expect(jsonBytes({ value })).toBe(utf8({ value }))
      }
    })

    it('halves a batch answered 413 and keeps later batches below the size that got it', async () => {
      // Something between the desktop and the API takes no more than 100 KB.
      const limit = 100 * 1024
      let refusals = 0
      api.onMessages = (request) => {
        if (utf8(request) > limit) {
          refusals += 1
          throw new ChatApiError(413, 'Too large.', 'too_large')
        }
        return undefined
      }
      const text = 'x'.repeat(2_000)
      const first = Array.from({ length: 200 }, (_, i) => incoming(`A${i}`, DIRECT, { text }))

      expect(await backend.ingest([directChat(DIRECT)], first, false)).toEqual({ stored: 200, known: 0, leftOut: 0, refused: 0 })
      expect(refusals).toBeGreaterThan(0)
      refusals = 0
      const before = api.messageCalls().length

      const second = Array.from({ length: 200 }, (_, i) => incoming(`B${i}`, DIRECT, { text }))
      expect(await backend.ingest([directChat(DIRECT)], second, false)).toEqual({ stored: 200, known: 0, leftOut: 0, refused: 0 })

      // The second ingest starts below the size that failed: no 413 at all, and never below the floor but for the rest.
      expect(refusals).toBe(0)
      const secondCalls = api.messageCalls().slice(before)
      expect(secondCalls.slice(0, -1).every((call) => utf8(call) <= limit && utf8(call) + 2_100 > RELAY_MIN_BATCH_BYTES)).toBe(true)
    })

    it('counts a single message still answered 413 as refused and goes on with the rest', async () => {
      api.onMessages = (request) => {
        if (request.messages.some((message) => message.waId === 'HUGE')) {
          throw new ChatApiError(413, 'Too large.', 'too_large')
        }
        return undefined
      }
      const messages = Array.from({ length: 10 }, (_, i) => incoming(i === 6 ? 'HUGE' : `M${i}`, DIRECT))

      const counts = await backend.ingest([directChat(DIRECT)], messages, false)

      expect(counts).toEqual({ stored: 9, known: 0, leftOut: 0, refused: 1 })
      expect(api.stored.has(`${DIRECT}\nHUGE`)).toBe(false)
      // Bounded: 10 messages, at most 2 * 10 - 1 calls.
      expect(api.messageCalls().length).toBeLessThanOrEqual(19)
    })

    it('bisects a batch refused as a whole (422) to the message it is about, counts it refused, and stores the rest', async () => {
      api.onMessages = (request) => {
        if (request.messages.some((message) => message.waId === 'BAD')) {
          throw new ChatApiError(422, 'messages[3].text: This value is too long.')
        }
        return undefined
      }
      const messages = Array.from({ length: 200 }, (_, i) => incoming(i === 77 ? 'BAD' : `M${i}`, i % 2 === 0 ? DIRECT : OTHER))

      const counts = await backend.ingest([directChat(DIRECT), directChat(OTHER)], messages, true)

      expect(counts).toEqual({ stored: 199, known: 0, leftOut: 0, refused: 1 })
      // One bad message in 200: about 2 log2(200) calls, far below the bound of 399.
      expect(api.messageCalls().length).toBeLessThanOrEqual(1 + 2 * Math.ceil(Math.log2(200)))
      // Every part keeps the batch's firstImport and carries the chats of its messages.
      for (const call of api.messageCalls()) {
        expect(call.firstImport).toBe(true)
        expect(call.chats.map((relayed) => relayed.jid).sort()).toEqual([...new Set(call.messages.map((message) => message.chatJid))].sort())
      }
    })

    it('sums the per-row results of the server', async () => {
      api.onMessages = (request) => counted(request.messages.map((_, i) => (['stored', 'known', 'left_out', 'refused'] as const)[i % 4]!))

      const counts = await backend.ingest([directChat(DIRECT)], Array.from({ length: 250 }, (_, i) => incoming(`M${i}`, DIRECT)), false)

      expect(counts).toEqual({ stored: 63, known: 63, leftOut: 62, refused: 62 })
    })

    it('rejects an answer whose counts do not add up, so the rows are sent again', async () => {
      api.onMessages = () => ({ stored: 1, known: 0, leftOut: 0, refused: 0, results: ['stored'] })

      await expect(backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT), incoming('A2', DIRECT)], false)).rejects.toThrow('do not add up')
    })

    it('passes firstImport through on every call', async () => {
      await backend.ingest([directChat(DIRECT)], Array.from({ length: 300 }, (_, i) => incoming(`F${i}`, DIRECT)), true)
      await backend.ingest([directChat(DIRECT)], [incoming('L1', DIRECT)], false)

      expect(api.messageCalls().map((call) => call.firstImport)).toEqual([true, true, false])
    })

    it('makes no call without messages', async () => {
      expect(await backend.ingest([directChat(DIRECT)], [], false)).toEqual({ stored: 0, known: 0, leftOut: 0, refused: 0 })
      expect(api.calls).toEqual([])
    })

    it('sends nothing of a chat the copy holds as left out, and counts it left out', async () => {
      await store.putChats([chat('c-left', ACCOUNT, { jid: OTHER, leftOut: true })])

      const counts = await backend.ingest([directChat(DIRECT), directChat(OTHER)], [incoming('A1', DIRECT), incoming('B1', OTHER), incoming('B2', OTHER)], false)

      expect(counts).toEqual({ stored: 1, known: 0, leftOut: 2, refused: 0 })
      expect(JSON.stringify(api.calls)).not.toContain(OTHER)
      expect(JSON.stringify(api.calls)).not.toContain('Text B1')
    })

    it('throws ChatRelayRetryLater with the Retry-After on 429', async () => {
      api.onMessages = () => {
        throw new ChatApiError(429, 'Too many batches at once.', null, 42_000)
      }
      const error: unknown = await backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT)], false).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ChatRelayRetryLater)
      expect((error as ChatRelayRetryLater).retryAfterMs).toBe(42_000)

      api.onMessages = () => {
        throw new ChatApiError(429, 'Too many batches at once.')
      }
      const without: unknown = await backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT)], false).catch((caught: unknown) => caught)
      expect((without as ChatRelayRetryLater).retryAfterMs).toBe(RELAY_ERROR_DELAY)
    })

    it('stops on 409 not_the_relay and on 404, and rejects as it came on anything else', async () => {
      api.relayDevice = OTHER_DEVICE
      await expect(backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT)], false)).rejects.toBeInstanceOf(ChatRelayStopped)
      api.relayDevice = DEVICE

      api.onMessages = () => {
        throw new ChatApiError(404, 'Chat account not found.')
      }
      await expect(backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT)], false)).rejects.toBeInstanceOf(ChatRelayStopped)

      for (const failure of [new ChatApiError(500, 'Server error.'), new ChatApiError(401, 'Signed out.'), new ChatApiError(400, 'Not read.'), new TypeError('Failed to fetch')]) {
        api.onMessages = () => {
          throw failure
        }
        await expect(backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT)], false)).rejects.toBe(failure)
      }
      // None of those were bisected: one call each.
      expect(api.messageCalls().length).toBe(6)
    })

    it('names no chat, number or text in the errors it makes', async () => {
      const errors: unknown[] = []
      api.relayDevice = OTHER_DEVICE
      errors.push(await backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT, { text: 'secret words' })], false).catch((caught: unknown) => caught))
      api.relayDevice = DEVICE
      api.onMessages = () => ({ stored: 5, known: 0, leftOut: 0, refused: 0, results: [] })
      errors.push(await backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT, { text: 'secret words' })], false).catch((caught: unknown) => caught))

      for (const error of errors) {
        const said = `${(error as Error).name} ${(error as Error).message}`
        expect(said).not.toMatch(/31612345678|secret|Kim/)
      }
    })
  })

  describe('settings', () => {
    it('takes includeGroups from the account in the copy and importSince as given', async () => {
      await store.putChatAccount(chatAccount(ACCOUNT, { includeGroups: false }))

      expect(await backend.settings()).toEqual({ includeGroups: false, leftOut: new Set(), importSince: NOW - 30 * 24 * 60 * 60_000 })
    })

    it('lists the chats found left out in the copy in canonical form, until one is taken in again', async () => {
      await store.putChats([chat('c-left', ACCOUNT, { jid: OTHER, leftOut: true })])
      await backend.ingest([directChat(OTHER)], [incoming('B1', OTHER)], false)

      expect((await backend.settings()).leftOut).toEqual(new Set([OTHER]))

      await store.putChats([chat('c-left', ACCOUNT, { jid: OTHER, leftOut: false })])
      expect((await backend.settings()).leftOut).toEqual(new Set())
      expect(await backend.ingest([directChat(OTHER)], [incoming('B2', OTHER)], false)).toMatchObject({ stored: 1, leftOut: 0 })
    })

    it('rejects while the account is not in the copy yet', async () => {
      await store.removeChatAccount(ACCOUNT)

      await expect(backend.settings()).rejects.toThrow('not on this device yet')
    })
  })

  describe('cursor', () => {
    const cursor: RelayCursor = { storeId: 'store-1', rowid: 42, firstImport: { through: 50, ranFor: 3_000, quietFor: 0 } }

    it('keeps its cursor apart from the local backend and per account', async () => {
      const local = new LocalChatBackend(store, { includeGroups: true, leftOut: [], importSince: 0 }, { number: null, name: null, deviceId: DEVICE, deviceName: 'Mac' })
      await local.setCursor({ storeId: 'local', rowid: 900, firstImport: null })

      expect(await backend.cursor()).toBeNull()
      await backend.setCursor(cursor)
      expect(await backend.cursor()).toEqual(cursor)
      expect(await local.cursor()).toEqual({ storeId: 'local', rowid: 900, firstImport: null })
      expect(serverCursorKey(ACCOUNT)).not.toBe(LOCAL_CURSOR)

      const another = new ServerChatBackend({ api, store, accountId: '0193b000-0000-7000-8000-00000000000b', deviceId: DEVICE, importSince: 0 })
      expect(await another.cursor()).toBeNull()

      await removeServerChatCursor(store, ACCOUNT)
      expect(await backend.cursor()).toBeNull()
    })

    it('reads an unreadable cursor as one at 0 with live rows', async () => {
      await store.setChatMeta(serverCursorKey(ACCOUNT), '{"rowid":"x"}')

      expect(await backend.cursor()).toEqual({ storeId: '', rowid: 0, firstImport: null })
    })
  })

  describe('replies', () => {
    const reply: RelayClaimResponse = { id: '0193c000-0000-7000-8000-000000000001', chatId: 'c1', chatJid: DIRECT, text: 'On my way', claimToken: 'a'.repeat(32) }

    it('claims one reply with this device and keeps its token for the result', async () => {
      expect(await backend.claimNext()).toBeNull()
      api.claimable = [reply]

      const claimed = await backend.claimNext()
      expect(claimed).toEqual({ id: reply.id, chatId: 'c1', chatJid: DIRECT, text: 'On my way', token: reply.claimToken })
      await backend.report(claimed!, { sent: true })

      expect(api.calls).toEqual([
        { kind: 'claim', accountId: ACCOUNT, deviceId: DEVICE },
        { kind: 'claim', accountId: ACCOUNT, deviceId: DEVICE },
        { kind: 'result', accountId: ACCOUNT, outgoingId: reply.id, request: { deviceId: DEVICE, claimToken: reply.claimToken, sent: true, error: null } },
      ])
      expect(api.claims.get(reply.id)?.result).toBe('sent')
    })

    it('reports a reply not sent with its error', async () => {
      api.claimable = [reply]
      const claimed = (await backend.claimNext())!

      await backend.report(claimed, { sent: false, error: 'not_linked' })

      expect(api.calls[api.calls.length - 1]).toMatchObject({ kind: 'result', request: { sent: false, error: 'not_linked', claimToken: reply.claimToken } })
    })

    it('takes 404 and 409 result_final on a result as final, and the same result again changes nothing', async () => {
      api.claimable = [reply]
      const claimed = (await backend.claimNext())!
      await backend.report(claimed, { sent: true })
      await backend.report(claimed, { sent: true })
      // Another result for a reply that has one: final, resolved, not retried.
      await backend.report(claimed, { sent: false, error: 'refused' })
      await backend.report({ ...claimed, id: '0193c000-0000-7000-8000-0000000000ff' }, { sent: true })
      api.failResult = new ChatApiError(422, 'claimToken: This value is too long.')
      await backend.report(claimed, { sent: true })

      expect(api.claims.get(reply.id)?.result).toBe('sent')
    })

    it('a former relay may still report sent for its own claim, and stops on anything else', async () => {
      api.claimable = [reply, { ...reply, id: '0193c000-0000-7000-8000-000000000002', claimToken: 'b'.repeat(32) }]
      const sentOne = (await backend.claimNext())!
      const failedOne = (await backend.claimNext())!
      // Another Mac takes over.
      api.relayDevice = OTHER_DEVICE

      await backend.report(sentOne, { sent: true })
      expect(api.claims.get(sentOne.id)?.result).toBe('sent')

      await expect(backend.report(failedOne, { sent: false, error: 'bridge_stopped' })).rejects.toBeInstanceOf(ChatRelayStopped)
      expect(api.claims.get(failedOne.id)?.result).toBe('sending')

      await expect(backend.claimNext()).rejects.toBeInstanceOf(ChatRelayStopped)
    })

    it('rejects a result that failed by network or 5xx as it came, so the relay reports it again', async () => {
      api.claimable = [reply]
      const claimed = (await backend.claimNext())!
      const network = new TypeError('Failed to fetch')
      api.failResult = network

      await expect(backend.report(claimed, { sent: true })).rejects.toBe(network)
      api.failResult = new ChatApiError(503, 'Unavailable.')
      await expect(backend.report(claimed, { sent: true })).rejects.toMatchObject({ status: 503 })
      api.failResult = new ChatApiError(429, 'Slow down.', null, 5_000)
      await expect(backend.report(claimed, { sent: true })).rejects.toBeInstanceOf(ChatRelayRetryLater)

      api.failResult = null
      await backend.report(claimed, { sent: true })
      expect(api.claims.get(reply.id)?.result).toBe('sent')
    })

    it('stops on a claim answered 404 or not_the_relay, waits on 429', async () => {
      api.failClaim = new ChatApiError(404, 'Chat account not found.')
      await expect(backend.claimNext()).rejects.toBeInstanceOf(ChatRelayStopped)
      api.failClaim = new ChatApiError(429, 'Slow down.', null, 2_000)
      await expect(backend.claimNext()).rejects.toMatchObject({ retryAfterMs: 2_000 })
    })
  })

  describe('heartbeat', () => {
    it('reports the bridge with this device and stops when another device relays', async () => {
      await backend.reportStatus({ bridge: 'running', link: 'linked', linkedAt: iso(-60), loopbackOnly: true })
      expect(api.calls).toEqual([{ kind: 'status', accountId: ACCOUNT, request: { deviceId: DEVICE, bridge: 'running', link: 'linked', linkedAt: iso(-60), loopbackOnly: true } }])

      api.relayDevice = OTHER_DEVICE
      await expect(backend.reportStatus({ bridge: 'stopped', link: 'unknown', linkedAt: null, loopbackOnly: null })).rejects.toBeInstanceOf(ChatRelayStopped)
    })
  })

  it('refuses a device id that is not a UUID and an import date that is not a time', () => {
    expect(() => new ServerChatBackend({ api, store, accountId: ACCOUNT, deviceId: 'mac', importSince: 0 })).toThrow('not a UUID')
    expect(() => new ServerChatBackend({ api, store, accountId: ACCOUNT, deviceId: DEVICE, importSince: Number.NaN })).toThrow('not a time')
  })

  describe('with the relay', () => {
    let rows: BridgeRow[]
    let storeId: string
    let sent: string[]
    let stopped: unknown[]
    let errors: unknown[]
    let relay: ChatRelay

    function row(rowid: number, id: string, chatJid = DIRECT): BridgeRow {
      return { rowid, id, chatJid, chatName: 'Kim', sender: '', text: `Text ${id}`, sentAt: NOW - 60_000, fromMe: false, mediaType: null, filename: null, fileLength: null }
    }

    beforeEach(() => {
      rows = []
      storeId = 'store-1'
      sent = []
      stopped = []
      errors = []
      const bridge: ChatBridge = {
        read: (after: number, limit: number): Promise<BridgePage> =>
          Promise.resolve({ rows: rows.filter((candidate) => candidate.rowid > after).slice(0, limit), maxRowid: rows.reduce((max, candidate) => Math.max(max, candidate.rowid), 0), storeId }),
        names: () => Promise.resolve({}),
        send: (recipient: string, text: string) => {
          sent.push(`${recipient} ${text}`)
          return Promise.resolve({ ok: true })
        },
      }
      relay = new ChatRelay({
        bridge,
        backend,
        now: () => NOW,
        schedule: () => () => undefined,
        onStopped: (reason) => stopped.push(reason),
        onError: (error) => errors.push(error),
      })
    })

    it('moves the cursor only after the server took the batch', async () => {
      rows = [row(1, 'A1'), row(2, 'A2')]
      api.onMessages = () => {
        throw new ChatApiError(503, 'Unavailable.')
      }

      await relay.pollNow()
      expect(await backend.cursor()).toBeNull()
      expect(errors).toHaveLength(1)

      api.onMessages = null
      await relay.pollNow()
      expect(await backend.cursor()).toMatchObject({ storeId: 'store-1', rowid: 2 })
      expect(api.stored.size).toBe(2)
    })

    it('reads a store whose id changed again from 0; the server answers known and the cursor moves on', async () => {
      rows = [row(1, 'A1'), row(2, 'A2'), row(3, 'A3')]
      await relay.pollNow()
      expect(api.stored.size).toBe(3)

      storeId = 'store-2'
      rows = [...rows, row(4, 'A4')]
      await relay.pollNow()

      const last = api.messageCalls()[api.messageCalls().length - 1]!
      expect(last.messages.map((message) => message.waId)).toEqual(['A1', 'A2', 'A3', 'A4'])
      expect(await backend.cursor()).toMatchObject({ storeId: 'store-2', rowid: 4 })
      expect(api.stored.size).toBe(4)
    })

    it('stops when another device took over, and sends the waiting replies one at a time otherwise', async () => {
      api.claimable = [{ id: '0193c000-0000-7000-8000-000000000001', chatId: 'c1', chatJid: DIRECT, text: 'First', claimToken: 't1' }]
      await relay.pollNow()
      expect(sent).toEqual([`${DIRECT} First`])
      expect(api.claims.get('0193c000-0000-7000-8000-000000000001')?.result).toBe('sent')

      api.relayDevice = OTHER_DEVICE
      rows = [row(1, 'A1')]
      await relay.pollNow()
      expect(stopped).toHaveLength(1)
      expect(stopped[0]).toBeInstanceOf(ChatRelayStopped)
      expect(relay.running).toBe(false)
    })
  })
})
