import type { BridgeState, ChatKind, ChatMediaAccess, ChatMediaError, ChatMediaKind, ChatMediaState, ChatOutgoingError, LinkState, SyncedChat, SyncedChatAccount, SyncedChatOutgoing } from './types'

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
/** RelayChat::MAX_FIELD: code points of a text or name in a batch (and RelayMessage::MAX_FIELD_BYTES, four times it, in bytes). */
export const RELAY_MAX_FIELD = 65_536
/** QueueReply::MAX_TEXT: characters of a reply, trimmed. */
export const QUEUE_REPLY_MAX_TEXT = 4096
/**
 * CHAT_MAX_FILE_BYTES as the API sets it by default: the largest WhatsApp file a browser or phone attaches, and the
 * largest the relaying Mac brings (the relay takes the server's own limit from each media claim, `maxBytes`).
 */
export const CHAT_MAX_FILE_BYTES = 100 * 1024 * 1024

/** The `code` of a refusal of the chat endpoints (ChatProblem in the API). All are 409 but `too_large` (413). */
export type ChatProblemCode =
  | 'not_the_relay'
  | 'already_going_out'
  | 'id_taken'
  | 'result_final'
  | 'not_failed'
  | 'cancelled'
  | 'too_large'
  | 'other_number'
  | 'not_requested'
  | 'not_stored'
  | 'still_sending'
  | 'too_much_waiting'

/**
 * A failed chat request as a ChatApi implementation rejects with it: the HTTP status, the problem's `code` when the
 * body named one, how long the server asked to wait (Retry-After, in ms), and a 422's violations by property path
 * (`messages[3].text`), in the shape of the web client's ApiError. Any error with a numeric `status` and these fields
 * serves; this class is one. Its message never quotes a request: no text, name, JID or number.
 */
export class ChatApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: ChatProblemCode | (string & {}) | null = null,
    readonly retryAfterMs: number | null = null,
    /** Messages per property path; only the paths are ever read (chatApiFailure). */
    readonly violations: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'ChatApiError'
  }
}

export interface ChatApiFailure {
  status: number
  code: string | null
  retryAfterMs: number | null
  /** The property paths a 422 named (`messages[3].text`, `deviceId`); never their messages or values. */
  violationPaths: string[]
}

/** What a chat request failed with, read from any error a ChatApi rejects with; null for one without a status (network). */
export function chatApiFailure(error: unknown): ChatApiFailure | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const { status, code, retryAfterMs, violations } = error as { status?: unknown; code?: unknown; retryAfterMs?: unknown; violations?: unknown }
  if (typeof status !== 'number' || !Number.isInteger(status)) {
    return null
  }
  return {
    status,
    code: typeof code === 'string' ? code : null,
    retryAfterMs: typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : null,
    violationPaths: violationPaths(violations),
  }
}

/** Paths from `{path: message}` (the web client's ApiError) or a problem body's `[{propertyPath}]`. */
function violationPaths(violations: unknown): string[] {
  if (Array.isArray(violations)) {
    return violations.flatMap((violation: unknown) => {
      const path = typeof violation === 'object' && violation !== null ? (violation as { propertyPath?: unknown }).propertyPath : undefined
      return typeof path === 'string' ? [path] : []
    })
  }
  return typeof violations === 'object' && violations !== null ? Object.keys(violations) : []
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
  /**
   * The number the bridge is linked to, 5 to 20 digits; null or absent when the relay does not know it. Another number
   * than the account's is 409 `other_number`, and the relay stops.
   */
  address?: string | null
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
  /**
   * The user left this chat out before the server knew it: the server keeps a left-out row for it (its JID sealed, no
   * name, no messages), so every relay leaves it out; a chat the server holds already is left as it is. Absent: false.
   */
  leftOut?: boolean
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

/** The file a claimed reply carries (RelayClaimOutput `file`). */
export interface RelayClaimFile {
  /** The name it goes out under: one plain name, no folder. */
  name: string
  /** Bytes. */
  size: number
  /** A signed link to its content, valid for an hour and only while the reply is being sent; no token needed. */
  url: string
}

/** The reply the relay sends now (RelayClaimOutput). */
export interface RelayClaimResponse {
  id: string
  chatId: string
  /** Canonical. */
  chatJid: string
  /** Empty for a file without a caption. */
  text: string
  /** This claim's secret; the result carries it back. No other answer and no delta carries it. */
  claimToken: string
  /** The file it carries; null for a text reply. */
  file: RelayClaimFile | null
}

/** POST /api/v1/chat-accounts/{id}/relay/media/claim (RelayMediaClaim). */
export type RelayMediaClaimRequest = RelayRequest

/** A file the user asked for on another device (RelayMediaClaimOutput). */
export interface RelayMediaClaimResponse {
  /** The message; the upload and the failure name it. */
  messageId: string
  /** Canonical. */
  chatJid: string
  waId: string
  kind: ChatMediaKind
  /** What the bridge's store said, in bytes; null when unknown. */
  size: number | null
  /** The largest file the server takes (CHAT_MAX_FILE_BYTES); a larger one is reported `too_large` without a download. */
  maxBytes: number
}

/**
 * PUT /api/v1/chat-accounts/{id}/relay/media/{messageId}: the file as the body (`application/octet-stream`), the device
 * in `X-Device-Id`, the SHA-256 the bridge's store holds in `X-Content-SHA256`.
 */
export interface RelayMediaUploadRequest extends RelayRequest {
  /** Hex. */
  sha256: string
  body: Blob
}

/** POST /api/v1/chat-accounts/{id}/relay/media/{messageId}/failed (RelayMediaFailed). */
export interface RelayMediaFailedRequest extends RelayRequest {
  error: ChatMediaError
}

/** Where a file the relay was asked for stands (RelayMediaOutput). */
export interface RelayMediaResponse {
  messageId: string
  state: ChatMediaState
  error: ChatMediaError | null
}

/** A message's file as GET /api/v1/chat-messages/{id}/media and its request answer it (ChatMediaResource). */
export interface ChatMediaResponse {
  messageId: string
  kind: ChatMediaKind
  /** WhatsApp's name; display it only (the download's name is made safe by the server). */
  name: string | null
  size: number | null
  state: ChatMediaState
  error: ChatMediaError | null
  access: ChatMediaAccess | null
  /** A signed link, valid for an hour; null until the file may be downloaded. */
  url: string | null
}

/** How an upload is followed and cancelled: an AbortSignal, and the bytes sent of all as they go. */
export interface ChatUploadOptions {
  signal?: AbortSignal
  onProgress?: (sent: number, total: number) => void
}

/** PUT /api/v1/chats/{chatId}/uploads/{id}: the answer (ChatUploadResource). */
export interface ChatUploadResponse {
  id: string
  chatId: string
  size: number
}

/** POST /api/v1/chat-accounts/{id}/relay/outgoing/{outgoingId}/result (RelayResult). */
export type RelayResultRequest = RelayRequest & { claimToken: string } & ({ sent: true; error: null } | { sent: false; error: ChatOutgoingError })

/** The file a queued reply carries (QueueReplyFile): one uploaded to the chat before, and its name. Our own apps only. */
export interface QueueReplyFile {
  uploadId: string
  /** 1 to 255 characters, no control characters; anything up to the last slash or backslash is dropped. */
  name: string
}

/** POST /api/v1/chats/{chatId}/outgoing (QueueReply). */
export interface QueueReplyRequest {
  /** A UUIDv7 the client made when the user pressed Send, at most 10 minutes before the server first sees it. */
  id: string
  /**
   * Trimmed by the server; up to QUEUE_REPLY_MAX_TEXT characters, no control characters but line breaks and tabs. Empty
   * only with a file (then it is the caption).
   */
  text: string
  file?: QueueReplyFile
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
 * The chat endpoints, one method per endpoint. An implementation sends the request as exactly `JSON.stringify(request)`
 * (the relay builds its batches by that size; a PATCH as `application/merge-patch+json`) and rejects with an error
 * chatApiFailure can read (ChatApiError, or one with the same fields: status, code, retryAfterMs, violations by path)
 * when the server answers otherwise than with success. It never retries `claimReply` by itself: a claim sent again
 * takes the next reply, and the first stays `sending` until the sweep fails it.
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
  /** POST /api/v1/chat-accounts/{id}/relay/media/claim (desktop only); null when nobody asked for a file (204). */
  claimMedia(accountId: string, request: RelayMediaClaimRequest): Promise<RelayMediaClaimResponse | null>
  /** PUT /api/v1/chat-accounts/{id}/relay/media/{messageId} (desktop only); safe to send again. */
  uploadMedia(accountId: string, messageId: string, request: RelayMediaUploadRequest): Promise<RelayMediaResponse>
  /** POST /api/v1/chat-accounts/{id}/relay/media/{messageId}/failed (desktop only). */
  failMedia(accountId: string, messageId: string, request: RelayMediaFailedRequest): Promise<RelayMediaResponse>
  /** The content behind a claimed reply's signed `file.url` (no token: the link is signed). */
  replyFile(url: string): Promise<Blob>
  /** POST /api/v1/chat-messages/{id}/media/request: asks the relaying Mac for the file (our own apps). */
  requestMedia(messageId: string): Promise<ChatMediaResponse>
  /** GET /api/v1/chat-messages/{id}/media: where the file stands, with a link once it may be downloaded. */
  media(messageId: string): Promise<ChatMediaResponse>
  /** POST /api/v1/chat-messages/{id}/media/unscanned-link: the link for a file that could not be scanned (our own apps). */
  unscannedMediaLink(messageId: string): Promise<ChatMediaResponse>
  /** PUT /api/v1/chats/{chatId}/uploads/{uploadId}: a file for a reply, before it is queued (our own apps). */
  uploadFile(chatId: string, uploadId: string, body: Blob, options?: ChatUploadOptions): Promise<ChatUploadResponse>
}
