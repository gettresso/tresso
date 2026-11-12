import { describe, expect, it, vi } from 'vitest'
import { codeChallenge, exchangeCode, OAuthError, parseCallback, refreshRefusalEndsSession, revokeToken, startAuthorization } from './oauth'

const config = { apiUrl: 'http://api.test/', clientId: 'web', redirectUri: 'http://app.test/auth/callback' }

describe('PKCE', () => {
  it('derives the S256 challenge as base64url(sha256(verifier)) without padding', async () => {
    // Expected value cross-checked with Python: base64.urlsafe_b64encode(hashlib.sha256(v).digest()).rstrip(b'=')
    expect(await codeChallenge('dBjftJeZ4CVP-mJ92K1i8DgNXCPP2yuKoaFT0dcwAAc')).toBe(
      'LG8uW6-wPvkqy07ektBRBnOh8P8NoW3LWcphpLhgKGA',
    )
  })

  it('builds an authorize URL with S256 challenge and state', async () => {
    const pending = await startAuthorization(config)
    const url = new URL(pending.url)

    expect(url.origin + url.pathname).toBe('http://api.test/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('web')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(await codeChallenge(pending.codeVerifier))
    expect(url.searchParams.get('state')).toBe(pending.state)
    expect(pending.codeVerifier.length).toBeGreaterThanOrEqual(43)
  })

  it('sends the browser to the sign-in address when it differs from the API address', async () => {
    const pending = await startAuthorization({ ...config, authorizeUrl: 'https://app.test/oauth/authorize' })
    const url = new URL(pending.url)

    expect(url.origin + url.pathname).toBe('https://app.test/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('web')
  })

  it('asks for the password again when told to, and only then', async () => {
    const forced = new URL((await startAuthorization(config, { prompt: 'login' })).url)
    const plain = new URL((await startAuthorization(config)).url)

    expect(forced.searchParams.get('prompt')).toBe('login')
    expect(plain.searchParams.has('prompt')).toBe(false)
  })

  it('falls back to the API address for an empty sign-in address', async () => {
    const pending = await startAuthorization({ ...config, authorizeUrl: '' })

    expect(pending.url.startsWith('http://api.test/oauth/authorize?')).toBe(true)
  })
})

describe('parseCallback', () => {
  it('returns the code when the state matches', () => {
    expect(parseCallback('http://app.test/auth/callback?code=abc&state=s1', 's1')).toBe('abc')
  })

  it('rejects a state mismatch', () => {
    expect(() => parseCallback('http://app.test/auth/callback?code=abc&state=other', 's1')).toThrow(OAuthError)
  })

  it('surfaces authorization server errors', () => {
    expect(() =>
      parseCallback('http://app.test/auth/callback?error=access_denied&error_description=Denied&state=s1', 's1'),
    ).toThrow('Denied')
  })
})

describe('exchangeCode', () => {
  it('posts the verifier and maps the token response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' }),
    )

    const tokens = await exchangeCode(config, 'code1', 'verifier1', fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://api.test/oauth/token')
    const body = new URLSearchParams(String(init?.body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code_verifier')).toBe('verifier1')
    expect(tokens.accessToken).toBe('at')
    expect(tokens.refreshToken).toBe('rt')
  })

  it('throws the server error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ error: 'invalid_grant', error_description: 'Code expired' }, { status: 400 }),
    )

    await expect(exchangeCode(config, 'c', 'v', fetchImpl)).rejects.toMatchObject({ code: 'invalid_grant' })
  })

  it('fails with the reason when the body of the answer does not arrive', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('no answer within 20 seconds'))
      },
    })
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(stalled, { status: 200 }))

    const failure = await exchangeCode(config, 'c', 'v', fetchImpl).catch((error: unknown) => error)

    expect(failure).not.toBeInstanceOf(OAuthError)
    expect(failure).toMatchObject({ message: 'no answer within 20 seconds' })
  })
})

describe('revokeToken', () => {
  it('posts the refresh token to the revocation endpoint of the API address (RFC 7009)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }))

    await revokeToken({ ...config, authorizeUrl: 'https://app.test/oauth/authorize' }, 'rt', fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://api.test/oauth/revoke')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(String(init?.body))
    expect(Object.fromEntries(body)).toEqual({ token: 'rt', token_type_hint: 'refresh_token', client_id: 'web' })
  })

  it('throws when the server does not confirm', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }))

    await expect(revokeToken(config, 'rt', fetchImpl)).rejects.toMatchObject({ name: 'OAuthError', code: 'temporarily_unavailable' })
  })
})

describe('refreshRefusalEndsSession', () => {
  it('ends the session only when the token endpoint says the sign-in itself is over, on every client', () => {
    expect(refreshRefusalEndsSession(new OAuthError('Refused', 'invalid_grant'))).toBe(true)
    expect(refreshRefusalEndsSession(new OAuthError('Refused', 'invalid_request'))).toBe(true)
    // The server does not know or allow the app for a moment (a deploy): a new sign-in would not cure that either.
    expect(refreshRefusalEndsSession(new OAuthError('Refused', 'invalid_client'))).toBe(false)
    expect(refreshRefusalEndsSession(new OAuthError('Refused', 'unauthorized_client'))).toBe(false)
    expect(refreshRefusalEndsSession(new OAuthError('Failed', null))).toBe(false)
    expect(refreshRefusalEndsSession(new Error('offline'))).toBe(false)
  })
})
