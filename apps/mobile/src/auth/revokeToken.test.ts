import { describe, expect, it, vi } from 'vitest'
import { OAuthError } from '@tresso/core'
import { revokeToken } from './revokeToken'

const CONFIG = { apiUrl: 'https://api.example.test/', clientId: 'mobile', redirectUri: 'tresso://auth/callback' }

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

describe('revokeToken', () => {
  it('posts the refresh token form encoded to the revocation endpoint', async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response(null, { status: 200 }))

    await revokeToken(CONFIG, 'refresh-1', fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.example.test/oauth/revoke')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({ token: 'refresh-1', token_type_hint: 'refresh_token', client_id: 'mobile' })
  })

  it('rejects when the server does not confirm', async () => {
    await expect(revokeToken(CONFIG, 'refresh-1', vi.fn<Fetch>(async () => new Response(null, { status: 503 })))).rejects.toEqual(new OAuthError('Token revocation failed (503).'))
  })
})
