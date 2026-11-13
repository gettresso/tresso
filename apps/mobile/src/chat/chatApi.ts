import {
  chatFromDelta,
  chatOutgoingFromDelta,
  type ChatApi,
  type ChatMediaResponse,
  type ChatUploadResponse,
  type QueueReplyRequest,
  type SyncedChat,
  type SyncedChatOutgoing,
  type UpdateChatRequest,
} from '@tresso/core'
import type { Api } from '@/mail/todoApi'

/**
 * The calls of the chat endpoints the phone makes (ARCHITECTURE.md 3.17): queueing, cancelling and trying a reply
 * again, Tresso's own state of a chat, asking the relaying Mac for a file and opening one the server holds, and
 * uploading a file for a reply. The account comes with the delta; the phone never relays, connects or changes it: that
 * stays with the desktop app.
 */
export type PhoneChatApi = Pick<ChatApi, 'queueReply' | 'cancelReply' | 'retryReply' | 'updateChat' | 'requestMedia' | 'media' | 'unscannedMediaLink' | 'uploadFile'>

/**
 * The chat endpoints over the signed-in session (`AuthSession.api`), whose ApiError carries the status, the problem's
 * `code`, Retry-After and the violations by path, so core's chatApiFailure reads it. Answers go through the delta
 * readers of core, so a row the phone stores at once is the same as the one the delta brings later; an answer that
 * cannot be read rejects (it is not what the server sends).
 */
export function phoneChatApi(api: Api): PhoneChatApi {
  const json = (method: string, body: unknown, contentType = 'application/json'): RequestInit => ({ method, headers: { 'Content-Type': contentType }, body: JSON.stringify(body) })

  return {
    queueReply: async (chatId: string, request: QueueReplyRequest) => readable(chatOutgoingFromDelta(await api<Record<string, unknown>>(`/api/v1/chats/${encodeURIComponent(chatId)}/outgoing`, json('POST', request)))),
    cancelReply: async (id: string) => {
      await api(`/api/v1/chat-outgoing/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    retryReply: async (id: string) => readable(chatOutgoingFromDelta(await api<Record<string, unknown>>(`/api/v1/chat-outgoing/${encodeURIComponent(id)}/retry`, json('POST', {})))),
    updateChat: async (id: string, request: UpdateChatRequest) =>
      readable(chatFromDelta(await api<Record<string, unknown>>(`/api/v1/chats/${encodeURIComponent(id)}`, json('PATCH', request, 'application/merge-patch+json')))),
    requestMedia: async (messageId: string) => media(await api<unknown>(`/api/v1/chat-messages/${encodeURIComponent(messageId)}/media/request`, json('POST', {}))),
    media: async (messageId: string) => media(await api<unknown>(`/api/v1/chat-messages/${encodeURIComponent(messageId)}/media`)),
    unscannedMediaLink: async (messageId: string) => media(await api<unknown>(`/api/v1/chat-messages/${encodeURIComponent(messageId)}/media/unscanned-link`, json('POST', { confirmed: true }))),
    // The file as the raw body: React Native sends a Blob from the device without holding it in JavaScript.
    uploadFile: (chatId: string, uploadId: string, body: Blob) =>
      api<ChatUploadResponse>(`/api/v1/chats/${encodeURIComponent(chatId)}/uploads/${encodeURIComponent(uploadId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body }),
  }
}

const MEDIA_STATES = ['remote', 'requested', 'stored', 'failed']

/** A file's answer (ChatMediaResource); one this version cannot read rejects. */
function media(raw: unknown): ChatMediaResponse {
  const answer = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  if (typeof answer.messageId !== 'string' || typeof answer.state !== 'string' || !MEDIA_STATES.includes(answer.state)) {
    throw new Error('The server answered with a file the app cannot read.')
  }
  return {
    messageId: answer.messageId,
    kind: (['image', 'video', 'audio', 'document'].includes(text(answer.kind) ?? '') ? answer.kind : 'document') as ChatMediaResponse['kind'],
    name: text(answer.name),
    size: typeof answer.size === 'number' ? answer.size : null,
    state: answer.state as ChatMediaResponse['state'],
    error: text(answer.error) as ChatMediaResponse['error'],
    access: text(answer.access) as ChatMediaResponse['access'],
    url: text(answer.url),
  }
}

function readable<T extends SyncedChat | SyncedChatOutgoing>(row: T | null): T {
  if (row === null) {
    throw new Error('The server answered with a chat row the app cannot read.')
  }
  return row
}
