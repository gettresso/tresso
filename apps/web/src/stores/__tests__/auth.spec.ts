import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { TokenSet } from '@tresso/core'

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
      sessionStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()

      await auth.signOut()

      expect(push.disabled).toBe(1)
      expect(auth.isAuthenticated).toBe(false)
    })

    it('keeps the pushes when the session expires, as a closed tab does, so signing in again finds them on', async () => {
      push.disabled = 0
      sessionStorage.setItem('auth.tokens', JSON.stringify({ ...TOKENS, refreshToken: null, expiresAt: Date.now() - 1000 }))
      const auth = await authStore()

      await expect(auth.api('/api/v1/me')).rejects.toThrow('Session expired.')

      await vi.waitFor(() => expect(auth.isAuthenticated).toBe(false))
      expect(push.disabled).toBe(0)
    })

    it('keeps the tokens in sessionStorage and forgets them on sign-out', async () => {
      sessionStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const auth = await authStore()
      expect(auth.isAuthenticated).toBe(true)

      auth.signOut()
      await vi.waitFor(() => expect(sessionStorage.getItem('auth.tokens')).toBeNull())
      expect(auth.isAuthenticated).toBe(false)
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

    it('clears the keychain on sign-out', async () => {
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
