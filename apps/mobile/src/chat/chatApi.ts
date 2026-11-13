import {
  chatFromDelta,
  chatOutgoingFromDelta,
  type ChatApi,
  type QueueReplyRequest,
  type SyncedChat,
  type SyncedChatOutgoing,
  type UpdateChatRequest,
} from '@tresso/core'
import type { Api } from '@/mail/todoApi'

/**
 * The calls of the chat endpoints the phone makes (ARCHITECTURE.md 3.17): queueing, cancelling and trying a reply
 * again, and Tresso's own state of a chat. The account comes with the delta; the phone never relays, connects or changes
 * it: that stays with the desktop app.
 */
export type PhoneChatApi = Pick<ChatApi, 'queueReply' | 'cancelReply' | 'retryReply' | 'updateChat'>

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
  }
}

function readable<T extends SyncedChat | SyncedChatOutgoing>(row: T | null): T {
  if (row === null) {
    throw new Error('The server answered with a chat row the app cannot read.')
  }
  return row
}
