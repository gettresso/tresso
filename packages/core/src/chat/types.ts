/**
 * Chats from a messaging channel (WhatsApp through whatsapp-mcp) as Tresso keeps them. They are their own entities,
 * not mail: no MIME, no folders, no pipeline. Read and archive state is Tresso's own and never reaches WhatsApp.
 */

export type ChatChannel = 'whatsapp'
export type ChatKind = 'direct' | 'group'
export type BridgeState = 'running' | 'stopped'
export type LinkState = 'linked' | 'unlinked' | 'unknown'
export type ChatMediaKind = 'image' | 'video' | 'audio' | 'document'
export type ChatOutgoingStatus = 'waiting' | 'sending' | 'sent' | 'failed' | 'cancelled'
/** `file_unavailable`: the relaying Mac could not fetch the file the reply carries from the server; nothing went out. */
export type ChatOutgoingError = 'bridge_stopped' | 'not_linked' | 'refused' | 'unconfirmed' | 'file_unavailable'
/**
 * Where the file of a message is ("All my devices"): on the Mac only (`remote`), asked for and waiting for the Mac
 * (`requested`), on the server (`stored`), or the Mac could not bring it (`failed`, with a ChatMediaError).
 */
export type ChatMediaState = 'remote' | 'requested' | 'stored' | 'failed'
/**
 * Why the Mac could not bring a file: the bridge does not know it (`not_found`), the file differs from the one its store
 * names (`mismatch`), the store names no hash to check it by (`unverified`), it is larger than the server takes
 * (`too_large`), or the bridge was stopped, not linked or its download failed (`unavailable`, often a file WhatsApp no
 * longer keeps).
 */
export type ChatMediaError = 'not_found' | 'mismatch' | 'unverified' | 'too_large' | 'unavailable'
/**
 * What a client may do with a stored file, from its malware scan: download it (`allowed`), wait (`scanning`), download it
 * only after the user accepts that it could not be scanned (`confirm`), never (`blocked`).
 */
export type ChatMediaAccess = 'allowed' | 'scanning' | 'confirm' | 'blocked'

export interface SyncedChatAccount {
  id: string
  /** `whatsapp` today. A channel a newer server adds is kept as it came, so compare with ChatChannel values. */
  channel: ChatChannel | (string & {})
  /** Own number, digits only. */
  address: string | null
  displayName: string | null
  relayDeviceId: string
  relayDeviceName: string
  relayOnline: boolean
  relayOfflineSince: string | null
  bridge: BridgeState
  link: LinkState
  linkedAt: string | null
  loopbackOnly: boolean | null
  includeGroups: boolean
  notify: boolean
}

/**
 * The shapes below are the wire format of the four chat lists of GET /api/v1/sync/changes (`ChatViews` in the API),
 * and the rows both mail stores keep. Times are ISO 8601 strings. That `lastMessageAt`, `sentAt` and `createdAt` are
 * never null is the client's assumption: the API types them nullable (one date helper serves every column) although
 * their columns are NOT NULL. A delta row that breaks it, or carries an unknown value or lacks a field (a newer
 * server), is still stored as far as it can be read (see the `fromDelta` readers in rows.ts): a time that is missing
 * becomes `''` and sorts last, so one odd row never stops the sync.
 *
 * Rows that exist only on this device (the "Only this Mac" mode, no server) belong to a chat account whose id starts
 * with {@link LOCAL_CHAT_PREFIX}; see `chatOnlyHere`.
 */
export interface SyncedChat {
  id: string
  chatAccountId: string
  jid: string
  kind: ChatKind
  /** The chat's name as WhatsApp knows it; null when it has none (a number nobody saved). */
  name: string | null
  lastMessageAt: string
  /** Time of the newest message the user has seen in Tresso. Incoming messages after it are unread. */
  readThrough: string | null
  /** The chat is out of the Unified Inbox while `lastMessageAt` is not after this time. */
  archivedThrough: string | null
  leftOut: boolean
}

export interface ChatSender {
  id: string
  name: string | null
}

/** The file a message carries, as `chatMedia` reads it from a message. */
export interface ChatMedia {
  kind: ChatMediaKind
  /** The bridge's name for the file; null when it gave none. */
  name: string | null
  size: number | null
}

export interface SyncedChatMessage {
  id: string
  chatId: string
  chatAccountId: string
  waId: string
  fromMe: boolean
  /** Null for own messages and in direct chats. */
  sender: ChatSender | null
  text: string
  sentAt: string
  /** The kind of file the message carries; null for text only. */
  mediaKind: ChatMediaKind | null
  mediaName: string | null
  mediaSize: number | null
  /**
   * Where the file is, on the server's chats ("All my devices"); absent or null for a message without a file and for
   * rows this device made itself ("Only this Mac", where the file is on this Mac).
   */
  mediaState?: ChatMediaState | null
  /** Why the Mac could not bring the file; null unless `mediaState` is `failed`. */
  mediaError?: ChatMediaError | null
  /** What may be done with a stored file, from its scan; null while it is not stored. */
  mediaAccess?: ChatMediaAccess | null
}

export interface SyncedChatOutgoing {
  id: string
  chatId: string
  chatAccountId: string
  text: string
  /** The delta never lists a `cancelled` reply; only a copy that keeps replies without the server holds one. */
  status: ChatOutgoingStatus
  error: ChatOutgoingError | null
  createdAt: string
  /** When the relaying device took it to send; null while it waits. */
  claimedAt: string | null
  sentAt: string | null
  /**
   * The file the reply carries: one the desktop sent at once ("Only this Mac", recordLocalAttachment), or one attached
   * in the browser or on the phone that waits on the server for the relaying Mac ("All my devices", the delta's `file`).
   * Absent or null for a text reply. Kept in the row as both stores keep it (JSON), so no column is needed.
   */
  file?: SentFile | null
}

/** A file sent from this Mac: its name and its size in bytes (null when the shell could not tell it). */
export interface SentFile {
  name: string
  size: number | null
}

/** A chat as a list shows it: the chat, its newest message, how many incoming messages are unread. */
export interface ChatSummary {
  chat: SyncedChat
  newest: SyncedChatMessage | null
  unread: number
  /** `chat.lastMessageAt` in epoch ms, for merging with mail (see mergeInbox). */
  lastMessageAt: number
}

/**
 * Where a message sits in its chat's order, as both stores keep it: its time in epoch ms (0 when `sentAt` does not
 * parse, see deltaInstant) and its id. See chatMessageKey.
 */
export interface ChatMessageKey {
  sentAt: number
  id: string
}

/** Part of a chat, as a chat screen reads it (MailStore.chatPage): a window of its messages and all its replies. */
export interface ChatPage {
  chat: SyncedChat
  /** Oldest first, in the stores' order (compareChatMessageKeys). */
  messages: SyncedChatMessage[]
  /** Every reply of the chat, oldest first (compareChatOutgoing): a chat has few, and their state changes. */
  outgoing: SyncedChatOutgoing[]
  /** Messages older than the first one here exist. */
  hasOlder: boolean
}

/**
 * Ids of chat accounts that exist only on this device start with this (`wa:account` in the "Only this Mac" mode);
 * the server's ids are UUIDs and never do.
 */
export const LOCAL_CHAT_PREFIX = 'wa:'

/** A row of the bridge's store as the desktop shell returns it. */
export interface BridgeRow {
  rowid: number
  id: string
  chatJid: string
  chatName: string | null
  sender: string
  text: string
  /** Epoch ms; null when the timestamp did not parse. */
  sentAt: number | null
  fromMe: boolean
  mediaType: string | null
  filename: string | null
  fileLength: number | null
}
