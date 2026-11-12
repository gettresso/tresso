import type { BridgeState, ChatKind, ChatMediaKind, ChatOutgoingError, LinkState, SyncedChat, SyncedChatAccount, SyncedChatOutgoing } from './types'

/*
 * The chat endpoints of the API ("All my devices"), as apps/api builds them: the account (ChatAccountResource), the
 * relay (ChatRelay, ChatRelayProcessor), the reply queue (ChatOutgoingResource) and Tresso's own chat state
 * (ChatResource), with their Input and Output classes. ARCHITECTURE.md section 3.17 describes them. Times are ISO 8601.
 */

/** RelayMessages::MAX_MESSAGES: messages per `relay/messages` call. */
export const RELAY_MAX_MESSAGES = 200
/** RelayMessages::MAX_CHATS: chats per `relay/messages` call. */
export const RELAY_MAX_CHATS = 200
/** RelayMessages::MAX_BYTES: bytes of a `relay/messages` body; a larger one is 413 `too_large`. */
export const RELAY_MAX_BYTES = 8 * 1024 * 1024
/** QueueReply::MAX_TEXT: characters of a reply, trimmed. */
export const QUEUE_REPLY_MAX_TEXT = 4096

/** The `code` of a refusal of the chat endpoints (ChatProblem in the API). All are 409 but `too_large` (413). */
export type ChatProblemCode = 'not_the_relay' | 'already_going_out' | 'id_taken' | 'result_final' | 'not_failed' | 'cancelled' | 'too_large'

/**
 * A failed chat request as a ChatApi implementation rejects with it: the HTTP status, the problem's `code` when the
 * body named one, and how long the server asked to wait (Retry-After, in ms). Any error with a numeric `status` and
 * these fields serves; this class is one. Its message never quotes a request: no text, name, JID or number.
 */
export class ChatApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: ChatProblemCode | (string & {}) | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'ChatApiError'
  }
}

/** What a chat request failed with, read from any error a ChatApi rejects with; null for one without a status (network). */
export function chatApiFailure(error: unknown): { status: number; code: string | null; retryAfterMs: number | null } | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const { status, code, retryAfterMs } = error as { status?: unknown; code?: unknown; retryAfterMs?: unknown }
  if (typeof status !== 'number' || !Number.isInteger(status)) {
    return null
  }
  return {
    status,
    code: typeof code === 'string' ? code : null,
    retryAfterMs: typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : null,
  }
}

/** PUT /api/v1/chat-accounts/whatsapp (ConnectChatAccount): makes the account, or makes this desktop its relay. */
export interface ConnectChatAccountRequest {
  /** A UUID the desktop app made once for itself. */
  deviceId: string
  /** 1 to 255 characters, no control or formatting characters. */
  deviceName: string
  /** The own number, 5 to 20 digits; null when the desktop does not know it. */
  address: string | null
  /** At most 255 characters, no control or formatting characters. */
  displayName: string | null
  /** Taken only when the account is made. */
  includeGroups: boolean
  /** Taken only when the account is made. */
  notify: boolean
}

/** PATCH /api/v1/chat-accounts/{id} (UpdateChatAccount): a field left out stays as it is. */
export interface UpdateChatAccountRequest {
  /** False removes the account's group chats from the server, and the relay leaves groups out from then on. */
  includeGroups?: boolean
  notify?: boolean
}

/** Every relay call names the desktop that makes it (RelayRequest); another device gets 409 `not_the_relay`. */
export interface RelayRequest {
  deviceId: string
}

/** POST /api/v1/chat-accounts/{id}/relay/status (RelayStatus): the heartbeat. */
export interface RelayStatusRequest extends RelayRequest {
  bridge: BridgeState
  link: LinkState
  /** When the relay saw the bridge get linked; null when it did not see it happen. */
  linkedAt: string | null
  /** Whether the bridge listens on loopback only; null when the relay could not check. */
  loopbackOnly: boolean | null
}

/** The answer to the heartbeat (RelayStatusOutput): this desktop relays the account. */
export interface RelayStatusResponse {
  relay: 'active'
}

/** A chat of a batch (RelayChat). */
export interface RelayChat {
  /** Canonical (canonicalChatJid); the server refuses a message of a chat Tresso does not take, alone. */
  jid: string
  /** At most 65,536 characters and 262,144 bytes; stored cut to 255 characters. */
  name: string | null
  /** The kind the JID says (chatKindOf); another one is 422. */
  kind: ChatKind
}

/** A group sender (RelaySender). */
export interface RelaySender {
  /** 1 to 128 visible ASCII characters, or the message is refused. */
  id: string
  name: string | null
}

/** The file a message carries (RelayMedia); the file itself stays on the Mac. */
export interface RelayMedia {
  kind: ChatMediaKind
  name: string | null
  size: number | null
}

/** A message of a batch (RelayMessage). */
export interface RelayMessage {
  chatJid: string
  /** 1 to 128 visible ASCII characters, or the message is refused. */
  waId: string
  fromMe: boolean
  /** Null for own messages and in a direct chat. */
  sender: RelaySender | null
  /** At most 65,536 characters and 262,144 bytes; empty when there is none. */
  text: string
  sentAt: string
  media: RelayMedia | null
}

/**
 * POST /api/v1/chat-accounts/{id}/relay/messages (RelayMessages): at most RELAY_MAX_MESSAGES messages,
 * RELAY_MAX_CHATS chats and RELAY_MAX_BYTES bytes. Every message's chat must be in the call or on the server (422
 * otherwise); a chat is in the call once.
 */
export interface RelayMessagesRequest extends RelayRequest {
  /** True only for the batches of the relay's first import: those messages arrive read. */
  firstImport: boolean
  chats: RelayChat[]
  messages: RelayMessage[]
}

/** What became of one message of a batch (RelayImportOutput). */
export type RelayMessageResult = 'stored' | 'known' | 'left_out' | 'refused'

/** The answer to a batch (RelayImportOutput): the counts, and per message in the order of the request. */
export interface RelayImportResponse {
  stored: number
  known: number
  leftOut: number
  refused: number
  results: RelayMessageResult[]
}

/** POST /api/v1/chat-accounts/{id}/relay/outgoing/claim (RelayClaim). */
export type RelayClaimRequest = RelayRequest

/** The reply the relay sends now (RelayClaimOutput). */
export interface RelayClaimResponse {
  id: string
  chatId: string
  /** Canonical. */
  chatJid: string
  text: string
  /** This claim's secret; the result carries it back. No other answer and no delta carries it. */
  claimToken: string
}

/** POST /api/v1/chat-accounts/{id}/relay/outgoing/{outgoingId}/result (RelayResult). */
export type RelayResultRequest = RelayRequest & { claimToken: string } & ({ sent: true; error: null } | { sent: false; error: ChatOutgoingError })

/** POST /api/v1/chats/{chatId}/outgoing (QueueReply). */
export interface QueueReplyRequest {
  /** A UUIDv7 the client made when the user pressed Send, at most 10 minutes before the server first sees it. */
  id: string
  /** Trimmed by the server; 1 to QUEUE_REPLY_MAX_TEXT characters, no control characters but line breaks and tabs. */
  text: string
}

/** PATCH /api/v1/chats/{id} (UpdateChat): a field left out stays as it is. Read and archive only move forward. */
export interface UpdateChatRequest {
  readThrough?: string
  /** Null puts the chat back in the inbox. */
  archivedThrough?: string | null
  /** True removes the chat's messages and replies from the server and takes no more; false takes them again. */
  leftOut?: boolean
}

/**
 * The chat endpoints, one method per endpoint. An implementation sends the request as `JSON.stringify(request)` (the
 * relay builds its batches by that size) and rejects with an error chatApiFailure can read (ChatApiError, or one with
 * the same fields) when the server answers otherwise than with success.
 */
export interface ChatApi {
  /** GET /api/v1/chat-accounts. */
  accounts(): Promise<SyncedChatAccount[]>
  /** PUT /api/v1/chat-accounts/whatsapp (desktop only). */
  connect(request: ConnectChatAccountRequest): Promise<SyncedChatAccount>
  /** PATCH /api/v1/chat-accounts/{id}. */
  updateAccount(id: string, request: UpdateChatAccountRequest): Promise<SyncedChatAccount>
  /** DELETE /api/v1/chat-accounts/{id}: the account with its chats, messages and replies. */
  removeAccount(id: string): Promise<void>
  /** POST /api/v1/chat-accounts/{id}/relay/status (desktop only). */
  relayStatus(accountId: string, request: RelayStatusRequest): Promise<RelayStatusResponse>
  /** POST /api/v1/chat-accounts/{id}/relay/messages (desktop only). */
  relayMessages(accountId: string, request: RelayMessagesRequest): Promise<RelayImportResponse>
  /** POST /api/v1/chat-accounts/{id}/relay/outgoing/claim (desktop only); null when none waits (204). */
  claimReply(accountId: string, request: RelayClaimRequest): Promise<RelayClaimResponse | null>
  /** POST /api/v1/chat-accounts/{id}/relay/outgoing/{outgoingId}/result (desktop only). */
  reportReply(accountId: string, outgoingId: string, request: RelayResultRequest): Promise<SyncedChatOutgoing>
  /** POST /api/v1/chats/{chatId}/outgoing: 201 with the new reply, 200 with the one queued with this id before. */
  queueReply(chatId: string, request: QueueReplyRequest): Promise<SyncedChatOutgoing>
  /** DELETE /api/v1/chat-outgoing/{id}: a reply that waits or failed (409 `already_going_out` otherwise). */
  cancelReply(id: string): Promise<void>
  /** POST /api/v1/chat-outgoing/{id}/retry: a reply that failed waits again (409 `not_failed` otherwise). */
  retryReply(id: string): Promise<SyncedChatOutgoing>
  /** PATCH /api/v1/chats/{id}. */
  updateChat(id: string, request: UpdateChatRequest): Promise<SyncedChat>
}
