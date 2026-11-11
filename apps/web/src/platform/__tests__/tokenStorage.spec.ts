import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TokenSet } from '@tresso/core'

const desktop = vi.hoisted(() => ({ isDesktop: false, keychain: null as string | null }))

vi.mock('@/platform/desktop', () => ({
  get isDesktop() {
    return desktop.isDesktop
  },
  loadKeychainTokens: async () => desktop.keychain,
  saveKeychainTokens: async (tokens: string) => {
    desktop.keychain = tokens
  },
  clearKeychainTokens: async () => {
    desktop.keychain = null
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

const TOKENS: TokenSet = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 1_900_000_000_000 }

/** Loads the module fresh, so its platform (web or desktop) is read again. */
async function storageModule() {
  vi.resetModules()
  return import('@/platform/tokenStorage')
}

describe('where the sign-in is kept', () => {
  beforeEach(() => {
    desktop.isDesktop = false
    desktop.keychain = null
    vi.stubGlobal('localStorage', memoryStorage())
  })

  afterEach(() => {
    sessionStorage.clear()
    vi.unstubAllGlobals()
  })

  describe('in the browser', () => {
    it('keeps the tokens in localStorage, shared by every tab and kept when the browser closes', async () => {
      const { tokenStorage, initialTokens } = await storageModule()

      await tokenStorage.save(TOKENS)

      expect(JSON.parse(localStorage.getItem('auth.tokens')!)).toEqual(TOKENS)
      expect(sessionStorage.getItem('auth.tokens')).toBeNull()
      expect(initialTokens()).toEqual(TOKENS)
      await tokenStorage.save(null)
      expect(localStorage.getItem('auth.tokens')).toBeNull()
    })

    it('moves the tokens of a tab from before the upgrade from sessionStorage to localStorage', async () => {
      sessionStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const { initialTokens } = await storageModule()

      expect(initialTokens()).toEqual(TOKENS)
      expect(JSON.parse(localStorage.getItem('auth.tokens')!)).toEqual(TOKENS)
      expect(sessionStorage.getItem('auth.tokens')).toBeNull()
    })

    it('prefers the set in localStorage over the one a tab from before the upgrade still holds', async () => {
      localStorage.setItem('auth.tokens', JSON.stringify({ ...TOKENS, accessToken: 'shared' }))
      sessionStorage.setItem('auth.tokens', JSON.stringify(TOKENS))
      const { initialTokens } = await storageModule()

      expect(initialTokens()?.accessToken).toBe('shared')
      expect(sessionStorage.getItem('auth.tokens')).toBeNull()
    })

    it('reads a corrupt or foreign value as signed out instead of failing at start', async () => {
      const { initialTokens, parseTokens } = await storageModule()

      localStorage.setItem('auth.tokens', '{not json')
      expect(initialTokens()).toBeNull()
      localStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'a', expiresAt: 'soon' }))
      expect(initialTokens()).toBeNull()
      expect(parseTokens(JSON.stringify({ accessToken: 'a', refreshToken: null, expiresAt: 1 }))).toEqual({ accessToken: 'a', refreshToken: null, expiresAt: 1 })
    })

    it('reads as signed out when the browser refuses storage', async () => {
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError')
        },
      })
      const { initialTokens, tokenStorage } = await storageModule()

      expect(initialTokens()).toBeNull()
      expect(tokenStorage.peek()).toBeNull()
    })

    it('tells about sign-ins, refreshes and sign-outs of other tabs', async () => {
      const { watchTokens } = await storageModule()
      const heard: (TokenSet | null)[] = []
      const stop = watchTokens((tokens) => heard.push(tokens))

      window.dispatchEvent(new StorageEvent('storage', { key: 'auth.tokens', newValue: JSON.stringify(TOKENS) }))
      window.dispatchEvent(new StorageEvent('storage', { key: 'tresso.server', newValue: 'https://elsewhere.example' }))
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth.tokens', newValue: null }))
      // localStorage.clear() in another tab.
      window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }))
      stop()
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth.tokens', newValue: JSON.stringify(TOKENS) }))

      expect(heard).toEqual([TOKENS, null, null])
    })

    it('runs a refresh under the lock all tabs share', async () => {
      const request = vi.fn<(name: string, run: () => Promise<string>) => Promise<string>>(async (_name, run) => run())
      vi.stubGlobal('navigator', { locks: { request } })
      const { withRefreshLock } = await storageModule()

      await expect(withRefreshLock(async () => 'done')).resolves.toBe('done')
      expect(request).toHaveBeenCalledWith('tresso.auth.refresh', expect.any(Function))
    })

    it('runs a refresh at once in a browser without the Web Locks API', async () => {
      vi.stubGlobal('navigator', {})
      const { withRefreshLock } = await storageModule()

      await expect(withRefreshLock(async () => 'done')).resolves.toBe('done')
    })
  })

  describe('in the desktop app', () => {
    beforeEach(() => {
      desktop.isDesktop = true
    })

    it('keeps the tokens in the keychain and has nothing shared to look at', async () => {
      const { tokenStorage, initialTokens } = await storageModule()

      await tokenStorage.save(TOKENS)

      expect(JSON.parse(desktop.keychain!)).toEqual(TOKENS)
      expect(await tokenStorage.load()).toEqual(TOKENS)
      expect(tokenStorage.peek()).toBeUndefined()
      expect(initialTokens()).toBeNull()
      expect(localStorage.getItem('auth.tokens')).toBeNull()
    })

    it('says so when the keychain holds something it cannot read', async () => {
      desktop.keychain = '{broken'
      const { tokenStorage } = await storageModule()

      await expect(tokenStorage.load()).rejects.toThrow('not a sign-in Tresso can read')
    })
  })
})
