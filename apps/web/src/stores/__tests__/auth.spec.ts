import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Me, TokenSet } from '@tresso/core'

const desktop = vi.hoisted(() => ({
  isDesktop: false,
  keychain: null as string | null,
  keychainFails: false,
  /** Holds a keychain write until it resolves, as the OS may while it asks the user. */
  keychainHold: null as Promise<void> | null,
  opened: [] as string[],
}))

vi.mock('@/platform/desktop', () => ({
  get isDesktop() {
    return desktop.isDesktop
  },
  loadKeychainTokens: async () => desktop.keychain,
  saveKeychainTokens: async (tokens: string) => {
    await desktop.keychainHold
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

const push = vi.hoisted(() => ({ disabled: 0, hangs: false, subscribed: false }))

vi.mock('@/platform/webPush', () => ({
  disableWebPush: async (send: (method: 'POST' | 'DELETE', path: string, body?: unknown) => Promise<unknown>) => {
    push.disabled += 1
    if (push.subscribed) {
      // As the real one does: it tells the server through the sign-out's own send.
      await send('POST', '/api/v1/notification-devices', { kind: 'web_push' })
    }
    if (push.hangs) {
      // A server that never answers.
      await new Promise(() => {})
    }
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
    request: (name: string, options: { signal?: AbortSignal } | (() => Promise<unknown>), callback?: () => Promise<unknown>) => {
      const run = typeof options === 'function' ? options : callback!
      const signal = typeof options === 'function' ? undefined : options.signal
      const previous = held.get(name) ?? Promise.resolve()
      let granted = false
      let gaveUp = false
      const mine = new Promise<unknown>((resolve, reject) => {
        // A request whose signal aborts before the lock is granted leaves the queue and rejects, as browsers do.
        signal?.addEventListener('abort', () => {
          if (!granted) {
            gaveUp = true
            reject(new DOMException('The lock request was aborted.', 'AbortError'))
          }
        })
        void previous
          .catch(() => undefined)
          .then(async () => {
            if (gaveUp) {
              return
            }
            granted = true
            try {
              resolve(await run())
            } catch (error) {
              reject(error)
            }
          })
      })
      held.set(
        name,
        mine.catch(() => undefined),
      )
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
    desktop.keychainHold = null
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

    it('signs out though the server cannot be reached, and stays in the app instead of leaving for an error page', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
      const forms = captureForms()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      await auth.signOut()

      expect(auth.isAuthenticated).toBe(false)
      expect(localStorage.getItem('auth.tokens')).toBeNull()
      // The sign-in pages are on the unreachable API here: the form would only show the browser's error page.
      expect(forms).toEqual([])
      expect(localStorage.getItem('tresso.auth.promptLogin')).not.toBeNull()
      expect(auth.browserSessionOpen).toBe(true)
    })

    it('ends the browser session when the server answered the revocation, even with an error', async () => {
      stubServer()
      vi.mocked(fetch).mockImplementation(async (input) =>
        String(input).endsWith('/oauth/revoke') ? Response.json({ error: 'temporarily_unavailable' }, { status: 503 }) : new Response(null, { status: 204 }),
      )
      const forms = captureForms()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      await auth.signOut()

      expect(forms).toHaveLength(1)
    })

    it('signs out within a few seconds when the server does not answer about the pushes', async () => {
      push.hangs = true
      const server = stubServer()
      const forms = captureForms()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      try {
        await withoutWaiting(() => auth.signOut())
      } finally {
        push.hangs = false
      }

      expect(localStorage.getItem('auth.tokens')).toBeNull()
      expect(server.revoked).toEqual(['refresh-1'])
      expect(forms).toHaveLength(1)
    })

    it('removes the tokens before the server is asked, so the sign-out holds on this device at once', async () => {
      let revoke!: () => void
      stubServer()
      vi.mocked(fetch).mockImplementation((input) =>
        String(input).endsWith('/oauth/revoke') ? new Promise<Response>((resolve) => (revoke = () => resolve(new Response(null, { status: 200 })))) : Promise.resolve(new Response(null, { status: 204 })),
      )
      captureForms()
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      const signingOut = auth.signOut()
      await vi.waitFor(() => expect(revoke).toBeDefined())

      expect(auth.isAuthenticated).toBe(false)
      expect(localStorage.getItem('auth.tokens')).toBeNull()
      revoke()
      await signingOut
    })

    it('never signs back in through a refresh this tab started, or a call the sign-out makes, with an expired token', async () => {
      push.subscribed = true
      let answer!: () => void
      const server = stubServer({
        refresh: () =>
          new Promise<Response>((resolve) => {
            answer = () => resolve(Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' }))
          }),
        api: () => Response.json({ id: 'device-1' }),
      })
      captureForms()
      localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
      const auth = await authStore()

      try {
        // A request of this tab is refreshing when the user signs out.
        const request = auth.api('/api/v1/me')
        await vi.waitFor(() => expect(answer).toBeDefined())
        await auth.signOut()
        answer()
        await expect(request).rejects.toThrow('Not signed in.')
      } finally {
        push.subscribed = false
      }

      // The sign-out's own call about the pushes went with the expired token as it was, and refreshed nothing.
      expect(server.refreshes).toEqual(['refresh-1'])
      expect(server.calls).toEqual([{ path: '/api/v1/notification-devices', token: 'access-1' }])
      await vi.waitFor(() => expect(server.revoked).toEqual(['refresh-1', 'refresh-2']))
      expect(auth.tokens).toBeNull()
      expect(auth.isAuthenticated).toBe(false)
      expect(localStorage.getItem('auth.tokens')).toBeNull()
    })

    it('ends a sign-in page session it could not end at sign-out at the next start, once the server answers', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
      const forms = captureForms()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const before = await authStore()
      await before.signOut()
      expect(before.browserSessionOpen).toBe(true)
      expect(forms).toEqual([])

      // The next start, still offline: nothing is sent, the sign-in screen keeps saying so.
      const offline = await authStore()
      await offline.endOpenBrowserSession()
      expect(offline.browserSessionOpen).toBe(true)
      expect(forms).toEqual([])

      // The next start with the server back.
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'Tresso' })))
      const online = await authStore()
      await online.endOpenBrowserSession()

      expect(vi.mocked(fetch)).toHaveBeenCalledWith('http://localhost:8080/api/v1/server-info', expect.anything())
      expect(forms).toHaveLength(1)
      expect(forms[0]!.action).toBe('http://localhost:8080/logout')
      expect(online.browserSessionOpen).toBe(false)
      expect(localStorage.getItem('tresso.auth.browserSessionOpen')).toBeNull()
    })

    it('does not send the remembered logout form while a sign-in started in this tab is on its way', async () => {
      localStorage.setItem('tresso.auth.browserSessionOpen', '1')
      sessionStorage.setItem('auth.pending', JSON.stringify({ state: 's', codeVerifier: 'v', server: 'http://localhost:8080' }))
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'Tresso' })))
      const forms = captureForms()
      const auth = await authStore()

      await auth.endOpenBrowserSession()

      expect(forms).toEqual([])
      expect(localStorage.getItem('tresso.auth.browserSessionOpen')).not.toBeNull()
    })

    it('does not send the remembered logout form when a sign-in completes while the server is being checked', async () => {
      localStorage.setItem('tresso.auth.browserSessionOpen', '1')
      let answerProbe!: () => void
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) =>
          String(input).endsWith('/api/v1/server-info')
            ? new Promise<Response>((resolve) => (answerProbe = () => resolve(Response.json({ name: 'Tresso' }))))
            : Promise.resolve(Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' })),
        ),
      )
      const forms = captureForms()
      const auth = await authStore()

      // The start check asks the server, which answers late; meanwhile a sign-in completes (here, or in another tab).
      const checking = auth.endOpenBrowserSession()
      await vi.waitFor(() => expect(answerProbe).toBeDefined())
      sessionStorage.setItem('auth.pending', JSON.stringify({ state: 's', codeVerifier: 'v', server: 'http://localhost:8080' }))
      await auth.completeSignIn('http://localhost:3000/auth/callback?code=the-code&state=s')
      answerProbe()
      await checking

      expect(forms).toEqual([])
      expect(auth.tokens?.accessToken).toBe('access-2')
      expect(localStorage.getItem('tresso.auth.browserSessionOpen')).toBeNull()
      expect(auth.browserSessionOpen).toBe(false)
    })

    it('stops the pushes at the server before revoking, while the access token is still accepted', async () => {
      push.subscribed = true
      const server = stubServer()
      const order: string[] = []
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname
        order.push(`${init?.method ?? 'GET'} ${path}`)
        if (path === '/oauth/revoke') {
          server.revoked.push('refresh-1')
          return new Response(null, { status: 200 })
        }
        // A revoked token takes its access token along.
        return server.revoked.length > 0 ? Response.json({}, { status: 401 }) : Response.json({ id: 'device-1' })
      })
      captureForms()
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      try {
        await auth.signOut()
      } finally {
        push.subscribed = false
      }

      expect(order).toEqual(['POST /api/v1/notification-devices', 'POST /oauth/revoke'])
    })

    it('checks sign-in pages on the app\'s own address before sending the form there', async () => {
      window.tressoConfig = { authUrl: window.location.origin }
      const forms = captureForms()
      const answersWith = (status: number) =>
        vi.stubGlobal(
          'fetch',
          vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/logout') ? new Response('Bad gateway', { status }) : new Response(null, { status: 200 }))),
        )
      try {
        answersWith(502)
        localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
        const failing = await authStore()
        await failing.signOut()
        expect(forms).toEqual([])
        expect(failing.browserSessionOpen).toBe(true)

        answersWith(200)
        const answering = await authStore()
        await answering.endOpenBrowserSession()
        expect(vi.mocked(fetch)).toHaveBeenCalledWith(`${window.location.origin}/logout`, expect.objectContaining({ redirect: 'manual' }))
        expect(forms).toHaveLength(1)
      } finally {
        delete window.tressoConfig
      }
    })

    it('says a sign-out is under way while it runs', async () => {
      stubServer()
      captureForms()
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      const signingOut = auth.signOut()
      expect(auth.signingOut).toBe(true)
      await signingOut

      expect(auth.signingOut).toBe(false)
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

    it('keeps the user the server confirmed next to the tokens, and carries it over a refresh', async () => {
      stubServer()
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()
      expect(auth.knownUserId).toBeNull()

      await auth.loadMe()
      expect(auth.knownUserId).toBe('user-1')
      expect(JSON.parse(localStorage.getItem('auth.tokens')!)).toMatchObject({ accessToken: 'access-1', userId: 'user-1' })

      auth.tokens = { ...auth.tokens!, expiresAt: Date.now() - 1000 }
      await auth.api('/api/v1/accounts')
      expect(JSON.parse(localStorage.getItem('auth.tokens')!)).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', userId: 'user-1' })
      expect(auth.knownUserId).toBe('user-1')
    })

    it('does not take an answer about tokens another tab replaced while the server was asked, and asks again', async () => {
      const answers: (() => void)[] = []
      const server = stubServer({ api: (_path, token) => new Promise((resolve) => answers.push(() => resolve(Response.json({ id: token === 'access-1' ? 'user-1' : 'user-2' })))) })
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      const loading = auth.loadMe()
      await vi.waitFor(() => expect(answers).toHaveLength(1))
      // Another tab signed in as someone else meanwhile.
      auth.tokens = { accessToken: 'access-9', refreshToken: 'refresh-9', expiresAt: Date.now() + 3_600_000 }
      answers[0]!()
      await vi.waitFor(() => expect(answers).toHaveLength(2))
      expect(auth.me).toBeNull()
      answers[1]!()
      await loading

      expect(server.calls.map((call) => call.token)).toEqual(['access-1', 'access-9'])
      expect(auth.me?.id).toBe('user-2')
      expect(auth.knownUserId).toBe('user-2')
    })

    it('knows who is signed in without waiting for the keychain to keep the id', async () => {
      desktop.isDesktop = true
      desktop.keychain = JSON.stringify(TOKENS)
      stubServer()
      const auth = await authStore()
      await auth.restore()
      let release!: () => void
      desktop.keychainHold = new Promise((resolve) => (release = resolve))

      await auth.loadMe()

      expect(auth.me?.id).toBe('user-1')
      expect(auth.knownUserId).toBe('user-1')
      expect(JSON.parse(desktop.keychain)).toEqual(TOKENS)
      release()
      await vi.waitFor(() => expect(JSON.parse(desktop.keychain!)).toMatchObject({ userId: 'user-1' }))
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

    it('never sends a request marked not to retry twice: the token is refreshed for the next one, and the session stays', async () => {
      const server = stubServer({
        api: (_path, token) => (token === 'access-2' ? Response.json({ id: 'claim-2' }) : Response.json({}, { status: 401 })),
      })
      localStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      await expect(auth.send('POST', '/api/v1/chat-accounts/a/relay/outgoing/claim', { deviceId: 'd' }, { retry: false })).rejects.toMatchObject({ name: 'ApiError', status: 401 })

      expect(server.calls.map((call) => call.token)).toEqual(['access-1'])
      expect(server.refreshes).toEqual(['refresh-1'])
      expect(auth.isAuthenticated).toBe(true)
      await expect(auth.send('POST', '/api/v1/chat-accounts/a/relay/outgoing/claim', { deviceId: 'd' }, { retry: false })).resolves.toEqual({ id: 'claim-2' })
      expect(server.calls.map((call) => call.token)).toEqual(['access-1', 'access-2'])
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

    it.each(['invalid_client', 'unauthorized_client'])('ends the session when the server no longer knows the client (%s)', async (code) => {
      stubServer({ refresh: () => Response.json({ error: code }, { status: 401 }) })
      localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
      const auth = await authStore()

      await expect(auth.api('/api/v1/me')).rejects.toThrow('Your session has expired.')

      await vi.waitFor(() => expect(auth.isAuthenticated).toBe(false))
      expect(auth.sessionEnd).toBe('expired')
    })

    it('keeps the sign-in for another refusal of the token endpoint, which may pass', async () => {
      stubServer({ refresh: () => Response.json({ error: 'server_error' }, { status: 400 }) })
      localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
      const auth = await authStore()

      await expect(auth.api('/api/v1/me')).rejects.toThrow('Tresso could not renew your sign-in')

      expect(auth.isAuthenticated).toBe(true)
      expect(auth.sessionEnd).toBeNull()
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

      // Made here, not said by the server: no status, so nothing reads it as the server's refusal.
      // (By name: the store was loaded afresh, with its own copy of the core module.)
      await expect(loading).rejects.toMatchObject({ name: 'SessionEndedDuringRequestError', message: 'Signed out while this request was under way.' })
      await expect(loading).rejects.not.toHaveProperty('status')
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

      it('signs out at once while another tab refreshes, and that refresh drops and revokes its answer', async () => {
        stubLocks()
        let answer!: () => void
        const server = stubServer({
          refresh: () =>
            new Promise<Response>((resolve) => {
              answer = () => resolve(Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' }))
            }),
        })
        const forms = captureForms()
        localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
        const signingOut = await authStore()
        const stuck = await authStore()
        const request = stuck.api('/api/v1/me')
        await vi.waitFor(() => expect(answer).toBeDefined())

        await signingOut.signOut()

        expect(localStorage.getItem('auth.tokens')).toBeNull()
        expect(server.revoked).toEqual(['refresh-1'])
        expect(forms).toHaveLength(1)
        answer()
        await expect(request).rejects.toThrow('Not signed in.')
        await vi.waitFor(() => expect(server.revoked).toEqual(['refresh-1', 'refresh-2']))
        expect(localStorage.getItem('auth.tokens')).toBeNull()
      })

      it('refreshes and signs out when the browser refuses the lock', async () => {
        const request = vi.fn<(name: string, options: object, run: () => Promise<unknown>) => Promise<unknown>>(async () => Promise.reject(new DOMException('The request is not allowed.', 'SecurityError')))
        vi.stubGlobal('navigator', { ...navigator, locks: { request } })
        const server = stubServer()
        const forms = captureForms()
        localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
        const auth = await authStore()

        await expect(auth.api('/api/v1/me')).resolves.toEqual({ id: 'user-1' })
        await auth.signOut()

        expect(request).toHaveBeenCalled()
        expect(server.refreshes).toEqual(['refresh-1'])
        expect(server.revoked).toEqual(['refresh-2'])
        expect(localStorage.getItem('auth.tokens')).toBeNull()
        expect(forms).toHaveLength(1)
      })

      it('refreshes without the lock once another tab held it far longer than a refresh takes', async () => {
        stubLocks()
        const server = stubServer()
        // A tab the browser suspended in the middle of its refresh: it never lets go.
        void navigator.locks.request('tresso.auth.refresh', () => new Promise(() => {}))
        localStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
        const auth = await authStore()

        await expect(withoutWaiting(() => auth.api('/api/v1/me'))).resolves.toEqual({ id: 'user-1' })

        expect(server.refreshes).toEqual(['refresh-1'])
        expect(auth.isAuthenticated).toBe(true)
      })

      it('stays signed in when the tab kept its own sign-in because the browser refused to share it', async () => {
        const refusing = memoryStorage()
        refusing.setItem = () => {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        }
        vi.stubGlobal('localStorage', refusing)
        sessionStorage.setItem('auth.tokens', JSON.stringify(EXPIRED))
        const server = stubServer()
        const auth = await authStore()

        await expect(auth.api('/api/v1/me')).resolves.toEqual({ id: 'user-1' })

        expect(server.refreshes).toEqual(['refresh-1'])
        expect(auth.isAuthenticated).toBe(true)
        expect(auth.storageError).toContain('could not be kept on this device')
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
      // Opening the same sign-in in the browser again still asks: the kept page address carries the parameter.
      await auth.reopenBrowser()
      expect(desktop.opened[1]).toBe(desktop.opened[0])
      expect(JSON.parse(sessionStorage.getItem('auth.pending')!).url).toBe(desktop.opened[0])
      // So does a new sign-in started before the first one completed.
      await auth.signIn()
      expect(new URL(desktop.opened[2]!).searchParams.get('prompt')).toBe('login')
      expect(callback).toContain('state=')
      stubTokenEndpoint()
      await auth.completeSignIn(`tresso://auth/callback?code=the-code&state=${new URL(desktop.opened[2]!).searchParams.get('state')}`)

      await auth.signIn()
      expect(new URL(desktop.opened[3]!).searchParams.has('prompt')).toBe(false)
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
