import type {
  ChatKind,
  ChatOutgoingError,
  SyncedChat,
  SyncedChatAccount,
  SyncedChatMessage,
  SyncedChatOutgoing,
} from './types'

const GROUP_SUFFIX = '@g.us'
const USER_SUFFIX = '@s.whatsapp.net'

/** How long after a reply was sent a stored own message with the same text counts as that reply. */
export const SENT_ECHO_WINDOW = 5 * 60 * 1000

/** `group` for a group JID, else `direct`. */
export function chatKindOf(jid: string): ChatKind {
  return jid.endsWith(GROUP_SUFFIX) ? 'group' : 'direct'
}

/**
 * Whether Tresso takes messages of this chat: never status updates (`@broadcast`) or channels (`@newsletter`), never a
 * chat the user left out, and groups only when the account includes them.
 */
export function importable(jid: string, includeGroups: boolean, leftOut: ReadonlySet<string>): boolean {
  if (jid === '' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) {
    return false
  }
  if (leftOut.has(jid)) {
    return false
  }
  return includeGroups || chatKindOf(jid) !== 'group'
}

/** `+31612345678`. No grouping: that needs a phone number library, and many chats carry no number at all. */
export function phoneLabel(digits: string): string | null {
  return digits === '' ? null : `+${digits}`
}

/** Second line of a chat: the number of a direct chat when its JID carries one, `Group` for a group. */
export function chatSubtitle(chat: Pick<SyncedChat, 'jid' | 'kind'>): string {
  if (chat.kind === 'group') {
    return 'Group'
  }
  if (!chat.jid.endsWith(USER_SUFFIX)) {
    return ''
  }
  const user = chat.jid.slice(0, -USER_SUFFIX.length)
  return /^\d+$/.test(user) ? (phoneLabel(user) ?? '') : ''
}

/** `+31698765432, via this Mac`, or `via <device>` when another device relays. */
export function accountSubtitle(
  account: Pick<SyncedChatAccount, 'address' | 'relayDeviceId' | 'relayDeviceName'>,
  thisDeviceId: string,
): string {
  const via = account.relayDeviceId === thisDeviceId ? 'this Mac' : account.relayDeviceName
  const number = account.address === null ? null : phoneLabel(account.address)
  return number === null ? `Via ${via}` : `${number}, via ${via}`
}

const MEDIA_LABELS = { image: 'Photo', video: 'Video', audio: 'Voice message' } as const

/** The text of a message, or a word for its media when it has no text. */
function messageText(message: SyncedChatMessage): string {
  if (message.text !== '' || message.media === null) {
    return message.text
  }
  return message.media.kind === 'document' ? `File: ${message.media.name}` : MEDIA_LABELS[message.media.kind]
}

/** Preview of the newest message in a chat list row. In a group the sender's first name goes in front. */
export function previewLine(chat: Pick<SyncedChat, 'kind'>, newest: SyncedChatMessage | null): string {
  if (newest === null) {
    return ''
  }
  const text = messageText(newest)
  const firstName = chat.kind === 'group' ? (newest.sender?.name?.trim().split(/\s+/)[0] ?? '') : ''
  return firstName === '' ? text : `${firstName}: ${text}`
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

/** Incoming messages of the chat after its `readThrough`. */
export function unreadCount(
  chat: Pick<SyncedChat, 'id' | 'readThrough'>,
  messages: readonly Pick<SyncedChatMessage, 'chatId' | 'fromMe' | 'sentAt'>[],
): number {
  const readThrough = chat.readThrough === null ? null : Date.parse(chat.readThrough)
  return messages.filter(
    (message) =>
      message.chatId === chat.id && !message.fromMe && (readThrough === null || Date.parse(message.sentAt) > readThrough),
  ).length
}

/** Whether the chat shows in the Unified Inbox: not left out, and a message came in after it was archived. */
export function inInbox(chat: Pick<SyncedChat, 'lastMessageAt' | 'archivedThrough' | 'leftOut'>): boolean {
  if (chat.leftOut) {
    return false
  }
  return chat.archivedThrough === null || Date.parse(chat.lastMessageAt) > Date.parse(chat.archivedThrough)
}

export type TimelineEntry =
  | { kind: 'message'; at: number; message: SyncedChatMessage }
  | { kind: 'outgoing'; at: number; outgoing: SyncedChatOutgoing }

/**
 * Messages and replies of a chat, oldest first. A cancelled reply is left out. A sent reply is left out when the
 * bridge also stored it: an own message of the same chat with the same text within 5 minutes of the reply's
 * `sentAt`. Each stored message stands in for one reply only, so the same text sent twice stays twice.
 */
export function timeline(
  messages: readonly SyncedChatMessage[],
  outgoing: readonly SyncedChatOutgoing[],
): TimelineEntry[] {
  const echoes = messages.filter((message) => message.fromMe)
  const used = new Set<SyncedChatMessage>()
  const entries: TimelineEntry[] = messages.map((message) => ({ kind: 'message', at: Date.parse(message.sentAt), message }))
  for (const reply of outgoing) {
    if (reply.status === 'cancelled') {
      continue
    }
    const at = Date.parse(reply.sentAt ?? reply.createdAt)
    if (reply.status === 'sent' && reply.sentAt !== null) {
      const text = reply.text.trim()
      const echo = echoes.find(
        (message) =>
          !used.has(message) &&
          message.chatId === reply.chatId &&
          message.text.trim() === text &&
          Math.abs(Date.parse(message.sentAt) - at) <= SENT_ECHO_WINDOW,
      )
      if (echo !== undefined) {
        used.add(echo)
        continue
      }
    }
    entries.push({ kind: 'outgoing', at, outgoing: reply })
  }
  // Array.prototype.sort is stable: on equal times messages stay before replies and each list keeps its order.
  return entries.sort((a, b) => a.at - b.at)
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
