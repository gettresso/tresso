import type { MailStore } from '../store/mailStore'
import {
  RELAY_MAX_BYTES,
  RELAY_MAX_CHATS,
  RELAY_MAX_MESSAGES,
  chatApiFailure,
  type ChatApi,
  type RelayChat,
  type RelayMessage,
  type RelayMessagesRequest,
  type RelayResultRequest,
  type RelayStatusRequest,
} from './api'
import { readRelayCursor } from './localBackend'
import {
  ChatRelayRetryLater,
  ChatRelayStopped,
  RELAY_ERROR_DELAY,
  type ChatBackend,
  type ClaimedReply,
  type IncomingChat,
  type IncomingMessage,
  type IngestCounts,
  type RelayCursor,
  type RelaySettings,
  type ReplyResult,
} from './relay'

/** Before the account id in the chat value (MailStore.chatMeta) that holds this backend's cursor; see serverCursorKey. */
export const SERVER_CURSOR_PREFIX = 'server-cursor:'

/**
 * The chat value holding the cursor of the relay to the server account `accountId`. Apart from the local backend's
 * (LOCAL_CURSOR) and per account, so a switch between the modes, or to an account made again, starts from 0 with a
 * first import instead of going on from where the other one was.
 */
export function serverCursorKey(accountId: string): string {
  return `${SERVER_CURSOR_PREFIX}${accountId}`
}

/** Removes the cursor of a server account: when the account is removed, or this device no longer relays it. */
export function removeServerChatCursor(store: Pick<MailStore, 'setChatMeta'>, accountId: string): Promise<void> {
  return store.setChatMeta(serverCursorKey(accountId), null)
}

/** The smallest a batch is cut to after a 413 from something between the desktop and the API with a lower limit. */
export const RELAY_MIN_BATCH_BYTES = 64 * 1024

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ServerChatBackendOptions {
  api: ChatApi
  /** The copy on this device: the account and its chats come here through the delta. */
  store: MailStore
  /** The server's chat account this desktop relays. */
  accountId: string
  /** The UUID the desktop app made once for itself; every relay call names it. */
  deviceId: string
  /**
   * Epoch ms; older messages are not brought in. The server's account does not keep it, so it comes from the desktop's
   * config (the connect moment less 30 days), the same on a switch between the modes.
   */
  importSince: number
}

/**
 * The "All my devices" backend: the relay's messages go to the server (`relay/messages`), its replies come from the
 * server's queue (`relay/outgoing/claim` and `.../result`). Nothing is written to the copy but the cursor: the rows the
 * server stored come back through the delta, a chat's messages possibly a page before the chat.
 *
 * Batches: at most RELAY_MAX_MESSAGES messages and RELAY_MAX_CHATS chats, and at most RELAY_MAX_BYTES bytes of the
 * request as JSON in UTF-8, each with the chats of its messages. A 413 halves the batch, and lowers the size of the
 * batches made after it to half the request that got it (at least RELAY_MIN_BATCH_BYTES); a 422 (a request the server
 * cannot take as a whole, which the relay's own checks should prevent) halves it too, to find the message it is about. A single message that still gets
 * either is counted as refused and left: the server would never take it, and it must not hold the cursor. A batch of
 * n messages costs at most 2n - 1 calls this way (each message alone at the end), about 2 log2(n) for one bad message.
 *
 * Errors: 409 `not_the_relay` and 404 (the account is gone) reject with ChatRelayStopped, 429 with
 * ChatRelayRetryLater after Retry-After; anything else (network, 5xx, 400, 401, 403) rejects as it came, so the relay tries
 * the same rows again later. A message stored by a call before the one that failed is stored again as `known`.
 *
 * Reading the store again from 0 (its storeId changed: VACUUM, a store made again, or a history sync that stores its
 * first row again) sends every row again, and the server answers `known`: no write, no change for the delta. That is
 * accepted rather than avoided: `ingest` gets no rowids and the relay learns of a new storeId only after the rows are
 * stored, so a high-water mark per storeId would need a change of the relay; and a history sync stores the rows it
 * brings again under new rowids anyway, which are read again in any case. The cost is bounded: about 300 bytes per
 * message of JSON, so 100,000 messages are 500 calls and 30 MB once, within the import limit's burst of 1,200 calls;
 * 1,000,000 messages are 5,000 calls and 300 MB, which the limit (120 calls a minute after the burst) spreads over about
 * 30 minutes through 429 and Retry-After.
 *
 * Left out: the server's account in the copy says whether groups are taken; a chat the copy holds as left out (the
 * delta's `leftOut`) is looked up per chat of a batch (MailStore.chatByJid) and none of its messages leaves the device.
 */
export class ServerChatBackend implements ChatBackend {
  private readonly api: ChatApi
  private readonly store: MailStore
  private readonly accountId: string
  private readonly deviceId: string
  private readonly importSince: number
  /** Bytes a batch may have; lowered after a 413 of a batch below RELAY_MAX_BYTES. */
  private maxBytes = RELAY_MAX_BYTES
  /** Chats found left out in the copy; checked again at every `settings`, since the user can take one in again. */
  private readonly leftOut = new Set<string>()

  constructor(options: ServerChatBackendOptions) {
    if (!UUID.test(options.deviceId)) {
      // Every relay call would be refused as a whole (422), and bisecting would count every message refused.
      throw new Error('The device id is not a UUID.')
    }
    if (!Number.isSafeInteger(options.importSince) || options.importSince < 0) {
      throw new Error('The import date is not a time.')
    }
    this.api = options.api
    this.store = options.store
    this.accountId = options.accountId
    this.deviceId = options.deviceId
    this.importSince = options.importSince
  }

  /**
   * Nothing to put right here: a reply an earlier session claimed and could not report stays `sending` on the server,
   * which fails it as `unconfirmed` after 5 minutes (the sweep).
   */
  prepare(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * `includeGroups` from the server's account in the copy, `leftOut` the chats found left out in the copy (canonical
   * JIDs, as the server hands them back), `importSince` as given. Rejects while the account is not in the copy yet (the
   * relay tries again after its error pause).
   */
  async settings(): Promise<RelaySettings> {
    const account = (await this.store.chatAccounts()).find((candidate) => candidate.id === this.accountId)
    if (account === undefined) {
      throw new Error('The chat account is not on this device yet.')
    }
    for (const jid of [...this.leftOut]) {
      if ((await this.store.chatByJid(this.accountId, jid))?.leftOut !== true) {
        this.leftOut.delete(jid)
      }
    }
    return { includeGroups: account.includeGroups, leftOut: new Set(this.leftOut), importSince: this.importSince }
  }

  async ingest(chats: IncomingChat[], messages: IncomingMessage[], firstImport: boolean): Promise<IngestCounts> {
    const counts: IngestCounts = { stored: 0, known: 0, leftOut: 0, refused: 0 }
    for (const jid of new Set(messages.map((message) => message.chatJid))) {
      if ((await this.store.chatByJid(this.accountId, jid))?.leftOut === true) {
        this.leftOut.add(jid)
      }
    }
    const sendable = messages.filter((message) => !this.leftOut.has(message.chatJid))
    counts.leftOut += messages.length - sendable.length

    const described = new Map<string, Sized<RelayChat>>()
    for (const chat of chats) {
      if (!described.has(chat.jid)) {
        const value: RelayChat = { jid: chat.jid, name: chat.name, kind: chat.kind }
        described.set(chat.jid, { value, bytes: jsonBytes(value) })
      }
    }
    const items = sendable.map((message) => {
      const value = relayMessage(message)
      return { value, bytes: jsonBytes(value) }
    })
    for (const batch of this.batches(items, described, firstImport)) {
      await this.send(batch, described, firstImport, counts)
    }
    return counts
  }

  async cursor(): Promise<RelayCursor | null> {
    const value = await this.store.chatMeta(serverCursorKey(this.accountId))
    if (value === null) {
      return null
    }
    // A value this version cannot read: read the store again from 0, as live messages (the server answers `known`).
    return readRelayCursor(value) ?? { storeId: '', rowid: 0, firstImport: null }
  }

  setCursor(cursor: RelayCursor): Promise<void> {
    return this.store.setChatMeta(serverCursorKey(this.accountId), JSON.stringify(cursor))
  }

  /** The oldest waiting reply, now `sending` on the server for this device; its claim token goes back with the result. */
  async claimNext(): Promise<ClaimedReply | null> {
    let claimed
    try {
      claimed = await this.api.claimReply(this.accountId, { deviceId: this.deviceId })
    } catch (error) {
      throw relayError(error)
    }
    if (claimed === null) {
      return null
    }
    return { id: claimed.id, chatId: claimed.chatId, chatJid: claimed.chatJid, text: claimed.text, token: claimed.claimToken }
  }

  /**
   * Reports a claimed reply's result with its claim token. Final answers resolve, so the relay moves on and never sends
   * again: 404 (the reply or its chat is gone), 409 `result_final` (it has a result already, or the claim is no longer
   * this one), and 422 (the server will never take this result; the sweep fails the reply as `unconfirmed`). A
   * device that no longer relays the account may still report `sent: true` for its own claim, which the server takes;
   * any other result of it is 409 `not_the_relay`, which stops the relay. A network error or 5xx rejects as it came: the
   * relay reports the same result again later, without sending again.
   */
  async report(reply: ClaimedReply, result: ReplyResult): Promise<void> {
    const request: RelayResultRequest = result.sent
      ? { deviceId: this.deviceId, claimToken: reply.token, sent: true, error: null }
      : { deviceId: this.deviceId, claimToken: reply.token, sent: false, error: result.error }
    try {
      await this.api.reportReply(this.accountId, reply.id, request)
    } catch (error) {
      const failure = chatApiFailure(error)
      if (failure !== null && (failure.status === 404 || failure.status === 422 || (failure.status === 409 && failure.code === 'result_final'))) {
        return
      }
      throw relayError(error)
    }
  }

  /**
   * The heartbeat (`relay/status`), with the same errors as the relay's calls: ChatRelayStopped when another device
   * relays now or the account is gone, ChatRelayRetryLater on 429.
   */
  async reportStatus(status: Omit<RelayStatusRequest, 'deviceId'>): Promise<void> {
    try {
      await this.api.relayStatus(this.accountId, { deviceId: this.deviceId, bridge: status.bridge, link: status.link, linkedAt: status.linkedAt, loopbackOnly: status.loopbackOnly })
    } catch (error) {
      throw relayError(error)
    }
  }

  /** The messages in batches within the limits, in their order; a message too large alone is a batch of its own. */
  private batches(items: Sized<RelayMessage>[], described: Map<string, Sized<RelayChat>>, firstImport: boolean): Sized<RelayMessage>[][] {
    const base = jsonBytes(this.request([], [], firstImport))
    const batches: Sized<RelayMessage>[][] = []
    let batch: Sized<RelayMessage>[] = []
    let chats = new Set<string>()
    let bytes = base
    /** What adding the message to the batch adds: itself and its chat when new, each with a comma unless first. */
    const growth = (item: Sized<RelayMessage>): { bytes: number; chat: Sized<RelayChat> | undefined } => {
      const chat = chats.has(item.value.chatJid) ? undefined : described.get(item.value.chatJid)
      return { bytes: item.bytes + (batch.length > 0 ? 1 : 0) + (chat === undefined ? 0 : chat.bytes + (chats.size > 0 ? 1 : 0)), chat }
    }
    for (const item of items) {
      let adds = growth(item)
      const tooMany = batch.length >= RELAY_MAX_MESSAGES || chats.size + (adds.chat === undefined ? 0 : 1) > RELAY_MAX_CHATS
      if (batch.length > 0 && (tooMany || bytes + adds.bytes > this.maxBytes)) {
        batches.push(batch)
        batch = []
        chats = new Set()
        bytes = base
        adds = growth(item)
      }
      bytes += adds.bytes
      if (adds.chat !== undefined) {
        chats.add(item.value.chatJid)
      }
      batch.push(item)
    }
    if (batch.length > 0) {
      batches.push(batch)
    }
    return batches
  }

  /** Sends a batch, halving it on 413 and 422 down to single messages, which are then counted as refused. */
  private async send(batch: Sized<RelayMessage>[], described: Map<string, Sized<RelayChat>>, firstImport: boolean, counts: IngestCounts): Promise<void> {
    const messages = batch.map((item) => item.value)
    const chats: RelayChat[] = []
    for (const jid of new Set(messages.map((message) => message.chatJid))) {
      const chat = described.get(jid)
      if (chat !== undefined) {
        chats.push(chat.value)
      }
    }
    const request = this.request(chats, messages, firstImport)
    let response
    try {
      response = await this.api.relayMessages(this.accountId, request)
    } catch (error) {
      const failure = chatApiFailure(error)
      if (failure === null || (failure.status !== 413 && failure.status !== 422)) {
        throw relayError(error)
      }
      if (failure.status === 413 && batch.length > 1) {
        this.maxBytes = Math.max(RELAY_MIN_BATCH_BYTES, Math.min(this.maxBytes, Math.floor(jsonBytes(request) / 2)))
      }
      if (batch.length === 1) {
        counts.refused += 1
        return
      }
      const half = Math.ceil(batch.length / 2)
      await this.send(batch.slice(0, half), described, firstImport, counts)
      await this.send(batch.slice(half), described, firstImport, counts)
      return
    }
    const answered = [response.stored, response.known, response.leftOut, response.refused]
    if (!answered.every((count) => Number.isSafeInteger(count) && count >= 0) || answered.reduce((sum, count) => sum + count, 0) !== messages.length) {
      // Not what the server answers; the relay tries the rows again rather than count what it cannot tell.
      throw new Error('The server answered a batch with counts that do not add up.')
    }
    counts.stored += response.stored
    counts.known += response.known
    counts.leftOut += response.leftOut
    counts.refused += response.refused
  }

  private request(chats: RelayChat[], messages: RelayMessage[], firstImport: boolean): RelayMessagesRequest {
    return { deviceId: this.deviceId, firstImport, chats, messages }
  }
}

interface Sized<T> {
  value: T
  /** Of the value as JSON in UTF-8. */
  bytes: number
}

/** A message as the server takes it, with only the fields it knows. */
function relayMessage(message: IncomingMessage): RelayMessage {
  return {
    chatJid: message.chatJid,
    waId: message.waId,
    fromMe: message.fromMe,
    sender: message.sender === null ? null : { id: message.sender.id, name: message.sender.name },
    text: message.text,
    sentAt: message.sentAt,
    media: message.media === null ? null : { kind: message.media.kind, name: message.media.name, size: message.media.size },
  }
}

/** What the relay must do on a failed relay call; the error as it came when it is nothing the relay acts on. */
function relayError(error: unknown): unknown {
  const failure = chatApiFailure(error)
  if (failure === null) {
    return error
  }
  if (failure.status === 409 && failure.code === 'not_the_relay') {
    return new ChatRelayStopped('Another device relays WhatsApp now.')
  }
  if (failure.status === 404) {
    return new ChatRelayStopped('The WhatsApp account is no longer on the server.')
  }
  if (failure.status === 429) {
    return new ChatRelayRetryLater(failure.retryAfterMs ?? RELAY_ERROR_DELAY)
  }
  return error
}

/** Bytes of a value as JSON in UTF-8 (JSON.stringify escapes a lone surrogate, so every surrogate left is paired). */
export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value))
}

function utf8Bytes(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) {
      bytes += 1
    } else if (unit < 0x800) {
      bytes += 2
    } else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      i += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}
