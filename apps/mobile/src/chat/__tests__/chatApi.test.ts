import { describe, expect, it, vi } from 'vitest'
import { chatApiFailure } from '@tresso/core'
import { ApiError } from '@/auth/session'
import { phoneChatApi } from '@/chat/chatApi'
import { chat, reply } from './fixtures'

function recording(answer: unknown) {
  const calls: { path: string; init: RequestInit | undefined }[] = []
  const api = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init })
    return answer
  }) as unknown as <T>(path: string, init?: RequestInit) => Promise<T>
  return { api, calls }
}

describe('phoneChatApi', () => {
  it('queues a reply with the id the phone made', async () => {
    const { api, calls } = recording(reply('0193a1c2-0000-7000-8000-000000000001', 'c1'))

    const queued = await phoneChatApi(api).queueReply('c1', { id: '0193a1c2-0000-7000-8000-000000000001', text: 'On my way' })

    expect(calls[0]?.path).toBe('/api/v1/chats/c1/outgoing')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ id: '0193a1c2-0000-7000-8000-000000000001', text: 'On my way' })
    expect(queued.status).toBe('waiting')
  })

  it('cancels and tries a reply again', async () => {
    const { api, calls } = recording(reply('r/1', 'c1'))
    const chats = phoneChatApi(api)

    await chats.cancelReply('r/1')
    await chats.retryReply('r/1')

    expect(calls.map((call) => [call.init?.method, call.path])).toEqual([
      ['DELETE', '/api/v1/chat-outgoing/r%2F1'],
      ['POST', '/api/v1/chat-outgoing/r%2F1/retry'],
    ])
  })

  it('changes a chat as a merge patch', async () => {
    const { api, calls } = recording(chat('c1', { readThrough: '2026-11-13T10:14:00.000Z' }))

    const changed = await phoneChatApi(api).updateChat('c1', { readThrough: '2026-11-13T10:14:00.000Z' })

    expect(calls[0]?.init?.method).toBe('PATCH')
    expect(new Headers(calls[0]?.init?.headers).get('Content-Type')).toBe('application/merge-patch+json')
    expect(changed.readThrough).toBe('2026-11-13T10:14:00.000Z')
  })

  it('refuses an answer that is no chat row', async () => {
    const { api } = recording({ unexpected: true })

    await expect(phoneChatApi(api).queueReply('c1', { id: 'x', text: 'Hi' })).rejects.toThrow('The server answered with a chat row the app cannot read.')
  })

  it('passes the server\'s refusal on with its code, as core reads it', async () => {
    const api = vi.fn(async () => Promise.reject(new ApiError(409, 'This reply is being sent or was sent; it can no longer be cancelled.', {}, null, 'already_going_out'))) as unknown as <T>(path: string, init?: RequestInit) => Promise<T>

    const error = await phoneChatApi(api)
      .cancelReply('r1')
      .catch((caught: unknown) => caught)

    expect(chatApiFailure(error)).toEqual({ status: 409, code: 'already_going_out', retryAfterMs: null, violationPaths: [] })
  })
})
