import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  exchangeCode,
  parseCallback,
  refreshTokens,
  startAuthorization,
  type Me,
  type OAuthClientConfig,
  type TokenSet,
} from '@tresso/core'
import { ApiError } from '@/api/errors'
import { config } from '@/config'
import { isDesktop, openInBrowser } from '@/platform/desktop'
import { initialTokens, tokenStorage } from '@/platform/tokenStorage'
import { disableWebPush } from '@/platform/webPush'

const PENDING_KEY = 'auth.pending'
/** Refresh slightly before expiry so a request never leaves with a token that dies in flight. */
const EXPIRY_MARGIN_MS = 30_000

const oauthConfig: OAuthClientConfig = config

export const useAuthStore = defineStore('auth', () => {
  const tokens = ref<TokenSet | null>(initialTokens())
  const me = ref<Me | null>(null)
  const isAuthenticated = computed(() => tokens.value !== null)
  /** The desktop app sent the user to the system browser and waits for the `tresso://` link back. */
  const awaitingBrowser = ref(false)
  /** Keeping or forgetting the tokens failed, e.g. the keychain refused; shown to the user. */
  const storageError = ref<string | null>(null)
  /** The server answered 402: the trial or subscription is over, and the payment screen covers the app. */
  const paymentRequired = ref(false)
  /** Goes up on every sign-out, so an answer to a request from before cannot change the next session. */
  const generation = ref(0)

  async function store(next: TokenSet | null): Promise<void> {
    tokens.value = next
    try {
      await tokenStorage.save(next)
      storageError.value = null
    } catch (error) {
      storageError.value =
        next === null
          ? `You are signed out here, but the sign-in could not be removed from this device: ${String(error)}`
          : `The sign-in could not be kept on this device, so you will have to sign in again next time: ${String(error)}`
    }
  }

  /** Loads the tokens kept from the previous launch; the desktop app reads them from the keychain before mounting. */
  async function restore(): Promise<void> {
    if (!isDesktop) {
      return
    }
    try {
      tokens.value = await tokenStorage.load()
    } catch (error) {
      storageError.value = `The saved sign-in could not be read: ${String(error)}`
    }
  }

  async function signIn(): Promise<void> {
    const pending = await startAuthorization(oauthConfig)
    // The server too: the code can only be exchanged where it was issued.
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state: pending.state, codeVerifier: pending.codeVerifier, server: config.apiUrl }))
    if (!isDesktop) {
      window.location.assign(pending.url)
      return
    }
    awaitingBrowser.value = true
    try {
      await openInBrowser(pending.url)
    } catch (error) {
      awaitingBrowser.value = false
      throw error
    }
  }

  async function completeSignIn(callbackUrl: string): Promise<void> {
    const raw = sessionStorage.getItem(PENDING_KEY)
    sessionStorage.removeItem(PENDING_KEY)
    if (raw === null) {
      throw new Error(isDesktop ? 'No sign-in was started in this window.' : 'No sign-in was started in this tab.')
    }
    const pending = JSON.parse(raw) as { state: string; codeVerifier: string; server?: string }
    awaitingBrowser.value = false
    if (pending.server !== undefined && pending.server !== config.apiUrl) {
      throw new Error(`This sign-in was started for ${pending.server}, but Tresso now uses ${config.apiUrl}. Sign in again.`)
    }
    const code = parseCallback(callbackUrl, pending.state)
    await store(await exchangeCode(oauthConfig, code, pending.codeVerifier))
  }

  /** The user signs out: this browser stops getting their pushes, telling the server, and the tokens go. */
  function signOut(): Promise<void> {
    return endSession(true)
  }

  /**
   * Ends the session here. When the user signs out (signedOut), pushes to this browser stop first, while the tokens
   * can still tell the server. A session that expired keeps them, as a closed tab does: the user did not sign out, and
   * signing in again finds them on; another user signing in here drops them (releaseOtherUsersPush).
   */
  async function endSession(signedOut: boolean): Promise<void> {
    if (signedOut) {
      try {
        await disableWebPush(send)
      } catch (error) {
        // The subscription is gone either way (disableWebPush drops it whatever the server said).
        console.error('Telling the server this browser signed out failed', error)
      }
    }
    generation.value++
    me.value = null
    paymentRequired.value = false
    await store(null)
  }

  async function accessToken(): Promise<string> {
    const current = tokens.value
    if (current === null) {
      throw new Error('Not signed in.')
    }
    if (current.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
      return current.accessToken
    }
    if (current.refreshToken === null) {
      void endSession(false)
      throw new Error('Session expired.')
    }
    try {
      await store(await refreshTokens(oauthConfig, current.refreshToken))
    } catch (error) {
      void endSession(false)
      throw error
    }
    return tokens.value!.accessToken
  }

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const session = generation.value
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await accessToken()}`)
    headers.set('Accept', 'application/json')

    const response = await fetch(`${config.apiUrl}${path}`, { ...init, headers })
    if (response.status === 401) {
      void endSession(false)
      throw new ApiError(401, 'Your session has expired. Sign in again.')
    }
    if (response.status === 402 && session === generation.value) {
      paymentRequired.value = true
    }
    if (!response.ok) {
      throw await ApiError.fromResponse(path, response)
    }
    if (response.status === 204) {
      return undefined as T
    }
    return (await response.json()) as T
  }

  /** POST, PUT, PATCH (as JSON merge patch) or DELETE. */
  function send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.headers = { 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' }
      init.body = JSON.stringify(body)
    }
    return api<T>(path, init)
  }

  async function loadMe(): Promise<void> {
    me.value = await api<Me>('/api/v1/me')
  }

  return { tokens, me, isAuthenticated, awaitingBrowser, storageError, paymentRequired, generation, restore, signIn, completeSignIn, signOut, loadMe, api, send }
})
