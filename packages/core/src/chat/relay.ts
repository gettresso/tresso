import { CopyClosingError } from '../store/mailStore'
import { canonicalChatJid, chatKindOf, importable, phoneLabel } from './format'
import type { BridgeRow, ChatKind, ChatMedia, ChatMediaKind, ChatOutgoingError, ChatSender } from './types'

/** Rows read from the bridge's store per round (the shell's maximum). */
export const RELAY_PAGE = 500
/** Pause between rounds. */
export const RELAY_INTERVAL = 3_000
/** Pause after a round in which a step failed. */
export const RELAY_ERROR_DELAY = 15_000
/** Sender ids per name lookup (the shell's maximum). */
const NAMES_PER_CALL = 500
/** A sender id the shell can look up: digits only (a phone number or a LID), as `valid_sender_id` in whatsapp.rs. */
const SENDER_ID = /^[0-9]{1,32}$/
/** A WhatsApp id or a sender id as the server takes it: 1 to 128 visible ASCII characters (`ChatIngestor::ID`). */
const WA_ID = /^[\x21-\x7E]{1,128}$/
/** The earliest message time the server takes (`ChatTime`); older is a broken timestamp. */
const EARLIEST = Date.UTC(2009, 0, 1)
/** How far ahead of the clock a message time may be, as the server takes it. */
const AHEAD = 24 * 60 * 60 * 1000

/** One read of the bridge's store (see `whatsapp_read` in the desktop shell). */
export interface BridgePage {
  /** Rows after the rowid asked for, by rowid. */
  rows: BridgeRow[]
  /** The highest rowid in the store. */
  maxRowid: number
  /** Names the store and its numbering; when it changes, a rowid read before means nothing any more. */
  storeId: string
}

export interface SenderLookup {
  /** Digits only; null for an id not known to be a phone number. */
  number: string | null
  name: string | null
}

export type BridgeSendResult = { ok: true } | { ok: false; error: ChatOutgoingError }

/** The desktop shell's bridge commands the relay needs (apps/web/src/platform/whatsapp.ts adapts them). */
export interface ChatBridge {
  /** At most `limit` rows after `afterRowid`; null while the bridge writes to its store (the round reads nothing). */
  read(afterRowid: number, limit: number): Promise<BridgePage | null>
  /** Names and numbers of sender ids (digits only, at most 500 a call); an id with nothing known may be left out. */
  names(ids: string[]): Promise<Record<string, SenderLookup>>
  /**
   * Sends a text. Resolves with what happened, `unconfirmed` when the bridge took the request but its answer was lost.
   * Rejects only when nothing went out (the shell refused the request before calling the bridge).
   */
  send(recipient: string, text: string): Promise<BridgeSendResult>
}

/** Where the relay is in the bridge's store. */
export interface RelayCursor {
  /** The store the rowid belongs to (BridgePage.storeId). */
  storeId: string
  /** Every row up to this one was stored. */
  rowid: number
  /**
   * While the first import runs: the highest rowid it covers (the store's highest when it began); rows after it are
   * live. Null once it is done.
   */
  firstImportThrough: number | null
}

export interface IncomingChat {
  /** In the one form the server stores (canonicalChatJid). */
  jid: string
  /** The chat's name in the bridge's store; null when it has none. */
  name: string | null
  kind: ChatKind
}

export interface IncomingMessage {
  /** In the one form the server stores (canonicalChatJid). */
  chatJid: string
  /** WhatsApp's id of the message, unique within its chat. */
  waId: string
  fromMe: boolean
  /** Null for own messages and in direct chats. */
  sender: ChatSender | null
  text: string
  /** ISO 8601. */
  sentAt: string
  media: ChatMedia | null
}

/** A reply the backend handed out to send; it is `sending` until its result is reported. */
export interface ClaimedReply {
  id: string
  chatId: string
  chatJid: string
  text: string
  /** What the backend needs back with the result (the server's claim token); null when nothing. */
  token: string | null
}

export type ReplyResult = { sent: true } | { sent: false; error: ChatOutgoingError }

export interface RelaySettings {
  includeGroups: boolean
  /** JIDs of chats the user left out. */
  leftOut: ReadonlySet<string>
  /** Epoch ms; older messages are not brought in. */
  importSince: number
}

/**
 * Where the chats go: the copy on this device ("Only this Mac", LocalChatBackend) or the server ("All my devices").
 * A method that must stop the relay (another device relays now, the chats were removed) rejects with
 * ChatRelayStopped; one that asks for a pause rejects with ChatRelayRetryLater.
 */
export interface ChatBackend {
  /** Runs once before the first round: puts right what an earlier session left unfinished. */
  prepare(): Promise<void>
  settings(): Promise<RelaySettings>
  /**
   * Stores the messages and the chats they belong to; resolves once all of it is stored safely. Storing a message
   * again (same chat, same WhatsApp id) changes nothing, or updates it to the text given. `firstImport` is true only
   * for messages of the first import and never for a live one.
   */
  ingest(chats: IncomingChat[], messages: IncomingMessage[], firstImport: boolean): Promise<void>
  /** Null before the first import began. */
  cursor(): Promise<RelayCursor | null>
  setCursor(cursor: RelayCursor): Promise<void>
  /** The oldest reply waiting, already marked as being sent; null when none waits. */
  claimNext(): Promise<ClaimedReply | null>
  /** The outcome of sending a claimed reply. Reporting the same result again changes nothing. */
  report(reply: ClaimedReply, result: ReplyResult): Promise<void>
}

/** The relay must stop: another device relays now, or the chats were removed. */
export class ChatRelayStopped extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ChatRelayStopped'
  }
}

/** A backend asks the relay to pause before the next round (the server's Retry-After). */
export class ChatRelayRetryLater extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Asked to wait ${Math.round(retryAfterMs / 1000)} seconds.`)
    this.name = 'ChatRelayRetryLater'
  }
}

/** The step of a round an error came from. */
export type RelayStep = 'prepare' | 'read' | 'names' | 'store' | 'claim' | 'report'

export interface ChatRelayOptions {
  bridge: ChatBridge
  backend: ChatBackend
  /** Epoch ms now; a message more than a day ahead of it is not brought in. */
  now: () => number
  /** Runs `run` after `ms`; returns the function that cancels it. */
  schedule: (run: () => void, ms: number) => () => void
  /** After each round that stored something: chats and messages stored in this session. */
  onProgress?: (progress: { chats: number; messages: number }) => void
  /**
   * A step failed; the round goes on with the next part and the next round runs after RELAY_ERROR_DELAY. Errors the
   * relay makes carry no message text, names or JIDs; log the step and the error's name, not what a store or bridge
   * error may quote.
   */
  onError?: (error: unknown, step: RelayStep) => void
  /** The relay stopped by itself: the backend said so (ChatRelayStopped) or the copy is closing (CopyClosingError). */
  onStopped?: (reason: unknown) => void
}

type RelayState = 'idle' | 'running' | 'stopped'

/**
 * Brings WhatsApp messages from the bridge's store to a backend and sends the replies the backend hands out. One relay
 * per account; its rounds never overlap: the next one is planned when one ends (RELAY_INTERVAL later, at once after a
 * full page, RELAY_ERROR_DELAY after an error).
 *
 * Reading: by rowid from the cursor. The cursor moves only after the backend stored the rows, so a crash in between
 * reads them again, which the backend's idempotence makes harmless. A row the bridge stores again gets a higher rowid
 * and is read again the same way. A store that was replaced or renumbered (its id changed, or its highest rowid fell
 * below the cursor) is read again from 0. What is left out is decided before anything is stored, the way the server
 * decides it for "All my devices": chats that are not a direct chat or a group, groups when they are not brought in,
 * chats the user left out, messages before `importSince`, without a time or with one before 2009 or more than a day
 * ahead, without a WhatsApp id the server takes, or without anything to show. JIDs are passed on in one form
 * (canonicalChatJid).
 *
 * Sending: after each import, the waiting replies one at a time, oldest first: claim, send, report. A send is never
 * repeated by the relay: a result that could not be reported is kept and reported again first in the next round, and
 * a reply whose send was interrupted by a crash is the backend's to settle at the next start (`prepare`), as not sent.
 */
export class ChatRelay {
  private state: RelayState = 'idle'
  private cancelTimer: (() => void) | null = null
  private current: Promise<void> | null = null
  private prepared = false
  private step: RelayStep = 'prepare'
  private readonly names = new Map<string, SenderLookup>()
  /** Results sent but not reported yet, by reply id. */
  private readonly unreported = new Map<string, { reply: ClaimedReply; result: ReplyResult }>()
  private readonly storedChats = new Set<string>()
  private storedMessages = 0

  constructor(private readonly options: ChatRelayOptions) {}

  /** Whether rounds are planned (started and not stopped). */
  get running(): boolean {
    return this.state === 'running'
  }

  /** Starts the rounds; the first runs at once. Does nothing once started or stopped. */
  start(): void {
    if (this.state !== 'idle') {
      return
    }
    this.state = 'running'
    this.plan(0)
  }

  /**
   * Stops planning rounds and resolves once the round under way finished (a reply being sent is sent and reported
   * first), then tries once more to report what could not be reported. A stopped relay does not start again.
   */
  async stop(): Promise<void> {
    this.state = 'stopped'
    this.cancel()
    if (this.current !== null) {
      await this.current
    }
    if (this.unreported.size > 0) {
      try {
        await this.reportUnreported()
      } catch (error) {
        if (!(error instanceof CopyClosingError)) {
          this.options.onError?.(error, 'report')
        }
      }
    }
  }

  /**
   * One round (an import, then the waiting replies) after the round under way, if any; then the rounds go on as
   * planned. Before `start` it runs one round alone; after `stop` it does nothing.
   */
  async pollNow(): Promise<void> {
    if (this.current !== null) {
      await this.current
    }
    if (this.state === 'stopped') {
      return
    }
    this.cancel()
    await this.run()
  }

  private cancel(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private plan(ms: number): void {
    this.cancel()
    this.cancelTimer = this.options.schedule(() => {
      this.cancelTimer = null
      void this.run()
    }, ms)
  }

  /** Runs a round, or joins the one under way: never two at once. */
  private run(): Promise<void> {
    if (this.current !== null) {
      return this.current
    }
    const round = (async () => {
      let delay = RELAY_ERROR_DELAY
      try {
        delay = await this.round()
      } catch {
        // Only a callback of the options can throw here; the round itself catches every error.
      } finally {
        this.current = null
        if (this.state === 'running') {
          this.plan(delay)
        }
      }
    })()
    this.current = round
    return round
  }

  /** One round; returns the pause before the next. Never rejects. */
  private async round(): Promise<number> {
    let delay = RELAY_INTERVAL
    const failed = (error: unknown): boolean => {
      if (error instanceof ChatRelayStopped || error instanceof CopyClosingError) {
        this.state = 'stopped'
        this.cancel()
        this.options.onStopped?.(error)
        return true
      }
      this.options.onError?.(error, this.step)
      delay = Math.max(delay, error instanceof ChatRelayRetryLater ? error.retryAfterMs : RELAY_ERROR_DELAY)
      return false
    }
    if (!this.prepared) {
      this.step = 'prepare'
      try {
        await this.options.backend.prepare()
        this.prepared = true
      } catch (error) {
        failed(error)
        return delay
      }
    }
    try {
      if (await this.importPage()) {
        delay = 0
      }
    } catch (error) {
      if (failed(error)) {
        return delay
      }
    }
    if (this.state === 'stopped') {
      return delay
    }
    try {
      await this.sendWaiting()
    } catch (error) {
      failed(error)
    }
    return delay
  }

  /** Reads and stores one page; true when the page was full, so more rows wait. */
  private async importPage(): Promise<boolean> {
    const { bridge, backend } = this.options
    this.step = 'read'
    const settings = await backend.settings()
    const saved = await backend.cursor()
    let page = await bridge.read(saved?.rowid ?? 0, RELAY_PAGE)
    if (page === null) {
      return false
    }
    let cursor: RelayCursor
    if (saved === null) {
      cursor = { storeId: page.storeId, rowid: 0, firstImportThrough: page.maxRowid }
    } else if (saved.storeId !== page.storeId || page.maxRowid < saved.rowid) {
      // Replaced or renumbered: the rowids read before mean nothing now. Everything is read again; what is stored
      // already stays as it is. A first import under way goes on to the new store's end.
      cursor = { storeId: page.storeId, rowid: 0, firstImportThrough: saved.firstImportThrough === null ? null : page.maxRowid }
      if (saved.rowid !== 0) {
        page = await bridge.read(0, RELAY_PAGE)
        if (page === null) {
          return false
        }
        if (page.storeId !== cursor.storeId) {
          // Changed again in between: the next round starts over.
          return true
        }
        if (cursor.firstImportThrough !== null) {
          cursor.firstImportThrough = page.maxRowid
        }
      }
    } else {
      cursor = saved
    }

    const target = cursor.firstImportThrough
    const firstImport = target !== null
    const rows = page.rows.filter((row) => row.rowid > cursor.rowid && (target === null || row.rowid <= target))
    const last = rows[rows.length - 1]?.rowid ?? cursor.rowid
    const full = page.rows.length >= RELAY_PAGE
    const firstImportDone = firstImport && (!full || (page.rows[page.rows.length - 1]?.rowid ?? 0) >= target)

    const { chats, messages } = await this.incoming(rows, settings)
    if (messages.length > 0) {
      this.step = 'store'
      await backend.ingest(chats, messages, firstImport)
    }
    const next: RelayCursor = { storeId: cursor.storeId, rowid: Math.max(last, cursor.rowid), firstImportThrough: firstImport && !firstImportDone ? target : null }
    if (saved === null || next.storeId !== saved.storeId || next.rowid !== saved.rowid || next.firstImportThrough !== saved.firstImportThrough) {
      this.step = 'store'
      await backend.setCursor(next)
    }
    if (messages.length > 0) {
      for (const chat of chats) {
        this.storedChats.add(chat.jid)
      }
      this.storedMessages += messages.length
      this.options.onProgress?.({ chats: this.storedChats.size, messages: this.storedMessages })
    }
    return full
  }

  /** The rows Tresso takes, as the backend stores them; one message per chat and WhatsApp id (the newest row). */
  private async incoming(rows: BridgeRow[], settings: RelaySettings): Promise<{ chats: IncomingChat[]; messages: IncomingMessage[] }> {
    const latest = this.options.now() + AHEAD
    const taken = new Map<string, { row: BridgeRow; jid: string; sentAt: number; media: ChatMedia | null }>()
    for (const row of rows) {
      const sentAt = row.sentAt
      if (!WA_ID.test(row.id) || sentAt === null || !Number.isFinite(sentAt) || sentAt < EARLIEST || sentAt > latest || sentAt < settings.importSince) {
        continue
      }
      const jid = canonicalChatJid(row.chatJid)
      if (jid === null || !importable(row.chatJid, settings.includeGroups, settings.leftOut)) {
        continue
      }
      const media = mediaOf(row)
      if (row.text.trim() === '' && media === null) {
        // A row with nothing to show (a reaction or a kind of message the bridge keeps without content).
        continue
      }
      taken.set(`${jid}\n${row.id}`, { row, jid, sentAt, media })
    }
    const senders = [...taken.values()].filter(({ row }) => groupSender(row)).map(({ row }) => row.sender)
    await this.lookUp(senders)

    const chats = new Map<string, IncomingChat>()
    const messages: IncomingMessage[] = []
    for (const { row, jid, sentAt, media } of taken.values()) {
      const chat = chats.get(jid)
      if (chat === undefined || (chat.name === null && row.chatName !== null)) {
        chats.set(jid, { jid, name: row.chatName, kind: chatKindOf(jid) })
      }
      messages.push({
        chatJid: jid,
        waId: row.id,
        fromMe: row.fromMe,
        sender: groupSender(row) ? this.sender(row.sender) : null,
        text: row.text,
        sentAt: new Date(sentAt).toISOString(),
        media,
      })
    }
    return { chats: [...chats.values()], messages }
  }

  /** Looks up the sender ids not seen in this session, once each. */
  private async lookUp(ids: string[]): Promise<void> {
    const unknown = [...new Set(ids)].filter((id) => SENDER_ID.test(id) && !this.names.has(id))
    for (let start = 0; start < unknown.length; start += NAMES_PER_CALL) {
      const batch = unknown.slice(start, start + NAMES_PER_CALL)
      this.step = 'names'
      const found = await this.options.bridge.names(batch)
      for (const id of batch) {
        const lookup = Object.prototype.hasOwnProperty.call(found, id) ? found[id] : undefined
        this.names.set(id, { number: lookup?.number ?? null, name: lookup?.name ?? null })
      }
    }
  }

  /** A group sender with the name found, else the number with `+`, else no name. */
  private sender(id: string): ChatSender {
    const lookup = this.names.get(id)
    const name = lookup !== undefined && lookup.name !== null && lookup.name.trim() !== '' ? lookup.name : null
    const number = lookup !== undefined && lookup.number !== null ? phoneLabel(lookup.number) : null
    return { id, name: name ?? number }
  }

  /** Reports what is still unreported, then sends the waiting replies one by one until none waits or the relay stops. */
  private async sendWaiting(): Promise<void> {
    await this.reportUnreported()
    const { backend, bridge } = this.options
    while (this.state !== 'stopped') {
      this.step = 'claim'
      const reply = await backend.claimNext()
      if (reply === null) {
        return
      }
      // Claimed means `sending`: from here the reply is sent and its result kept until reported, also when the relay
      // is asked to stop meanwhile, so it never stays `sending` for a reply that was not sent.
      let result: ReplyResult
      try {
        const sent = await bridge.send(reply.chatJid, reply.text)
        result = sent.ok ? { sent: true } : { sent: false, error: sent.error }
      } catch {
        // The shell refused the request before the bridge was called (whatsapp_send in whatsapp.rs).
        result = { sent: false, error: 'refused' }
      }
      this.unreported.set(reply.id, { reply, result })
      await this.reportUnreported()
    }
  }

  private async reportUnreported(): Promise<void> {
    for (const [id, { reply, result }] of [...this.unreported]) {
      this.step = 'report'
      await this.options.backend.report(reply, result)
      this.unreported.delete(id)
    }
  }
}

/** A message of someone else in a group, the only kind that carries a sender (when its id is one the server takes). */
function groupSender(row: BridgeRow): boolean {
  return !row.fromMe && WA_ID.test(row.sender) && chatKindOf(row.chatJid) === 'group'
}

const MEDIA_KINDS: readonly string[] = ['image', 'video', 'audio', 'document'] satisfies ChatMediaKind[]

/** The file a row carries; a kind Tresso does not know is no file (its text is kept). */
function mediaOf(row: BridgeRow): ChatMedia | null {
  if (row.mediaType === null || !MEDIA_KINDS.includes(row.mediaType)) {
    return null
  }
  return { kind: row.mediaType as ChatMediaKind, name: row.filename, size: row.fileLength }
}
