import { describe, expect, it, vi } from 'vitest'
import type { TokenSet } from '@tresso/core'
import { ApiError, Session, type TokenStore } from './session'

const CONFIG = { apiUrl: 'https://api.example.test/', clientId: 'mobile', redirectUri: 'tresso://auth/callback' }

function memoryStore(initial: TokenSet | null = null): TokenStore & { saved: TokenSet | null; failing: boolean } {
  return {
    saved: initial,
    failing: false,
    async load() {
      return this.saved
    },
    async save(tokens) {
      if (this.failing) {
        throw new Error('Keychain is locked.')
      }
      this.saved = tokens
    },
  }
}

const fresh = (accessToken = 'access-1', refreshToken: string | null = 'refresh-1'): TokenSet => ({
  accessToken,
  refreshToken,
  expiresAt: Date.now() + 3_600_000,
})
const expired = (refreshToken: string | null = 'refresh-1'): TokenSet => ({ accessToken: 'old', refreshToken, expiresAt: Date.now() - 1 })

function tokenResponse(accessToken: string, refreshToken: string): Response {
  return new Response(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 }), { status: 200 })
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

async function restored(store: TokenStore, fetchImpl: Fetch): Promise<Session> {
  const session = new Session(CONFIG, store, fetchImpl)
  await session.restore()
  return session
}

describe('Session', () => {
  it('restores the sign-in kept from the previous launch', async () => {
    const session = await restored(memoryStore(fresh()), vi.fn<Fetch>())

    expect(session.snapshot.tokens?.accessToken).toBe('access-1')
  })

  it('reports a store it cannot read instead of pretending to be signed out', async () => {
    const store = memoryStore()
    store.load = async () => {
      throw new Error('Keychain is locked.')
    }

    const session = await restored(store, vi.fn<Fetch>())

    expect(session.snapshot.tokens).toBeNull()
    expect(session.snapshot.storageError).toBe('The saved sign-in could not be read: Keychain is locked.')
  })

  it('exchanges the code with its verifier and keeps the tokens', async () => {
    const store = memoryStore()
    const fetchImpl = vi.fn<Fetch>(async () => tokenResponse('access-2', 'refresh-2'))
    const session = await restored(store, fetchImpl)

    await session.completeSignIn('the-code', 'the-verifier')

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.example.test/oauth/token')
    expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: 'the-verifier',
      redirect_uri: 'tresso://auth/callback',
      client_id: 'mobile',
    })
    expect(store.saved?.accessToken).toBe('access-2')
    expect(session.snapshot.tokens?.refreshToken).toBe('refresh-2')
  })

  it('sends API requests with the access token', async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response(JSON.stringify({ id: 'u1', email: 'kim@example.test', displayName: 'Kim' })))
    const session = await restored(memoryStore(fresh()), fetchImpl)

    expect(await session.me()).toEqual({ id: 'u1', email: 'kim@example.test', displayName: 'Kim' })
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.example.test/api/v1/me')
    expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer access-1')
  })

  it('refreshes an expired token once for requests that need it at the same time', async () => {
    const store = memoryStore(expired())
    const fetchImpl = vi.fn<Fetch>(async () => tokenResponse('access-2', 'refresh-2'))
    const session = await restored(store, fetchImpl)

    const tokens = await Promise.all([session.accessToken(), session.accessToken(), session.accessToken()])

    expect(tokens).toEqual(['access-2', 'access-2', 'access-2'])
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(store.saved).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' })
  })

  it('signs out when the refresh token is refused', async () => {
    const store = memoryStore(expired())
    const fetchImpl = vi.fn<Fetch>(async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'The refresh token is invalid.' }), { status: 400 }))
    const session = await restored(store, fetchImpl)

    await expect(session.accessToken()).rejects.toThrow('The refresh token is invalid.')

    expect(session.snapshot.tokens).toBeNull()
    expect(store.saved).toBeNull()
  })

  it('signs out when the token expired and there is no refresh token', async () => {
    const session = await restored(memoryStore(expired(null)), vi.fn<Fetch>())

    await expect(session.accessToken()).rejects.toThrow(ApiError)
    expect(session.snapshot.tokens).toBeNull()
  })

  it('stays signed out when a refresh finishes after signing out', async () => {
    const store = memoryStore(expired())
    let respond: (response: Response) => void = () => {}
    const fetchImpl = vi.fn<Fetch>(() => new Promise<Response>((resolve) => (respond = resolve)))
    const session = await restored(store, fetchImpl)

    const pending = session.accessToken()
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    await session.signOut()
    respond(tokenResponse('access-2', 'refresh-2'))

    await expect(pending).rejects.toThrow('Signed out.')
    expect(session.snapshot.tokens).toBeNull()
    expect(store.saved).toBeNull()
  })

  it('signs out when the API says the token is no longer valid', async () => {
    const store = memoryStore(fresh())
    const session = await restored(store, vi.fn<Fetch>(async () => new Response(null, { status: 401 })))

    await expect(session.me()).rejects.toThrow('Your session has expired. Sign in again.')
    expect(store.saved).toBeNull()
  })

  it('passes on what the API said went wrong', async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response(JSON.stringify({ title: 'An error occurred', detail: 'The account is paused.' }), { status: 409 }))
    const session = await restored(memoryStore(fresh()), fetchImpl)

    await expect(session.me()).rejects.toEqual(new ApiError(409, 'The account is paused.'))
  })

  it('says so when the tokens cannot be kept or removed', async () => {
    const store = memoryStore()
    const session = await restored(store, vi.fn<Fetch>(async () => tokenResponse('access-2', 'refresh-2')))
    store.failing = true

    await session.completeSignIn('the-code', 'the-verifier')
    expect(session.snapshot.tokens?.accessToken).toBe('access-2')
    expect(session.snapshot.storageError).toBe('The sign-in could not be kept on this device, so you will have to sign in again next time: Keychain is locked.')

    await session.signOut()
    expect(session.snapshot.tokens).toBeNull()
    expect(session.snapshot.storageError).toBe('You are signed out here, but the sign-in could not be removed from this device: Keychain is locked.')
  })

  it('tells subscribers about every change', async () => {
    const session = new Session(CONFIG, memoryStore(fresh()), vi.fn<Fetch>())
    const listener = vi.fn<() => void>()
    const unsubscribe = session.subscribe(listener)

    await session.restore()
    unsubscribe()
    await session.signOut()

    expect(listener).toHaveBeenCalledOnce()
  })

  it('covers the app on 402 until a served request shows the user may use it again', async () => {
    const answers = [
      new Response(JSON.stringify({ title: 'Payment Required', status: 402 }), { status: 402 }),
      new Response(JSON.stringify({ enabled: true, entitled: false }), { status: 200 }),
      new Response(JSON.stringify({ id: 'kim' }), { status: 200 }),
    ]
    const session = await restored(memoryStore(fresh()), vi.fn<Fetch>(async () => answers.shift()!))

    await expect(session.api('/api/v1/me')).rejects.toMatchObject({ status: 402 })
    expect(session.snapshot.paymentRequired).toBe(true)

    await session.api('/api/v1/billing')
    expect(session.snapshot.paymentRequired).toBe(true)

    await session.api('/api/v1/me')
    expect(session.snapshot.paymentRequired).toBe(false)
  })

  it('takes the payment notice down on sign-out', async () => {
    const session = await restored(memoryStore(fresh()), vi.fn<Fetch>(async () => new Response('{}', { status: 402 })))
    await expect(session.api('/api/v1/me')).rejects.toMatchObject({ status: 402 })

    await session.signOut()

    expect(session.snapshot.paymentRequired).toBe(false)
  })

  it('ignores a 402 that answers a request from before the sign-out', async () => {
    let answer: (response: Response) => void = () => undefined
    const session = await restored(memoryStore(fresh()), vi.fn<Fetch>(() => new Promise<Response>((resolve) => (answer = resolve))))
    const request = session.api('/api/v1/me')
    await Promise.resolve()

    await session.signOut()
    answer(new Response('{}', { status: 402 }))

    await expect(request).rejects.toMatchObject({ status: 402 })
    expect(session.snapshot.paymentRequired).toBe(false)
  })
})
