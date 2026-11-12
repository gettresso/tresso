import { CopyClosingError } from '../store/mailStore'
import { canonicalChatJid, chatKindOf, importable, importableChat, phoneLabel } from './format'
import type { BridgeRow, ChatKind, ChatMedia, ChatMediaKind, ChatOutgoingError, ChatSender } from './types'

/** Rows read from the bridge's store per round (the shell's maximum). */
export const RELAY_PAGE = 500
/** Pause between rounds. */
export const RELAY_INTERVAL = 3_000
/** Pause after a round in which a step failed. */
export const RELAY_ERROR_DELAY = 15_000
/** The shortest and longest pause a backend may ask for (ChatRelayRetryLater). */
export const RELAY_RETRY_MIN = 1_000
export const RELAY_RETRY_MAX = 10 * 60_000
/**
 * The first import ends once the store had no new rows for this long: after linking, the bridge's history sync streams
 * in over minutes, and all of it is history.
 */
export const FIRST_IMPORT_QUIET = 60_000
/** The first import ends at the latest this long after it began; rows after that are live. */
export const FIRST_IMPORT_MAX = 30 * 60_000
/** How long a sender without a known name waits before it is looked up again (contacts arrive after messages). */
export const NAME_RETRY = 5 * 60_000
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
  /** At most `limit` rows after `afterRowid`; null while the bridge writes to its store (the shell's `busy`). */
  read(afterRowid: number, limit: number): Promise<BridgePage | null>
  /** Names and numbers of sender ids (digits only, at most 500 a call); an id with nothing known may be left out. */
  names(ids: string[]): Promise<Record<string, SenderLookup>>
  /**
   * Sends a text. Resolves with what happened, `unconfirmed` when the bridge took the request but its answer was lost.
   * Rejects only when nothing went out (the shell refused the request before calling the bridge); no timeout of its
   * own may reject it.
   */
  send(recipient: string, text: string): Promise<BridgeSendResult>
}

/** The first import while it runs; times are epoch ms of the relay's clock. */
export interface FirstImport {
  /** The store's highest rowid as last seen: every row up to it is history. */
  through: number
  /** When the first import began; it ends FIRST_IMPORT_MAX after this at the latest. */
  startedAt: number
  /** When the store last grew (or this session took the import up); it ends FIRST_IMPORT_QUIET after this. */
  quietSince: number
}

/** Where the relay is in the bridge's store. */
export interface RelayCursor {
  /** The store the rowid belongs to (BridgePage.storeId). */
  storeId: string
  /** Every row up to this one was stored. */
  rowid: number
  /** Set while the first import runs; null once it ended. */
  firstImport: FirstImport | null
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
  /** Null for own messages and in direct chats. Its id is the user part of the sender's JID (digits). */
  sender: ChatSender | null
  text: string
  /** ISO 8601. */
  sentAt: string
  media: ChatMedia | null
}

/** What a backend did with the messages of one `ingest`, as the server's per-row results count them. */
export interface IngestCounts {
  /** Stored now (the local backend counts a message stored again here too: it cannot tell it apart cheaply). */
  stored: number
  /** Held already; nothing changed. */
  known: number
  /** Of a chat the user left out, or a group while groups are not brought in. */
  leftOut: number
  /** Refused as broken; the relay goes on. */
  refused: number
}

/** A reply the backend handed out to send; it is `sending` until its result is reported. */
export interface ClaimedReply {
  id: string
  chatId: string
  chatJid: string
  text: string
  /** Names this claim; the backend needs it back with the result (the server's claim token). */
  token: string
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
   * for messages of the first import, and once a call without it was made the first import is over.
   */
  ingest(chats: IncomingChat[], messages: IncomingMessage[], firstImport: boolean): Promise<IngestCounts>
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
    super('Asked to wait before the next round.')
    this.name = 'ChatRelayRetryLater'
  }
}

/** The step of a round an error came from. */
export type RelayStep = 'prepare' | 'read' | 'names' | 'store' | 'claim' | 'report'

/** Why a row of the bridge's store was not brought in. */
export type SkipReason = 'not_a_chat' | 'groups_off' | 'left_out' | 'before_import' | 'no_time' | 'bad_time' | 'bad_id' | 'nothing_to_show'

/** Counts only: what the relay brought in during this session. */
export interface RelayProgress {
  /** Chats that messages were handed over for. */
  chats: number
  /** As the backend counted them (IngestCounts), summed. */
  stored: number
  known: number
  leftOut: number
  refused: number
  /** Rows the relay itself did not hand over, by why. */
  skipped: Record<SkipReason, number>
  /** Whether the first import still runs. */
  firstImport: boolean
}

export interface ChatRelayOptions {
  bridge: ChatBridge
  backend: ChatBackend
  /** Epoch ms now: for the first import's timing, name lookups, and messages dated too far ahead. */
  now: () => number
  /** Runs `run` after `ms`; returns the function that cancels it. */
  schedule: (run: () => void, ms: number) => () => void
  /** After each round that read rows or changed the first import. */
  onProgress?: (progress: RelayProgress) => void
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

/** A pause a backend asked for, kept to a sane range; one that is no number gets the error pause. */
export function retryDelay(error: ChatRelayRetryLater): number {
  const ms = error.retryAfterMs
  return Number.isFinite(ms) ? Math.min(RELAY_RETRY_MAX, Math.max(RELAY_RETRY_MIN, ms)) : RELAY_ERROR_DELAY
}

/** A sender as the bridge stored it: the user part (live messages) or a whole JID (history sync). */
interface SenderAddress {
  /** The user part, without agent and device. */
  id: string
  /** What the JID says it is; null when the bridge stored the user part alone. */
  kind: 'lid' | 'phone' | null
}

/** `31612345678`, `31612345678:3@s.whatsapp.net` or `84932172912345@lid` to its user part; null when none is left. */
export function senderAddress(raw: string): SenderAddress | null {
  const at = raw.indexOf('@')
  const server = at === -1 ? null : raw.slice(at + 1).toLowerCase()
  const user = (at === -1 ? raw : raw.slice(0, at)).replace(/:[0-9]+$/, '').replace(/\.[0-9]+$/, '')
  if (!WA_ID.test(user)) {
    return null
  }
  return { id: user, kind: server === 'lid' ? 'lid' : server === 's.whatsapp.net' ? 'phone' : null }
}

function noSkips(): Record<SkipReason, number> {
  return { not_a_chat: 0, groups_off: 0, left_out: 0, before_import: 0, no_time: 0, bad_time: 0, bad_id: 0, nothing_to_show: 0 }
}

/**
 * Brings WhatsApp messages from the bridge's store to a backend and sends the replies the backend hands out. One relay
 * per account; its rounds never overlap: the next one is planned when one ends (RELAY_INTERVAL later, at once after a
 * full page, RELAY_ERROR_DELAY after an error, or what the backend asks for).
 *
 * Reading: by rowid from the cursor. The cursor moves only after the backend stored the rows, so a crash in between
 * reads them again, which the backend's idempotence makes harmless. A row the bridge stores again gets a higher rowid
 * and is read again the same way. A store that was replaced or renumbered (its id changed, or its highest rowid fell
 * below the cursor) is read again from 0. What is left out is decided before anything is stored, the way the server
 * decides it for "All my devices": chats that are not a direct chat or a group, groups when they are not brought in,
 * chats the user left out, messages before `importSince`, without a time or with one before 2009 or more than a day
 * ahead, without a WhatsApp id the server takes, or without anything to show. JIDs are passed on in one form
 * (canonicalChatJid), group senders as the user part of their JID.
 *
 * The first import: from the first read until the store had no new rows for FIRST_IMPORT_QUIET (the history sync after
 * linking streams in over minutes), and at most FIRST_IMPORT_MAX after it began. All of it goes to the backend as
 * `firstImport`; nothing goes as live before it ended. A restart during it measures the quiet time anew.
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
  /** Whether this session took up a first import an earlier one began (its quiet time is then measured anew). */
  private firstImportTakenUp = false
  /** Senders with a known name; kept for the session. */
  private readonly names = new Map<string, SenderLookup>()
  /** Senders without a known name: what was found, and when to ask again. */
  private readonly unnamed = new Map<string, { lookup: SenderLookup; retryAt: number }>()
  /** What the JIDs said a sender id is. */
  private readonly senderKinds = new Map<string, 'lid' | 'phone'>()
  /** Results sent but not reported yet, by reply id. */
  private readonly unreported = new Map<string, { reply: ClaimedReply; result: ReplyResult }>()
  private readonly handedChats = new Set<string>()
  private readonly progress: RelayProgress = { chats: 0, stored: 0, known: 0, leftOut: 0, refused: 0, skipped: noSkips(), firstImport: false }

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
        if (!(error instanceof CopyClosingError) && !(error instanceof ChatRelayStopped)) {
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
    let asked = false
    const failed = (error: unknown): boolean => {
      if (error instanceof ChatRelayStopped || error instanceof CopyClosingError) {
        this.state = 'stopped'
        this.cancel()
        this.options.onStopped?.(error)
        return true
      }
      this.options.onError?.(error, this.step)
      if (error instanceof ChatRelayRetryLater) {
        asked = true
        delay = Math.max(delay, retryDelay(error))
      } else {
        delay = Math.max(delay, RELAY_ERROR_DELAY)
      }
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
    // A backend that asked for a pause gets it whole: no replies are claimed from it in this round either.
    if (this.state === 'stopped' || asked) {
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
    const now = this.options.now()
    let rowid: number
    let firstImport: FirstImport | null
    let storeId = page.storeId
    if (saved === null) {
      rowid = 0
      firstImport = { through: page.maxRowid, startedAt: now, quietSince: now }
      this.firstImportTakenUp = true
    } else if (saved.storeId !== page.storeId || page.maxRowid < saved.rowid) {
      // Replaced or renumbered: the rowids read before mean nothing now. Everything is read again; what is stored
      // already stays as it is. A first import under way goes on in the new store.
      rowid = 0
      firstImport = saved.firstImport === null ? null : { ...saved.firstImport, through: 0 }
      if (saved.rowid !== 0) {
        page = await bridge.read(0, RELAY_PAGE)
        if (page === null) {
          return false
        }
        if (page.storeId !== storeId) {
          // Changed again in between: the next round starts over.
          return true
        }
      }
      storeId = page.storeId
    } else {
      rowid = saved.rowid
      firstImport = saved.firstImport === null ? null : { ...saved.firstImport }
    }

    if (firstImport !== null) {
      if (!this.firstImportTakenUp) {
        // Taken up after a restart: the bridge may only now be catching up, so the quiet time starts again.
        this.firstImportTakenUp = true
        firstImport.quietSince = now
      }
      if (page.maxRowid > firstImport.through) {
        firstImport.through = page.maxRowid
        firstImport.quietSince = now
      }
      if (now - firstImport.startedAt >= FIRST_IMPORT_MAX) {
        // Too long: what comes from here on is live, so a message that arrives later is never marked read.
        firstImport = null
      }
    }

    const rows = page.rows.filter((row) => row.rowid > rowid)
    const full = page.rows.length >= RELAY_PAGE
    const { chats, messages } = await this.incoming(rows, settings)
    if (messages.length > 0) {
      this.step = 'store'
      const counts = await backend.ingest(chats, messages, firstImport !== null)
      for (const chat of chats) {
        this.handedChats.add(chat.jid)
      }
      this.progress.chats = this.handedChats.size
      this.progress.stored += counts.stored
      this.progress.known += counts.known
      this.progress.leftOut += counts.leftOut
      this.progress.refused += counts.refused
    }
    const nextRowid = Math.max(rowid, rows[rows.length - 1]?.rowid ?? rowid)
    if (firstImport !== null && !full && nextRowid >= firstImport.through && now - firstImport.quietSince >= FIRST_IMPORT_QUIET) {
      // Caught up, and the store was quiet long enough: the history is in. Every later batch is live.
      firstImport = null
    }
    const next: RelayCursor = { storeId, rowid: nextRowid, firstImport }
    if (saved === null || JSON.stringify(next) !== JSON.stringify(saved)) {
      this.step = 'store'
      await backend.setCursor(next)
    }
    const firstImportChanged = (firstImport !== null) !== this.progress.firstImport
    this.progress.firstImport = firstImport !== null
    if (rows.length > 0 || firstImportChanged) {
      this.options.onProgress?.({ ...this.progress, skipped: { ...this.progress.skipped } })
    }
    return full
  }

  /** The rows Tresso takes, as the backend stores them; one message per chat and WhatsApp id (the newest row). */
  private async incoming(rows: BridgeRow[], settings: RelaySettings): Promise<{ chats: IncomingChat[]; messages: IncomingMessage[] }> {
    const latest = this.options.now() + AHEAD
    const skipped = this.progress.skipped
    const taken = new Map<string, { row: BridgeRow; jid: string; sentAt: number; media: ChatMedia | null; sender: SenderAddress | null }>()
    for (const row of rows) {
      const jid = canonicalChatJid(row.chatJid)
      const sentAt = row.sentAt
      const reason: SkipReason | null =
        jid === null || !importableChat(row.chatJid)
          ? 'not_a_chat'
          : !settings.includeGroups && chatKindOf(jid) === 'group'
            ? 'groups_off'
            : !importable(row.chatJid, settings.includeGroups, settings.leftOut)
              ? 'left_out'
              : !WA_ID.test(row.id)
                ? 'bad_id'
                : sentAt === null
                  ? 'no_time'
                  : !Number.isFinite(sentAt) || sentAt < EARLIEST || sentAt > latest
                    ? 'bad_time'
                    : sentAt < settings.importSince
                      ? 'before_import'
                      : null
      if (reason !== null || jid === null || sentAt === null) {
        skipped[reason ?? 'not_a_chat'] += 1
        continue
      }
      const media = mediaOf(row)
      if (row.text.trim() === '' && media === null) {
        // A row with nothing to show (a reaction or a kind of message the bridge keeps without content).
        skipped.nothing_to_show += 1
        continue
      }
      const sender = !row.fromMe && chatKindOf(jid) === 'group' ? senderAddress(row.sender) : null
      if (sender?.kind != null) {
        this.senderKinds.set(sender.id, sender.kind)
      }
      taken.set(`${jid}\n${row.id}`, { row, jid, sentAt, media, sender })
    }
    await this.lookUp([...taken.values()].flatMap(({ sender }) => (sender === null ? [] : [sender.id])))

    const chats = new Map<string, IncomingChat>()
    const messages: IncomingMessage[] = []
    for (const { row, jid, sentAt, media, sender } of taken.values()) {
      const chat = chats.get(jid)
      if (chat === undefined || (chat.name === null && row.chatName !== null)) {
        chats.set(jid, { jid, name: row.chatName, kind: chatKindOf(jid) })
      }
      messages.push({
        chatJid: jid,
        waId: row.id,
        fromMe: row.fromMe,
        sender: sender === null ? null : this.sender(sender.id),
        text: row.text,
        sentAt: new Date(sentAt).toISOString(),
        media,
      })
    }
    return { chats: [...chats.values()], messages }
  }

  /** Looks up sender ids without a known name: once per session for a name found, again after NAME_RETRY otherwise. */
  private async lookUp(ids: string[]): Promise<void> {
    const now = this.options.now()
    const due = [...new Set(ids)].filter((id) => SENDER_ID.test(id) && !this.names.has(id) && (this.unnamed.get(id)?.retryAt ?? 0) <= now)
    for (let start = 0; start < due.length; start += NAMES_PER_CALL) {
      const batch = due.slice(start, start + NAMES_PER_CALL)
      this.step = 'names'
      const found = await this.options.bridge.names(batch)
      for (const id of batch) {
        const raw = Object.prototype.hasOwnProperty.call(found, id) ? found[id] : undefined
        const lookup: SenderLookup = { number: raw?.number ?? null, name: raw?.name ?? null }
        if (lookup.name !== null && lookup.name.trim() !== '') {
          this.names.set(id, lookup)
          this.unnamed.delete(id)
        } else {
          this.unnamed.set(id, { lookup, retryAt: now + NAME_RETRY })
        }
      }
    }
  }

  /** A group sender with the name found, else the number with `+`, else no name. */
  private sender(id: string): ChatSender {
    const lookup = this.names.get(id) ?? this.unnamed.get(id)?.lookup
    const name = lookup !== undefined && lookup.name !== null && lookup.name.trim() !== '' ? lookup.name : null
    // What the JID said beats the shell's guess: a LID is no phone number, a phone JID is one.
    const kind = this.senderKinds.get(id)
    const number = kind === 'phone' ? id : kind === 'lid' && lookup?.number === id ? null : (lookup?.number ?? null)
    return { id, name: name ?? (number === null ? null : phoneLabel(number)) }
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

const MEDIA_KINDS: readonly string[] = ['image', 'video', 'audio', 'document'] satisfies ChatMediaKind[]

/** The file a row carries; a kind Tresso does not know is no file (its text is kept). */
function mediaOf(row: BridgeRow): ChatMedia | null {
  if (row.mediaType === null || !MEDIA_KINDS.includes(row.mediaType)) {
    return null
  }
  const size = row.fileLength
  return { kind: row.mediaType as ChatMediaKind, name: row.filename, size: size !== null && Number.isSafeInteger(size) && size >= 0 ? size : null }
}
