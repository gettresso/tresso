import {
  ChatApiError,
  chatAccountFromDelta,
  chatFromDelta,
  chatOutgoingFromDelta,
  type ChatApi,
  type RelayClaimResponse,
  type RelayImportResponse,
  type RelayStatusResponse,
  type SyncedChat,
  type SyncedChatAccount,
  type SyncedChatOutgoing,
} from '@tresso/core'
import { ApiError } from '@/api/errors'
import { useAuthStore, type RequestOptions } from '@/stores/auth'

/** How the chat endpoints are reached: the auth store's `api` (GET) and `send` (JSON bodies), or a fake in tests. */
export interface ChatTransport {
  get<T>(path: string): Promise<T>
  send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, options?: RequestOptions): Promise<T>
}

const BASE = '/api/v1'

function segment(id: string): string {
  return encodeURIComponent(id)
}

/**
 * A failed chat request as ChatApi promises it (ChatApiError): the status, the problem's `code`, Retry-After in ms, and
 * the violation paths only. The message is a generic one: what the server said (a validation message, a detail) stays
 * out, so nothing a request carried can end up in a log line or on screen through it. Anything without a status (no
 * network, the session ended meanwhile) is passed on as it came.
 */
export function chatApiError(error: unknown): unknown {
  if (!(error instanceof ApiError)) {
    return error
  }
  const paths = Object.fromEntries(Object.keys(error.violations).map((path) => [path, '']))
  return new ChatApiError(error.status, `The chat request failed (${error.status}).`, error.code, error.retryAfterMs, paths)
}

/** An answer this version cannot read; never quotes it. */
class UnreadableAnswer extends Error {
  constructor(what: string) {
    super(`The server answered ${what} with something this version cannot read.`)
    this.name = 'UnreadableAnswer'
  }
}

function account(raw: unknown): SyncedChatAccount {
  const read = typeof raw === 'object' && raw !== null ? chatAccountFromDelta(raw as Parameters<typeof chatAccountFromDelta>[0]) : null
  if (read === null) {
    throw new UnreadableAnswer('a chat account request')
  }
  return read
}

function chat(raw: unknown): SyncedChat {
  const read = typeof raw === 'object' && raw !== null ? chatFromDelta(raw as Parameters<typeof chatFromDelta>[0]) : null
  if (read === null) {
    throw new UnreadableAnswer('a chat request')
  }
  return read
}

function outgoing(raw: unknown): SyncedChatOutgoing {
  const read = typeof raw === 'object' && raw !== null ? chatOutgoingFromDelta(raw as Parameters<typeof chatOutgoingFromDelta>[0]) : null
  if (read === null) {
    throw new UnreadableAnswer('a reply request')
  }
  return read
}

function claim(raw: unknown): RelayClaimResponse | null {
  if (raw === undefined || raw === null) {
    return null
  }
  const answer = raw as Partial<Record<keyof RelayClaimResponse, unknown>>
  if (typeof answer.id !== 'string' || typeof answer.chatId !== 'string' || typeof answer.chatJid !== 'string' || typeof answer.text !== 'string' || typeof answer.claimToken !== 'string') {
    throw new UnreadableAnswer('a claim')
  }
  return { id: answer.id, chatId: answer.chatId, chatJid: answer.chatJid, text: answer.text, claimToken: answer.claimToken }
}

/**
 * The chat endpoints of the API (packages/core/src/chat/api.ts, docs/ARCHITECTURE.md 3.17) over the web client's
 * requests. Each request body is exactly `JSON.stringify(request)`, sent as UTF-8 (`application/json`, a PATCH as
 * `application/merge-patch+json`), as the relay sizes its batches by it. A failure rejects with ChatApiError
 * (chatApiError). `claimReply` is never sent twice, not even after a refused access token: a claim sent again takes
 * the next reply, and the first stays `sending` until the server's sweep fails it.
 */
export function createChatApi(transport: ChatTransport): ChatApi {
  async function call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      throw chatApiError(error)
    }
  }

  return {
    async accounts() {
      const rows = await call(() => transport.get<unknown>(`${BASE}/chat-accounts`))
      if (!Array.isArray(rows)) {
        throw new UnreadableAnswer('the chat accounts request')
      }
      return rows.map(account)
    },
    async connect(request) {
      return account(await call(() => transport.send<unknown>('PUT', `${BASE}/chat-accounts/whatsapp`, request)))
    },
    async updateAccount(id, request) {
      return account(await call(() => transport.send<unknown>('PATCH', `${BASE}/chat-accounts/${segment(id)}`, request)))
    },
    async removeAccount(id) {
      await call(() => transport.send<void>('DELETE', `${BASE}/chat-accounts/${segment(id)}`))
    },
    relayStatus(accountId, request) {
      return call(() => transport.send<RelayStatusResponse>('POST', `${BASE}/chat-accounts/${segment(accountId)}/relay/status`, request))
    },
    relayMessages(accountId, request) {
      return call(() => transport.send<RelayImportResponse>('POST', `${BASE}/chat-accounts/${segment(accountId)}/relay/messages`, request))
    },
    async claimReply(accountId, request) {
      return claim(await call(() => transport.send<unknown>('POST', `${BASE}/chat-accounts/${segment(accountId)}/relay/outgoing/claim`, request, { retry: false })))
    },
    async reportReply(accountId, outgoingId, request) {
      return outgoing(await call(() => transport.send<unknown>('POST', `${BASE}/chat-accounts/${segment(accountId)}/relay/outgoing/${segment(outgoingId)}/result`, request)))
    },
    async queueReply(chatId, request) {
      return outgoing(await call(() => transport.send<unknown>('POST', `${BASE}/chats/${segment(chatId)}/outgoing`, request)))
    },
    async cancelReply(id) {
      await call(() => transport.send<void>('DELETE', `${BASE}/chat-outgoing/${segment(id)}`))
    },
    async retryReply(id) {
      return outgoing(await call(() => transport.send<unknown>('POST', `${BASE}/chat-outgoing/${segment(id)}/retry`)))
    },
    async updateChat(id, request) {
      return chat(await call(() => transport.send<unknown>('PATCH', `${BASE}/chats/${segment(id)}`, request)))
    },
  }
}

/** The chat endpoints for the signed-in user (the auth store's requests). */
export function useChatApi(): ChatApi {
  const auth = useAuthStore()
  return createChatApi({
    get: (path) => auth.api(path),
    send: (method, path, body, options) => auth.send(method, path, body, options),
  })
}
