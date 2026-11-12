import { LOCAL_CHAT_PREFIX, type ChatMedia, type SyncedChatMessage, type SyncedChatOutgoing } from './types'

/** The file a message carries, or null for a message with text only. */
export function chatMedia(message: Pick<SyncedChatMessage, 'mediaKind' | 'mediaName' | 'mediaSize'>): ChatMedia | null {
  return message.mediaKind === null ? null : { kind: message.mediaKind, name: message.mediaName, size: message.mediaSize }
}

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
 * Epoch ms of a chat row's time, for the stores' indexes. The server and the local relay write ISO 8601, so a time
 * that does not parse is refused rather than stored in a place it would sort wrong.
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

/** Messages oldest first; equal times by id. */
export function compareChatMessages(a: SyncedChatMessage, b: SyncedChatMessage): number {
  return Date.parse(a.sentAt) - Date.parse(b.sentAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Replies oldest first by when they were written; equal times by id (client UUIDv7s, which rise with time). */
export function compareChatOutgoing(a: SyncedChatOutgoing, b: SyncedChatOutgoing): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
