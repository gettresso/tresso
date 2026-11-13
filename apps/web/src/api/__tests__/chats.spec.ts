import { describe, expect, it } from 'vitest'
import { ChatApiError, chatApiFailure, type ChatApi, type RelayMessagesRequest } from '@tresso/core'
import { ApiError } from '@/api/errors'
import { chatApiError, createChatApi, type ChatTransport } from '@/api/chats'
import type { RequestOptions } from '@/stores/auth'

const ACCOUNT = {
  id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  channel: 'whatsapp',
  address: '31612345678',
  displayName: 'Kim',
  relayDeviceId: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
  relayDeviceName: "Kim's MacBook Pro",
  relayOnline: true,
  relayOfflineSince: null,
  bridge: 'running',
  link: 'linked',
  linkedAt: null,
  loopbackOnly: true,
  includeGroups: true,
  notify: false,
}
const CHAT = { id: 'chat-1', chatAccountId: ACCOUNT.id, jid: '31612345678@s.whatsapp.net', kind: 'direct', name: 'Kim', lastMessageAt: '2026-11-12T10:00:00Z', readThrough: null, archivedThrough: null, leftOut: false }
const REPLY = { id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c', chatId: 'chat-1', chatAccountId: ACCOUNT.id, text: 'On my way', status: 'waiting', error: null, createdAt: '2026-11-12T10:00:00Z', claimedAt: null, sentAt: null }

interface Call {
  method: string
  path: string
  body: unknown
  options: RequestOptions | undefined
}

/** Records every request; answers with `answer`, or rejects with `fails`. */
function transport(answer: unknown, fails: unknown = null): { api: ChatApi; calls: Call[] } {
  const calls: Call[] = []
  const handle = <T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T> => {
    calls.push({ method, path, body, options })
    return fails === null ? Promise.resolve(answer as T) : Promise.reject(fails)
  }
  const fake: ChatTransport = {
    get: (path) => handle('GET', path),
    send: (method, path, body, options) => handle(method, path, body, options),
  }
  return { api: createChatApi(fake), calls }
}

describe('the chat endpoints', () => {
  it('sends one request per endpoint, with the request object itself as the body', async () => {
    const batch: RelayMessagesRequest = {
      deviceId: ACCOUNT.relayDeviceId,
      firstImport: true,
      chats: [{ jid: CHAT.jid, name: 'Kïm 🌷', kind: 'direct' }],
      messages: [{ chatJid: CHAT.jid, waId: 'W1', fromMe: false, sender: null, text: 'Héllo 👋', sentAt: '2026-11-12T10:00:00Z', media: null }],
    }
    const cases: [string, (api: ChatApi) => Promise<unknown>, string, string, unknown, unknown][] = [
      ['accounts', (api) => api.accounts(), 'GET', '/api/v1/chat-accounts', undefined, [ACCOUNT]],
      [
        'connect',
        (api) => api.connect({ deviceId: ACCOUNT.relayDeviceId, deviceName: 'Mac', address: null, displayName: null, includeGroups: true, notify: false }),
        'PUT',
        '/api/v1/chat-accounts/whatsapp',
        { deviceId: ACCOUNT.relayDeviceId, deviceName: 'Mac', address: null, displayName: null, includeGroups: true, notify: false },
        ACCOUNT,
      ],
      ['updateAccount', (api) => api.updateAccount(ACCOUNT.id, { notify: true }), 'PATCH', `/api/v1/chat-accounts/${ACCOUNT.id}`, { notify: true }, ACCOUNT],
      ['removeAccount', (api) => api.removeAccount(ACCOUNT.id), 'DELETE', `/api/v1/chat-accounts/${ACCOUNT.id}`, undefined, undefined],
      [
        'relayStatus',
        (api) => api.relayStatus(ACCOUNT.id, { deviceId: 'd', bridge: 'running', link: 'linked', linkedAt: null, loopbackOnly: true }),
        'POST',
        `/api/v1/chat-accounts/${ACCOUNT.id}/relay/status`,
        { deviceId: 'd', bridge: 'running', link: 'linked', linkedAt: null, loopbackOnly: true },
        { relay: 'active' },
      ],
      ['relayMessages', (api) => api.relayMessages(ACCOUNT.id, batch), 'POST', `/api/v1/chat-accounts/${ACCOUNT.id}/relay/messages`, batch, { stored: 1, known: 0, leftOut: 0, refused: 0, results: ['stored'] }],
      [
        'reportReply',
        (api) => api.reportReply(ACCOUNT.id, REPLY.id, { deviceId: 'd', claimToken: 't', sent: true, error: null }),
        'POST',
        `/api/v1/chat-accounts/${ACCOUNT.id}/relay/outgoing/${REPLY.id}/result`,
        { deviceId: 'd', claimToken: 't', sent: true, error: null },
        REPLY,
      ],
      ['queueReply', (api) => api.queueReply('chat/1', { id: REPLY.id, text: 'On my way' }), 'POST', '/api/v1/chats/chat%2F1/outgoing', { id: REPLY.id, text: 'On my way' }, REPLY],
      ['cancelReply', (api) => api.cancelReply(REPLY.id), 'DELETE', `/api/v1/chat-outgoing/${REPLY.id}`, undefined, undefined],
      ['retryReply', (api) => api.retryReply(REPLY.id), 'POST', `/api/v1/chat-outgoing/${REPLY.id}/retry`, undefined, REPLY],
      ['updateChat', (api) => api.updateChat('chat-1', { archivedThrough: null }), 'PATCH', '/api/v1/chats/chat-1', { archivedThrough: null }, CHAT],
    ]
    for (const [name, run, method, path, body, answer] of cases) {
      const { api, calls } = transport(answer)
      await run(api)
      expect(calls, name).toHaveLength(1)
      expect(calls[0]!.method, name).toBe(method)
      expect(calls[0]!.path, name).toBe(path)
      expect(JSON.stringify(calls[0]!.body), name).toBe(JSON.stringify(body))
    }
  })

  it('hands the relay its batch unchanged, so the bytes it counted are the bytes sent', async () => {
    const batch: RelayMessagesRequest = { deviceId: 'd', firstImport: false, chats: [], messages: [] }
    const { api, calls } = transport({ stored: 0, known: 0, leftOut: 0, refused: 0, results: [] })
    await api.relayMessages('a', batch)
    expect(calls[0]!.body).toBe(batch)
  })

  it('never lets the client send a claim twice, and reads a claim or none', async () => {
    const claimed = { id: REPLY.id, chatId: 'chat-1', chatJid: CHAT.jid, text: 'On my way', claimToken: 'abc' }
    const { api, calls } = transport(claimed)
    await expect(api.claimReply('a', { deviceId: 'd' })).resolves.toEqual(claimed)
    expect(calls[0]!.options).toEqual({ retry: false })
    // Every other request may be retried by the client as usual.
    await api.relayStatus('a', { deviceId: 'd', bridge: 'running', link: 'linked', linkedAt: null, loopbackOnly: true })
    expect(calls[1]!.options).toBeUndefined()

    await expect(transport(undefined).api.claimReply('a', { deviceId: 'd' })).resolves.toBeNull()
    await expect(transport({ id: REPLY.id }).api.claimReply('a', { deviceId: 'd' })).rejects.toThrow('cannot read')
  })

  it('reads the rows it answers as the delta does, and refuses an answer it cannot read', async () => {
    const accounts = await transport([ACCOUNT, { channel: 'whatsapp' }]).api.accounts().catch((error: unknown) => error)
    expect(accounts).toBeInstanceOf(Error)
    await expect(transport({ ...REPLY, status: 'teleported' }).api.retryReply(REPLY.id)).resolves.toMatchObject({ status: 'sending' })
    await expect(transport({ nothing: true }).api.updateChat('chat-1', {})).rejects.toThrow('cannot read')
    await expect(transport({ rows: [] }).api.accounts()).rejects.toThrow('cannot read')
  })

  it('rejects with the status, the code, Retry-After and the violation paths, never with what the server said', async () => {
    const response = Response.json(
      { title: 'Conflict', detail: 'Secret dinner plans', code: 'not_the_relay', violations: [{ propertyPath: 'messages[3].text', message: 'Secret dinner plans is too long' }] },
      { status: 409, headers: { 'Retry-After': '30' } },
    )
    const failure = await ApiError.fromResponse('/api/v1/chat-accounts/a/relay/messages', response)
    expect(failure.code).toBe('not_the_relay')

    const { api } = transport(null, failure)
    const error = await api.relayMessages('a', { deviceId: 'd', firstImport: false, chats: [], messages: [] }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ChatApiError)
    expect(chatApiFailure(error)).toEqual({ status: 409, code: 'not_the_relay', retryAfterMs: 30_000, violationPaths: ['messages[3].text'] })
    expect(JSON.stringify(error)).not.toContain('Secret')
    expect((error as Error).message).not.toContain('Secret')
  })

  it('passes on an error without a status as it came (no network, a session that ended)', () => {
    const offline = new TypeError('Failed to fetch')
    expect(chatApiError(offline)).toBe(offline)
    expect(chatApiFailure(chatApiError(new ApiError(429, 'Slow down', {}, 5000)))).toEqual({ status: 429, code: null, retryAfterMs: 5000, violationPaths: [] })
  })
})
