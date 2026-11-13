import { beforeEach, describe, expect, it } from 'vitest'
import { chat, chatAccount } from '../store/contract'
import { memorySql } from '../store/memorySql'
import { SqliteMailStore } from '../store/sqlite'
import {
  ChatApiError,
  RELAY_MAX_BYTES,
  RELAY_MAX_CHATS,
  RELAY_MAX_FIELD,
  RELAY_MAX_MESSAGES,
  chatApiFailure,
  type ChatApi,
  type RelayClaimResponse,
  type RelayImportResponse,
  type RelayMediaClaimResponse,
  type RelayMediaFailedRequest,
  type RelayMediaResponse,
  type RelayMediaUploadRequest,
  type RelayMessageResult,
  type RelayMessagesRequest,
  type RelayResultRequest,
  type RelayStatusRequest,
} from './api'
import { LOCAL_CURSOR, LocalChatBackend } from './localBackend'
import {
  ChatRelay,
  ChatRelayRetryLater,
  ChatRelayStopped,
  RELAY_ERROR_DELAY,
  RELAY_RETRY_MAX,
  type BridgePage,
  type ChatBridge,
  type IncomingChat,
  type IncomingMessage,
  type RelayCursor,
  type RelayProgress,
} from './relay'
import {
  ChatRelayImportStuck,
  ChatRelayOtherNumber,
  RELAY_MAX_REFUSED,
  RELAY_MIN_BATCH_BYTES,
  ServerChatBackend,
  relayBodyBytes,
  removeServerChatState,
  serverClaimKey,
  serverCursorKey,
  type ServerChatProblem,
} from './serverBackend'
import type { BridgeRow, ChatOutgoingError, SyncedChatOutgoing } from './types'

const ACCOUNT = '0193b000-0000-7000-8000-00000000000a'
const DEVICE = '0193a000-0000-7000-8000-000000000001'
const OTHER_DEVICE = '0193a000-0000-7000-8000-000000000002'
const DIRECT = '31612345678@s.whatsapp.net'
const OTHER = '31687654321@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'
const NOW = Date.parse('2026-11-12T10:00:00Z')
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()
/** The server's Assert\Uuid (strict): version 1 to 8, variant 10xx. */
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** ChatIngestor::ID. */
const WA_ID = /^[\x21-\x7E]{1,128}$/

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
  | { kind: 'mediaClaim'; accountId: string; deviceId: string }
  | { kind: 'upload'; accountId: string; messageId: string; deviceId: string; sha256: string; content: string }
  | { kind: 'mediaFailed'; accountId: string; messageId: string; request: RelayMediaFailedRequest }

interface ClaimState {
  token: string
  device: string
  status: 'sending' | 'sent' | 'failed'
  error: ChatOutgoingError | null
}

/**
 * A fake server for the relay endpoints that follows the rules of the API: the device id is checked as Assert\Uuid
 * does (422 on `deviceId`), a message whose chat is neither in the call nor on the server is 422 on
 * `messages[i].chatJid`, a message with an id the server does not take is `refused` alone, a stored message is `known`
 * the second time, batches are limited (429 with Retry-After), and a result follows ChatQueue::report. Any endpoint can
 * be made to fail instead.
 */
class FakeChatApi implements ChatApi {
  readonly calls: Call[] = []
  readonly stored = new Set<string>()
  readonly chats = new Set<string>()
  relayDevice = DEVICE
  /** Batches the import limit still lets through; null for no limit. */
  batchesLeft: number | null = null
  /** Answers a batch instead of the fake's own rules when it returns a response or throws. */
  onMessages: ((request: RelayMessagesRequest, call: number) => RelayImportResponse | undefined) | null = null
  failClaim: unknown = null
  failResult: unknown = null
  claimable: RelayClaimResponse[] = []
  readonly claims = new Map<string, ClaimState>()
  mediaClaimable: RelayMediaClaimResponse[] = []
  /** Answers an upload with this error instead of storing it. */
  failUpload: unknown = null
  failMediaFailed: unknown = null
  failMediaClaim: unknown = null
  readonly replyFiles = new Map<string, string>()

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
  requestMedia(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }
  media(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }
  unscannedMediaLink(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }
  uploadFile(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }

  claimMedia(accountId: string, request: { deviceId: string }): Promise<RelayMediaClaimResponse | null> {
    this.calls.push({ kind: 'mediaClaim', accountId, deviceId: request.deviceId })
    if (this.failMediaClaim !== null) {
      return Promise.reject(this.failMediaClaim)
    }
    return this.guard(request.deviceId) ?? Promise.resolve(this.mediaClaimable.shift() ?? null)
  }

  async uploadMedia(accountId: string, messageId: string, request: RelayMediaUploadRequest): Promise<RelayMediaResponse> {
    this.calls.push({ kind: 'upload', accountId, messageId, deviceId: request.deviceId, sha256: request.sha256, content: await request.body.text() })
    if (this.failUpload !== null) {
      throw this.failUpload
    }
    await (this.guard(request.deviceId) ?? Promise.resolve())
    return { messageId, state: 'stored', error: null }
  }

  async failMedia(accountId: string, messageId: string, request: RelayMediaFailedRequest): Promise<RelayMediaResponse> {
    this.calls.push({ kind: 'mediaFailed', accountId, messageId, request })
    if (this.failMediaFailed !== null) {
      throw this.failMediaFailed
    }
    await (this.guard(request.deviceId) ?? Promise.resolve())
    return { messageId, state: 'failed', error: request.error }
  }

  replyFile(url: string): Promise<Blob> {
    const content = this.replyFiles.get(url)
    return content === undefined ? Promise.reject(new ChatApiError(404, 'Not found.')) : Promise.resolve(new Blob([content]))
  }

  relayStatus(accountId: string, request: RelayStatusRequest): Promise<{ relay: 'active' }> {
    this.calls.push({ kind: 'status', accountId, request })
    return this.guard(request.deviceId) ?? Promise.resolve({ relay: 'active' })
  }

  relayMessages(accountId: string, request: RelayMessagesRequest): Promise<RelayImportResponse> {
    // What a real client sends: the request as JSON.
    const sent = JSON.parse(JSON.stringify(request)) as RelayMessagesRequest
    this.calls.push({ kind: 'messages', accountId, request: sent })
    try {
      const answer = this.onMessages?.(sent, this.messageCalls().length)
      if (answer !== undefined) {
        return Promise.resolve(answer)
      }
    } catch (error) {
      return Promise.reject(error)
    }
    if (utf8(sent) > RELAY_MAX_BYTES) {
      return Promise.reject(new ChatApiError(413, 'Too large.', 'too_large'))
    }
    const guarded = this.guard(sent.deviceId)
    if (guarded !== null) {
      return guarded
    }
    if (this.batchesLeft !== null) {
      if (this.batchesLeft <= 0) {
        return Promise.reject(new ChatApiError(429, 'Too many batches at once.', null, 30_000))
      }
      this.batchesLeft -= 1
    }
    const violations: Record<string, string> = {}
    if (sent.messages.length > RELAY_MAX_MESSAGES) {
      violations.messages = 'Too many.'
    }
    if (sent.chats.length > RELAY_MAX_CHATS) {
      violations.chats = 'Too many.'
    }
    const named = new Set(sent.chats.map((relayed) => relayed.jid))
    sent.messages.forEach((message, i) => {
      if (!named.has(message.chatJid) && !this.chats.has(message.chatJid)) {
        violations[`messages[${i}].chatJid`] = 'This chat is neither in the request nor on the server.'
      }
    })
    if (Object.keys(violations).length > 0) {
      return Promise.reject(new ChatApiError(422, 'Validation failed.', null, null, violations))
    }
    const results: RelayMessageResult[] = sent.messages.map((message) => {
      if (!WA_ID.test(message.waId)) {
        return 'refused'
      }
      const key = `${message.chatJid}\n${message.waId}`
      if (this.stored.has(key)) {
        return 'known'
      }
      this.stored.add(key)
      this.chats.add(message.chatJid)
      return 'stored'
    })
    return Promise.resolve(counted(results))
  }

  claimReply(accountId: string, request: { deviceId: string }): Promise<RelayClaimResponse | null> {
    this.calls.push({ kind: 'claim', accountId, deviceId: request.deviceId })
    if (this.failClaim !== null) {
      return Promise.reject(this.failClaim)
    }
    const guarded = this.guard(request.deviceId)
    if (guarded !== null) {
      return guarded
    }
    const next = this.claimable.shift()
    if (next === undefined) {
      return Promise.resolve(null)
    }
    this.claims.set(next.id, { token: next.claimToken, device: request.deviceId, status: 'sending', error: null })
    return Promise.resolve(next)
  }

  /** As ChatQueue::report. */
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
    const wentOutAfterAll = request.sent && claim.status === 'failed' && claim.error === 'unconfirmed'
    if (theClaim && (fromRelay || request.sent) && (claim.status === 'sending' || wentOutAfterAll)) {
      claim.status = request.sent ? 'sent' : 'failed'
      claim.error = request.sent ? null : request.error
      return Promise.resolve(outgoingRow(outgoingId, claim))
    }
    if (request.sent ? claim.status === 'sent' : claim.status === 'failed' && claim.error === request.error) {
      return Promise.resolve(outgoingRow(outgoingId, claim))
    }
    return Promise.reject(fromRelay ? new ChatApiError(409, 'Final.', 'result_final') : notTheRelay())
  }

  messageCalls(): RelayMessagesRequest[] {
    return this.calls.flatMap((call) => (call.kind === 'messages' ? [call.request] : []))
  }

  /** ChatRelayGuard after RelayRequest's Assert\Uuid. */
  private guard(deviceId: string): Promise<never> | null {
    if (!STRICT_UUID.test(deviceId)) {
      return Promise.reject(new ChatApiError(422, 'Validation failed.', null, null, { deviceId: 'This is not a valid UUID.' }))
    }
    return deviceId === this.relayDevice ? null : Promise.reject(notTheRelay())
  }
}

function notTheRelay(): ChatApiError {
  return new ChatApiError(409, 'Another device relays this WhatsApp account now.', 'not_the_relay')
}

function counted(results: RelayMessageResult[]): RelayImportResponse {
  const count = (result: string) => results.filter((value) => value === result).length
  return { stored: count('stored'), known: count('known'), leftOut: count('left_out'), refused: count('refused'), results }
}

function outgoingRow(id: string, claim: ClaimState): SyncedChatOutgoing {
  return {
    id,
    chatId: 'c1',
    chatAccountId: ACCOUNT,
    text: 'Reply',
    status: claim.status,
    error: claim.error,
    createdAt: iso(-5),
    claimedAt: iso(-1),
    sentAt: claim.status === 'sent' ? iso(0) : null,
  }
}

describe('chatApiFailure', () => {
  it('reads the violation paths of either shape, never their messages', () => {
    expect(chatApiFailure(new ChatApiError(422, 'x', null, null, { 'messages[3].text': 'secret words are too long' }))).toEqual({
      status: 422,
      code: null,
      retryAfterMs: null,
      violationPaths: ['messages[3].text'],
    })
    expect(chatApiFailure({ status: 422, violations: [{ propertyPath: 'deviceId', message: 'm' }, { message: 'no path' }] })?.violationPaths).toEqual(['deviceId'])
    expect(chatApiFailure(new TypeError('Failed to fetch'))).toBeNull()
  })
})

describe('ServerChatBackend', () => {
  let store: SqliteMailStore
  let api: FakeChatApi
  let backend: ServerChatBackend
  let problems: ServerChatProblem[]

  const make = (extra: Partial<ConstructorParameters<typeof ServerChatBackend>[0]> = {}) =>
    new ServerChatBackend({ api, store, accountId: ACCOUNT, deviceId: DEVICE, importSince: NOW - 30 * 24 * 60 * 60_000, onProblem: (kind) => problems.push(kind), ...extra })

  beforeEach(async () => {
    store = await SqliteMailStore.open(await memorySql())
    await store.putChatAccount(chatAccount(ACCOUNT, { relayDeviceId: DEVICE, includeGroups: true }))
    api = new FakeChatApi()
    problems = []
    backend = make()
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
      expect(utf8(calls[0]) + utf8(calls[0]!.messages[0]) + 1).toBeGreaterThan(RELAY_MAX_BYTES)
    })

    it('counts UTF-8 bytes as TextEncoder does, also for escapes and lone surrogates', () => {
      for (const value of ['plain', 'é€😀', 'line\nbreak "quoted" \\', '\u0000\u001f', '\ud800 lone', 'pair 😀 \udc00']) {
        expect(relayBodyBytes({ value })).toBe(utf8({ value }))
      }
    })

    it('after a 413 makes the rest of the same call smaller, and keeps later calls below the size that got it', async () => {
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
      const first = Array.from({ length: 450 }, (_, i) => incoming(`A${i}`, DIRECT, { text }))

      expect(await backend.ingest([directChat(DIRECT)], first, false)).toEqual({ stored: 450, known: 0, leftOut: 0, refused: 0 })
      // Only the first batch is cut down; the batches after it are made at the lower size at once.
      expect(refusals).toBeLessThanOrEqual(4)
      refusals = 0
      const before = api.messageCalls().length

      const second = Array.from({ length: 200 }, (_, i) => incoming(`B${i}`, DIRECT, { text }))
      expect(await backend.ingest([directChat(DIRECT)], second, false)).toEqual({ stored: 200, known: 0, leftOut: 0, refused: 0 })

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
      expect(api.messageCalls().length).toBeLessThanOrEqual(10)
      expect(problems).toEqual(['row_refused'])
    })

    it('goes straight to the rows a 422 names, counts them refused and stores the rest', async () => {
      api.onMessages = (request) => {
        const index = request.messages.findIndex((message) => message.waId === 'BAD')
        if (index !== -1) {
          throw new ChatApiError(422, 'Validation failed.', null, null, { [`messages[${index}].text`]: 'This value is too long.' })
        }
        return undefined
      }
      const messages = Array.from({ length: 200 }, (_, i) => incoming(i === 77 ? 'BAD' : `M${i}`, i % 2 === 0 ? DIRECT : OTHER))

      const counts = await backend.ingest([directChat(DIRECT), directChat(OTHER)], messages, true)

      expect(counts).toEqual({ stored: 199, known: 0, leftOut: 0, refused: 1 })
      expect(api.messageCalls()).toHaveLength(2)
      expect(api.messageCalls().every((call) => call.firstImport)).toBe(true)
    })

    it('halves towards a row when the paths name none in the batch, within about 2 log2(n) calls', async () => {
      api.onMessages = (request) => {
        if (request.messages.some((message) => message.waId === 'BAD')) {
          // A path about a row, but an index this batch does not have (a server that numbers otherwise).
          throw new ChatApiError(422, 'Validation failed.', null, null, { 'messages[999].text': 'This value is too long.' })
        }
        return undefined
      }
      const messages = Array.from({ length: 200 }, (_, i) => incoming(i === 77 ? 'BAD' : `M${i}`, i % 2 === 0 ? DIRECT : OTHER))

      const counts = await backend.ingest([directChat(DIRECT), directChat(OTHER)], messages, false)

      expect(counts).toEqual({ stored: 199, known: 0, leftOut: 0, refused: 1 })
      expect(api.messageCalls().length).toBeLessThanOrEqual(2 + 2 * Math.ceil(Math.log2(200)))
      for (const call of api.messageCalls()) {
        expect(call.chats.map((relayed) => relayed.jid).sort()).toEqual([...new Set(call.messages.map((message) => message.chatJid))].sort())
      }
    })

    it('sends a chat the server refused as an entry without it; the messages of a chat it knows still go', async () => {
      api.chats.add(OTHER)
      api.onMessages = (request) => {
        const index = request.chats.findIndex((relayed) => relayed.jid === OTHER)
        if (index !== -1) {
          throw new ChatApiError(422, 'Validation failed.', null, null, { [`chats[${index}].kind`]: 'The kind does not match the chat.' })
        }
        return undefined
      }

      const counts = await backend.ingest([directChat(DIRECT), directChat(OTHER)], [incoming('A1', DIRECT), incoming('B1', OTHER)], false)

      expect(counts).toEqual({ stored: 2, known: 0, leftOut: 0, refused: 0 })
      expect(api.messageCalls()[1]!.chats.map((relayed) => relayed.jid)).toEqual([DIRECT])
    })

    it('rejects instead of refusing a message the server refuses only because its chat entry had to be left out', async () => {
      api.onMessages = (request) => {
        const index = request.chats.findIndex((relayed) => relayed.jid === OTHER)
        if (index !== -1) {
          throw new ChatApiError(422, 'Validation failed.', null, null, { [`chats[${index}].kind`]: 'The kind does not match the chat.' })
        }
        return undefined
      }

      // The fake's own rule then answers 422 on messages[1].chatJid: the client's doing, so nothing is passed over.
      const error: unknown = await backend.ingest([directChat(DIRECT), directChat(OTHER)], [incoming('A1', DIRECT), incoming('B1', OTHER)], false).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(ChatRelayImportStuck)
      expect(error).toMatchObject({ reason: 'chat_refused', refused: 1 })
      expect(api.stored.has(`${OTHER}\nB1`)).toBe(false)
      expect(problems).toEqual([])
    })

    it('sends a chat entry refused for its name alone again without a name', async () => {
      api.onMessages = (request) => {
        const index = request.chats.findIndex((relayed) => relayed.jid === OTHER && relayed.name !== null)
        if (index !== -1) {
          throw new ChatApiError(422, 'Validation failed.', null, null, { [`chats[${index}].name`]: 'This value is too long.' })
        }
        return undefined
      }

      const counts = await backend.ingest([directChat(DIRECT), directChat(OTHER, 'Bad name')], [incoming('A1', DIRECT), incoming('B1', OTHER)], false)

      expect(counts).toEqual({ stored: 2, known: 0, leftOut: 0, refused: 0 })
      expect(api.messageCalls()[1]!.chats).toEqual([
        { jid: DIRECT, name: 'Kim', kind: 'direct' },
        { jid: OTHER, name: null, kind: 'direct' },
      ])
    })

    it('rejects at once on a 422 with no paths, or one about the request rather than a row', async () => {
      api.onMessages = () => {
        throw new ChatApiError(422, 'Validation failed.')
      }
      const messages = Array.from({ length: 500 }, (_, i) => incoming(`M${i}`, DIRECT))
      await expect(backend.ingest([directChat(DIRECT)], messages, true)).rejects.toMatchObject({ status: 422 })
      expect(api.messageCalls()).toHaveLength(1)

      api.onMessages = () => {
        throw new ChatApiError(422, 'Validation failed.', null, null, { 'messages[0].text': 'x', deviceId: 'This is not a valid UUID.' })
      }
      await expect(backend.ingest([directChat(DIRECT)], messages, true)).rejects.toMatchObject({ status: 422 })
      expect(api.messageCalls()).toHaveLength(2)
      expect(problems).toEqual([])
    })

    it('stops with an error when more rows are refused than one ingest allows', async () => {
      const bad = new Set(['B1', 'B2', 'B3', 'B4'])
      api.onMessages = (request) => {
        const violations: Record<string, string> = {}
        request.messages.forEach((message, i) => {
          if (bad.has(message.waId)) {
            violations[`messages[${i}].text`] = 'This value is too long.'
          }
        })
        if (Object.keys(violations).length > 0) {
          throw new ChatApiError(422, 'Validation failed.', null, null, violations)
        }
        return undefined
      }
      const messages = Array.from({ length: 200 }, (_, i) => incoming(`M${i}`, DIRECT))
      messages[7] = incoming('B1', DIRECT)
      messages[57] = incoming('B2', DIRECT)
      messages[107] = incoming('B3', DIRECT)
      messages[157] = incoming('B4', DIRECT)

      const error: unknown = await backend.ingest([directChat(DIRECT)], messages, false).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ChatRelayImportStuck)
      expect(error).toMatchObject({ reason: 'too_many_refused', refused: 4 })
      expect(`${(error as Error).name} ${(error as Error).message}`).not.toMatch(/B1|31612345678/)
      expect(api.messageCalls()).toHaveLength(1)
    })

    it('tells of refused rows only when the ingest resolves, not for an attempt that rejected', async () => {
      let bad = ['B1', 'B2']
      api.onMessages = (request) => {
        const index = request.messages.findIndex((message) => bad.includes(message.waId))
        if (index !== -1) {
          throw new ChatApiError(422, 'Validation failed.', null, null, { [`messages[${index}].text`]: 'This value is too long.' })
        }
        return undefined
      }
      const messages = ['M1', 'B1', 'M2', 'B2'].map((waId) => incoming(waId, DIRECT))
      // One more refusal than allowed in the first attempt: rejected, nothing told.
      bad = ['B1', 'B2', 'M1', 'M2']
      await expect(backend.ingest([directChat(DIRECT)], messages, false)).rejects.toBeInstanceOf(ChatRelayImportStuck)
      expect(problems).toEqual([])
      expect(backend.problems.row_refused).toBe(0)

      bad = ['B1', 'B2']
      expect(await backend.ingest([directChat(DIRECT)], messages, false)).toMatchObject({ stored: 2, refused: 2 })
      expect(problems).toEqual(['row_refused', 'row_refused'])
      expect(backend.problems.row_refused).toBe(2)
    })

    it('cuts texts and names to 65,536 code points on a code point boundary', async () => {
      const long = '😀'.repeat(RELAY_MAX_FIELD + 1)
      const message = incoming('G1', GROUP, { text: long, sender: { id: '31611111111', name: long }, media: { kind: 'document', name: long, size: 1 } })

      await backend.ingest([{ jid: GROUP, name: long, kind: 'group' }], [message], false)

      const call = api.messageCalls()[0]!
      const sentFields = [call.messages[0]!.text, call.messages[0]!.sender!.name!, call.messages[0]!.media!.name!, call.chats[0]!.name!]
      for (const field of sentFields) {
        expect([...field]).toHaveLength(RELAY_MAX_FIELD)
        expect(field).toBe('😀'.repeat(RELAY_MAX_FIELD))
        expect(new TextEncoder().encode(field).length).toBe(4 * RELAY_MAX_FIELD)
      }
      // At the limit nothing is cut.
      await backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT, { text: 'é'.repeat(RELAY_MAX_FIELD) })], false)
      expect(api.messageCalls()[1]!.messages[0]!.text).toHaveLength(RELAY_MAX_FIELD)
    })

    it('rejects when everything is answered 422 about its first row, after a few calls', async () => {
      api.onMessages = () => {
        throw new ChatApiError(422, 'Validation failed.', null, null, { 'messages[0].text': 'This value is too long.' })
      }

      await expect(backend.ingest([directChat(DIRECT)], Array.from({ length: 500 }, (_, i) => incoming(`M${i}`, DIRECT)), false)).rejects.toBeInstanceOf(ChatRelayImportStuck)
      expect(api.messageCalls()).toHaveLength(RELAY_MAX_REFUSED + 1)
    })

    it('rejects when everything is answered 413, after a few calls', async () => {
      api.onMessages = () => {
        throw new ChatApiError(413, 'Too large.', 'too_large')
      }

      await expect(backend.ingest([directChat(DIRECT)], Array.from({ length: 500 }, (_, i) => incoming(`M${i}`, DIRECT)), false)).rejects.toBeInstanceOf(ChatRelayImportStuck)
      // Halving 200 to 1 takes 8 calls, then a single message per call until one more than allowed.
      expect(api.messageCalls().length).toBeLessThanOrEqual(8 + RELAY_MAX_REFUSED + 1)
    })

    it('sums the per-row results of the server', async () => {
      api.onMessages = (request) => counted(request.messages.map((_, i) => (['stored', 'known', 'left_out', 'refused'] as const)[i % 4]!))

      const counts = await backend.ingest([directChat(DIRECT)], Array.from({ length: 250 }, (_, i) => incoming(`M${i}`, DIRECT)), false)

      expect(counts).toEqual({ stored: 63, known: 63, leftOut: 62, refused: 62 })
    })

    it('counts a message the server refuses alone as refused, without limit', async () => {
      const counts = await backend.ingest(
        [directChat(DIRECT)],
        Array.from({ length: 10 }, (_, i) => incoming(i < 5 ? `bad id ${i}` : `M${i}`, DIRECT)),
        false,
      )

      expect(counts).toEqual({ stored: 5, known: 0, leftOut: 0, refused: 5 })
      expect(problems).toEqual([])
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

    it('throws ChatRelayRetryLater with the Retry-After on 429, and the longest pause on 403', async () => {
      api.batchesLeft = 0
      const error: unknown = await backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT)], false).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ChatRelayRetryLater)
      expect((error as ChatRelayRetryLater).retryAfterMs).toBe(30_000)

      api.onMessages = () => {
        throw new ChatApiError(429, 'Too many batches at once.')
      }
      const without: unknown = await backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT)], false).catch((caught: unknown) => caught)
      expect((without as ChatRelayRetryLater).retryAfterMs).toBe(RELAY_ERROR_DELAY)

      api.onMessages = () => {
        throw new ChatApiError(403, 'Access denied.')
      }
      const denied: unknown = await backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT)], false).catch((caught: unknown) => caught)
      expect((denied as ChatRelayRetryLater).retryAfterMs).toBe(RELAY_RETRY_MAX)
    })

    it('counts what an earlier ingest stored before a later batch failed as stored when the rows come again', async () => {
      api.batchesLeft = 1
      const messages = Array.from({ length: 450 }, (_, i) => incoming(`M${i}`, DIRECT))

      await expect(backend.ingest([directChat(DIRECT)], messages, false)).rejects.toBeInstanceOf(ChatRelayRetryLater)
      api.batchesLeft = null

      expect(await backend.ingest([directChat(DIRECT)], messages, false)).toEqual({ stored: 450, known: 0, leftOut: 0, refused: 0 })
      // Once counted, a repeat is known again.
      expect(await backend.ingest([directChat(DIRECT)], messages.slice(0, 10), false)).toEqual({ stored: 0, known: 10, leftOut: 0, refused: 0 })
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
      expect(api.messageCalls().length).toBe(6)
    })

    it('names no chat, number or text in the errors it makes', async () => {
      const errors: unknown[] = []
      api.relayDevice = OTHER_DEVICE
      errors.push(await backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT, { text: 'secret words' })], false).catch((caught: unknown) => caught))
      api.relayDevice = DEVICE
      api.onMessages = () => ({ stored: 5, known: 0, leftOut: 0, refused: 0, results: [] })
      errors.push(await backend.ingest([directChat(DIRECT)], [incoming('A1', DIRECT, { text: 'secret words' })], false).catch((caught: unknown) => caught))
      api.onMessages = () => {
        throw new ChatApiError(422, 'Validation failed.', null, null, { 'messages[0].text': 'x' })
      }
      errors.push(await backend.ingest([directChat(DIRECT)], Array.from({ length: 5 }, (_, i) => incoming(`S${i}`, DIRECT, { text: 'secret words' })), false).catch((caught: unknown) => caught))

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

      const another = make({ accountId: '0193b000-0000-7000-8000-00000000000b' })
      expect(await another.cursor()).toBeNull()

      await store.setChatMeta(serverClaimKey(ACCOUNT), '{"id":"r","token":"t","result":null}')
      await removeServerChatState(store, ACCOUNT)
      expect(await backend.cursor()).toBeNull()
      expect(await store.chatMeta(serverClaimKey(ACCOUNT))).toBeNull()
    })

    it('reads an unreadable cursor as none, so the store is read again as a first import', async () => {
      await store.setChatMeta(serverCursorKey(ACCOUNT), '{"rowid":"x"}')

      expect(await backend.cursor()).toBeNull()
    })
  })

  describe('files', () => {
    const asked: RelayMediaClaimResponse = { messageId: '0193d000-0000-7000-8000-000000000001', chatJid: DIRECT, waId: 'P1', kind: 'image', size: 12, maxBytes: 4096 }

    it('claims a file with this device and uploads it with its SHA-256', async () => {
      expect(await backend.claimMedia()).toBeNull()
      api.mediaClaimable = [asked]

      const request = await backend.claimMedia()
      expect(request).toEqual({ messageId: asked.messageId, chatJid: DIRECT, waId: 'P1', size: 12, maxBytes: 4096 })
      await backend.deliverMedia(request!, new Blob(['a photo']), 'abc')

      expect(api.calls).toEqual([
        { kind: 'mediaClaim', accountId: ACCOUNT, deviceId: DEVICE },
        { kind: 'mediaClaim', accountId: ACCOUNT, deviceId: DEVICE },
        { kind: 'upload', accountId: ACCOUNT, messageId: asked.messageId, deviceId: DEVICE, sha256: 'abc', content: 'a photo' },
      ])
    })

    it('ends the request when the server refuses the file, so the user sees why', async () => {
      const request = { messageId: asked.messageId, chatJid: DIRECT, waId: 'P1', size: 12, maxBytes: 4096 }
      api.failUpload = new ChatApiError(413, 'Too large.', 'too_large')
      await backend.deliverMedia(request, new Blob(['x']), 'abc')
      api.failUpload = new ChatApiError(422, 'Validation failed.', null, null, { file: '' })
      await backend.deliverMedia(request, new Blob(['x']), 'abc')

      expect(api.calls.filter((call) => call.kind === 'mediaFailed').map((call) => (call.kind === 'mediaFailed' ? call.request.error : null))).toEqual(['too_large', 'mismatch'])
    })

    it('passes over a file whose message is gone or that nobody asks for any more, and keeps relaying', async () => {
      const request = { messageId: asked.messageId, chatJid: DIRECT, waId: 'P1', size: 12, maxBytes: 4096 }
      api.failUpload = new ChatApiError(404, 'Not found.')
      await expect(backend.deliverMedia(request, new Blob(['x']), 'abc')).resolves.toBeUndefined()
      api.failUpload = new ChatApiError(409, 'Not requested.', 'not_requested')
      await expect(backend.deliverMedia(request, new Blob(['x']), 'abc')).resolves.toBeUndefined()
      api.failMediaFailed = new ChatApiError(404, 'Not found.')
      await expect(backend.failMedia(request, 'unavailable')).resolves.toBeUndefined()
    })

    it('stops when another device relays now, and waits when the server asks', async () => {
      const request = { messageId: asked.messageId, chatJid: DIRECT, waId: 'P1', size: 12, maxBytes: 4096 }
      api.relayDevice = OTHER_DEVICE
      await expect(backend.claimMedia()).rejects.toBeInstanceOf(ChatRelayStopped)
      await expect(backend.deliverMedia(request, new Blob(['x']), 'abc')).rejects.toBeInstanceOf(ChatRelayStopped)
      api.relayDevice = DEVICE
      api.failMediaClaim = new ChatApiError(429, 'Slow down.', null, 30_000)
      await expect(backend.claimMedia()).rejects.toBeInstanceOf(ChatRelayRetryLater)
      api.failUpload = new TypeError('Failed to fetch')
      await expect(backend.deliverMedia(request, new Blob(['x']), 'abc')).rejects.toBeInstanceOf(TypeError)
    })

    it('fetches the file a claimed reply carries through its signed link', async () => {
      api.replyFiles.set('https://api.example/content/chat-files/r1', '%PDF manual')
      api.claimable = [{ id: '0193c000-0000-7000-8000-000000000009', chatId: 'c1', chatJid: DIRECT, text: '', claimToken: 't', file: { name: 'manual.pdf', size: 11, url: 'https://api.example/content/chat-files/r1' } }]

      const claimed = await backend.claimNext()
      expect(claimed?.file).toEqual({ name: 'manual.pdf', size: 11, url: 'https://api.example/content/chat-files/r1' })
      expect(await (await backend.replyFile(claimed!)).text()).toBe('%PDF manual')
      await expect(backend.replyFile({ ...claimed!, file: null })).rejects.toThrow()
    })
  })

  describe('replies', () => {
    const reply: RelayClaimResponse = { id: '0193c000-0000-7000-8000-000000000001', chatId: 'c1', chatJid: DIRECT, text: 'On my way', claimToken: 'a'.repeat(32), file: null }

    it('claims one reply with this device and keeps its token for the result', async () => {
      expect(await backend.claimNext()).toBeNull()
      api.claimable = [reply]

      const claimed = await backend.claimNext()
      expect(claimed).toEqual({ id: reply.id, chatId: 'c1', chatJid: DIRECT, text: 'On my way', token: reply.claimToken, file: null })
      // Kept without its text until reported.
      expect(JSON.parse((await store.chatMeta(serverClaimKey(ACCOUNT)))!)).toEqual({ id: reply.id, token: reply.claimToken, result: null })
      await backend.report(claimed!, { sent: true })

      expect(api.calls).toEqual([
        { kind: 'claim', accountId: ACCOUNT, deviceId: DEVICE },
        { kind: 'claim', accountId: ACCOUNT, deviceId: DEVICE },
        { kind: 'result', accountId: ACCOUNT, outgoingId: reply.id, request: { deviceId: DEVICE, claimToken: reply.claimToken, sent: true, error: null } },
      ])
      expect(api.claims.get(reply.id)?.status).toBe('sent')
      expect(await store.chatMeta(serverClaimKey(ACCOUNT))).toBeNull()
    })

    it('reports a reply not sent with its error', async () => {
      api.claimable = [reply]
      const claimed = (await backend.claimNext())!

      await backend.report(claimed, { sent: false, error: 'not_linked' })

      expect(api.calls[api.calls.length - 1]).toMatchObject({ kind: 'result', request: { sent: false, error: 'not_linked', claimToken: reply.claimToken } })
      expect(api.claims.get(reply.id)).toMatchObject({ status: 'failed', error: 'not_linked' })
    })

    it('takes 404, 409 result_final and 422 on a result as final, and tells of a 422', async () => {
      api.claimable = [reply]
      const claimed = (await backend.claimNext())!
      await backend.report(claimed, { sent: true })
      await backend.report(claimed, { sent: true })
      await backend.report(claimed, { sent: false, error: 'refused' })
      await backend.report({ ...claimed, id: '0193c000-0000-7000-8000-0000000000ff' }, { sent: true })
      expect(problems).toEqual([])

      api.failResult = new ChatApiError(422, 'Validation failed.', null, null, { claimToken: 'This value is too long.' })
      await backend.report(claimed, { sent: true })

      expect(api.claims.get(reply.id)?.status).toBe('sent')
      expect(problems).toEqual(['result_refused'])
      expect(backend.problems).toEqual({ row_refused: 0, result_refused: 1 })
      expect(await store.chatMeta(serverClaimKey(ACCOUNT))).toBeNull()
    })

    it('a former relay may still report sent for its own claim, and stops on anything else', async () => {
      api.claimable = [reply, { ...reply, id: '0193c000-0000-7000-8000-000000000002', claimToken: 'b'.repeat(32) }]
      const sentOne = (await backend.claimNext())!
      // Reported (so the next claim is not held for it), then put back to `sending` on the fake: the result of this
      // claim is still open on the server when the takeover happens.
      await backend.report(sentOne, { sent: false, error: 'bridge_stopped' })
      api.claims.get(sentOne.id)!.status = 'sending'
      api.claims.get(sentOne.id)!.error = null
      const failedOne = (await backend.claimNext())!
      api.relayDevice = OTHER_DEVICE

      await backend.report(sentOne, { sent: true })
      expect(api.claims.get(sentOne.id)?.status).toBe('sent')

      await expect(backend.report(failedOne, { sent: false, error: 'bridge_stopped' })).rejects.toBeInstanceOf(ChatRelayStopped)
      expect(api.claims.get(failedOne.id)?.status).toBe('sending')

      await expect(backend.claimNext()).rejects.toBeInstanceOf(ChatRelayStopped)
    })

    it('rejects a result that failed by network, 5xx or 429, so the relay reports it again', async () => {
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
      expect(api.claims.get(reply.id)?.status).toBe('sent')
    })

    it('stops on a claim answered 404 or not_the_relay, waits on 429 and 403', async () => {
      api.failClaim = new ChatApiError(404, 'Chat account not found.')
      await expect(backend.claimNext()).rejects.toBeInstanceOf(ChatRelayStopped)
      api.failClaim = new ChatApiError(429, 'Slow down.', null, 2_000)
      await expect(backend.claimNext()).rejects.toMatchObject({ retryAfterMs: 2_000 })
      api.failClaim = new ChatApiError(403, 'Access denied.')
      await expect(backend.claimNext()).rejects.toMatchObject({ retryAfterMs: RELAY_RETRY_MAX })
    })

    describe('a crash between claim and result', () => {
      /** The same copy after a restart: a new backend that runs prepare. */
      const restart = async () => {
        const again = make()
        await again.prepare()
        return again
      }

      it('after the claim, before or during the send: reported as unconfirmed, and a later sent of that claim still wins', async () => {
        api.claimable = [reply]
        await backend.claimNext()

        await restart()

        expect(api.claims.get(reply.id)).toMatchObject({ status: 'failed', error: 'unconfirmed' })
        expect(await store.chatMeta(serverClaimKey(ACCOUNT))).toBeNull()
        // The server's rule: the send did go out after all.
        await api.reportReply(ACCOUNT, reply.id, { deviceId: DEVICE, claimToken: reply.claimToken, sent: true, error: null })
        expect(api.claims.get(reply.id)?.status).toBe('sent')
      })

      it('after the result was kept, before it was reported: the kept result is reported', async () => {
        api.claimable = [reply]
        const claimed = (await backend.claimNext())!
        api.failResult = new TypeError('Failed to fetch')
        await expect(backend.report(claimed, { sent: true })).rejects.toBeInstanceOf(TypeError)
        api.failResult = null

        await restart()

        expect(api.claims.get(reply.id)?.status).toBe('sent')
        expect(await store.chatMeta(serverClaimKey(ACCOUNT))).toBeNull()
      })

      it('after it was reported, before the claim was cleared: the repeat is final (200 or result_final)', async () => {
        api.claimable = [reply]
        const claimed = (await backend.claimNext())!
        await backend.report(claimed, { sent: true })
        await store.setChatMeta(serverClaimKey(ACCOUNT), JSON.stringify({ id: reply.id, token: reply.claimToken, result: { sent: true } }))

        await restart()
        expect(await store.chatMeta(serverClaimKey(ACCOUNT))).toBeNull()

        // A kept claim without a result for a reply that went out: `unconfirmed` is 409 result_final, also final.
        await store.setChatMeta(serverClaimKey(ACCOUNT), JSON.stringify({ id: reply.id, token: reply.claimToken, result: null }))
        await restart()
        expect(await store.chatMeta(serverClaimKey(ACCOUNT))).toBeNull()
        expect(api.claims.get(reply.id)?.status).toBe('sent')
      })

      it('keeps the claim when the report at start fails, so prepare tries again', async () => {
        api.claimable = [reply]
        await backend.claimNext()
        api.failResult = new ChatApiError(503, 'Unavailable.')

        await expect(make().prepare()).rejects.toMatchObject({ status: 503 })
        expect(await store.chatMeta(serverClaimKey(ACCOUNT))).not.toBeNull()
      })

      it('reports a kept claim before asking for the next reply', async () => {
        api.claimable = [reply, { ...reply, id: '0193c000-0000-7000-8000-000000000002', claimToken: 'b'.repeat(32) }]
        await backend.claimNext()

        const next = await backend.claimNext()

        expect(api.claims.get(reply.id)).toMatchObject({ status: 'failed', error: 'unconfirmed' })
        expect(JSON.parse((await store.chatMeta(serverClaimKey(ACCOUNT)))!)).toMatchObject({ id: next!.id, result: null })
      })
    })
  })

  describe('heartbeat', () => {
    it('reports the bridge with this device and stops when another device relays', async () => {
      await backend.reportStatus({ bridge: 'running', link: 'linked', linkedAt: iso(-60), loopbackOnly: true })
      expect(api.calls).toEqual([{ kind: 'status', accountId: ACCOUNT, request: { deviceId: DEVICE, bridge: 'running', link: 'linked', linkedAt: iso(-60), loopbackOnly: true } }])

      api.relayDevice = OTHER_DEVICE
      await expect(backend.reportStatus({ bridge: 'stopped', link: 'unknown', linkedAt: null, loopbackOnly: null })).rejects.toBeInstanceOf(ChatRelayStopped)
    })

    it('names the linked number when it knows it, and stops when the server says it is another', async () => {
      await backend.reportStatus({ bridge: 'running', link: 'linked', linkedAt: null, loopbackOnly: true, address: '31698765432' })
      await backend.reportStatus({ bridge: 'running', link: 'linked', linkedAt: null, loopbackOnly: true, address: null })
      expect(api.calls.map((call) => (call.kind === 'status' ? call.request.address : null))).toEqual(['31698765432', undefined])

      api.relayStatus = () => Promise.reject(new ChatApiError(409, 'Another number', 'other_number'))
      const error = await backend.reportStatus({ bridge: 'running', link: 'linked', linkedAt: null, loopbackOnly: true, address: '31611112222' }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ChatRelayOtherNumber)
      expect(error).toBeInstanceOf(ChatRelayStopped)
    })
  })

  describe('chats left out before the server knew them', () => {
    it('hands them over as left-out chats without names or messages, in the server form, inside the first import', async () => {
      const many = Array.from({ length: 250 }, (_, i) => `316${String(10_000_000 + i)}@s.whatsapp.net`)
      await backend.handOverLeftOut(['31612345678:3@S.whatsapp.net', 'not a jid', ...many, many[0]!])

      const calls = api.messageCalls()
      expect(calls.map((call) => [call.chats.length, call.messages.length])).toEqual([
        [200, 0],
        [51, 0],
      ])
      expect(calls[0]!.chats[0]).toEqual({ jid: '31612345678@s.whatsapp.net', name: null, kind: 'direct', leftOut: true })
      expect(calls.every((call) => call.firstImport)).toBe(true)

      api.relayDevice = OTHER_DEVICE
      await expect(backend.handOverLeftOut(['31612345678@s.whatsapp.net'])).rejects.toBeInstanceOf(ChatRelayStopped)
    })
  })

  it('refuses a device id the server would not take, and an import date that is not a time', () => {
    for (const deviceId of ['mac', '00000000-0000-0000-0000-000000000000', '0193a000-0000-0000-8000-000000000001', '0193a000-0000-7000-c000-000000000001', '0193a000-0000-9000-8000-000000000001']) {
      expect(() => make({ deviceId })).toThrow('not an RFC 4122 UUID')
    }
    expect(make({ deviceId: '0193A000-0000-4000-B000-000000000001' })).toBeInstanceOf(ServerChatBackend)
    expect(() => make({ importSince: Number.NaN })).toThrow('not a time')
  })

  describe('with the relay', () => {
    let rows: BridgeRow[]
    let storeId: string
    let sent: string[]
    let stopped: unknown[]
    let errors: unknown[]
    let progress: RelayProgress[]
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
      progress = []
      const bridge: ChatBridge = {
        read: (after: number, limit: number): Promise<BridgePage> =>
          Promise.resolve({ rows: rows.filter((candidate) => candidate.rowid > after).slice(0, limit), maxRowid: rows.reduce((max, candidate) => Math.max(max, candidate.rowid), 0), storeId }),
        names: () => Promise.resolve({}),
        send: (recipient: string, text: string) => {
          sent.push(`${recipient} ${text}`)
          return Promise.resolve({ ok: true })
        },
        download: () => Promise.resolve({ ok: false, error: 'not_found' }),
        file: () => Promise.reject(new Error('not used')),
        stage: () => Promise.reject(new Error('not used')),
        discard: () => Promise.resolve(),
      }
      relay = new ChatRelay({
        bridge,
        backend,
        now: () => NOW,
        schedule: () => () => undefined,
        onProgress: (value) => progress.push(value),
        onStopped: (reason) => stopped.push(reason),
        onError: (error) => errors.push(error),
      })
    })

    const page = (count: number) => Array.from({ length: count }, (_, i) => row(i + 1, `M${i + 1}`))

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

    it('keeps the cursor and drops nothing when the server refuses every batch as a whole', async () => {
      rows = page(500)
      api.onMessages = () => {
        throw new ChatApiError(422, 'Validation failed.')
      }
      await relay.pollNow()
      api.onMessages = () => {
        throw new ChatApiError(413, 'Too large.', 'too_large')
      }
      await relay.pollNow()

      expect(await backend.cursor()).toBeNull()
      expect(errors).toHaveLength(2)
      expect(api.messageCalls().length).toBeLessThanOrEqual(1 + 8 + RELAY_MAX_REFUSED + 1)

      api.onMessages = null
      await relay.pollNow()
      expect(api.stored.size).toBe(500)
      expect(await backend.cursor()).toMatchObject({ rowid: 500 })
    })

    it('keeps the cursor when four rows of a page are refused, and tells onError', async () => {
      rows = page(300)
      api.onMessages = (request) => {
        const violations: Record<string, string> = {}
        request.messages.forEach((message, i) => {
          if (['M10', 'M20', 'M30', 'M40'].includes(message.waId)) {
            violations[`messages[${i}].text`] = 'This value is too long.'
          }
        })
        if (Object.keys(violations).length > 0) {
          throw new ChatApiError(422, 'Validation failed.', null, null, violations)
        }
        return undefined
      }

      await relay.pollNow()

      expect(await backend.cursor()).toBeNull()
      expect(errors).toHaveLength(1)
      expect(errors[0]).toBeInstanceOf(ChatRelayImportStuck)
    })

    it('pauses on a 429 in the middle of a page, keeps the cursor, and counts the page once when it goes through', async () => {
      rows = page(450)
      api.batchesLeft = 1

      await relay.pollNow()
      expect(await backend.cursor()).toBeNull()
      expect(errors[0]).toBeInstanceOf(ChatRelayRetryLater)
      // A round that was asked to pause claims no reply.
      expect(api.calls.some((call) => call.kind === 'claim')).toBe(false)

      api.batchesLeft = null
      await relay.pollNow()

      expect(await backend.cursor()).toMatchObject({ rowid: 450 })
      expect(progress[progress.length - 1]).toMatchObject({ stored: 450, known: 0 })
      expect(api.stored.size).toBe(450)
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
      expect(progress[progress.length - 1]).toMatchObject({ stored: 4, known: 3 })
    })

    it('stops when another device took over, and sends the waiting replies one at a time otherwise', async () => {
      api.claimable = [{ id: '0193c000-0000-7000-8000-000000000001', chatId: 'c1', chatJid: DIRECT, text: 'First', claimToken: 't1', file: null }]
      await relay.pollNow()
      expect(sent).toEqual([`${DIRECT} First`])
      expect(api.claims.get('0193c000-0000-7000-8000-000000000001')?.status).toBe('sent')
      expect(await store.chatMeta(serverClaimKey(ACCOUNT))).toBeNull()

      api.relayDevice = OTHER_DEVICE
      rows = [row(1, 'A1')]
      await relay.pollNow()
      expect(stopped).toHaveLength(1)
      expect(stopped[0]).toBeInstanceOf(ChatRelayStopped)
      expect(relay.running).toBe(false)
    })
  })
})
