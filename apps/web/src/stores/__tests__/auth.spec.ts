import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Me, TokenSet } from '@tresso/core'

const desktop = vi.hoisted(() => ({
  isDesktop: false,
  keychain: null as string | null,
  keychainFails: false,
  opened: [] as string[],
}))

vi.mock('@/platform/desktop', () => ({
  get isDesktop() {
    return desktop.isDesktop
  },
  loadKeychainTokens: async () => desktop.keychain,
  saveKeychainTokens: async (tokens: string) => {
    if (desktop.keychainFails) {
      throw new Error('User canceled the operation.')
    }
    desktop.keychain = tokens
  },
  clearKeychainTokens: async () => {
    if (desktop.keychainFails) {
      throw new Error('User canceled the operation.')
    }
    desktop.keychain = null
  },
  openInBrowser: async (url: string) => {
    desktop.opened.push(url)
  },
}))

const push = vi.hoisted(() => ({ disabled: 0 }))

vi.mock('@/platform/webPush', () => ({
  disableWebPush: async () => {
    push.disabled += 1
  },
}))

// The browser's local storage, kept in memory.
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

const TOKENS: TokenSet = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }

/** Loads the store fresh, so its platform (web or desktop) is read again. */
async function authStore() {
  vi.resetModules()
  setActivePinia(createPinia())
  const { useAuthStore } = await import('@/stores/auth')
  return useAuthStore()
}

const EXPIRED: TokenSet = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() - 1000 }

/** The browser's Web Locks API for one origin: a request runs once the previous holder of the same name is done. */
function stubLocks(): void {
  const held = new Map<string, Promise<unknown>>()
  const locks = {
    request: (name: string, run: () => Promise<unknown>) => {
      const previous = held.get(name) ?? Promise.resolve()
      const mine = previous.catch(() => undefined).then(run)
      held.set(name, mine)
      return mine
    },
  }
  vi.stubGlobal('navigator', { ...navigator, locks })
}

interface FakeServer {
  /** Refresh requests, by the refresh token they sent. */
  refreshes: string[]
  /** Revocation requests, by the token they sent. */
  revoked: string[]
  /** API requests, by the access token they sent. */
  calls: { path: string; token: string }[]
}

/**
 * An authorization server whose refresh tokens rotate (a used one is refused with invalid_grant) and an API that
 * accepts only the access token issued last, unless `api` says otherwise.
 */
function stubServer(options: {
  refresh?: (refreshToken: string, server: FakeServer) => Response | Promise<Response>
  api?: (path: string, token: string, server: FakeServer) => Response | Promise<Response>
} = {}): FakeServer {
  const server: FakeServer = { refreshes: [], revoked: [], calls: [] }
  let issued = 1
  let current = 'refresh-1'
  let access = 'access-1'
  const rotate = (refreshToken: string): Response => {
    if (refreshToken !== current) {
      return Response.json({ error: 'invalid_grant', error_description: 'The refresh token is invalid.' }, { status: 400 })
    }
    issued += 1
    current = `refresh-${issued}`
    access = `access-${issued}`
    return Response.json({ access_token: access, refresh_token: current, expires_in: 3600, token_type: 'Bearer' })
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/oauth/token') {
        const refreshToken = new URLSearchParams(String(init?.body)).get('refresh_token')!
        server.refreshes.push(refreshToken)
        return options.refresh ? options.refresh(refreshToken, server) : rotate(refreshToken)
      }
      if (url.pathname === '/oauth/revoke') {
        server.revoked.push(new URLSearchParams(String(init?.body)).get('token')!)
        return new Response(null, { status: 200 })
      }
      const token = new Headers(init?.headers).get('Authorization')!.replace('Bearer ', '')
      server.calls.push({ path: url.pathname, token })
      if (options.api) {
        return options.api(url.pathname, token, server)
      }
      return token === access ? Response.json({ id: 'user-1' }) : Response.json({ title: 'Unauthorized' }, { status: 401 })
    }),
  )
  return server
}

/**
 * Runs `work` with fake timers that move on until it settles, so the wait before a lost answer is asked for again,
 * and a timeout, take no real time. The clock itself stays real.
 */
async function withoutWaiting<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let settled: { ok: true; value: T } | { ok: false; error: unknown } | undefined
    void work().then(
      (value) => (settled = { ok: true, value }),
      (error: unknown) => (settled = { ok: false, error }),
    )
    while (settled === undefined) {
      await vi.advanceTimersByTimeAsync(500)
    }
    const outcome = settled as { ok: true; value: T } | { ok: false; error: unknown }
    if (!outcome.ok) {
      throw outcome.error
    }
    return outcome.value
  } finally {
    vi.useRealTimers()
  }
}

/** The forms the page submitted (sign-out ends the browser session of the sign-in pages with one). */
function captureForms(): HTMLFormElement[] {
  const submitted: HTMLFormElement[] = []
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
    submitted.push(this)
  })
  return submitted
}

function stubTokenEndpoint(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' }), { status: 200 })),
  )
}

/** Starts a sign-in and returns the callback URL the authorization server would send back. */
async function startSignIn(auth: Awaited<ReturnType<typeof authStore>>, opened: () => string): Promise<string> {
  await auth.signIn()
  const state = new URL(opened()).searchParams.get('state')
  return `tresso://auth/callback?code=the-code&state=${state}`
}

describe('auth store', () => {
  beforeEach(() => {
    desktop.isDesktop = false
    desktop.keychain = null
    desktop.keychainFails = false
    desktop.opened = []
    vi.stubGlobal('localStorage', memoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  describe('in the browser', () => {
    it('stops this browser getting the user\'s pushes on sign-out, telling the server while it still can', async () => {
      push.disabled = 0
      stubServer()
      vi.stubGlobal('location', { ...window.location, assign: vi.fn<(url: string) => void>() })
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      await auth.signOut()

      expect(push.disabled).toBe(1)
      expect(auth.isAuthenticated).toBe(false)
    })

    it('keeps the pushes when the session expires, as a closed tab does, so signing in again finds them on', async () => {
      push.disabled = 0
      localStorage.setItem('auth.tokens', JSON.stringify({ ...TOKENS, refreshToken: null, expiresAt: Date.now() - 1000 }))
      const auth = await authStore()

      await expect(auth.api('/api/v1/me')).rejects.toThrow('Your session has expired.')

      await vi.waitFor(() => expect(auth.isAuthenticated).toBe(false))
      expect(push.disabled).toBe(0)
      expect(auth.sessionEnd).toBe('expired')
    })

    it('keeps the tokens in localStorage and forgets them on sign-out', async () => {
      stubServer()
      vi.stubGlobal('location', { ...window.location, assign: vi.fn<(url: string) => void>() })
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()
      expect(auth.isAuthenticated).toBe(true)

      auth.signOut()
      await vi.waitFor(() => expect(localStorage.getItem('auth.tokens')).toBeNull())
      expect(auth.isAuthenticated).toBe(false)
    })

    it('revokes the refresh token, forgets the tokens, and ends the browser session at the sign-in pages', async () => {
      const server = stubServer()
      const forms = captureForms()
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()
      const order: string[] = []
      auth.onSessionEnd((reason) => {
        order.push(`ended: ${reason}`)
      })

      await auth.signOut()

      expect(server.revoked).toEqual(['refresh-1'])
      expect(localStorage.getItem('auth.tokens')).toBeNull()
      expect(order).toEqual(['ended: signedOut'])
      // A POST: the sign-in pages only sign out on a POST from the app (a GET shows a page with a button).
      expect(forms).toHaveLength(1)
      expect(forms[0]!.method).toBe('post')
      expect(forms[0]!.action).toBe('http://localhost:8080/logout')
      expect(forms[0]!.isConnected).toBe(true)
      expect(auth.sessionEnd).toBe('signedOut')
    })

    it('signs out though the server cannot revoke the token', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
      const forms = captureForms()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      await auth.signOut()

      expect(auth.isAuthenticated).toBe(false)
      expect(localStorage.getItem('auth.tokens')).toBeNull()
      expect(forms).toHaveLength(1)
    })

    it('refreshes once for requests that all find the token expired, and keeps the user signed in', async () => {
      const server = stubServer()
      localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
      const auth = await authStore()

      await Promise.all([auth.api('/api/v1/me'), auth.api('/api/v1/accounts'), auth.api('/api/v1/todos')])

      expect(server.refreshes).toEqual(['refresh-1'])
      expect(server.calls.map((call) => call.token)).toEqual(['access-2', 'access-2', 'access-2'])
      expect(auth.isAuthenticated).toBe(true)
      expect(JSON.parse(localStorage.getItem('auth.tokens')!)).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' })
    })

    it('keeps the tokens when the token endpoint cannot be reached, and says it tries again', async () => {
      const server = stubServer({ refresh: () => Promise.reject(new TypeError('Failed to fetch')) })
      localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
      const auth = await authStore()

      const failed = withoutWaiting(() => auth.api('/api/v1/me'))

      await expect(failed).rejects.toMatchObject({ name: 'SignInRenewalError' })
      await expect(failed).rejects.toThrow('It tries again with the next request.')
      // Asked twice: once more after a moment, as the answer may only have been lost on the way.
      expect(server.refreshes).toEqual(['refresh-1', 'refresh-1'])
      expect(auth.isAuthenticated).toBe(true)
      expect(auth.sessionEnd).toBeNull()
      expect(JSON.parse(localStorage.getItem('auth.tokens')!)).toEqual(EXPIRED)
      expect(server.calls).toEqual([])
    })

    it('keeps the tokens when the token endpoint fails with a server error, and refreshes on the next request', async () => {
      let failing = true
      const server = stubServer({
        refresh: () =>
          failing
            ? Response.json({ error: 'server_error' }, { status: 503 })
            : Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' }),
        api: () => Response.json({ id: 'user-1' }),
      })
      localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
      const auth = await authStore()

      await expect(auth.api('/api/v1/me')).rejects.toMatchObject({ name: 'SignInRenewalError' })
      expect(auth.isAuthenticated).toBe(true)
      failing = false
      await auth.api('/api/v1/me')

      expect(server.refreshes).toEqual(['refresh-1', 'refresh-1'])
      expect(auth.tokens?.accessToken).toBe('access-2')
    })

    it('ends the session, without removing the pushes, when the server refuses the refresh token', async () => {
      push.disabled = 0
      stubServer({ refresh: () => Response.json({ error: 'invalid_grant' }, { status: 400 }) })
      localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
      const auth = await authStore()

      await expect(auth.api('/api/v1/me')).rejects.toThrow('Your session has expired.')

      await vi.waitFor(() => expect(auth.isAuthenticated).toBe(false))
      expect(auth.sessionEnd).toBe('expired')
      expect(push.disabled).toBe(0)
      expect(localStorage.getItem('auth.tokens')).toBeNull()
    })

    it('refreshes and retries once when the API refuses a token that had not expired yet', async () => {
      const server = stubServer({
        api: (_path, token) => (token === 'access-2' ? Response.json({ id: 'user-1' }) : Response.json({}, { status: 401 })),
      })
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      await expect(auth.api<Me>('/api/v1/me')).resolves.toEqual({ id: 'user-1' })

      expect(server.refreshes).toEqual(['refresh-1'])
      expect(server.calls.map((call) => call.token)).toEqual(['access-1', 'access-2'])
      expect(auth.isAuthenticated).toBe(true)
    })

    it('ends the session when the API refuses the refreshed token too', async () => {
      const server = stubServer({ api: () => Response.json({}, { status: 401 }) })
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      await expect(auth.api('/api/v1/me')).rejects.toThrow('Your session has expired.')

      expect(server.calls).toHaveLength(2)
      await vi.waitFor(() => expect(auth.isAuthenticated).toBe(false))
      expect(auth.sessionEnd).toBe('expired')
    })

    it('keeps the user signed in when a 401 meets a token endpoint that cannot be reached', async () => {
      stubServer({ refresh: () => Promise.reject(new TypeError('Failed to fetch')), api: () => Response.json({}, { status: 401 }) })
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      await expect(withoutWaiting(() => auth.api('/api/v1/me'))).rejects.toMatchObject({ name: 'SignInRenewalError' })

      expect(auth.isAuthenticated).toBe(true)
    })

    it('asks again once when the answer to a refresh was lost, and gets the pair the server issued meanwhile', async () => {
      let lost = true
      const server = stubServer({
        refresh: (refreshToken) => {
          if (lost) {
            // The server rotated, but the answer never arrived.
            lost = false
            return Promise.reject(new TypeError('Failed to fetch'))
          }
          // Within the server's grace, the old refresh token gets the same new pair again.
          return refreshToken === 'refresh-1'
            ? Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' })
            : Response.json({ error: 'invalid_grant' }, { status: 400 })
        },
        api: () => Response.json({ id: 'user-1' }),
      })
      localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
      const auth = await authStore()

      await withoutWaiting(() => auth.api('/api/v1/me'))

      expect(server.refreshes).toEqual(['refresh-1', 'refresh-1'])
      expect(auth.isAuthenticated).toBe(true)
      expect(auth.tokens?.refreshToken).toBe('refresh-2')
    })

    it('does not ask again when the token endpoint answered with an error', async () => {
      const server = stubServer({ refresh: () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }) })
      localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
      const auth = await authStore()

      await expect(auth.api('/api/v1/me')).rejects.toMatchObject({ name: 'SignInRenewalError' })

      expect(server.refreshes).toEqual(['refresh-1'])
    })

    it('gives up on an answer whose body stalls, and lets the next refresh go', async () => {
      stubLocks()
      let stalled = true
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!String(input).endsWith('/oauth/token')) {
            return Response.json({ id: 'user-1' })
          }
          if (!stalled) {
            return Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' })
          }
          // Headers arrive, the body never does, until the request is aborted.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason))
            },
          })
          return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
        }),
      )
      localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
      const auth = await authStore()

      vi.spyOn(console, 'error').mockImplementation(() => {})
      const tokenRequests = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/oauth/token')).length

      await expect(withoutWaiting(() => auth.api('/api/v1/me'))).rejects.toThrow('no answer within 20 seconds')
      expect(tokenRequests()).toBe(2)
      stalled = false

      await expect(auth.api('/api/v1/me')).resolves.toEqual({ id: 'user-1' })
      expect(auth.tokens?.refreshToken).toBe('refresh-2')
    })

    it('ends the session when the server no longer knows the client', async () => {
      stubServer({ refresh: () => Response.json({ error: 'invalid_client' }, { status: 401 }) })
      localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
      const auth = await authStore()

      await expect(auth.api('/api/v1/me')).rejects.toThrow('Your session has expired.')

      await vi.waitFor(() => expect(auth.isAuthenticated).toBe(false))
      expect(auth.sessionEnd).toBe('expired')
    })

    it('does not set the user from an answer that arrives after a sign-out', async () => {
      let answer!: (response: Response) => void
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) =>
          String(input).endsWith('/api/v1/me') ? new Promise<Response>((resolve) => (answer = resolve)) : Promise.resolve(new Response(null, { status: 200 })),
        ),
      )
      vi.stubGlobal('location', { ...window.location, assign: vi.fn<(url: string) => void>() })
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      const loading = auth.loadMe()
      await vi.waitFor(() => expect(answer).toBeDefined())
      await auth.signOut()
      answer(Response.json({ id: 'user-1' }))

      await expect(loading).rejects.toThrow('Signed out while this request was under way.')
      expect(auth.me).toBeNull()
    })

    describe('across tabs', () => {
      it('refreshes once when two tabs find the shared token expired at the same time, and signs neither out', async () => {
        stubLocks()
        const server = stubServer()
        localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
        const first = await authStore()
        const second = await authStore()

        await Promise.all([first.api('/api/v1/me'), second.api('/api/v1/me')])

        expect(server.refreshes).toEqual(['refresh-1'])
        expect(first.isAuthenticated).toBe(true)
        expect(second.isAuthenticated).toBe(true)
        expect(second.tokens?.refreshToken).toBe('refresh-2')
      })

      it('takes the set another tab stored meanwhile when the server refuses the refresh token as used', async () => {
        const server = stubServer({
          refresh: () => {
            // Another tab (a browser without locks) rotated the token first and stored the result.
            localStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'access-9', refreshToken: 'refresh-9', expiresAt: Date.now() + 3_600_000 }))
            return Response.json({ error: 'invalid_grant' }, { status: 400 })
          },
          api: () => Response.json({ id: 'user-1' }),
        })
        localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
        const auth = await authStore()

        await auth.api('/api/v1/me')

        expect(server.calls.map((call) => call.token)).toEqual(['access-9'])
        expect(auth.isAuthenticated).toBe(true)
        expect(auth.sessionEnd).toBeNull()
      })

      it('waits for a refresh in another tab before signing out, and revokes the set that refresh stored', async () => {
        stubLocks()
        let answer!: () => void
        const server = stubServer({
          refresh: () =>
            new Promise<Response>((resolve) => {
              answer = () => resolve(Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' }))
            }),
          api: () => Response.json({ id: 'user-1' }),
        })
        captureForms()
        localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
        const signingOut = await authStore()
        const refreshing = await authStore()

        const request = refreshing.api('/api/v1/me')
        await vi.waitFor(() => expect(answer).toBeDefined())
        const signOut = signingOut.signOut()
        answer()
        await request
        await signOut

        expect(server.revoked).toEqual(['refresh-2'])
        expect(localStorage.getItem('auth.tokens')).toBeNull()
      })

      it('drops and revokes a refreshed set when another tab signed out while the refresh ran', async () => {
        let answer!: () => void
        const server = stubServer({
          refresh: () =>
            new Promise<Response>((resolve) => {
              answer = () => resolve(Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' }))
            }),
        })
        localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
        const auth = await authStore()

        const request = auth.api('/api/v1/me')
        await vi.waitFor(() => expect(answer).toBeDefined())
        // Another tab signed out; its storage event has not reached this one yet.
        localStorage.removeItem('auth.tokens')
        answer()

        await expect(request).rejects.toThrow('Not signed in.')
        expect(localStorage.getItem('auth.tokens')).toBeNull()
        await vi.waitFor(() => expect(server.revoked).toEqual(['refresh-2']))
        expect(auth.isAuthenticated).toBe(false)
        expect(auth.sessionEnd).toBe('elsewhere')
      })

      it('follows a sign-out in another tab without telling the server again', async () => {
        push.disabled = 0
        const server = stubServer()
        localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
        const auth = await authStore()
        const ended: string[] = []
        auth.onSessionEnd((reason) => {
          ended.push(reason)
        })
        const generation = auth.generation

        localStorage.removeItem('auth.tokens')
        window.dispatchEvent(new StorageEvent('storage', { key: 'auth.tokens', newValue: null }))

        await vi.waitFor(() => expect(ended).toEqual(['elsewhere']))
        expect(auth.isAuthenticated).toBe(false)
        expect(auth.generation).toBe(generation + 1)
        expect(push.disabled).toBe(0)
        expect(server.revoked).toEqual([])
      })

      it('takes a sign-in or refresh from another tab', async () => {
        stubServer()
        const auth = await authStore()
        expect(auth.isAuthenticated).toBe(false)

        window.dispatchEvent(new StorageEvent('storage', { key: 'auth.tokens', newValue: JSON.stringify(TOKENS) }))

        expect(auth.tokens).toEqual(TOKENS)
      })

      it('starts again when another tab signed in as someone else', async () => {
        stubServer({ api: () => Response.json({ id: 'user-2' }) })
        const reload = vi.fn<() => void>()
        vi.stubGlobal('location', { ...window.location, reload })
        localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
        const auth = await authStore()
        auth.me = { id: 'user-1' } as Me

        window.dispatchEvent(new StorageEvent('storage', { key: 'auth.tokens', newValue: JSON.stringify({ ...TOKENS, accessToken: 'access-2', refreshToken: 'refresh-2' }) }))

        await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
      })
    })

    it('signs in by leaving for the authorization page', async () => {
      const assign = vi.fn<(url: string) => void>()
      vi.stubGlobal('location', { ...window.location, assign, origin: window.location.origin })
      const auth = await authStore()

      await auth.signIn()

      expect(assign).toHaveBeenCalledOnce()
      expect(new URL(assign.mock.calls[0]![0]).searchParams.get('client_id')).toBe('web')
      expect(desktop.opened).toEqual([])
    })
  })

  describe('in the desktop app', () => {
    beforeEach(() => {
      desktop.isDesktop = true
    })

    it('starts signed out and restores the sign-in from the keychain', async () => {
      sessionStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      desktop.keychain = JSON.stringify({ ...TOKENS, accessToken: 'from-keychain' })
      const auth = await authStore()
      expect(auth.isAuthenticated).toBe(false)

      await auth.restore()

      expect(auth.tokens?.accessToken).toBe('from-keychain')
    })

    it('signs in through the system browser and the tresso:// link back', async () => {
      stubTokenEndpoint()
      const auth = await authStore()

      const callback = await startSignIn(auth, () => desktop.opened[0]!)
      const authorize = new URL(desktop.opened[0]!).searchParams
      expect(authorize.get('client_id')).toBe('desktop')
      expect(authorize.get('redirect_uri')).toBe('tresso://auth/callback')
      expect(auth.awaitingBrowser).toBe(true)

      await auth.completeSignIn(callback)

      expect(auth.awaitingBrowser).toBe(false)
      expect(auth.tokens?.accessToken).toBe('access-2')
      expect(JSON.parse(desktop.keychain!)).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' })
      expect(sessionStorage.getItem('auth.tokens')).toBeNull()
    })

    it('opens the sign-in under way again, so the browser tab the user had already still finishes it', async () => {
      stubTokenEndpoint()
      const auth = await authStore()
      const callback = await startSignIn(auth, () => desktop.opened[0]!)

      await auth.reopenBrowser()

      expect(desktop.opened).toEqual([desktop.opened[0], desktop.opened[0]])
      await auth.completeSignIn(callback)
      expect(auth.tokens?.accessToken).toBe('access-2')
    })

    it('starts a new sign-in when the browser is opened again without one under way', async () => {
      const auth = await authStore()

      await auth.reopenBrowser()

      expect(desktop.opened).toHaveLength(1)
      expect(auth.hasPendingSignIn()).toBe(true)
      expect(auth.awaitingBrowser).toBe(true)
    })

    it('a callback with another state leaves the pending sign-in, and the right one still completes', async () => {
      stubTokenEndpoint()
      const auth = await authStore()
      const callback = await startSignIn(auth, () => desktop.opened[0]!)

      await expect(auth.completeSignIn('tresso://auth/callback?code=stray&state=other')).rejects.toThrow('state mismatch')
      await expect(auth.completeSignIn('tresso://auth/callback?error=access_denied&state=other')).rejects.toThrow('state mismatch')
      expect(auth.hasPendingSignIn()).toBe(true)
      expect(auth.awaitingBrowser).toBe(true)

      await auth.completeSignIn(callback)
      expect(auth.tokens?.accessToken).toBe('access-2')
      expect(auth.hasPendingSignIn()).toBe(false)
    })

    it('reports an error the authorization server sent for this sign-in, and ends it', async () => {
      const auth = await authStore()
      const callback = await startSignIn(auth, () => desktop.opened[0]!)
      const state = new URL(callback).searchParams.get('state')

      await expect(auth.completeSignIn(`tresso://auth/callback?error=access_denied&error_description=Denied&state=${state}`)).rejects.toThrow('Denied')
      expect(auth.hasPendingSignIn()).toBe(false)
      expect(auth.awaitingBrowser).toBe(false)
    })

    it('knows whether a sign-in waits for its answer', async () => {
      stubTokenEndpoint()
      const auth = await authStore()
      expect(auth.hasPendingSignIn()).toBe(false)

      const callback = await startSignIn(auth, () => desktop.opened[0]!)
      expect(auth.hasPendingSignIn()).toBe(true)

      await auth.completeSignIn(callback)
      expect(auth.hasPendingSignIn()).toBe(false)
    })

    it('signs in to the server the user chose, and exchanges the code there', async () => {
      stubTokenEndpoint()
      localStorage.setItem('tresso.server', 'https://mail.example.com')
      const auth = await authStore()

      const callback = await startSignIn(auth, () => desktop.opened[0]!)
      expect(new URL(desktop.opened[0]!).origin).toBe('https://mail.example.com')
      await auth.completeSignIn(callback)

      expect(fetch).toHaveBeenCalledWith('https://mail.example.com/oauth/token', expect.anything())
    })

    it('refuses a sign-in that was started for another server', async () => {
      stubTokenEndpoint()
      const auth = await authStore()
      const callback = await startSignIn(auth, () => desktop.opened[0]!)
      const { chooseServer } = await import('@/platform/server')
      chooseServer('mail.example.com')

      await expect(auth.completeSignIn(callback)).rejects.toThrow('Sign in again.')
      expect(auth.isAuthenticated).toBe(false)
    })

    it('refreshes once for concurrent requests and keeps the sign-in through a network error', async () => {
      let offline = true
      const server = stubServer({
        refresh: () =>
          offline
            ? Promise.reject(new TypeError('Load failed'))
            : Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' }),
        api: () => Response.json({ id: 'user-1' }),
      })
      desktop.keychain = JSON.stringify(EXPIRED)
      const auth = await authStore()
      await auth.restore()

      await expect(withoutWaiting(() => Promise.all([auth.api('/api/v1/me'), auth.api('/api/v1/todos')]))).rejects.toMatchObject({ name: 'SignInRenewalError' })
      expect(auth.isAuthenticated).toBe(true)
      expect(JSON.parse(desktop.keychain!)).toEqual(EXPIRED)
      offline = false
      await Promise.all([auth.api('/api/v1/me'), auth.api('/api/v1/todos')])

      // Two while offline (the second after a moment), one once back.
      expect(server.refreshes).toEqual(['refresh-1', 'refresh-1', 'refresh-1'])
      expect(JSON.parse(desktop.keychain!)).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' })
    })

    it('revokes the refresh token on sign-out and stays in the app', async () => {
      const server = stubServer()
      const forms = captureForms()
      desktop.keychain = JSON.stringify(TOKENS)
      const auth = await authStore()
      await auth.restore()

      await auth.signOut()

      expect(server.revoked).toEqual(['refresh-1'])
      expect(desktop.keychain).toBeNull()
      // The system browser's session is left alone (docs/ARCHITECTURE.md, 3.10).
      expect(forms).toEqual([])
    })

    it('asks for the password at the first sign-in after a sign-out, also after a restart, until one completes', async () => {
      stubServer()
      desktop.keychain = JSON.stringify(TOKENS)
      const before = await authStore()
      await before.restore()
      await before.signOut()

      // The app restarts.
      const auth = await authStore()
      const callback = await startSignIn(auth, () => desktop.opened[0]!)
      expect(new URL(desktop.opened[0]!).searchParams.get('prompt')).toBe('login')
      // Opening the authorization page again still asks.
      await auth.signIn()
      expect(new URL(desktop.opened[1]!).searchParams.get('prompt')).toBe('login')
      stubTokenEndpoint()
      await auth.completeSignIn(`${callback.split('&state=')[0]}&state=${new URL(desktop.opened[1]!).searchParams.get('state')}`)

      await auth.signIn()
      expect(new URL(desktop.opened[2]!).searchParams.has('prompt')).toBe(false)
    })

    it('does not ask for the password again after a session that expired', async () => {
      stubServer({ refresh: () => Response.json({ error: 'invalid_grant' }, { status: 400 }) })
      desktop.keychain = JSON.stringify(EXPIRED)
      const auth = await authStore()
      await auth.restore()
      await expect(auth.api('/api/v1/me')).rejects.toThrow('Your session has expired.')
      await vi.waitFor(() => expect(auth.isAuthenticated).toBe(false))

      await auth.signIn()

      expect(new URL(desktop.opened[0]!).searchParams.has('prompt')).toBe(false)
    })

    it('clears the keychain on sign-out', async () => {
      stubServer()
      desktop.keychain = JSON.stringify(TOKENS)
      const auth = await authStore()
      await auth.restore()

      auth.signOut()

      await vi.waitFor(() => expect(desktop.keychain).toBeNull())
      expect(auth.storageError).toBeNull()
    })

    it('says so when the keychain refuses, instead of pretending the sign-in was kept', async () => {
      stubTokenEndpoint()
      desktop.keychainFails = true
      const auth = await authStore()
      const callback = await startSignIn(auth, () => desktop.opened[0]!)

      await auth.completeSignIn(callback)

      expect(auth.isAuthenticated).toBe(true)
      expect(auth.storageError).toContain('could not be kept on this device')
      expect(auth.storageError).toContain('User canceled the operation.')
    })

    it('says so when the sign-in could not be removed from the keychain', async () => {
      stubServer()
      desktop.keychain = JSON.stringify(TOKENS)
      const auth = await authStore()
      await auth.restore()
      desktop.keychainFails = true

      auth.signOut()

      await vi.waitFor(() => expect(auth.storageError).toContain('could not be removed from this device'))
      expect(auth.isAuthenticated).toBe(false)
    })
  })
})
