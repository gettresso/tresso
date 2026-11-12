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
export type ChatOutgoingError = 'bridge_stopped' | 'not_linked' | 'refused' | 'unconfirmed'

export interface SyncedChatAccount {
  id: string
  channel: ChatChannel
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
 * and the rows both mail stores keep. Times are ISO 8601 strings. The API types `lastMessageAt`, `sentAt` and
 * `createdAt` as nullable because one date helper serves every column, but their columns are NOT NULL, so a row
 * always carries them.
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
