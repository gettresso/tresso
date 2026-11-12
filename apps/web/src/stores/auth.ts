import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  exchangeCode,
  OAuthError,
  parseCallback,
  refreshRefusalEndsSession,
  refreshTokens,
  revokeToken,
  ServerClock,
  SessionEndedDuringRequestError,
  startAuthorization,
  withDeadline,
  type Me,
  type OAuthClientConfig,
  type TokenSet,
} from '@tresso/core'
import { ApiError } from '@/api/errors'
import { config } from '@/config'
import { isDesktop, openInBrowser } from '@/platform/desktop'
import { initialTokens, tokenStorage, watchTokens, withRefreshLock, type StoredTokens } from '@/platform/tokenStorage'
import { disableWebPush } from '@/platform/webPush'

const PENDING_KEY = 'auth.pending'
/**
 * Set when the user signed out on this device, until the next sign-in completes: that sign-in asks for the password
 * again (`prompt=login`), as the sign-in pages may still remember the browser (30 days). localStorage, so it outlasts a
 * restart of the desktop app and a closed browser; a reopened authorization page keeps asking.
 */
const PROMPT_LOGIN_KEY = 'tresso.auth.promptLogin'
/** How often loadMe asks again when the token set changed while it asked. */
const LOAD_ME_ATTEMPTS = 3
/** Refresh slightly before expiry so a request never leaves with a token that dies in flight. */
const EXPIRY_MARGIN_MS = 30_000
/** How long the token endpoint gets to answer: a refresh holds the lock of every tab while it waits. */
const REFRESH_TIMEOUT_MS = 20_000
/** How long a sign-out waits for the server to revoke the refresh token. */
const REVOKE_TIMEOUT_MS = 5_000
/**
 * How long a sign-out waits for the server in all: revoking the refresh token and stopping this browser's pushes run
 * side by side within it. The tokens are gone from the device before it starts.
 */
const SIGN_OUT_BUDGET_MS = 6_000
/**
 * The part of that budget the push calls get. They go first: revoking the refresh token also revokes the access token
 * they are sent with, so after it the server would refuse them.
 */
const PUSH_BUDGET_MS = 2_500
/** How long the check whether the sign-in pages answer may take. */
const PROBE_TIMEOUT_MS = 3_000
/**
 * Set when a sign-out could not end the browser session of the sign-in pages (they did not answer), until the logout
 * form went out at a later start or the user signed in again.
 */
const BROWSER_SESSION_KEY = 'tresso.auth.browserSessionOpen'
/**
 * How long a refresh waits for the lock: longer than a healthy holder needs (two token requests of 20 seconds and the
 * 2 second wait between them). After that the holder is stuck (a suspended tab), and this one goes on without it.
 */
const REFRESH_LOCK_WAIT_MS = 60_000
/**
 * The wait before a refresh whose answer never came is sent again. The server may have rotated the token already; it
 * answers the same refresh token with the same new pair for 30 seconds, so the retry has to come well within that.
 */
export const REFRESH_RETRY_DELAY_MS = 2_000
const EXPIRED = 'Your session has expired. Sign in again.'

const oauthConfig: OAuthClientConfig = config

/** A sign-in under way in this tab or window, kept until its answer comes back. */
interface PendingSignIn {
  state: string
  codeVerifier: string
  /** The server: the code can only be exchanged where it was issued. */
  server?: string
  /** The authorization page, so the desktop app can open the same sign-in in the browser again. */
  url?: string
}

function pendingSignIn(): PendingSignIn | null {
  const raw = sessionStorage.getItem(PENDING_KEY)
  return raw === null ? null : (JSON.parse(raw) as PendingSignIn)
}

/**
 * Why a session ended. Only `signedOut` is the user's own choice here: then the local mail copy goes. An `expired`
 * session (the server refused the tokens) and one that ended in another tab keep it, so drafts that never reached the
 * server are still there when the user signs in again.
 */
export type SessionEnd = 'signedOut' | 'expired' | 'elsewhere'

/**
 * Renewing the sign-in failed for a reason that may pass (offline, the server did not answer or failed). The tokens
 * are kept and the next request tries again.
 */
export class SignInRenewalError extends Error {
  constructor(readonly reason: unknown) {
    super(`Tresso could not renew your sign-in (${reason instanceof Error ? reason.message : String(reason)}). It tries again with the next request.`)
    this.name = 'SignInRenewalError'
  }
}

function isFresh(set: TokenSet): boolean {
  return set.expiresAt - EXPIRY_MARGIN_MS > Date.now()
}

/**
 * Runs a request with a fetch that gives up after `ms`, so an endpoint that never answers fails like one that is down.
 * The time covers the whole of `run`, reading the answer's body included: a body that stalls must not hold the lock
 * of every tab.
 */
async function withTimeout<T>(ms: number, run: (fetchImpl: typeof fetch) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`no answer within ${ms / 1000} seconds`)), ms)
  try {
    return await run((input, init) => fetch(input, { ...init, signal: controller.signal }))
  } finally {
    clearTimeout(timer)
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Whether a request to `url` gets any answer but a server error within the probe time. */
async function answers(url: string, init: RequestInit = {}): Promise<boolean> {
  try {
    const response = await withTimeout(PROBE_TIMEOUT_MS, (fetchImpl) => fetchImpl(url, { ...init, cache: 'no-store' }))
    // A redirect read as opaque (redirect: manual) is an answer too.
    return response.type === 'opaqueredirect' || response.status < 500
  } catch {
    return false
  }
}

/**
 * Whether the sign-in pages would answer the logout form, so it does not leave the user on the browser's error page.
 * On the app's own origin (Tresso Cloud, where a proxy serves them) a GET of /logout tells (it never signs out); on the
 * API's origin the revocation's outcome tells, or the server-info endpoint. Another address cannot be asked (the CSP
 * allows no connection to it), so the form goes there.
 */
async function signInPagesAnswer(revocationAnswered?: boolean): Promise<boolean> {
  const signIn = originOf(config.authUrl)
  if (signIn !== null && signIn === window.location.origin) {
    return answers(`${config.authUrl}/logout`, { redirect: 'manual', credentials: 'same-origin' })
  }
  if (signIn !== null && signIn === originOf(config.apiUrl)) {
    return revocationAnswered ?? answers(`${config.apiUrl}/api/v1/server-info`, { headers: { Accept: 'application/json' } })
  }
  return true
}

function browserSessionLeftOpen(): boolean {
  try {
    return localStorage.getItem(BROWSER_SESSION_KEY) !== null
  } catch {
    return false
  }
}

function rememberBrowserSession(open: boolean): void {
  try {
    if (open) {
      localStorage.setItem(BROWSER_SESSION_KEY, '1')
    } else {
      localStorage.removeItem(BROWSER_SESSION_KEY)
    }
  } catch (error) {
    console.error('Remembering the sign-in page session on this device failed', error)
  }
}

/** `work`, or a failure once `ms` passed; `work` itself goes on, its outcome no longer awaited. */
function withinTime<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} seconds`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function signedOutBefore(): boolean {
  try {
    return localStorage.getItem(PROMPT_LOGIN_KEY) !== null
  } catch {
    return false
  }
}

function rememberSignOut(signedOut: boolean): void {
  try {
    if (signedOut) {
      localStorage.setItem(PROMPT_LOGIN_KEY, '1')
    } else {
      localStorage.removeItem(PROMPT_LOGIN_KEY)
    }
  } catch (error) {
    // Without storage the next sign-in may not ask for the password; on the web the sign-out form still ends the session.
    console.error('Remembering the sign-out on this device failed', error)
  }
}

/** The token endpoint answered (an OAuth error, or a failure status): sending the same request again will not help. */
function answered(error: unknown): boolean {
  return error instanceof OAuthError
}

/**
 * Ends the browser session of the sign-in pages. A top-level POST form, as the server only signs out on a POST from the
 * app's origin (a GET shows a page with a button); the server then sends the browser back to the app.
 */
function endBrowserSession(): void {
  const form = document.createElement('form')
  form.method = 'post'
  form.action = `${config.authUrl}/logout`
  form.hidden = true
  document.body.append(form)
  form.submit()
}

function jsonRequest(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): RequestInit {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' }
    init.body = JSON.stringify(body)
  }
  return init
}

export const useAuthStore = defineStore('auth', () => {
  const tokens = ref<StoredTokens | null>(initialTokens())
  const me = ref<Me | null>(null)
  const isAuthenticated = computed(() => tokens.value !== null)
  /**
   * The user the server last confirmed for the tokens kept here, from before this page load: their mail copy may open
   * before the server answers again, but only to be read until it does. Null when none was confirmed yet.
   */
  const knownUserId = computed(() => tokens.value?.userId ?? null)
  /** The desktop app sent the user to the system browser and waits for the `tresso://` link back. */
  const awaitingBrowser = ref(false)
  /** Keeping or forgetting the tokens failed, e.g. the keychain refused; shown to the user. */
  const storageError = ref<string | null>(null)
  /**
   * The web client signed out while the sign-in pages did not answer: this browser is still signed in there. The
   * sign-in screen says so, and the next start ends it once they answer (endOpenBrowserSession).
   */
  const browserSessionOpen = ref(!isDesktop && browserSessionLeftOpen())
  /** Goes up on every failure to keep or forget the tokens, so the same message is shown again when it happens again. */
  const storageFailures = ref(0)
  /**
   * The current token set is in the storage shared with other tabs. Only then does a set missing from that storage mean
   * that another tab signed out (a browser that refuses storage never had one there).
   */
  let keptInStorage = tokens.value !== null && tokenStorage.peek() !== null
  /** completeSignIn is exchanging a code; a remembered logout form must not go out meanwhile. */
  let completingSignIn = false
  /** A sign-out is under way; the buttons that start one show it. */
  const signingOut = ref(false)
  /** The server answered 402: the trial or subscription is over, and the payment screen covers the app. */
  const paymentRequired = ref(false)
  /** Goes up whenever a session ends, so an answer to a request from before cannot change the next session. */
  const generation = ref(0)
  /** Why the last session ended; null while none ended in this page load. */
  const sessionEnd = ref<SessionEnd | null>(null)
  /** What has to happen when a session ends (the mail copy closes or goes); a sign-out waits for all of it. */
  const endHandlers = new Set<(reason: SessionEnd) => Promise<void> | void>()
  /** Refresh tokens rotate: two refreshes with the same one would sign the user out, so a tab runs one at a time. */
  let refreshing: Promise<string> | null = null

  async function store(next: StoredTokens | null): Promise<void> {
    tokens.value = next
    try {
      await tokenStorage.save(next)
      keptInStorage = next !== null
      storageError.value = null
    } catch (error) {
      keptInStorage = false
      storageFailures.value++
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
      keptInStorage = tokens.value !== null
    } catch (error) {
      storageFailures.value++
      storageError.value = `The saved sign-in could not be read: ${String(error)}`
    }
  }

  // Every tab of the web client shares one sign-in: another tab's sign-in, refresh and sign-out reach this one here.
  watchTokens((next) => {
    const previous = tokens.value
    if (next === null) {
      if (previous !== null) {
        void endedElsewhere()
      }
      return
    }
    tokens.value = next
    keptInStorage = true
    if (previous !== null) {
      void confirmSameUser()
    }
  })

  /**
   * Whether the shared storage says another tab signed out, though its storage event has not reached this tab yet.
   * If so, this tab follows the sign-out now. Never true in the desktop app, which has one window.
   */
  function followSignOutElsewhere(): boolean {
    if (tokens.value === null || !keptInStorage || tokenStorage.peek() !== null) {
      return false
    }
    void endedElsewhere()
    return true
  }

  /**
   * Another tab stored a new token set while this one was signed in. Normally that tab refreshed; should it have
   * signed in as someone else, everything on this page belongs to the previous user, so it starts again.
   */
  async function confirmSameUser(): Promise<void> {
    const shown = me.value?.id
    if (shown === undefined) {
      return
    }
    try {
      const asked = tokens.value
      const current = await api<Me>('/api/v1/me')
      if (current.id !== shown) {
        window.location.reload()
        return
      }
      // The other tab's set came without the id (a new sign-in of the same user): this tab confirmed it.
      await keepUserId(asked, current.id)
    } catch (error) {
      // The next request finds out the same way.
      console.error('Checking who is signed in after another tab changed the sign-in failed', error)
    }
  }

  async function signIn(): Promise<void> {
    // After a sign-out the authorization page asks for the password again; the URL kept for reopenBrowser carries it.
    const pending = await startAuthorization(oauthConfig, signedOutBefore() ? { prompt: 'login' } : {})
    const entry: PendingSignIn = { state: pending.state, codeVerifier: pending.codeVerifier, server: config.apiUrl, url: pending.url }
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(entry))
    if (!isDesktop) {
      window.location.assign(pending.url)
      return
    }
    await openBrowser(pending.url)
  }

  /**
   * The desktop app opens the sign-in that is under way in the browser again, so whichever browser tab the user
   * finishes in, its answer belongs to it. Without one (or one for another server) a new sign-in starts.
   */
  async function reopenBrowser(): Promise<void> {
    const pending = pendingSignIn()
    if (pending?.url === undefined || pending.server !== config.apiUrl) {
      await signIn()
      return
    }
    await openBrowser(pending.url)
  }

  async function openBrowser(url: string): Promise<void> {
    awaitingBrowser.value = true
    try {
      await openInBrowser(url)
    } catch (error) {
      awaitingBrowser.value = false
      throw error
    }
  }

  /** Whether a sign-in was started here and waits for its answer. */
  function hasPendingSignIn(): boolean {
    return pendingSignIn() !== null
  }

  async function completeSignIn(callbackUrl: string): Promise<void> {
    completingSignIn = true
    try {
      await finishSignIn(callbackUrl)
    } finally {
      completingSignIn = false
    }
  }

  async function finishSignIn(callbackUrl: string): Promise<void> {
    const pending = pendingSignIn()
    if (pending === null) {
      throw new Error(isDesktop ? 'No sign-in was started in this window.' : 'No sign-in was started in this tab.')
    }
    // An answer with another state belongs to another sign-in, or to none: the one under way stays, and its own
    // answer still completes it. An error is reported only once the state shows it answers this sign-in.
    if (new URL(callbackUrl).searchParams.get('state') !== pending.state) {
      throw new OAuthError('The sign-in response does not match the request (state mismatch).', 'invalid_state')
    }
    sessionStorage.removeItem(PENDING_KEY)
    awaitingBrowser.value = false
    if (pending.server !== undefined && pending.server !== config.apiUrl) {
      throw new Error(`This sign-in was started for ${pending.server}, but Tresso now uses ${config.apiUrl}. Sign in again.`)
    }
    const code = parseCallback(callbackUrl, pending.state)
    await store(await exchangeCode(oauthConfig, code, pending.codeVerifier))
    rememberSignOut(false)
    // The user signed in at the sign-in pages again: the fresh browser session there replaces the old one, and is theirs.
    rememberBrowserSession(false)
    browserSessionOpen.value = false
  }

  /** A sign-in this tab started is on its way back, or its code is being exchanged now. */
  function signInUnderWay(): boolean {
    return completingSignIn || sessionStorage.getItem(PENDING_KEY) !== null
  }

  /**
   * The user signs out: this browser stops getting their pushes, the server revokes the refresh token, the tokens go,
   * and the web client also ends the browser session at the sign-in pages, so the next sign-in asks for the password.
   */
  async function signOut(): Promise<void> {
    if (signingOut.value) {
      return
    }
    signingOut.value = true
    try {
      await endSession('signedOut')
    } finally {
      signingOut.value = false
    }
  }

  /** Registers what has to happen when a session ends; returns the function that removes it again. */
  function onSessionEnd(handler: (reason: SessionEnd) => Promise<void> | void): () => void {
    endHandlers.add(handler)
    return () => endHandlers.delete(handler)
  }

  async function runEndHandlers(reason: SessionEnd): Promise<void> {
    const results = await Promise.allSettled([...endHandlers].map(async (handler) => handler(reason)))
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Ending the session here failed', result.reason)
      }
    }
  }

  /**
   * Ends the session here. When the user signs out, pushes to this browser stop first, while the tokens can still
   * tell the server. A session that expired keeps them, as a closed browser does: the user did not sign out, and
   * signing in again finds them on; another user signing in here drops them (releaseOtherUsersPush).
   */
  async function endSession(reason: 'signedOut' | 'expired'): Promise<void> {
    // First, so nothing still underway (a billing check that would reload the app, a refresh) acts on the session that
    // ends: their answers are dropped, a refreshed set is revoked.
    generation.value++
    refreshing = null
    if (reason !== 'signedOut') {
      forgetSession(reason)
      await store(null)
      await runEndHandlers(reason)
      return
    }
    rememberSignOut(true)
    // The newest set (another tab may have rotated it), taken for the server calls below before it goes.
    const ending = adoptStored()
    // Gone from this device at once, before the server is asked: every tab follows through the storage event, and a
    // refresh anywhere that finishes later drops and revokes its answer. Nothing here can refresh again: the calls
    // below use the access token as it is.
    forgetSession(reason)
    await store(null)
    let revocationAnswered = false
    const tellServer = (async () => {
      // The pushes first, while the access token is still valid at the server; then the revocation, which ends it.
      await withinTime(PUSH_BUDGET_MS, disableWebPush(sendWith(ending?.accessToken ?? null))).catch((error: unknown) => {
        // The subscription in the browser went before the server was asked (disableWebPush).
        console.error('Telling the server this browser signed out failed', error)
      })
      revocationAnswered = await revokeQuietly(ending?.refreshToken ?? null)
    })()
    await Promise.all([
      withinTime(SIGN_OUT_BUDGET_MS, tellServer).catch((error: unknown) => {
        console.error('The server did not confirm the sign-out in time', error)
      }),
      runEndHandlers(reason),
    ])
    if (!isDesktop) {
      // The sign-in pages keep a browser session of their own (with a remember-me cookie); the form ends it too. The
      // desktop app leaves the system browser's session alone, see docs/ARCHITECTURE.md (3.10).
      await endBrowserSessionOrRemember(revocationAnswered)
    }
  }

  /**
   * Sends the logout form when the sign-in pages answer; otherwise the form would only leave the user on the browser's
   * error page, so the app stays, remembers that the browser is still signed in there, and says so.
   */
  async function endBrowserSessionOrRemember(revocationAnswered?: boolean, atStart = false): Promise<void> {
    const reachable = await signInPagesAnswer(revocationAnswered)
    // At a start, the user may have signed in meanwhile (here or in another tab): the form would end that session.
    if (atStart && (tokens.value !== null || signInUnderWay() || !browserSessionLeftOpen())) {
      browserSessionOpen.value = tokens.value === null && browserSessionLeftOpen()
      return
    }
    if (reachable) {
      rememberBrowserSession(false)
      browserSessionOpen.value = false
      endBrowserSession()
      return
    }
    rememberBrowserSession(true)
    browserSessionOpen.value = true
  }

  /** At the start of the signed-out web client: ends a sign-in page session a sign-out could not end, once it answers. */
  async function endOpenBrowserSession(): Promise<void> {
    // Not while a sign-in is on its way: its callback loads the app too, and the form would end the new session.
    if (isDesktop || !browserSessionOpen.value || tokens.value !== null || signInUnderWay()) {
      return
    }
    await endBrowserSessionOrRemember(undefined, true)
  }


  function forgetSession(reason: SessionEnd): void {
    me.value = null
    paymentRequired.value = false
    sessionEnd.value = reason
  }

  /**
   * Revokes a refresh token at the server, best effort: signing out here matters more than what the server said.
   * Returns whether the server answered at all (an error answer counts); without a token there was nothing to ask.
   */
  async function revokeQuietly(refreshToken: string | null): Promise<boolean> {
    if (refreshToken === null) {
      return true
    }
    try {
      await withTimeout(REVOKE_TIMEOUT_MS, (fetchImpl) => revokeToken(oauthConfig, refreshToken, fetchImpl))
      return true
    } catch (error) {
      console.error('Revoking the sign-in at the server failed', error)
      return answered(error)
    }
  }

  /** Another tab signed out or its session ended: this one follows, without telling the server again. */
  async function endedElsewhere(): Promise<void> {
    generation.value++
    refreshing = null
    forgetSession('elsewhere')
    tokens.value = null
    keptInStorage = false
    await runEndHandlers('elsewhere')
  }

  /**
   * The token set to use instead of `stale`, refreshed at most once at a time in this tab and, under a lock, in all
   * tabs: inside the lock the stored set is read again, as another tab may have refreshed already.
   */
  function renew(stale: string): Promise<string> {
    if (refreshing === null) {
      const pending: Promise<string> = refreshUnderLock(stale).finally(() => {
        if (refreshing === pending) {
          refreshing = null
        }
      })
      refreshing = pending
    }
    return refreshing
  }

  /** Takes a set another tab stored, when it differs from the one this tab holds. */
  function adoptStored(): StoredTokens | null {
    const stored = tokenStorage.peek()
    // Null in storage is not a sign-out by itself (the storage may refuse writes); the storage event says when it is.
    if (stored !== undefined && stored !== null && tokens.value !== null && stored.refreshToken !== tokens.value.refreshToken) {
      tokens.value = stored
    }
    return tokens.value
  }

  function refreshUnderLock(stale: string): Promise<string> {
    const session = generation.value
    return withRefreshLock(async () => {
      const latest = session === generation.value && !followSignOutElsewhere() ? adoptStored() : null
      if (latest === null) {
        throw new ApiError(401, 'Not signed in.')
      }
      if (latest.accessToken !== stale && isFresh(latest)) {
        return latest.accessToken
      }
      if (latest.refreshToken === null) {
        void endSession('expired')
        throw new ApiError(401, EXPIRED)
      }
      const refreshToken = latest.refreshToken
      const request = () => withTimeout(REFRESH_TIMEOUT_MS, (fetchImpl) => refreshTokens(oauthConfig, refreshToken, fetchImpl))
      let next: TokenSet
      try {
        try {
          next = await request()
        } catch (error) {
          if (answered(error) || session !== generation.value) {
            throw error
          }
          // The answer was lost (offline for a moment, a timeout): the server may have rotated the token anyway, and
          // gives the same answer again for a short while, so ask once more right away rather than at the next request.
          await wait(REFRESH_RETRY_DELAY_MS)
          if (session !== generation.value) {
            throw error
          }
          next = await request()
        }
      } catch (error) {
        if (session !== generation.value) {
          throw new ApiError(401, 'Not signed in.')
        }
        // The rule all clients share: only an answer that says the sign-in itself is over ends it. Anything else
        // (offline, a timeout, a 5xx, a server that does not know the app for a moment) may work on the next try.
        if (!refreshRefusalEndsSession(error)) {
          throw new SignInRenewalError(error)
        }
        // Refused: unless another tab or window stored a newer set meanwhile (a browser without locks), it is over.
        const newer = adoptStored()
        if (newer !== null && newer.refreshToken !== latest.refreshToken) {
          if (isFresh(newer)) {
            return newer.accessToken
          }
          throw new SignInRenewalError(error)
        }
        void endSession('expired')
        throw new ApiError(401, EXPIRED)
      }
      if (session !== generation.value || tokens.value === null || followSignOutElsewhere()) {
        // Signed out while it ran, here or in another tab: the new set must not sign the user back in, and is revoked
        // so it is of no use to anyone.
        void revokeQuietly(next.refreshToken)
        throw new ApiError(401, 'Not signed in.')
      }
      // The same user's set: the id confirmed for the one it replaces stays with it.
      await store(latest.userId === undefined ? next : { ...next, userId: latest.userId })
      return next.accessToken
    }, { waitMs: REFRESH_LOCK_WAIT_MS })
  }

  async function accessToken(): Promise<string> {
    const current = tokens.value
    if (current === null) {
      throw new ApiError(401, 'Not signed in.')
    }
    if (isFresh(current)) {
      return current.accessToken
    }
    return renew(current.accessToken)
  }

  /** A token to retry with after the API refused `rejected`: one refreshed meanwhile, or a new one. */
  function accessTokenAfterRejection(rejected: string): Promise<string> {
    const current = tokens.value
    if (current === null) {
      return Promise.reject(new ApiError(401, 'Not signed in.'))
    }
    if (current.accessToken !== rejected && isFresh(current)) {
      return Promise.resolve(current.accessToken)
    }
    return renew(rejected)
  }

  /** The server's clock, as the Date header of its answers tells it (for send times it keeps, such as undo). */
  const clock = new ServerClock()

  async function request(path: string, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    headers.set('Accept', 'application/json')
    const sentAt = Date.now()
    const response = await fetch(`${config.apiUrl}${path}`, { ...init, headers })
    clock.note(response.headers.get('Date'), sentAt)
    return response
  }

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    // A request that hangs is given up after a while, so what waits on it (a hand-over, say) fails instead of waiting for
    // ever. Uploads of the user's files may rightly take longer and keep only the caller's own signal.
    const upload = init.body instanceof FormData || init.body instanceof Blob
    return upload ? answer<T>(path, init) : withDeadline((signal) => answer<T>(path, { ...init, signal }), init.signal)
  }

  async function answer<T>(path: string, init: RequestInit): Promise<T> {
    const session = generation.value
    const sent = await accessToken()
    let response = await request(path, init, sent)
    if (response.status === 401 && session === generation.value) {
      // The server refused a token this tab took for valid (revoked, or the clock is off): refresh once and retry
      // once. Only a refused refresh or a second 401 ends the session.
      const retry = await accessTokenAfterRejection(sent)
      response = await request(path, init, retry)
      if (response.status === 401) {
        if (session === generation.value) {
          void endSession('expired')
        }
        throw new ApiError(401, EXPIRED)
      }
    }
    if (session !== generation.value) {
      // The session ended while the request ran: its answer belongs to no one now, and must not reach the next user.
      // Not a 401: the server said nothing of the kind, and may have done what was asked (a send may be queued).
      throw new SessionEndedDuringRequestError()
    }
    if (response.status === 401) {
      throw new ApiError(401, EXPIRED)
    }
    if (response.status === 402) {
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
    return api<T>(path, jsonRequest(method, body))
  }

  /**
   * `send` with one fixed access token, for the sign-out's own calls after the tokens are gone: no refresh, no retry,
   * so nothing it does can sign the user back in.
   */
  function sendWith(token: string | null): <T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<T> {
    return async <T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> => {
      if (token === null) {
        throw new ApiError(401, 'Not signed in.')
      }
      const response = await request(path, jsonRequest(method, body), token)
      if (!response.ok) {
        throw await ApiError.fromResponse(path, response)
      }
      return (response.status === 204 ? undefined : await response.json()) as T
    }
  }

  /**
   * Asks the server who is signed in. An answer to a token set that was replaced while it was asked (a refresh, or
   * another tab's sign-in, maybe of someone else) is not taken: the server is asked again with the set as it is now.
   */
  async function loadMe(): Promise<void> {
    const session = generation.value
    for (let attempt = 0; attempt < LOAD_ME_ATTEMPTS; attempt++) {
      const asked = tokens.value
      const loaded = await api<Me>('/api/v1/me')
      // A sign-out while it ran: the answer is about a user who is gone.
      if (session !== generation.value) {
        return
      }
      if (tokens.value !== asked) {
        continue
      }
      me.value = loaded
      // Not awaited: the id is in `tokens` at once, and the copy of another user must not wait for the keychain.
      void keepUserId(asked, loaded.id)
      return
    }
    throw new Error('The sign-in kept changing while Tresso asked who is signed in. It tries again.')
  }

  /**
   * Keeps the id the server confirmed next to the tokens it confirmed it for, so the next start can open that user's
   * copy at once. Not when the set changed while the server was asked (a refresh, or another tab's sign-in): the id
   * might then belong to another set; the next confirmation keeps it.
   */
  async function keepUserId(asked: StoredTokens | null, userId: string): Promise<void> {
    const current = tokens.value
    if (current === null || current !== asked || current.userId === userId) {
      return
    }
    await store({ ...current, userId })
  }

  return {
    tokens,
    me,
    isAuthenticated,
    knownUserId,
    awaitingBrowser,
    storageError,
    browserSessionOpen,
    endOpenBrowserSession,
    storageFailures,
    signingOut,
    paymentRequired,
    generation,
    sessionEnd,
    restore,
    signIn,
    reopenBrowser,
    hasPendingSignIn,
    completeSignIn,
    signOut,
    onSessionEnd,
    followSignOutElsewhere,
    loadMe,
    api,
    send,
    serverNow: () => clock.now(),
  }
})
