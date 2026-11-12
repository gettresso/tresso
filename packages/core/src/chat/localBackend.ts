import type { MailStore } from '../store/mailStore'
import { CHAT_REPLY_MAX, chatKindOf, replyText } from './format'
import { chatInstant } from './rows'
import { ChatRelayStopped, type ChatBackend, type ClaimedReply, type FirstImport, type IncomingChat, type IncomingMessage, type IngestCounts, type RelayCursor, type RelaySettings, type ReplyResult } from './relay'
import { LOCAL_CHAT_PREFIX, type SyncedChat, type SyncedChatAccount, type SyncedChatMessage, type SyncedChatOutgoing } from './types'

/** The chat account of the "Only this Mac" mode. */
export const LOCAL_CHAT_ACCOUNT = `${LOCAL_CHAT_PREFIX}account`
/** The chat value (MailStore.chatMeta) holding the relay's cursor in the bridge's store. */
export const LOCAL_CURSOR = 'cursor'

/** The id of the chat with this JID in the "Only this Mac" mode. */
export function localChatId(jid: string): string {
  return `${LOCAL_CHAT_PREFIX}${jid}`
}

/** The id of a message in the "Only this Mac" mode. */
export function localMessageId(jid: string, waId: string): string {
  return `${LOCAL_CHAT_PREFIX}${jid}:${waId}`
}

/** The JID of a local chat id; null for anything else (the account's own id has no `@`). */
function jidOf(chatId: string): string | null {
  return chatId.startsWith(LOCAL_CHAT_PREFIX) && chatId.includes('@') ? chatId.slice(LOCAL_CHAT_PREFIX.length) : null
}

export type LocalChatErrorCode = 'no_chat' | 'left_out' | 'empty' | 'too_long' | 'control' | 'not_found' | 'already_going_out' | 'not_failed' | 'not_a_time'

const ERROR_TEXTS: Record<LocalChatErrorCode, string> = {
  no_chat: 'The chat is not on this Mac.',
  left_out: 'The chat is left out.',
  empty: 'The reply is empty.',
  too_long: `The reply is longer than ${CHAT_REPLY_MAX} characters.`,
  control: 'The reply cannot contain control characters.',
  not_found: 'The reply is not on this Mac.',
  already_going_out: 'The reply is already going out.',
  not_failed: 'Only a reply that was not sent can be tried again.',
  not_a_time: 'A chat time is not a time.',
}

/** A local chat action was refused; nothing changed. The message names no chat and quotes no text. */
export class LocalChatError extends Error {
  constructor(readonly code: LocalChatErrorCode) {
    super(ERROR_TEXTS[code])
    this.name = 'LocalChatError'
  }
}

/*
 * Every write of local chat rows goes through one queue per copy: the relay's (store, claim, report) and the user's
 * (queue, cancel, retry, leave out). Each reads what it changes and writes it back with nothing in between, so a reply
 * cancelled while the relay claims it is either cancelled or sent, never both, and a chat left out while a page is
 * stored keeps none of it.
 */
const queues = new WeakMap<MailStore, Promise<unknown>>()

function serialized<T>(store: MailStore, task: () => Promise<T>): Promise<T> {
  const before = queues.get(store) ?? Promise.resolve()
  const result = before.then(task, task)
  queues.set(store, result.catch(() => undefined))
  return result
}

/** Raised by removeLocalChats: a backend made before it stops (ChatRelayStopped) instead of writing the rows again. */
const generations = new WeakMap<MailStore, number>()

export interface LocalChatConfig {
  includeGroups: boolean
  /** JIDs of chats the user left out. */
  leftOut: readonly string[]
  /** Epoch ms; older messages are not brought in (the connect moment less 30 days, kept in the config). */
  importSince: number
}

export interface LocalChatIdentity {
  /** The linked number, digits only; null while unknown. */
  number: string | null
  name: string | null
  deviceId: string
  deviceName: string
}

/**
 * The "Only this Mac" backend: chats, messages and replies in the copy on this device under the chat account
 * `wa:account` (see chatOnlyHere), with ids `wa:<jid>` and `wa:<jid>:<WhatsApp id>`. No request goes to the server.
 *
 * Stop the relay before removing the chats (removeLocalChats); a backend made before the removal refuses to write.
 */
export class LocalChatBackend implements ChatBackend {
  private config: LocalChatConfig
  private readonly generation: number
  private closed = false

  constructor(
    private readonly store: MailStore,
    config: LocalChatConfig,
    private readonly identity: LocalChatIdentity,
    private readonly now: () => number = Date.now,
  ) {
    this.config = { ...config, leftOut: [...config.leftOut] }
    this.generation = generations.get(store) ?? 0
  }

  /**
   * Takes a changed setting from the config. Save the config first: the relay reads what to leave out from here, and
   * the copy keeps a left-out chat's row (setLocalChatState) only as a second guard.
   */
  async configure(config: Partial<LocalChatConfig>): Promise<void> {
    this.config = { ...this.config, ...config, leftOut: [...(config.leftOut ?? this.config.leftOut)] }
    if (config.includeGroups !== undefined) {
      await this.locked(async () => {
        const account = await this.account()
        if (account !== null && account.includeGroups !== this.config.includeGroups) {
          await this.store.putChatAccount({ ...account, includeGroups: this.config.includeGroups })
        }
      })
    }
  }

  /** Writes nothing more; the relay using it stops at its next write. */
  close(): void {
    this.closed = true
  }

  /**
   * Makes the account row if it is missing (or brings its identity up to date), and settles every reply of this account
   * found `sending` (an earlier session was sending it): whether it went out cannot be known, so it becomes `failed`
   * with `unconfirmed` and only the user's Try again sends it.
   */
  prepare(): Promise<void> {
    return this.locked(async () => {
      const account = await this.account()
      const wanted: SyncedChatAccount = {
        id: LOCAL_CHAT_ACCOUNT,
        channel: 'whatsapp',
        address: this.identity.number,
        displayName: this.identity.name,
        relayDeviceId: this.identity.deviceId,
        relayDeviceName: this.identity.deviceName,
        relayOnline: true,
        relayOfflineSince: null,
        bridge: account?.bridge ?? 'running',
        link: account?.link ?? 'unknown',
        linkedAt: account?.linkedAt ?? null,
        loopbackOnly: account?.loopbackOnly ?? null,
        includeGroups: this.config.includeGroups,
        notify: account?.notify ?? false,
      }
      if (account === null || JSON.stringify(account) !== JSON.stringify({ ...account, ...wanted })) {
        await this.store.putChatAccount(account === null ? wanted : { ...account, ...wanted })
      }
      const sending = (await this.store.sendingOutgoingHere()).filter((row) => row.chatAccountId === LOCAL_CHAT_ACCOUNT)
      if (sending.length > 0) {
        // The claim stays on the row (claimedAt), so a `sent` the relay of that session still reports wins (see report).
        await this.store.putChatOutgoing(sending.map((row) => ({ ...row, status: 'failed', error: 'unconfirmed' })))
      }
    })
  }

  settings(): Promise<RelaySettings> {
    return Promise.resolve({ includeGroups: this.config.includeGroups, leftOut: new Set(this.config.leftOut), importSince: this.config.importSince })
  }

  /**
   * Stores messages by id (storing one again replaces it) and their chats: `lastMessageAt` only moves forward, an
   * existing chat keeps its name when none is given and its read and archive times. The first import marks a chat that
   * had nothing unread (made in this import, or read through its last message) read through its newest message, so
   * history does not arrive unread; a chat with unread messages, also one never read, stays as it is (as the server's
   * `ChatIngestor` does). A chat the copy holds as left out takes nothing (counted as left out).
   */
  ingest(chats: IncomingChat[], messages: IncomingMessage[], firstImport: boolean): Promise<IngestCounts> {
    return this.locked(async () => {
      let leftOut = 0
      const described = new Map(chats.map((chat) => [chat.jid, chat]))
      const byChat = new Map<string, IncomingMessage[]>()
      for (const message of messages) {
        byChat.set(message.chatJid, [...(byChat.get(message.chatJid) ?? []), message])
      }
      const rows: SyncedChatMessage[] = []
      const changed: SyncedChat[] = []
      for (const [jid, own] of byChat) {
        const existing = await this.store.chatByJid(LOCAL_CHAT_ACCOUNT, jid)
        if (existing?.leftOut === true) {
          leftOut += own.length
          continue
        }
        const chatId = localChatId(jid)
        let newest = existing === null ? Number.NEGATIVE_INFINITY : timeOf(existing.lastMessageAt)
        for (const message of own) {
          newest = Math.max(newest, chatInstant(message.sentAt, 'sentAt'))
          rows.push({
            id: localMessageId(jid, message.waId),
            chatId,
            chatAccountId: LOCAL_CHAT_ACCOUNT,
            waId: message.waId,
            fromMe: message.fromMe,
            sender: message.sender,
            text: message.text,
            sentAt: message.sentAt,
            mediaKind: message.media?.kind ?? null,
            mediaName: message.media?.name ?? null,
            mediaSize: message.media?.size ?? null,
          })
        }
        const lastMessageAt = new Date(newest).toISOString()
        const chat = described.get(jid)
        changed.push({
          id: chatId,
          chatAccountId: LOCAL_CHAT_ACCOUNT,
          jid,
          kind: chat?.kind ?? existing?.kind ?? chatKindOf(jid),
          name: chat?.name ?? existing?.name ?? null,
          lastMessageAt,
          readThrough: firstImport && nothingUnread(existing) ? lastMessageAt : (existing?.readThrough ?? null),
          archivedThrough: existing?.archivedThrough ?? null,
          leftOut: false,
        })
      }
      // Messages first: a crash in between leaves messages whose chat shows them once the page is read again, never a
      // chat that points at messages it does not have.
      if (rows.length > 0) {
        await this.store.putChatMessages(rows)
        await this.store.putChats(changed)
      }
      // Stored again or for the first time: the copy cannot tell them apart without reading every message back.
      return { stored: rows.length, known: 0, leftOut, refused: 0 }
    })
  }

  async cursor(): Promise<RelayCursor | null> {
    const value = await this.store.chatMeta(LOCAL_CURSOR)
    if (value === null) {
      return null
    }
    const cursor = readCursor(value)
    // A value this version cannot read: read the store again from 0, as live messages (what is stored stays).
    return cursor ?? { storeId: '', rowid: 0, firstImport: null }
  }

  setCursor(cursor: RelayCursor): Promise<void> {
    return this.locked(() => this.store.setChatMeta(LOCAL_CURSOR, JSON.stringify(cursor)))
  }

  /**
   * The oldest waiting reply of this account, marked `sending` in one write (a write that fails changes nothing), with
   * its claim time as the claim's token. Nothing is claimed while a reply of this account is `sending`: its result is
   * not recorded yet, and the next start settles it. A waiting reply whose chat id names no chat cannot be sent and
   * becomes `failed` with `refused`, so it holds up nothing.
   */
  claimNext(): Promise<ClaimedReply | null> {
    return this.locked(async () => {
      if ((await this.store.sendingOutgoingHere()).some((row) => row.chatAccountId === LOCAL_CHAT_ACCOUNT)) {
        return null
      }
      for (const row of (await this.store.waitingOutgoing()).filter((reply) => reply.chatAccountId === LOCAL_CHAT_ACCOUNT)) {
        const jid = jidOf(row.chatId)
        if (jid === null) {
          await this.store.putChatOutgoing([{ ...row, status: 'failed', error: 'refused' }])
          continue
        }
        const claimedAt = new Date(this.now()).toISOString()
        await this.store.putChatOutgoing([{ ...row, status: 'sending', error: null, claimedAt }])
        return { id: row.id, chatId: row.chatId, chatJid: jid, text: row.text, token: claimedAt }
      }
      return null
    })
  }

  /**
   * `sent` with `sentAt` (and the chat's `lastMessageAt` moved to it), or `failed` with the error. Only the claim that
   * is on the row takes a result, and only while the reply is `sending`, so reporting again changes nothing; except that
   * `sent` wins over `failed` with `unconfirmed` of the same claim (it did go out, and Try again would send it twice),
   * as the server's ChatQueue does.
   */
  report(reply: ClaimedReply, result: ReplyResult): Promise<void> {
    return this.locked(async () => {
      const row = await outgoingRow(this.store, reply.chatId, reply.id)
      const ownClaim = row !== null && row.claimedAt === reply.token
      const open = ownClaim && (row.status === 'sending' || (result.sent && row.status === 'failed' && row.error === 'unconfirmed'))
      if (row !== null && open) {
        if (result.sent) {
          const sentAt = new Date(this.now()).toISOString()
          await this.store.putChatOutgoing([{ ...row, status: 'sent', error: null, sentAt }])
          const chat = await this.store.chatByJid(LOCAL_CHAT_ACCOUNT, reply.chatJid)
          if (chat !== null && timeOf(chat.lastMessageAt) < Date.parse(sentAt)) {
            await this.store.putChats([{ ...chat, lastMessageAt: sentAt }])
          }
        } else {
          await this.store.putChatOutgoing([{ ...row, status: 'failed', error: result.error }])
        }
      }
    })
  }

  private locked<T>(task: () => Promise<T>): Promise<T> {
    return serialized(this.store, async () => {
      if (this.closed || (generations.get(this.store) ?? 0) !== this.generation) {
        throw new ChatRelayStopped('The chats on this Mac were removed.')
      }
      return task()
    })
  }

  private async account(): Promise<SyncedChatAccount | null> {
    return (await this.store.chatAccounts()).find((account) => account.id === LOCAL_CHAT_ACCOUNT) ?? null
  }
}

function readCursor(value: string): RelayCursor | null {
  try {
    const parsed = JSON.parse(value) as Partial<Record<keyof RelayCursor, unknown>>
    const firstImport = parsed.firstImport === null ? null : readFirstImport(parsed.firstImport)
    if (typeof parsed.storeId === 'string' && wholeNumber(parsed.rowid) && firstImport !== undefined) {
      return { storeId: parsed.storeId, rowid: parsed.rowid, firstImport }
    }
  } catch {
    // Not JSON.
  }
  return null
}

/** The first import of a stored cursor; undefined when it is not one. */
function readFirstImport(value: unknown): FirstImport | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const { through, ranFor, quietFor } = value as Partial<Record<keyof FirstImport, unknown>>
  return wholeNumber(through) && wholeNumber(ranFor) && wholeNumber(quietFor) ? { through, ranFor, quietFor } : undefined
}

function wholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Epoch ms of a stored time; a time that does not parse is the earliest. */
function timeOf(value: string): number {
  const at = Date.parse(value)
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at
}

/** Whether a chat had nothing unread before this import: new, or read through its last message. */
function nothingUnread(chat: SyncedChat | null): boolean {
  if (chat === null) {
    return true
  }
  return chat.readThrough !== null && timeOf(chat.readThrough) >= timeOf(chat.lastMessageAt)
}

/** The later of two times; `value` when `current` is null or does not parse. */
function later(current: string | null, value: string): string {
  return current !== null && timeOf(current) >= timeOf(value) ? current : value
}

async function outgoingRow(store: MailStore, chatId: string, id: string): Promise<SyncedChatOutgoing | null> {
  return (await store.chat(chatId))?.outgoing.find((row) => row.id === id) ?? null
}

/** The local chat with this id, or why not. */
async function localChat(store: MailStore, chatId: string): Promise<SyncedChat> {
  const jid = jidOf(chatId)
  const chat = jid === null ? null : await store.chatByJid(LOCAL_CHAT_ACCOUNT, jid)
  if (chat === null || chat.id !== chatId) {
    throw new LocalChatError('no_chat')
  }
  return chat
}

/**
 * Queues a reply in a local chat; the relay sends it. The text is checked and trimmed by `replyText`, the rule the
 * server's QueueReply holds too, and stored and sent trimmed. `id` is a UUIDv7 the caller made; queueing the same id
 * again returns the reply as stored.
 *
 * @throws LocalChatError `no_chat`, `left_out`, `empty`, `too_long`, `control`
 */
export function queueLocalReply(store: MailStore, chatId: string, text: string, id: string, now: number): Promise<SyncedChatOutgoing> {
  return serialized(store, async () => {
    const chat = await localChat(store, chatId)
    if (chat.leftOut) {
      throw new LocalChatError('left_out')
    }
    const checked = replyText(text)
    if (!checked.ok) {
      throw new LocalChatError(checked.problem)
    }
    const stored = await outgoingRow(store, chatId, id)
    if (stored !== null) {
      return stored
    }
    const row: SyncedChatOutgoing = {
      id,
      chatId,
      chatAccountId: LOCAL_CHAT_ACCOUNT,
      text: checked.text,
      status: 'waiting',
      error: null,
      createdAt: new Date(now).toISOString(),
      claimedAt: null,
      sentAt: null,
    }
    await store.putChatOutgoing([row])
    return row
  })
}

/**
 * Cancels a reply that waits or was not sent: it is kept as `cancelled`, which no list shows and the relay never
 * sends.
 *
 * @throws LocalChatError `no_chat`, `not_found`, `already_going_out` (being sent, or sent)
 */
export function cancelLocalReply(store: MailStore, chatId: string, id: string): Promise<SyncedChatOutgoing> {
  return serialized(store, async () => {
    await localChat(store, chatId)
    const row = await outgoingRow(store, chatId, id)
    if (row === null) {
      throw new LocalChatError('not_found')
    }
    if (row.status === 'cancelled') {
      return row
    }
    if (row.status !== 'waiting' && row.status !== 'failed') {
      throw new LocalChatError('already_going_out')
    }
    const cancelled: SyncedChatOutgoing = { ...row, status: 'cancelled' }
    await store.putChatOutgoing([cancelled])
    return cancelled
  })
}

/**
 * The user's Try again: a reply that was not sent waits again, its error cleared. The only way a reply whose send
 * could not be confirmed goes out again.
 *
 * @throws LocalChatError `no_chat`, `left_out`, `not_found`, `not_failed`
 */
export function retryLocalReply(store: MailStore, chatId: string, id: string): Promise<SyncedChatOutgoing> {
  return serialized(store, async () => {
    const chat = await localChat(store, chatId)
    if (chat.leftOut) {
      throw new LocalChatError('left_out')
    }
    const row = await outgoingRow(store, chatId, id)
    if (row === null) {
      throw new LocalChatError('not_found')
    }
    if (row.status !== 'failed') {
      throw new LocalChatError('not_failed')
    }
    const waiting: SyncedChatOutgoing = { ...row, status: 'waiting', error: null, claimedAt: null }
    await store.putChatOutgoing([waiting])
    return waiting
  })
}

export interface LocalChatState {
  /** Moves forward only; an earlier time is ignored. */
  readThrough?: string
  /** Moves forward only; null puts the chat back in the inbox. */
  archivedThrough?: string | null
  /**
   * True removes the chat's messages and replies and keeps the chat row, marked left out; false lets it be read again
   * from then on. Save the config's `leftOut` first (and give it to the backend, LocalChatBackend.configure): the
   * relay leaves out what the config says.
   */
  leftOut?: boolean
}

/**
 * Tresso's own state of a local chat; none of it reaches WhatsApp. Returns the chat as stored afterwards.
 *
 * @throws LocalChatError `no_chat`, `not_a_time`
 */
export function setLocalChatState(store: MailStore, chatId: string, change: LocalChatState): Promise<SyncedChat> {
  return serialized(store, async () => {
    const chat = await localChat(store, chatId)
    const checked = (value: string): string => {
      if (Number.isNaN(Date.parse(value))) {
        throw new LocalChatError('not_a_time')
      }
      return value
    }
    let next: SyncedChat = { ...chat }
    if (change.readThrough !== undefined) {
      next.readThrough = later(chat.readThrough, checked(change.readThrough))
    }
    if (change.archivedThrough !== undefined) {
      next.archivedThrough = change.archivedThrough === null ? null : later(chat.archivedThrough, checked(change.archivedThrough))
    }
    if (change.leftOut === true && !chat.leftOut) {
      next = { ...next, leftOut: true }
      // Marked first, so a crash before the removal leaves a chat no list shows and no import adds to; the removal
      // takes the messages and replies with the row, which is then written back.
      await store.putChats([next])
      await store.removeChat(chatId)
      await store.putChats([next])
      return next
    }
    if (change.leftOut === false) {
      next.leftOut = false
    }
    if (JSON.stringify(next) !== JSON.stringify(chat)) {
      await store.putChats([next])
    }
    return next
  })
}

/**
 * Removes the chats of the "Only this Mac" mode with the relay's values: on disconnect and when the account goes.
 * Stop the relay first; every LocalChatBackend made before refuses to write afterwards, so nothing comes back.
 */
export function removeLocalChats(store: MailStore): Promise<void> {
  generations.set(store, (generations.get(store) ?? 0) + 1)
  return serialized(store, async () => {
    await store.removeChatAccount(LOCAL_CHAT_ACCOUNT)
    await store.setChatMeta(LOCAL_CURSOR, null)
  })
}
