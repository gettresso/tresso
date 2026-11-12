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

export interface SyncedChat {
  id: string
  chatAccountId: string
  jid: string
  kind: ChatKind
  name: string
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

export interface ChatMedia {
  kind: ChatMediaKind
  name: string
  size: number | null
}

export interface SyncedChatMessage {
  id: string
  chatId: string
  waId: string
  fromMe: boolean
  /** Null for own messages and in direct chats. */
  sender: ChatSender | null
  text: string
  sentAt: string
  media: ChatMedia | null
}

export interface SyncedChatOutgoing {
  id: string
  chatId: string
  text: string
  status: ChatOutgoingStatus
  error: ChatOutgoingError | null
  createdAt: string
  sentAt: string | null
}

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
