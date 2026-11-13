import { chatKindOf } from './format'
import {
  LOCAL_CHAT_PREFIX,
  type BridgeState,
  type ChatKind,
  type ChatMessageKey,
  type ChatMediaKind,
  type ChatOutgoingError,
  type ChatOutgoingStatus,
  type LinkState,
  type SyncedChat,
  type SyncedChatAccount,
  type SyncedChatMessage,
  type SyncedChatOutgoing,
} from './types'

/**
 * Whether a chat row exists only on this device: one of a chat account whose id starts with `wa:` ("Only this Mac",
 * which keeps chats without the server). Takes the chat account id of the row: an account's own id, or the
 * `chatAccountId` of a chat, message or reply. Such rows outlive a rebuilt copy the way drafts that exist only here
 * do, since no sync brings them back.
 */
export function chatOnlyHere(chatAccountId: string): boolean {
  return chatAccountId.startsWith(LOCAL_CHAT_PREFIX)
}

/** A chat time can not be read. */
export class ChatTimeError extends Error {
  constructor(field: string) {
    // The value itself stays out of the message: errors are logged, and nothing of a chat goes to a log.
    super(`A chat row's ${field} is not a time.`)
    this.name = 'ChatTimeError'
  }
}

/**
 * Epoch ms of a chat row's time, for the stores' indexes, on the paths where this device writes the rows itself (the
 * "Only this Mac" relay): a time that does not parse there is a programming error, refused rather than stored in a
 * place it would sort wrong. Rows of the delta take {@link deltaInstant} instead.
 *
 * @throws ChatTimeError when it does not parse
 */
export function chatInstant(value: string, field: string): number {
  const at = Date.parse(value)
  if (Number.isNaN(at)) {
    throw new ChatTimeError(field)
  }
  return at
}

/** A message's place in its chat's order, as the stores keep it (deltaInstant: a time that does not parse is 0). */
export function chatMessageKey(message: Pick<SyncedChatMessage, 'sentAt' | 'id'>): ChatMessageKey {
  return { sentAt: deltaInstant(message.sentAt), id: message.id }
}

/** Keys oldest first: by time, equal times by id (compared as the stores compare text). */
export function compareChatMessageKeys(a: ChatMessageKey, b: ChatMessageKey): number {
  return a.sentAt - b.sentAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Messages oldest first; equal times by id. */
export function compareChatMessages(a: SyncedChatMessage, b: SyncedChatMessage): number {
  return Date.parse(a.sentAt) - Date.parse(b.sentAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Replies oldest first by when they were written; equal times by id (client UUIDv7s, which rise with time). */
export function compareChatOutgoing(a: SyncedChatOutgoing, b: SyncedChatOutgoing): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * Epoch ms of a chat time from the delta, for the stores' indexes: a time that is missing or does not parse becomes
 * 0, so the row is stored and sorts last instead of failing the page (and with it every later page, mail included).
 */
export function deltaInstant(value: string | null): number {
  const at = value === null ? Number.NaN : Date.parse(value)
  return Number.isNaN(at) ? 0 : at
}

/** Epoch ms of an optional time (`readThrough`, `archivedThrough`); null when it is missing or does not parse. */
export function optionalInstant(value: string | null): number | null {
  const at = value === null ? Number.NaN : Date.parse(value)
  return Number.isNaN(at) ? null : at
}

const CHAT_KINDS: readonly string[] = ['direct', 'group'] satisfies ChatKind[]
const BRIDGE_STATES: readonly string[] = ['running', 'stopped'] satisfies BridgeState[]
const LINK_STATES: readonly string[] = ['linked', 'unlinked', 'unknown'] satisfies LinkState[]
const MEDIA_KINDS: readonly string[] = ['image', 'video', 'audio', 'document'] satisfies ChatMediaKind[]
const OUTGOING_STATUSES: readonly string[] = ['waiting', 'sending', 'sent', 'failed', 'cancelled'] satisfies ChatOutgoingStatus[]
const OUTGOING_ERRORS: readonly string[] = ['bridge_stopped', 'not_linked', 'refused', 'unconfirmed'] satisfies ChatOutgoingError[]

type Raw<T> = { [K in keyof T]?: unknown }

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function flag(value: unknown, otherwise: boolean): boolean {
  return typeof value === 'boolean' ? value : otherwise
}

function size(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function oneOf<T extends string>(value: unknown, known: readonly string[], otherwise: T): T {
  return typeof value === 'string' && known.includes(value) ? (value as T) : otherwise
}

/*
 * The readers below take a chat row of the delta as it came and return what the stores keep, or null for a row that
 * cannot be stored (no id, no chat or account to hang it on, or a chat without a JID). What a newer server may send differently:
 * - a missing optional field becomes its "nothing" (null, or the default the API itself gives a new row);
 * - a missing time becomes '' (sorts last; the format functions treat it as no time);
 * - an unknown enum value becomes a safe known one, chosen so nothing acts on it wrongly: a chat kind follows its
 *   JID, a bridge is `stopped`, a link `unknown`, a file kind `document` (shown as a file with its name), a reply status
 *   `sending` (neither sent again nor offered to retry) and a reply error `refused`; an unknown channel is kept as it
 *   came, since mapping it to WhatsApp would be wrong.
 */

export function chatAccountFromDelta(raw: Raw<SyncedChatAccount>): SyncedChatAccount | null {
  const id = text(raw.id)
  if (id === null) {
    return null
  }
  return {
    id,
    channel: text(raw.channel) ?? 'whatsapp',
    address: text(raw.address),
    displayName: text(raw.displayName),
    relayDeviceId: text(raw.relayDeviceId) ?? '',
    relayDeviceName: text(raw.relayDeviceName) ?? '',
    relayOnline: flag(raw.relayOnline, false),
    relayOfflineSince: text(raw.relayOfflineSince),
    bridge: oneOf<BridgeState>(raw.bridge, BRIDGE_STATES, 'stopped'),
    link: oneOf<LinkState>(raw.link, LINK_STATES, 'unknown'),
    linkedAt: text(raw.linkedAt),
    loopbackOnly: typeof raw.loopbackOnly === 'boolean' ? raw.loopbackOnly : null,
    includeGroups: flag(raw.includeGroups, true),
    notify: flag(raw.notify, false),
  }
}

export function chatFromDelta(raw: Raw<SyncedChat>): SyncedChat | null {
  const id = text(raw.id)
  const chatAccountId = text(raw.chatAccountId)
  const jid = text(raw.jid)
  // Without a JID a chat is no chat, and stored under '' it would take the place of every other chat without one
  // (one chat per account and JID), removing them with their messages.
  if (id === null || chatAccountId === null || jid === null || jid === '') {
    return null
  }
  return {
    id,
    chatAccountId,
    jid,
    kind: oneOf<ChatKind>(raw.kind, CHAT_KINDS, chatKindOf(jid)),
    name: text(raw.name),
    lastMessageAt: text(raw.lastMessageAt) ?? '',
    readThrough: text(raw.readThrough),
    archivedThrough: text(raw.archivedThrough),
    leftOut: flag(raw.leftOut, false),
  }
}

export function chatMessageFromDelta(raw: Raw<SyncedChatMessage>): SyncedChatMessage | null {
  const id = text(raw.id)
  const chatId = text(raw.chatId)
  const chatAccountId = text(raw.chatAccountId)
  if (id === null || chatId === null || chatAccountId === null) {
    return null
  }
  const sender = raw.sender as { id?: unknown; name?: unknown } | null | undefined
  const senderId = typeof sender === 'object' && sender !== null ? text(sender.id) : null
  return {
    id,
    chatId,
    chatAccountId,
    waId: text(raw.waId) ?? '',
    fromMe: flag(raw.fromMe, false),
    sender: senderId === null ? null : { id: senderId, name: text(sender?.name) },
    text: text(raw.text) ?? '',
    sentAt: text(raw.sentAt) ?? '',
    mediaKind: raw.mediaKind === null || raw.mediaKind === undefined ? null : oneOf<ChatMediaKind>(raw.mediaKind, MEDIA_KINDS, 'document'),
    mediaName: text(raw.mediaName),
    mediaSize: size(raw.mediaSize),
  }
}

export function chatOutgoingFromDelta(raw: Raw<SyncedChatOutgoing>): SyncedChatOutgoing | null {
  const id = text(raw.id)
  const chatId = text(raw.chatId)
  const chatAccountId = text(raw.chatAccountId)
  if (id === null || chatId === null || chatAccountId === null) {
    return null
  }
  return {
    id,
    chatId,
    chatAccountId,
    text: text(raw.text) ?? '',
    status: oneOf<ChatOutgoingStatus>(raw.status, OUTGOING_STATUSES, 'sending'),
    error: raw.error === null || raw.error === undefined ? null : oneOf<ChatOutgoingError>(raw.error, OUTGOING_ERRORS, 'refused'),
    createdAt: text(raw.createdAt) ?? '',
    claimedAt: text(raw.claimedAt),
    sentAt: text(raw.sentAt),
  }
}
