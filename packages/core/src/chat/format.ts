import type {
  ChatKind,
  ChatMedia,
  ChatOutgoingError,
  SyncedChat,
  SyncedChatAccount,
  SyncedChatMessage,
  SyncedChatOutgoing,
} from './types'

/** How long after a reply was sent a stored own message with the same text counts as that reply. */
export const SENT_ECHO_WINDOW = 5 * 60 * 1000
/** How much earlier than the reply's `sentAt` its stored copy may be, for clocks that differ a little. */
export const SENT_ECHO_SKEW = 60 * 1000

/** C0 and C1 control characters other than tab, line feed and carriage return (those are whitespace below). */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
/**
 * Embeddings, overrides and isolates: they change the direction of the text after them and can reverse a whole row.
 * The marks (U+200E, U+200F, U+061C) are kept: they only keep punctuation in place in Hebrew and Arabic text.
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g
/** Characters that draw nothing: format characters and the Hangul fillers. */
const INVISIBLE = /[\p{Cf}\u115F\u1160\u3164\uFFA0]/gu
/** First strong isolate and pop directional isolate, around a name placed in a line of other text. */
const ISOLATE_START = '\u2068'
const ISOLATE_END = '\u2069'

/**
 * Text from WhatsApp made fit for one line of Tresso's own: control characters and direction overrides removed,
 * every run of whitespace (line breaks too) one space, trimmed. Every label below goes through it. Names and texts
 * come from other people, so a name cannot reverse or break the row it is shown in.
 */
export function labelText(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '').replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim()
}

/**
 * A name from WhatsApp as `labelText` makes it, or `''` when nothing of it would be visible (only zero width or
 * format characters, Hangul fillers). Invisible characters inside a visible name stay, so emoji joined with a zero
 * width joiner survive. Every label decides "has a name" through this.
 */
export function nameText(name: string | null): string {
  const text = labelText(name ?? '')
  return text.replace(INVISIBLE, '').trim() === '' ? '' : text
}

interface ChatAddress {
  kind: ChatKind
  user: string
  server: 's.whatsapp.net' | 'lid' | 'g.us'
}

/** `<user>[.<agent>][:<device>]@<server>`, compared in lower case. */
const JID = /^([0-9]+(?:-[0-9]+)?)(?:\.[0-9]+)?(?::[0-9]+)?@([a-z.]+)$/

/**
 * The chat a JID names, or null when it is not a chat Tresso takes. Direct chats are `<digits>@s.whatsapp.net`
 * (a phone number) and `<digits>@lid` (a hidden number); groups are `@g.us`. A device suffix (`123:4@...`) is
 * dropped. Status updates (`status@broadcast`), channels (`@newsletter`), bots (`@bot`), the server itself
 * (`0@s.whatsapp.net`), `@c.us`, `@hosted` and anything else are not chats.
 */
function chatAddress(jid: string): ChatAddress | null {
  const match = JID.exec(jid.toLowerCase())
  if (match === null) {
    return null
  }
  const user = match[1]!
  const server = match[2]!
  if (/^0+$/.test(user.replace('-', ''))) {
    return null
  }
  if (server === 'g.us') {
    return { kind: 'group', user, server }
  }
  if ((server === 's.whatsapp.net' || server === 'lid') && /^[0-9]+$/.test(user)) {
    return { kind: 'direct', user, server }
  }
  return null
}

/** Whether a JID names a direct chat or a group, the only chats Tresso takes. */
export function importableChat(jid: string): boolean {
  return chatAddress(jid) !== null
}

/**
 * The one form a chat's JID is kept in, as the server stores it (`App\Chat\ChatJid`): lower case, without agent and
 * device suffix (`31612345678@s.whatsapp.net` for `31612345678.0:3@S.WhatsApp.Net`). Null for a JID that is not a
 * chat Tresso takes.
 */
export function canonicalChatJid(jid: string): string | null {
  const address = chatAddress(jid)
  return address === null ? null : `${address.user}@${address.server}`
}

/** `group` for a group JID, else `direct`. Meaningful for JIDs that pass `importableChat`. */
export function chatKindOf(jid: string): ChatKind {
  return chatAddress(jid)?.kind ?? 'direct'
}

/**
 * Whether Tresso takes messages of this chat: only a direct chat or a group (`importableChat`), never a chat the
 * user left out, and groups only when the account includes them.
 */
export function importable(jid: string, includeGroups: boolean, leftOut: ReadonlySet<string>): boolean {
  const address = chatAddress(jid)
  if (address === null) {
    return false
  }
  if (leftOut.has(jid) || leftOut.has(`${address.user}@${address.server}`)) {
    return false
  }
  return includeGroups || address.kind !== 'group'
}

/**
 * `+31612345678` for digits only, else null. No grouping: that needs a phone number library, and many chats carry
 * no number at all.
 */
export function phoneLabel(digits: string): string | null {
  return /^[0-9]+$/.test(digits) ? `+${digits}` : null
}

/** Second line of a chat: the number of a direct chat when its JID carries one, `Group` for a group. */
export function chatSubtitle(chat: Pick<SyncedChat, 'jid' | 'kind'>): string {
  if (chat.kind === 'group') {
    return 'Group'
  }
  const address = chatAddress(chat.jid)
  if (address === null || address.server !== 's.whatsapp.net') {
    return ''
  }
  return phoneLabel(address.user) ?? ''
}

/**
 * `+31698765432, via this Mac`, or `via <device>` when another device relays. Without a known number:
 * `Via this Mac`. A device without an id is never this Mac, and one without a name is `another device`.
 */
export function accountSubtitle(
  account: Pick<SyncedChatAccount, 'address' | 'relayDeviceId' | 'relayDeviceName'>,
  thisDeviceId: string,
): string {
  const name = nameText(account.relayDeviceName)
  const thisMac = account.relayDeviceId !== '' && account.relayDeviceId === thisDeviceId
  const via = thisMac ? 'this Mac' : name !== '' ? name : 'another device'
  const number = account.address === null ? null : phoneLabel(account.address)
  return number === null ? `Via ${via}` : `${number}, via ${via}`
}

/** The file a message carries, or null for a message with text only. */
export function chatMedia(message: Pick<SyncedChatMessage, 'mediaKind' | 'mediaName' | 'mediaSize'>): ChatMedia | null {
  return message.mediaKind === null ? null : { kind: message.mediaKind, name: message.mediaName, size: message.mediaSize }
}

/** The text of a message on one line, or a word for its media when it has no text. */
function messageText(message: SyncedChatMessage): string {
  const text = labelText(message.text)
  const media = chatMedia(message)
  if (text !== '' || media === null) {
    return text
  }
  switch (media.kind) {
    case 'image':
      return 'Photo'
    case 'video':
      return 'Video'
    case 'audio':
      return 'Voice message'
    case 'document': {
      const name = nameText(media.name)
      return name === '' ? 'File' : `File: ${name}`
    }
    default:
      return 'File'
  }
}

/**
 * Preview of the newest message in a chat list row. In a group the sender's first visible word goes in front,
 * isolated, so a Hebrew or Arabic name does not pull the start of the text (a number, say) to its side.
 */
export function previewLine(chat: Pick<SyncedChat, 'kind'>, newest: SyncedChatMessage | null): string {
  if (newest === null) {
    return ''
  }
  const text = messageText(newest)
  const name = chat.kind === 'group' ? nameText(newest.sender?.name ?? null) : ''
  const firstName = name.split(' ').find((word) => nameText(word) !== '') ?? ''
  return firstName === '' ? text : `${ISOLATE_START}${firstName}${ISOLATE_END}: ${text}`
}

export type ReplyLabel = 'Sending' | 'Sent' | 'Waiting for your Mac' | 'Not sent, tap to retry'

/** What a reply says about itself. Null for a cancelled reply, which is not shown. */
export function replyLabel(outgoing: Pick<SyncedChatOutgoing, 'status'>, relayOnline: boolean): ReplyLabel | null {
  switch (outgoing.status) {
    case 'sending':
      return 'Sending'
    case 'waiting':
      return relayOnline ? 'Sending' : 'Waiting for your Mac'
    case 'sent':
      return 'Sent'
    case 'failed':
      return 'Not sent, tap to retry'
    case 'cancelled':
      return null
  }
}

/** `10:02`, or `10:02, sent`. A failed reply's label stands alone. */
export function bubbleMeta(time: string, label: ReplyLabel | null): string {
  if (label === null) {
    return time
  }
  if (label === 'Not sent, tap to retry') {
    return label
  }
  return `${time}, ${label.charAt(0).toLowerCase()}${label.slice(1)}`
}

const ERROR_TEXTS: Record<ChatOutgoingError, string> = {
  bridge_stopped: 'The bridge is not running.',
  not_linked: 'WhatsApp is not linked.',
  refused: 'WhatsApp refused the message.',
  unconfirmed: 'Tresso could not confirm this was sent. Check WhatsApp on your phone before trying again.',
}

/** Why a reply was not sent, for under its bubble. */
export function replyErrorText(error: ChatOutgoingError): string {
  return ERROR_TEXTS[error]
}

/** Epoch ms of an ISO time, or NaN for null or a time that does not parse. */
function instant(value: string | null): number {
  return value === null ? Number.NaN : Date.parse(value)
}

/**
 * Incoming messages of the chat after its `readThrough`. A `readThrough` that is null or does not parse counts as
 * never read. WhatsApp times have whole seconds, so a message in the same second as `readThrough` counts as read.
 * A message whose time does not parse counts as sent at 0 (the earliest time), as the stores keep it (deltaInstant):
 * read once there is a `readThrough`, unread before.
 */
export function unreadCount(
  chat: Pick<SyncedChat, 'id' | 'readThrough'>,
  messages: readonly Pick<SyncedChatMessage, 'chatId' | 'fromMe' | 'sentAt'>[],
): number {
  const readThrough = instant(chat.readThrough)
  return messages.filter(
    (message) =>
      message.chatId === chat.id &&
      !message.fromMe &&
      (Number.isNaN(readThrough) || !((Date.parse(message.sentAt) || 0) <= readThrough)),
  ).length
}

/**
 * Whether the chat shows in the Unified Inbox: not left out, and a message came in after it was archived. An
 * `archivedThrough` that does not parse counts as not archived; a `lastMessageAt` that does not parse counts as 0 (the
 * earliest time), as the stores keep it (deltaInstant), so such a chat stays archived once it is.
 */
export function inInbox(chat: Pick<SyncedChat, 'lastMessageAt' | 'archivedThrough' | 'leftOut'>): boolean {
  if (chat.leftOut) {
    return false
  }
  const archivedThrough = instant(chat.archivedThrough)
  return Number.isNaN(archivedThrough) || !((Date.parse(chat.lastMessageAt) || 0) <= archivedThrough)
}

export type TimelineEntry =
  | { kind: 'message'; at: number; message: SyncedChatMessage }
  | { kind: 'outgoing'; at: number; outgoing: SyncedChatOutgoing }

/** A time for sorting: an unknown time sorts last. */
function sortTime(...candidates: number[]): number {
  return candidates.find((candidate) => !Number.isNaN(candidate)) ?? Number.POSITIVE_INFINITY
}

/**
 * Messages and replies of a chat, oldest first. A message sorts by `sentAt`, a reply by `sentAt` and else by
 * `createdAt`; a time that does not parse sorts last (`at` is then Infinity). On equal times messages come before
 * replies and each list keeps its order.
 *
 * A cancelled reply is left out. A sent reply is left out when the bridge also stored it: an own message of the same
 * chat with the same trimmed text, stored from 1 minute before to 5 minutes after the reply's `sentAt`. Sent replies
 * are matched oldest first, each to the nearest unmatched message, so one stored message stands in for one reply
 * only and a message typed on the phone more than a minute before a reply never hides it. A reply without text is
 * never matched.
 */
export function timeline(
  messages: readonly SyncedChatMessage[],
  outgoing: readonly SyncedChatOutgoing[],
): TimelineEntry[] {
  const echoes = messages.filter((message) => message.fromMe && !Number.isNaN(Date.parse(message.sentAt)))
  const used = new Set<SyncedChatMessage>()
  const stored = new Set<SyncedChatOutgoing>()
  const sent = outgoing
    .filter((reply) => reply.status === 'sent' && !Number.isNaN(instant(reply.sentAt)) && reply.text.trim() !== '')
    .sort((a, b) => instant(a.sentAt) - instant(b.sentAt))
  for (const reply of sent) {
    const at = instant(reply.sentAt)
    const text = reply.text.trim()
    let nearest: SyncedChatMessage | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const message of echoes) {
      if (used.has(message) || message.chatId !== reply.chatId || message.text.trim() !== text) {
        continue
      }
      const offset = Date.parse(message.sentAt) - at
      if (offset < -SENT_ECHO_SKEW || offset > SENT_ECHO_WINDOW) {
        continue
      }
      if (Math.abs(offset) < nearestDistance) {
        nearest = message
        nearestDistance = Math.abs(offset)
      }
    }
    if (nearest !== null) {
      used.add(nearest)
      stored.add(reply)
    }
  }
  const entries: TimelineEntry[] = messages.map((message) => ({
    kind: 'message',
    at: sortTime(Date.parse(message.sentAt)),
    message,
  }))
  for (const reply of outgoing) {
    if (reply.status !== 'cancelled' && !stored.has(reply)) {
      entries.push({ kind: 'outgoing', at: sortTime(instant(reply.sentAt), instant(reply.createdAt)), outgoing: reply })
    }
  }
  // Array.prototype.sort is stable, and this comparator stays consistent when times are Infinity.
  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/** Two lists already sorted newest first, merged newest first and cut to `limit`. On equal times mail goes first. */
export function mergeInbox<M extends { lastMessageAt: number }, C extends { lastMessageAt: number }>(
  mail: readonly M[],
  chats: readonly C[],
  limit: number,
): (M | C)[] {
  const merged: (M | C)[] = []
  let m = 0
  let c = 0
  while (merged.length < limit) {
    const nextMail = mail[m]
    const nextChat = chats[c]
    if (nextMail === undefined && nextChat === undefined) {
      break
    }
    if (nextChat === undefined || (nextMail !== undefined && nextMail.lastMessageAt >= nextChat.lastMessageAt)) {
      merged.push(nextMail as M)
      m++
    } else {
      merged.push(nextChat)
      c++
    }
  }
  return merged
}

/** The six colours group sender names are drawn in, from the boards' palette. */
export const SENDER_COLORS = ['#4B2F86', '#256B5D', '#1A31A8', '#7A3704', '#B42318', '#4A505C'] as const

/** A fixed colour per sender, by a hash (FNV-1a) of the sender id. */
export function senderColor(id: string): (typeof SENDER_COLORS)[number] {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return SENDER_COLORS[(hash >>> 0) % SENDER_COLORS.length] as (typeof SENDER_COLORS)[number]
}
