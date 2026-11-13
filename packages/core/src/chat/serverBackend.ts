import type { MailStore } from '../store/mailStore'
import {
  RELAY_MAX_BYTES,
  RELAY_MAX_CHATS,
  RELAY_MAX_FIELD,
  RELAY_MAX_MESSAGES,
  chatApiFailure,
  type ChatApi,
  type ChatApiFailure,
  type RelayChat,
  type RelayImportResponse,
  type RelayMessage,
  type RelayMessagesRequest,
  type RelayResultRequest,
  type RelayStatusRequest,
} from './api'
import { canonicalChatJid, chatKindOf } from './format'
import { readRelayCursor } from './localBackend'
import {
  ChatRelayRetryLater,
  ChatRelayStopped,
  RELAY_ERROR_DELAY,
  RELAY_RETRY_MAX,
  type ChatBackend,
  type ClaimedReply,
  type IncomingChat,
  type IncomingMessage,
  type IngestCounts,
  type RelayCursor,
  type RelaySettings,
  type ReplyResult,
} from './relay'
import type { ChatOutgoingError } from './types'

/** Before the account id in the chat value (MailStore.chatMeta) that holds this backend's cursor; see serverCursorKey. */
export const SERVER_CURSOR_PREFIX = 'server-cursor:'
/** Before the account id in the chat value that holds the reply this backend claimed and has not reported yet. */
export const SERVER_CLAIM_PREFIX = 'server-claim:'

/**
 * The chat value holding the cursor of the relay to the server account `accountId`. Apart from the local backend's
 * (LOCAL_CURSOR) and per account, so a switch between the modes, or to an account made again, starts from 0 with a
 * first import instead of going on from where the other one was.
 */
export function serverCursorKey(accountId: string): string {
  return `${SERVER_CURSOR_PREFIX}${accountId}`
}

/** The chat value holding the claim of the relay to the server account `accountId` until its result is reported. */
export function serverClaimKey(accountId: string): string {
  return `${SERVER_CLAIM_PREFIX}${accountId}`
}

/**
 * Removes what this backend keeps for a server account (its cursor and an unreported claim): when the account is
 * removed, or this device no longer relays it. A claim left unreported is failed as `unconfirmed` by the server's sweep.
 */
export async function removeServerChatState(store: Pick<MailStore, 'setChatMeta'>, accountId: string): Promise<void> {
  await store.setChatMeta(serverCursorKey(accountId), null)
  await store.setChatMeta(serverClaimKey(accountId), null)
}

/** The smallest a batch is cut to after a 413 from something between the desktop and the API with a lower limit. */
export const RELAY_MIN_BATCH_BYTES = 64 * 1024
/**
 * The most messages one `ingest` may count as refused by isolating them after a 413 or 422. More than that is no bad
 * row but a cause that affects every row (a proxy, a newer server, a broken client): the call rejects, the cursor holds
 * and the relay tries again later, so a history is never dropped for it.
 */
export const RELAY_MAX_REFUSED = 3

/**
 * An `ingest` that cannot go on without passing messages over for a cause that is not theirs: more refusals than
 * RELAY_MAX_REFUSED (`too_many_refused`), or messages the server refuses only because their chat's entry had to be left
 * out (`chat_refused`). The cursor holds and the relay tries again later; the UI can show the import as stuck. It
 * carries counts only.
 */
export class ChatRelayImportStuck extends Error {
  constructor(
    readonly reason: 'too_many_refused' | 'chat_refused',
    /** Messages that would have been refused. */
    readonly refused: number,
  ) {
    super(reason === 'too_many_refused' ? 'The import is stuck: more messages were refused than one bad row explains.' : 'The import is stuck: the server refused a chat its messages need.')
    this.name = 'ChatRelayImportStuck'
  }
}

/**
 * The server says the bridge here is linked to another WhatsApp number than the account's (409 `other_number`): the relay
 * stops (a ChatRelayStopped) and the UI says why.
 */
export class ChatRelayOtherNumber extends ChatRelayStopped {
  constructor() {
    super('The bridge is linked to another WhatsApp number than the account.')
    this.name = 'ChatRelayOtherNumber'
  }
}

/** Problems the backend saw and went past; counts only, no content (ServerChatBackend.problems). */
export type ServerChatProblem = 'row_refused' | 'result_refused'

/** RFC 4122 as the server's strict Assert\Uuid takes it: version 1 to 8, variant 10xx. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** A violation path about one message or one chat of a batch, with the field it names (`messages[3].chatJid`). */
const ROW_PATH = /^(messages|chats)\[([0-9]+)\](?:\.([A-Za-z]+))?(?:[.[]|$)/

export interface ServerChatBackendOptions {
  api: ChatApi
  /** The copy on this device: the account and its chats come here through the delta. */
  store: MailStore
  /** The server's chat account this desktop relays. */
  accountId: string
  /** The RFC 4122 UUID the desktop app made once for itself, the one it connected with; every relay call names it. */
  deviceId: string
  /**
   * Epoch ms; older messages are not brought in. The server's account does not keep it, so it comes from the desktop's
   * config, set once at connect (the connect moment less 30 days) and passed unchanged: 0 uploads the whole history.
   */
  importSince: number
  /** Called for each problem the backend went past (see ServerChatProblem), for a log line without content. */
  onProblem?: (kind: ServerChatProblem) => void
}

interface ClaimRecord {
  id: string
  token: string
  /** Null until the relay has a result; a claim found without one may have been sent: `unconfirmed`. */
  result: ReplyResult | null
}

interface Item {
  value: RelayMessage
  /** Of the value as JSON in UTF-8. */
  bytes: number
  /** Chat JID and WhatsApp id. */
  key: string
}

/**
 * The "All my devices" backend: the relay's messages go to the server (`relay/messages`), its replies come from the
 * server's queue (`relay/outgoing/claim` and `.../result`). Nothing is written to the copy but the cursor and the
 * claim under way: the rows the server stored come back through the delta, a chat's messages possibly a page before the
 * chat.
 *
 * Batches: at most RELAY_MAX_MESSAGES messages and RELAY_MAX_CHATS chats, and at most RELAY_MAX_BYTES bytes of the
 * request as JSON in UTF-8, each with the chats of its messages. Texts and names are cut to RELAY_MAX_FIELD code points.
 * - 413: the batches left are made again at half the size of the request that got it (at least RELAY_MIN_BATCH_BYTES,
 *   and half as many messages), and stay that size for this backend; a single message still answered 413 is refused.
 * - 422 naming rows (`messages[i]...`, `chats[i]...`): the messages named are refused and the rest goes again. A chat
 *   entry named for its name alone goes again without a name; one named otherwise goes without its entry (the server
 *   may know the chat). A message then refused for want of that chat (`messages[i].chatJid`) is not passed over: the
 *   call rejects with ChatRelayImportStuck. Paths that name nothing in the batch: halved down to one message, which is
 *   refused. A 422 with no paths, or one naming anything else (`deviceId`), rejects as it came.
 * - At most RELAY_MAX_REFUSED messages are refused that way per `ingest`; one more rejects with ChatRelayImportStuck,
 *   so the cursor holds. A batch-wide cause therefore costs a few calls and drops nothing. What was refused is told
 *   (`row_refused`) only when the `ingest` resolves.
 *
 * Errors: 409 `not_the_relay` and 404 (the account is gone) reject with ChatRelayStopped, 429 with ChatRelayRetryLater
 * after Retry-After, 403 with ChatRelayRetryLater after RELAY_RETRY_MAX (the token lacks access; no point asking every
 * 15 seconds); anything else (network, 5xx, 400, 401) rejects as it came, so the relay tries the same rows again later.
 * Messages a call stored before a later call of the same `ingest` failed are stored again as `known`; the next `ingest`
 * still counts them as stored (kept in memory for the session).
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
  private readonly onProblem: ((kind: ServerChatProblem) => void) | undefined
  /** Bytes a batch may have; lowered after a 413 of a batch below RELAY_MAX_BYTES. */
  private maxBytes = RELAY_MAX_BYTES
  /** Chats found left out in the copy; checked again at every `settings`, since the user can take one in again. */
  private readonly leftOut = new Set<string>()
  /** Messages answered `stored` by an `ingest` that then failed: its repeat counts them as stored, not known. */
  private storedBefore = new Set<string>()
  /** What the backend went past, by kind. */
  readonly problems: Record<ServerChatProblem, number> = { row_refused: 0, result_refused: 0 }

  constructor(options: ServerChatBackendOptions) {
    if (!UUID.test(options.deviceId)) {
      // The server would refuse every relay call as a whole (422 on `deviceId`).
      throw new Error('The device id is not an RFC 4122 UUID.')
    }
    if (!Number.isSafeInteger(options.importSince) || options.importSince < 0) {
      throw new Error('The import date is not a time.')
    }
    this.api = options.api
    this.store = options.store
    this.accountId = options.accountId
    this.deviceId = options.deviceId
    this.importSince = options.importSince
    this.onProblem = options.onProblem
  }

  /**
   * Reports a claim an earlier session left: its recorded result, or `unconfirmed` when none was recorded (see report).
   * Rejects when that report fails for a reason worth trying again; the relay runs `prepare` again in its next round.
   */
  async prepare(): Promise<void> {
    await this.settleClaim()
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

    const described = new Map<string, { value: RelayChat; bytes: number }>()
    for (const chat of chats) {
      if (!described.has(chat.jid)) {
        const value: RelayChat = { jid: chat.jid, name: cutRelayField(chat.name), kind: chat.kind }
        described.set(chat.jid, { value, bytes: relayBodyBytes(value) })
      }
    }
    const items: Item[] = sendable.map((message) => {
      const value = relayMessage(message)
      return { value, bytes: relayBodyBytes(value), key: `${value.chatJid}\n${value.waId}` }
    })
    const storedNow: string[] = []
    try {
      const refused = await this.sendAll(items, described, firstImport, counts, storedNow)
      // Told only once nothing more can undo it: a rejected ingest passes nothing over.
      this.problem('row_refused', refused)
    } catch (error) {
      for (const key of storedNow) {
        this.storedBefore.add(key)
      }
      throw error
    }
    this.storedBefore = new Set()
    return counts
  }

  /**
   * The cursor; null before the first import began. A value this version cannot read is null too: the relay reads the
   * store from 0 as a first import. That is safe after the server's history import ended: it honours `firstImport`
   * only until the relay's first batch without it (ChatIngestor), so a stale flag marks nothing read; and before it
   * ended, it is what keeps the history from arriving unread.
   */
  async cursor(): Promise<RelayCursor | null> {
    const value = await this.store.chatMeta(serverCursorKey(this.accountId))
    return value === null ? null : readRelayCursor(value)
  }

  setCursor(cursor: RelayCursor): Promise<void> {
    return this.store.setChatMeta(serverCursorKey(this.accountId), JSON.stringify(cursor))
  }

  /**
   * The oldest waiting reply, now `sending` on the server for this device. The claim (id and token, no text) is kept in
   * the copy until its result is reported, so a crash cannot make it go out twice. Where a crash can fall:
   *
   * 1. After the server claimed it, before the claim is kept: nothing here knows it; the server's sweep fails it as
   *    `unconfirmed` after 5 minutes. It was not sent.
   * 2. After the claim is kept, before or while it is sent: `prepare` reports `unconfirmed` (it may have gone out);
   *    only the user's Try again sends it once more.
   * 3. After it was sent, before the result is kept: the same, `unconfirmed`. A `sent: true` of the same claim later
   *    still wins on the server.
   * 4. After the result is kept, before it is reported: `prepare` reports the kept result.
   * 5. After it was reported, before the claim is cleared: `prepare` reports it again; the server answers 200 (the
   *    same result) or 409 `result_final`, both final, and the claim is cleared.
   *
   * A claim still kept when another is asked for is reported first. The claim call itself is never repeated by this
   * backend: a repeated claim takes the next reply.
   */
  async claimNext(): Promise<ClaimedReply | null> {
    await this.settleClaim()
    let claimed
    try {
      claimed = await this.api.claimReply(this.accountId, { deviceId: this.deviceId })
    } catch (error) {
      throw relayError(error)
    }
    if (claimed === null) {
      return null
    }
    await this.keepClaim({ id: claimed.id, token: claimed.claimToken, result: null })
    return { id: claimed.id, chatId: claimed.chatId, chatJid: claimed.chatJid, text: claimed.text, token: claimed.claimToken }
  }

  /**
   * Keeps the result with the claim, then reports it with its claim token. Final answers resolve and clear the claim, so
   * the relay moves on and never sends again: 404 (the reply or its chat is gone), 409 `result_final` (it has a result
   * already, or the claim is no longer this one), and 422 (the server will never take this result; counted as
   * `result_refused`, and the sweep fails the reply as `unconfirmed`). A device that no longer relays the account may
   * still report `sent: true` for its own claim, which the server takes; any other result of it is 409
   * `not_the_relay`, which stops the relay. A network error or 5xx rejects as it came: the relay reports the same
   * result again later, without sending again.
   */
  async report(reply: ClaimedReply, result: ReplyResult): Promise<void> {
    await this.keepClaim({ id: reply.id, token: reply.token, result })
    await this.reportClaim(reply.id, reply.token, result)
  }

  /**
   * The heartbeat (`relay/status`), with the same errors as the relay's calls: ChatRelayStopped when another device
   * relays now or the account is gone, ChatRelayRetryLater on 429 and 403.
   */
  async reportStatus(status: Omit<RelayStatusRequest, 'deviceId'>): Promise<void> {
    const request: RelayStatusRequest = { deviceId: this.deviceId, bridge: status.bridge, link: status.link, linkedAt: status.linkedAt, loopbackOnly: status.loopbackOnly }
    if (status.address !== undefined && status.address !== null) {
      request.address = status.address
    }
    try {
      await this.api.relayStatus(this.accountId, request)
    } catch (error) {
      throw relayError(error)
    }
  }

  /**
   * Hands chats the user left out on this device to the server as left-out chats (no name, no messages), at most
   * RELAY_MAX_CHATS a call, so every relay leaves them out (RelayChat `leftOut`). Idempotent: one the server holds is
   * left as it is. JIDs go in the one form the server stores. Rejects as the other relay calls do.
   */
  async handOverLeftOut(jids: readonly string[]): Promise<void> {
    const chats: RelayChat[] = []
    for (const jid of new Set(jids)) {
      const canonical = canonicalChatJid(jid)
      if (canonical !== null) {
        chats.push({ jid: canonical, name: null, kind: chatKindOf(canonical), leftOut: true })
      }
    }
    for (let start = 0; start < chats.length; start += RELAY_MAX_CHATS) {
      try {
        // As part of the first import: a batch without it would end the server's history import (and the history would
        // arrive unread); with no messages it marks nothing read.
        await this.api.relayMessages(this.accountId, { deviceId: this.deviceId, firstImport: true, chats: chats.slice(start, start + RELAY_MAX_CHATS), messages: [] })
      } catch (error) {
        throw relayError(error)
      }
    }
  }

  private async settleClaim(): Promise<void> {
    const value = await this.store.chatMeta(serverClaimKey(this.accountId))
    if (value === null) {
      return
    }
    const record = readClaim(value)
    if (record === null) {
      // Not readable: no token to report with; the sweep fails the reply as `unconfirmed`.
      await this.store.setChatMeta(serverClaimKey(this.accountId), null)
      return
    }
    await this.reportClaim(record.id, record.token, record.result ?? { sent: false, error: 'unconfirmed' })
  }

  private keepClaim(record: ClaimRecord): Promise<void> {
    return this.store.setChatMeta(serverClaimKey(this.accountId), JSON.stringify(record))
  }

  private async reportClaim(id: string, token: string, result: ReplyResult): Promise<void> {
    const request: RelayResultRequest = result.sent
      ? { deviceId: this.deviceId, claimToken: token, sent: true, error: null }
      : { deviceId: this.deviceId, claimToken: token, sent: false, error: result.error }
    try {
      await this.api.reportReply(this.accountId, id, request)
    } catch (error) {
      const failure = chatApiFailure(error)
      const final = failure !== null && (failure.status === 404 || failure.status === 422 || (failure.status === 409 && failure.code === 'result_final'))
      if (!final) {
        throw relayError(error)
      }
      if (failure.status === 422) {
        this.problem('result_refused')
      }
    }
    // Cleared only when it is still this claim's (a later claim is never cleared by an earlier report).
    const kept = await this.store.chatMeta(serverClaimKey(this.accountId))
    if (kept !== null && readClaim(kept)?.id === id) {
      await this.store.setChatMeta(serverClaimKey(this.accountId), null)
    }
  }

  private problem(kind: ServerChatProblem, times = 1): void {
    this.problems[kind] += times
    for (let i = 0; i < times; i += 1) {
      this.onProblem?.(kind)
    }
  }

  /** Sends the messages in batches, in their order, as the class comment says. */
  /** Returns how many messages it refused itself. */
  private async sendAll(items: Item[], described: Map<string, { value: RelayChat; bytes: number }>, firstImport: boolean, counts: IngestCounts, storedNow: string[]): Promise<number> {
    let remaining = items
    /** Messages per batch: halved by a 413 at the smallest size, and while halving towards a row a 422 does not name. */
    let countLimit = RELAY_MAX_MESSAGES
    let halving = false
    /** Chats the server refused as entries; their messages go without them. */
    const withoutEntry = new Set<string>()
    let refusedHere = 0
    const refuse = (count: number): void => {
      if (refusedHere + count > RELAY_MAX_REFUSED) {
        throw new ChatRelayImportStuck('too_many_refused', refusedHere + count)
      }
      refusedHere += count
      counts.refused += count
    }

    while (remaining.length > 0) {
      const batch = this.firstBatch(remaining, described, withoutEntry, firstImport, countLimit)
      const request = this.request(chatsOf(batch, described, withoutEntry), batch.map((item) => item.value), firstImport)
      let response: RelayImportResponse
      try {
        response = await this.api.relayMessages(this.accountId, request)
      } catch (error) {
        const failure = chatApiFailure(error)
        if (failure?.status === 413) {
          if (batch.length === 1) {
            refuse(1)
            remaining = remaining.slice(1)
          } else {
            this.maxBytes = Math.max(RELAY_MIN_BATCH_BYTES, Math.min(this.maxBytes, Math.floor(relayBodyBytes(request) / 2)))
            countLimit = Math.min(countLimit, Math.ceil(batch.length / 2))
          }
          continue
        }
        if (failure?.status !== 422) {
          throw relayError(error)
        }
        const named = namedRows(failure, request)
        if (named === null) {
          // Nothing about a row, or something about the whole request: no row is to blame.
          throw error
        }
        if (named.messages.size > 0 || named.chats.size > 0) {
          // A message refused only for want of its chat, after that chat's entry was left out: the client's doing.
          const chatless = [...named.messages].filter(([index, field]) => field === 'chatJid' && withoutEntry.has(batch[index]!.value.chatJid))
          if (chatless.length > 0) {
            throw new ChatRelayImportStuck('chat_refused', chatless.length)
          }
          if (named.messages.size > 0) {
            refuse(named.messages.size)
            const bad = new Set([...named.messages.keys()].map((index) => batch[index]))
            remaining = remaining.filter((item) => !bad.has(item))
          }
          for (const [jid, fields] of named.chats) {
            const entry = described.get(jid)
            if (entry !== undefined && fields.size === 1 && fields.has('name') && entry.value.name !== null) {
              // Only its name: the entry goes again without one (the server keeps the name it has).
              const value: RelayChat = { ...entry.value, name: null }
              described.set(jid, { value, bytes: relayBodyBytes(value) })
            } else {
              withoutEntry.add(jid)
            }
          }
          continue
        }
        // Paths about rows that are not in this batch: find the row by halving.
        if (batch.length === 1) {
          refuse(1)
          remaining = remaining.slice(1)
          countLimit = RELAY_MAX_MESSAGES
          halving = false
        } else {
          countLimit = Math.ceil(batch.length / 2)
          halving = true
        }
        continue
      }
      this.tally(response, batch, counts, storedNow)
      remaining = remaining.slice(batch.length)
      if (halving) {
        // The half that went through is clean; the bad row is in what is left, which goes in halves again.
        countLimit = Math.max(1, Math.min(countLimit, Math.ceil(remaining.length / 2)))
      }
    }
    return refusedHere
  }

  /** Counts a batch's answer; a message stored by an earlier failed `ingest` counts as stored, not known. */
  private tally(response: RelayImportResponse, batch: Item[], counts: IngestCounts, storedNow: string[]): void {
    const answered = [response.stored, response.known, response.leftOut, response.refused]
    if (!answered.every((count) => Number.isSafeInteger(count) && count >= 0) || answered.reduce((sum, count) => sum + count, 0) !== batch.length) {
      // Not what the server answers; the relay tries the rows again rather than count what it cannot tell.
      throw new Error('The server answered a batch with counts that do not add up.')
    }
    let storedBefore = 0
    if (Array.isArray(response.results) && response.results.length === batch.length) {
      response.results.forEach((result, index) => {
        const key = batch[index]!.key
        if (result === 'stored') {
          storedNow.push(key)
        } else if (result === 'known' && this.storedBefore.has(key)) {
          storedBefore += 1
        }
      })
    }
    counts.stored += response.stored + storedBefore
    counts.known += response.known - storedBefore
    counts.leftOut += response.leftOut
    counts.refused += response.refused
  }

  /** The first batch of `items` within the limits; a message too large alone is a batch of its own. */
  private firstBatch(items: Item[], described: Map<string, { value: RelayChat; bytes: number }>, withoutEntry: Set<string>, firstImport: boolean, countLimit: number): Item[] {
    const batch: Item[] = []
    const chats = new Set<string>()
    let bytes = relayBodyBytes(this.request([], [], firstImport))
    for (const item of items) {
      const jid = item.value.chatJid
      const chat = chats.has(jid) || withoutEntry.has(jid) ? undefined : described.get(jid)
      // Itself and its chat when new, each with a comma unless first of its list.
      const adds = item.bytes + (batch.length > 0 ? 1 : 0) + (chat === undefined ? 0 : chat.bytes + (chats.size > 0 ? 1 : 0))
      const full = batch.length >= Math.min(countLimit, RELAY_MAX_MESSAGES) || chats.size + (chat === undefined ? 0 : 1) > RELAY_MAX_CHATS || bytes + adds > this.maxBytes
      if (batch.length > 0 && full) {
        break
      }
      bytes += adds
      if (chat !== undefined) {
        chats.add(jid)
      }
      batch.push(item)
    }
    return batch
  }

  private request(chats: RelayChat[], messages: RelayMessage[], firstImport: boolean): RelayMessagesRequest {
    return { deviceId: this.deviceId, firstImport, chats, messages }
  }
}

/** The chat entries of a batch: those of its messages, in order of first use, but those the server refused as entries. */
function chatsOf(batch: Item[], described: Map<string, { value: RelayChat }>, withoutEntry: Set<string>): RelayChat[] {
  const chats: RelayChat[] = []
  for (const jid of new Set(batch.map((item) => item.value.chatJid))) {
    const chat = withoutEntry.has(jid) ? undefined : described.get(jid)
    if (chat !== undefined) {
      chats.push(chat.value)
    }
  }
  return chats
}

/**
 * The rows a 422 names: message indexes and chat JIDs of the request. Null when it names no path, or one that is not
 * about a row (the device id, the request's shape): then no row is to blame.
 */
function namedRows(failure: ChatApiFailure, request: RelayMessagesRequest): { messages: Map<number, string>; chats: Map<string, Set<string>> } | null {
  if (failure.violationPaths.length === 0) {
    return null
  }
  /** Message index to the field named (the first, when several are). */
  const messages = new Map<number, string>()
  /** Chat JID to the fields named. */
  const chats = new Map<string, Set<string>>()
  for (const path of failure.violationPaths) {
    const match = ROW_PATH.exec(path)
    if (match === null) {
      return null
    }
    const index = Number(match[2])
    const field = match[3] ?? ''
    if (match[1] === 'messages' && index < request.messages.length) {
      if (!messages.has(index) || field === 'chatJid') {
        messages.set(index, field)
      }
    } else if (match[1] === 'chats' && index < request.chats.length) {
      const jid = request.chats[index]!.jid
      chats.set(jid, (chats.get(jid) ?? new Set()).add(field))
    }
  }
  return { messages, chats }
}

const OUTGOING_ERRORS: readonly string[] = ['bridge_stopped', 'not_linked', 'refused', 'unconfirmed'] satisfies ChatOutgoingError[]

function readClaim(value: string): ClaimRecord | null {
  try {
    const parsed = JSON.parse(value) as { id?: unknown; token?: unknown; result?: unknown }
    if (typeof parsed.id !== 'string' || typeof parsed.token !== 'string') {
      return null
    }
    const result = parsed.result as { sent?: unknown; error?: unknown } | null | undefined
    if (result === null || result === undefined) {
      return { id: parsed.id, token: parsed.token, result: null }
    }
    if (result.sent === true) {
      return { id: parsed.id, token: parsed.token, result: { sent: true } }
    }
    if (result.sent === false && typeof result.error === 'string' && OUTGOING_ERRORS.includes(result.error)) {
      return { id: parsed.id, token: parsed.token, result: { sent: false, error: result.error as ChatOutgoingError } }
    }
    return { id: parsed.id, token: parsed.token, result: null }
  } catch {
    return null
  }
}

/** A message as the server takes it, with only the fields it knows. */
function relayMessage(message: IncomingMessage): RelayMessage {
  return {
    chatJid: message.chatJid,
    waId: message.waId,
    fromMe: message.fromMe,
    sender: message.sender === null ? null : { id: message.sender.id, name: cutRelayField(message.sender.name) },
    text: cutRelayField(message.text),
    sentAt: message.sentAt,
    media: message.media === null ? null : { kind: message.media.kind, name: cutRelayField(message.media.name), size: message.media.size },
  }
}

/**
 * A text or name cut to RELAY_MAX_FIELD code points, on a code point boundary, as the server takes it. The shell cuts
 * in the store before decoding, and bytes that are not UTF-8 decode to more characters than it counted.
 */
export function cutRelayField<T extends string | null>(value: T): T {
  if (value === null || value.length <= RELAY_MAX_FIELD) {
    // UTF-16 units are never fewer than code points.
    return value
  }
  let points = 0
  for (let i = 0; i < value.length; i += 1) {
    if (points === RELAY_MAX_FIELD) {
      return value.slice(0, i) as T
    }
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < value.length && (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      i += 1
    }
    points += 1
  }
  return value
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
  if (failure.status === 409 && failure.code === 'other_number') {
    return new ChatRelayOtherNumber()
  }
  if (failure.status === 404) {
    return new ChatRelayStopped('The WhatsApp account is no longer on the server.')
  }
  if (failure.status === 429) {
    return new ChatRelayRetryLater(failure.retryAfterMs ?? RELAY_ERROR_DELAY)
  }
  if (failure.status === 403) {
    return new ChatRelayRetryLater(RELAY_RETRY_MAX)
  }
  return error
}

/** Bytes of a relay request (or a part of one) as JSON in UTF-8, as the ChatApi sends it. */
export function relayBodyBytes(value: unknown): number {
  const text = JSON.stringify(value)
  // JSON.stringify escapes a lone surrogate, so every surrogate left is one of a pair.
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
