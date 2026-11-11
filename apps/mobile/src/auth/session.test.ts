import { describe, expect, it, vi } from 'vitest'
import type { TokenSet } from '@tresso/core'
import { ApiError, RenewalFailedError, Session, type TokenStore } from './session'

const CONFIG = { apiUrl: 'https://api.example.test/', clientId: 'mobile', redirectUri: 'tresso://auth/callback' }

function memoryStore(initial: TokenSet | null = null): TokenStore & { saved: TokenSet | null; lastUser: string | null; promptLogin: boolean; failing: boolean } {
  return {
    saved: initial,
    lastUser: initial === null ? null : 'kim',
    promptLogin: false,
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
    async forgetUser() {
      if (this.failing) {
        throw new Error('Keychain is locked.')
      }
      this.lastUser = null
    },
    async loginRequired() {
      return this.promptLogin
    },
    async setLoginRequired(required) {
      if (this.failing) {
        throw new Error('Keychain is locked.')
      }
      this.promptLogin = required
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

const REVOKE_URL = 'https://api.example.test/oauth/revoke'

/** Answers the revocation endpoint as the server does (always 200), and everything else with `rest`. */
function server(rest: Fetch): Fetch & { revoked: string[] } {
  const revoked: string[] = []
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (String(input) === REVOKE_URL) {
      revoked.push(new URLSearchParams(init!.body as URLSearchParams).get('token')!)
      return new Response(null, { status: 200 })
    }
    return rest(input, init)
  }
  return Object.assign(handler, { revoked })
}

const refused = (code = 'invalid_grant') => new Response(JSON.stringify({ error: code, error_description: 'The refresh token is invalid.' }), { status: 400 })

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

  it.each(['invalid_grant', 'invalid_request'])('ends the sign-in as expired when the refresh token is refused (%s), and keeps who it was', async (code) => {
    const store = memoryStore(expired())
    const session = await restored(store, vi.fn<Fetch>(async () => refused(code)))

    await expect(session.accessToken()).rejects.toThrow('The refresh token is invalid.')

    expect(session.snapshot.tokens).toBeNull()
    expect(session.snapshot.ended).toBe('expired')
    expect(store.saved).toBeNull()
    expect(store.lastUser).toBe('kim')
  })

  it('keeps the sign-in when the refresh request fails without an answer', async () => {
    const store = memoryStore(expired())
    const answers: (() => Promise<Response>)[] = [() => Promise.reject(new TypeError('Network request failed')), async () => tokenResponse('access-2', 'refresh-2')]
    const session = await restored(store, vi.fn<Fetch>(() => answers.shift()!()))

    const failed = session.accessToken()
    await expect(failed).rejects.toBeInstanceOf(RenewalFailedError)
    await expect(failed).rejects.toThrow('The sign-in could not be renewed right now: Network request failed')
    expect(session.snapshot.tokens?.refreshToken).toBe('refresh-1')
    expect(session.snapshot.ended).toBeNull()
    expect(store.saved?.refreshToken).toBe('refresh-1')

    expect(await session.accessToken()).toBe('access-2')
  })

  it.each([500, 502, 503])('keeps the sign-in when the token endpoint answers %i', async (status) => {
    const store = memoryStore(expired())
    const session = await restored(store, vi.fn<Fetch>(async () => new Response('<html>Bad gateway</html>', { status })))

    await expect(session.accessToken()).rejects.toThrow(`The sign-in could not be renewed right now: Token request failed (${status}).`)

    expect(session.snapshot.tokens?.refreshToken).toBe('refresh-1')
    expect(store.saved?.refreshToken).toBe('refresh-1')
    expect(session.snapshot.ended).toBeNull()
  })

  it('ends the sign-in as expired when the token expired and there is no refresh token', async () => {
    const session = await restored(memoryStore(expired(null)), vi.fn<Fetch>())

    await expect(session.accessToken()).rejects.toThrow(ApiError)
    expect(session.snapshot.tokens).toBeNull()
    expect(session.snapshot.ended).toBe('expired')
  })

  it('stays signed out when a refresh finishes after signing out, and revokes the token it brought', async () => {
    const store = memoryStore(expired())
    let respond: (response: Response) => void = () => {}
    const tokenEndpoint = vi.fn<Fetch>(() => new Promise<Response>((resolve) => (respond = resolve)))
    const fetchImpl = server(tokenEndpoint)
    const session = await restored(store, fetchImpl)

    const pending = session.accessToken()
    await vi.waitFor(() => expect(tokenEndpoint).toHaveBeenCalledOnce())
    await session.signOut()
    respond(tokenResponse('access-2', 'refresh-2'))

    await expect(pending).rejects.toThrow('Signed out.')
    expect(session.snapshot.tokens).toBeNull()
    expect(store.saved).toBeNull()
    await vi.waitFor(() => expect(fetchImpl.revoked).toEqual(['refresh-1', 'refresh-2']))
  })

  it('renews the token once and asks again when the API refuses it', async () => {
    const store = memoryStore(fresh())
    const fetchImpl = vi.fn<Fetch>(async (input, init) => {
      if (String(input).endsWith('/oauth/token')) {
        return tokenResponse('access-2', 'refresh-2')
      }
      const token = new Headers(init!.headers).get('Authorization')
      return token === 'Bearer access-2' ? new Response(JSON.stringify({ id: 'kim' })) : new Response(null, { status: 401 })
    })
    const session = await restored(store, fetchImpl)

    expect(await session.api('/api/v1/me')).toEqual({ id: 'kim' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(store.saved?.accessToken).toBe('access-2')
    expect(session.snapshot.ended).toBeNull()
  })

  it('ends the sign-in as expired when the API refuses the renewed token too', async () => {
    const store = memoryStore(fresh())
    const fetchImpl = vi.fn<Fetch>(async (input) => (String(input).endsWith('/oauth/token') ? tokenResponse('access-2', 'refresh-2') : new Response(null, { status: 401 })))
    const session = await restored(store, fetchImpl)

    await expect(session.me()).rejects.toThrow('Your session has expired. Sign in again.')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(store.saved).toBeNull()
    expect(store.lastUser).toBe('kim')
    expect(session.snapshot.ended).toBe('expired')
  })

  it('keeps the sign-in when the API refuses the token and the renewal gets no answer', async () => {
    const store = memoryStore(fresh())
    const fetchImpl = vi.fn<Fetch>(async (input) => {
      if (String(input).endsWith('/oauth/token')) {
        throw new TypeError('Network request failed')
      }
      return new Response(null, { status: 401 })
    })
    const session = await restored(store, fetchImpl)

    await expect(session.me()).rejects.toBeInstanceOf(RenewalFailedError)
    expect(session.snapshot.tokens?.accessToken).toBe('access-1')
    expect(store.saved?.accessToken).toBe('access-1')
    expect(session.snapshot.ended).toBeNull()
  })

  it('ends the sign-in when the API refuses the token and there is no refresh token', async () => {
    const store = memoryStore(fresh('access-1', null))
    const fetchImpl = vi.fn<Fetch>(async () => new Response(null, { status: 401 }))
    const session = await restored(store, fetchImpl)

    await expect(session.me()).rejects.toThrow('Your session has expired. Sign in again.')
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(session.snapshot.ended).toBe('expired')
  })

  it('revokes the refresh token on sign-out, then forgets the tokens and who was signed in', async () => {
    const store = memoryStore(fresh())
    const fetchImpl = server(vi.fn<Fetch>())
    const session = await restored(store, fetchImpl)

    await session.signOut()

    expect(fetchImpl.revoked).toEqual(['refresh-1'])
    expect(session.snapshot.tokens).toBeNull()
    expect(session.snapshot.ended).toBe('signedOut')
    expect(store.saved).toBeNull()
    expect(store.lastUser).toBeNull()
  })

  it('signs out when the server cannot be told to revoke the token', async () => {
    const store = memoryStore(fresh())
    const session = await restored(store, vi.fn<Fetch>(async () => Promise.reject(new TypeError('Network request failed'))))

    await session.signOut()

    expect(session.snapshot.ended).toBe('signedOut')
    expect(store.saved).toBeNull()
  })

  it('does not wait long for a revocation that gets no answer', async () => {
    vi.useFakeTimers()
    try {
      const store = memoryStore(fresh())
      const session = await restored(store, vi.fn<Fetch>(() => new Promise<Response>(() => undefined)))

      const signingOut = session.signOut()
      await vi.advanceTimersByTimeAsync(5_000)
      await signingOut

      expect(store.saved).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets who was signed in last before keeping a new sign-in', async () => {
    const store = memoryStore()
    store.lastUser = 'lisa'
    const session = await restored(store, vi.fn<Fetch>(async () => tokenResponse('access-2', 'refresh-2')))

    await session.completeSignIn('the-code', 'the-verifier')

    expect(store.lastUser).toBeNull()
    expect(session.snapshot).toMatchObject({ restored: false, ended: null })
  })

  it('tries reading the kept sign-in again after it failed', async () => {
    const store = memoryStore(fresh())
    const load = store.load.bind(store)
    store.load = async () => {
      throw new Error('Keychain is not available yet.')
    }
    const session = await restored(store, vi.fn<Fetch>())
    expect(session.snapshot.restoreFailed).toBe(true)

    store.load = load
    await session.restore()

    expect(session.snapshot).toMatchObject({ restoreFailed: false, restored: true, storageError: null, ended: null })
    expect(session.snapshot.tokens?.accessToken).toBe('access-1')
  })

  it('keeps a sign-in made while the kept one was being read again', async () => {
    const store = memoryStore(fresh('access-old'))
    let finish: (tokens: TokenSet | null) => void = () => undefined
    store.load = () => new Promise((resolve) => (finish = resolve))
    const session = new Session(CONFIG, store, vi.fn<Fetch>(async () => tokenResponse('access-2', 'refresh-2')))

    const reading = session.restore()
    await session.completeSignIn('the-code', 'the-verifier')
    finish(fresh('access-old'))
    await reading

    expect(session.snapshot.tokens?.accessToken).toBe('access-2')
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

  it('does not keep a new sign-in when who was signed in last cannot be forgotten', async () => {
    const store = memoryStore()
    store.lastUser = 'lisa'
    const session = await restored(store, vi.fn<Fetch>(async () => tokenResponse('access-2', 'refresh-2')))
    store.forgetUser = async () => {
      throw new Error('Keychain is locked.')
    }

    await session.completeSignIn('the-code', 'the-verifier')

    expect(session.snapshot.tokens?.accessToken).toBe('access-2')
    expect(store.saved).toBeNull()
    expect(session.snapshot.storageError).toContain('could not be kept on this device')
  })

  it('asks for the password at the next sign-in after a sign-out, also after a restart, until a sign-in completes', async () => {
    const store = memoryStore(fresh())
    const fetchImpl = server(async () => tokenResponse('access-2', 'refresh-2'))
    const session = await restored(store, fetchImpl)
    expect(await session.loginRequired()).toBe(false)

    await session.signOut()
    expect(await session.loginRequired()).toBe(true)

    const afterRestart = await restored(store, fetchImpl)
    expect(await afterRestart.loginRequired()).toBe(true)

    await afterRestart.completeSignIn('the-code', 'the-verifier')
    expect(await afterRestart.loginRequired()).toBe(false)
    expect(await (await restored(store, fetchImpl)).loginRequired()).toBe(false)
  })

  it('does not ask for the password at the next sign-in after the sign-in expired', async () => {
    const store = memoryStore(expired())
    const session = await restored(store, vi.fn<Fetch>(async () => refused()))

    await expect(session.accessToken()).rejects.toThrow()

    expect(session.snapshot.ended).toBe('expired')
    expect(await session.loginRequired()).toBe(false)
  })

  it('asks for the password when the store cannot say whether it has to', async () => {
    const store = memoryStore()
    store.loginRequired = async () => {
      throw new Error('Keychain is locked.')
    }
    const session = await restored(store, vi.fn<Fetch>())

    expect(await session.loginRequired()).toBe(true)
  })

  it('starts no refresh while the sign-out waits for the revocation', async () => {
    vi.useFakeTimers()
    try {
      const store = memoryStore(expired())
      const tokenEndpoint = vi.fn<Fetch>(async () => tokenResponse('access-2', 'refresh-2'))
      const fetchImpl = vi.fn<Fetch>(async (input, init) => (String(input) === REVOKE_URL ? new Promise<Response>(() => undefined) : tokenEndpoint(input, init)))
      const session = await restored(store, fetchImpl)

      const signingOut = session.signOut()
      await expect(session.accessToken()).rejects.toMatchObject({ status: 401 })
      await expect(session.api('/api/v1/me')).rejects.toMatchObject({ status: 401 })
      await vi.advanceTimersByTimeAsync(5_000)
      await signingOut

      expect(tokenEndpoint).not.toHaveBeenCalled()
      expect(session.snapshot.tokens).toBeNull()
      expect(store.saved).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('finishes a sign-out that was cut off at the next launch, so the mail on the phone goes too', async () => {
    const store = memoryStore(fresh())
    store.promptLogin = true
    const fetchImpl = server(vi.fn<Fetch>())

    const session = await restored(store, fetchImpl)

    expect(session.snapshot).toMatchObject({ tokens: null, ended: 'signedOut', restored: false })
    expect(store.saved).toBeNull()
    expect(store.lastUser).toBeNull()
    await vi.waitFor(() => expect(fetchImpl.revoked).toEqual(['refresh-1']))
  })

  it('says a launch after a sign-out is signed out, and one after an expired sign-in is not', async () => {
    const afterSignOut = memoryStore()
    afterSignOut.promptLogin = true
    expect((await restored(afterSignOut, vi.fn<Fetch>())).snapshot.ended).toBe('signedOut')

    const afterExpiry = memoryStore()
    afterExpiry.lastUser = 'kim'
    expect((await restored(afterExpiry, vi.fn<Fetch>())).snapshot.ended).toBeNull()
  })

  it('a refresh after a failed forget does not keep the tokens until the last user is forgotten', async () => {
    const store = memoryStore()
    store.lastUser = 'lisa'
    let issued = 1
    const refused = new Set(['access-2'])
    const fetchImpl = vi.fn<Fetch>(async (input, init) => {
      if (String(input).endsWith('/oauth/token')) {
        issued++
        return tokenResponse(`access-${issued}`, `refresh-${issued}`)
      }
      const token = new Headers(init!.headers).get('Authorization')!.replace('Bearer ', '')
      return refused.has(token) ? new Response(null, { status: 401 }) : new Response(JSON.stringify({ id: 'kim' }))
    })
    const session = await restored(store, fetchImpl)
    const forget = store.forgetUser.bind(store)
    store.forgetUser = async () => {
      throw new Error('Keychain is locked.')
    }

    await session.completeSignIn('the-code', 'the-verifier')
    await session.me()
    expect(session.snapshot.tokens?.accessToken).toBe('access-3')
    expect(store.saved).toBeNull()
    expect(store.lastUser).toBe('lisa')

    store.forgetUser = forget
    refused.add('access-3')
    await session.me()

    expect(store.lastUser).toBeNull()
    expect(store.saved?.accessToken).toBe('access-4')
  })

  it('removes the tokens on sign-out only after a save that already started', async () => {
    const store = memoryStore(expired())
    const save = store.save.bind(store)
    let release: () => void = () => undefined
    store.save = async (tokens) => {
      if (tokens !== null) {
        await new Promise<void>((resolve) => (release = resolve))
      }
      await save(tokens)
    }
    const session = await restored(store, server(async () => tokenResponse('access-2', 'refresh-2')))

    const refreshed = session.accessToken()
    await vi.waitFor(() => expect(session.snapshot.tokens?.accessToken).toBe('access-2'))
    const signingOut = session.signOut()
    release()
    await Promise.all([refreshed, signingOut])

    expect(store.saved).toBeNull()
    expect(session.snapshot.tokens).toBeNull()
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
    const session = await restored(memoryStore(fresh()), server(() => new Promise<Response>((resolve) => (answer = resolve))))
    const request = session.api('/api/v1/me')
    await Promise.resolve()

    await session.signOut()
    answer(new Response('{}', { status: 402 }))

    await expect(request).rejects.toMatchObject({ status: 402 })
    expect(session.snapshot.paymentRequired).toBe(false)
  })

  it('does not sign out a newer session for a 401 that answers the previous one', async () => {
    let answer: (response: Response) => void = () => undefined
    const store = memoryStore(fresh())
    const session = await restored(store, server(() => new Promise<Response>((resolve) => (answer = resolve))))
    const request = session.api('/api/v1/me')
    await Promise.resolve()

    await session.signOut()
    // Someone signs in again, as a completed sign-in leaves the store.
    store.saved = fresh('access-2')
    store.promptLogin = false
    await session.restore()
    answer(new Response('{}', { status: 401 }))

    await expect(request).rejects.toMatchObject({ status: 401 })
    expect(session.snapshot.tokens?.accessToken).toBe('access-2')
  })
})
