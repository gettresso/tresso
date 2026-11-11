import { describe, expect, it, vi } from 'vitest'
import { authorizationEndpoint } from './authorizationEndpoint'

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const metadata = (body: unknown, status = 200): Fetch => vi.fn<Fetch>(async () => new Response(JSON.stringify(body), { status }))

describe('authorizationEndpoint', () => {
  it('follows the sign-in address the server names in its metadata', async () => {
    const fetchImpl = metadata({ issuer: 'https://api.example.test', authorization_endpoint: 'https://app.example.test/oauth/authorize' })

    expect(await authorizationEndpoint('https://api.example.test/', fetchImpl)).toBe('https://app.example.test/oauth/authorize')
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe('https://api.example.test/.well-known/oauth-authorization-server')
  })

  it.each([
    ['the metadata cannot be fetched', vi.fn<Fetch>(async () => Promise.reject(new TypeError('Network request failed')))],
    ['the server has no metadata', metadata({}, 404)],
    ['the metadata names no address', metadata({ issuer: 'https://api.example.test' })],
    ['the address is not a URL', metadata({ authorization_endpoint: 'not a url' })],
    ['the address is plain http for an https server', metadata({ authorization_endpoint: 'http://app.example.test/oauth/authorize' })],
    ['the address uses another scheme', metadata({ authorization_endpoint: 'javascript:alert(1)' })],
  ])('signs in at the API address when %s', async (_case, fetchImpl) => {
    expect(await authorizationEndpoint('https://api.example.test', fetchImpl)).toBe('https://api.example.test/oauth/authorize')
  })

  it('accepts a plain http sign-in page from a development server reached over http', async () => {
    expect(await authorizationEndpoint('http://localhost:8000', metadata({ authorization_endpoint: 'http://localhost:5173/oauth/authorize' }))).toBe('http://localhost:5173/oauth/authorize')
  })

  it('signs in at the API address when the metadata does not come within five seconds, and not sooner', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn<Fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      )
      let settled: string | null = null

      void authorizationEndpoint('https://api.example.test', fetchImpl).then((endpoint) => (settled = endpoint))
      await vi.advanceTimersByTimeAsync(4_999)
      expect(settled).toBeNull()
      await vi.advanceTimersByTimeAsync(1)

      expect(settled).toBe('https://api.example.test/oauth/authorize')
    } finally {
      vi.useRealTimers()
    }
  })
})
