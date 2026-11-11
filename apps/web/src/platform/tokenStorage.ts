import type { TokenSet } from '@tresso/core'
import { clearKeychainTokens, isDesktop, loadKeychainTokens, saveKeychainTokens } from '@/platform/desktop'

const TOKENS_KEY = 'auth.tokens'
/** The name of the lock every tab of this origin takes around a token refresh. */
const REFRESH_LOCK = 'tresso.auth.refresh'

/** Where the signed-in user's tokens are kept between page loads or app launches. */
export interface TokenStorage {
  load(): Promise<TokenSet | null>
  save(tokens: TokenSet | null): Promise<void>
  /**
   * The set as it is stored right now, which another tab may have written since this one read it. Undefined where
   * nothing else writes the store (the desktop app has one window): what this window holds is the latest.
   */
  peek(): TokenSet | null | undefined
}

/** A stored token set, or null for anything else: a corrupt or foreign value means signed out, not a crash. */
export function parseTokens(raw: string | null): TokenSet | null {
  if (raw === null) {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { accessToken, refreshToken, expiresAt } = value as Record<string, unknown>
  if (typeof accessToken !== 'string' || (typeof refreshToken !== 'string' && refreshToken !== null) || typeof expiresAt !== 'number') {
    return null
  }
  return { accessToken, refreshToken, expiresAt }
}

/** Reads one key; a browser that refuses storage (blocked site data) reads as empty. */
function readItem(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key)
  } catch {
    return null
  }
}

function removeItem(storage: () => Storage, key: string): void {
  try {
    storage().removeItem(key)
  } catch {
    // Nothing can be read from a store the browser refuses either.
  }
}

/**
 * The tokens in the browser's localStorage. A tab from before they moved there kept them in sessionStorage: they move
 * over, and a set already in localStorage (signed in by another tab since) wins over the tab's own.
 */
function browserTokens(): TokenSet | null {
  const kept = readItem(() => localStorage, TOKENS_KEY)
  const fromTab = readItem(() => sessionStorage, TOKENS_KEY)
  if (fromTab !== null) {
    const moved = parseTokens(fromTab)
    if (kept === null && moved !== null) {
      try {
        localStorage.setItem(TOKENS_KEY, JSON.stringify(moved))
      } catch {
        // Without localStorage the tab keeps its own set, which still signs it in until it closes.
        return moved
      }
    }
    removeItem(() => sessionStorage, TOKENS_KEY)
    if (kept === null) {
      return moved
    }
  }
  return parseTokens(kept)
}

/**
 * Tokens read without waiting, so the web client can render signed in on the first frame. The desktop app has to
 * ask the keychain first, see {@link TokenStorage.load}.
 */
export function initialTokens(): TokenSet | null {
  return isDesktop ? null : browserTokens()
}

/**
 * The web client: localStorage, shared by every tab of the origin and kept when the browser closes, so one sign-in
 * serves all tabs until the user signs out (one user per browser profile).
 */
const browserStorage: TokenStorage = {
  async load() {
    return browserTokens()
  },
  async save(tokens) {
    if (tokens === null) {
      localStorage.removeItem(TOKENS_KEY)
      return
    }
    localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens))
  },
  peek() {
    return parseTokens(readItem(() => localStorage, TOKENS_KEY))
  },
}

/** The desktop app: the OS keychain, so a sign-in lasts across launches without tokens on disk in plain text. */
const keychainStorage: TokenStorage = {
  async load() {
    const raw = await loadKeychainTokens()
    const tokens = parseTokens(raw)
    if (raw !== null && tokens === null) {
      // Said, not swallowed: the user would otherwise be signed out at launch without a reason.
      throw new Error('the keychain entry is not a sign-in Tresso can read')
    }
    return tokens
  },
  async save(tokens) {
    if (tokens === null) {
      await clearKeychainTokens()
      return
    }
    await saveKeychainTokens(JSON.stringify(tokens))
  },
  peek() {
    return undefined
  },
}

export const tokenStorage: TokenStorage = isDesktop ? keychainStorage : browserStorage

/**
 * Calls back when another tab stores a new token set (a sign-in or a refresh) or removes it (a sign-out), with the
 * set or null. Returns the function that stops listening. Nothing to hear in the desktop app.
 */
export function watchTokens(callback: (tokens: TokenSet | null) => void): () => void {
  if (isDesktop) {
    return () => {}
  }
  const listener = (event: StorageEvent) => {
    // A null key is localStorage.clear(), which removes the tokens too.
    if (event.key !== null && event.key !== TOKENS_KEY) {
      return
    }
    if (event.storageArea !== null && event.storageArea !== localStorage) {
      return
    }
    callback(parseTokens(event.newValue))
  }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}

/**
 * Runs a token refresh while no other tab runs one. Refresh tokens rotate: two tabs refreshing with the same one would
 * leave one of them with a revoked token. Without the Web Locks API (old browsers) it runs at once, as a single tab
 * does; the desktop app has one window.
 *
 * `waitMs` limits the wait for the lock: a tab the browser suspended while it held the lock may keep it for long.
 * When the wait runs out, or the browser refuses the lock (a SecurityError where it refuses storage to the origin),
 * `run` goes ahead without the lock. That keeps the app usable, at a price: two tabs may then refresh with the same
 * token, and the one the server refuses ends the session as expired in every tab (the mail copy stays, and signing in
 * again is one click). An error of `run` itself is passed on.
 */
export async function withRefreshLock<T>(run: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  if (isDesktop || typeof navigator === 'undefined' || navigator.locks === undefined) {
    return run()
  }
  let started = false
  const controller = new AbortController()
  const timer = options.waitMs === undefined ? undefined : setTimeout(() => controller.abort(), options.waitMs)
  try {
    return await navigator.locks.request(REFRESH_LOCK, { signal: controller.signal }, async () => {
      started = true
      clearTimeout(timer)
      return run()
    })
  } catch (error) {
    if (started) {
      throw error
    }
    return run()
  } finally {
    clearTimeout(timer)
  }
}
