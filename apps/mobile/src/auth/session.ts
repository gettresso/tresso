import { exchangeCode, OAuthError, refreshTokens, retryAfterMs, ServerClock, withDeadline, type Me, type OAuthClientConfig, type TokenSet } from '@tresso/core'
import { revokeToken } from '@/auth/revokeToken'

/** Refresh slightly before expiry so a request never leaves with a token that dies in flight. */
const EXPIRY_MARGIN_MS = 30_000
/** How long a sign-out waits for the server to revoke the refresh token before it goes on without it. */
const REVOKE_WAIT_MS = 5_000
/**
 * How long the token endpoint gets to answer, the body included. Every request that needs a token waits on the one
 * shared refresh, and Android sets no time limit of its own on a connection that died silently.
 */
const TOKEN_TIMEOUT_MS = 20_000
/**
 * The wait before a refresh whose answer never came is sent again. The server may have rotated the token already; it
 * answers the same refresh token with the same new pair for 30 seconds, so the retry has to come well within that.
 */
const REFRESH_RETRY_DELAY_MS = 2_000
/** The token endpoint's answers that mean the refresh token is no longer good; anything else is tried again later. */
const REFUSED_REFRESH = new Set(['invalid_grant', 'invalid_request'])
const EXPIRED = 'Your session has expired. Sign in again.'

/** Where the tokens are kept between launches. */
export interface TokenStore {
  load(): Promise<TokenSet | null>
  /** Keeps this token set, or removes the kept one (null). */
  save(tokens: TokenSet | null): Promise<void>
  /** Forgets who was signed in last (see MailProvider), so their mail no longer opens before the server answers. */
  forgetUser(): Promise<void>
  /** The kept refresh token on its own, also when the rest of the set is gone (a sign-out cut off halfway). */
  refreshToken(): Promise<string | null>
  /** Whether the next sign-in has to ask for the password again (see {@link Session.loginRequired}). */
  loginRequired(): Promise<boolean>
  setLoginRequired(required: boolean): Promise<void>
}

/** Why the sign-in ended: the user signed out, or the server no longer accepts it. */
export type SessionEnd = 'signedOut' | 'expired'

export interface SessionState {
  tokens: TokenSet | null
  /** Keeping or forgetting the tokens failed; shown to the user. */
  storageError: string | null
  /** The kept sign-in could not be read at launch: it may still be there, so reading it is tried again. */
  restoreFailed: boolean
  /**
   * The tokens were read from the previous launch, so they belong to the user who was signed in last. Tokens from a
   * sign-in here may belong to someone else until the server says who it is.
   */
  restored: boolean
  /**
   * How the last sign-in ended, null while signed in or when none ended in this run. Only a sign-out the user asked
   * for removes the mail on the phone; an expired sign-in keeps it, with its unsent drafts, for the next sign-in.
   */
  ended: SessionEnd | null
  /** The server answered 402: the trial or subscription is over, and a notice covers the app until it is renewed. */
  paymentRequired: boolean
}

/** Billing paths a blocked user still reaches; an answer from them says nothing about being unblocked. */
const OPEN_PATHS = ['/api/v1/billing', '/api/v1/server-info']

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Messages per field path (e.g. "subject"), from the API's validation violations. */
    readonly violations: Record<string, string> = {},
    /** How long the server asked to wait before trying again (Retry-After), in ms; null when it did not say. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * The sign-in could not be renewed because no answer came (offline, a timeout, a server error). The tokens are kept,
 * and the next request tries again.
 */
export class RenewalFailedError extends Error {
  constructor(readonly cause: unknown) {
    super(`The sign-in could not be renewed right now: ${message(cause)}`)
    this.name = 'RenewalFailedError'
  }
}

/**
 * The signed-in user's tokens: kept in the store, refreshed before they expire, and handed to API requests. Plain
 * TypeScript without React Native, so it is tested directly; the screens read it through `AuthProvider`.
 */
export class Session {
  private state: SessionState = { tokens: null, storageError: null, restoreFailed: false, restored: false, ended: null, paymentRequired: false }
  private readonly listeners = new Set<() => void>()
  /** Refresh tokens rotate: two refreshes with the same one would sign the user out, so they share one request. */
  private refreshing: Promise<string> | null = null
  /** Goes up whenever a sign-in ends, so a refresh that finishes afterwards cannot sign the user back in. */
  private generation = 0
  /** Every write to the store, one after another, so a removal never lands between the steps of an earlier save. */
  private writes: Promise<void> = Promise.resolve()
  /**
   * The store no longer names the previous user or a sign-out (see {@link prepareStore}). Until it does, tokens are
   * not kept: they would open another user's mail at the next launch, or be taken for an unfinished sign-out.
   */
  private prepared = true
  /** The server's clock, as the Date header of its answers tells it (for send times it keeps, such as undo). */
  private readonly clock = new ServerClock()

  constructor(
    private readonly config: OAuthClientConfig,
    private readonly store: TokenStore,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  get snapshot(): SessionState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Reads the sign-in kept from the previous launch. Called again after it failed; a sign-in or sign-out made in the
   * meantime wins over what it reads. A sign-out the user asked for that was cut off (the app was killed) is finished
   * here: it ends as signed out, so the mail on the phone is removed too.
   */
  async restore(): Promise<void> {
    const generation = this.generation
    try {
      const [tokens, signedOut] = await Promise.all([this.store.load(), this.store.loginRequired()])
      if (generation !== this.generation || this.state.tokens !== null) {
        return
      }
      if (!signedOut) {
        this.update({ tokens, restored: tokens !== null, restoreFailed: false, storageError: null })
        return
      }
      this.update({ tokens: null, restored: false, restoreFailed: false, ended: 'signedOut', storageError: null })
      // Also without a loadable set: a sign-out cut off inside the removal can leave a refresh token or the last user.
      await this.finishSignOut(tokens?.refreshToken ?? null)
    } catch (error) {
      if (generation === this.generation && this.state.tokens === null) {
        this.update({ restoreFailed: true, storageError: `The saved sign-in could not be read: ${message(error)}` })
      }
    }
  }

  /**
   * Exchanges the authorization code from the browser for tokens and keeps them. The store is prepared first (see
   * {@link prepareStore}); while that fails, the tokens are not kept.
   */
  async completeSignIn(code: string, codeVerifier: string): Promise<void> {
    const tokens = await exchangeCode(this.config, code, codeVerifier, this.fetchImpl)
    this.update({ tokens, restored: false, restoreFailed: false, ended: null })
    this.prepared = false
    await this.saveTokens(tokens)
  }

  /**
   * Whether the next sign-in asks for the password again (`prompt=login`): after a sign-out the user asked for, until
   * a sign-in completes, also across launches. The server keeps the browser signed in (remember-me) and approves the
   * app without a page, so otherwise "Sign in" would go straight back in as the same user, with no way to switch
   * account. An expired sign-in does not ask. When the store cannot say, it asks, which costs only a password.
   */
  async loginRequired(): Promise<boolean> {
    try {
      return await this.store.loginRequired()
    } catch {
      return true
    }
  }

  /**
   * The sign-out the user asked for: the refresh token is revoked at the server (best effort, it does not wait long),
   * then the tokens and who was signed in are removed from the phone, and with them the mail on it (MailProvider). The
   * next sign-in asks for the password again ({@link loginRequired}).
   */
  async signOut(): Promise<void> {
    const refreshToken = this.state.tokens?.refreshToken ?? null
    this.generation++
    this.refreshing = null
    // Signed out at once: a request made while the revocation is underway finds no tokens and starts no refresh.
    this.update({ tokens: null, restored: false, ended: 'signedOut', paymentRequired: false })
    let failure: unknown = null
    try {
      // First, so a sign-out cut off from here on is finished at the next launch (see restore).
      await this.write(() => this.store.setLoginRequired(true))
    } catch (error) {
      failure = error
    }
    if (refreshToken !== null) {
      await this.revoke(refreshToken)
    }
    try {
      await this.removeSignIn()
    } catch (error) {
      failure ??= error
    }
    // A sign-in completed during the revocation: its own write prepared the store and kept its tokens, and its state
    // is not this sign-out's to report on.
    if (this.state.tokens === null) {
      this.update({ storageError: failure === null ? null : `You are signed out here, but the sign-in could not be removed from this device: ${message(failure)}` })
    }
  }

  async accessToken(): Promise<string> {
    const current = this.state.tokens
    if (current === null) {
      throw new ApiError(401, 'Not signed in.')
    }
    if (current.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
      return current.accessToken
    }
    return this.renew(current)
  }

  async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    // A request that hangs is given up after a while, so what waits on it (a hand-over, say) fails instead of waiting for
    // ever. Uploads of the user's files may rightly take longer and keep only the caller's own signal.
    const upload = init.body instanceof FormData || (typeof Blob !== 'undefined' && init.body instanceof Blob)
    return upload ? this.answer<T>(path, init) : withDeadline((signal) => this.answer<T>(path, { ...init, signal }), init.signal)
  }

  private async answer<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.accessToken()
    const generation = this.generation
    let response = await this.send(path, init, token)
    if (response.status === 401 && generation === this.generation) {
      // The server refused a token that looked valid here (revoked, or the clock is off): renew it once and ask again.
      const current = this.state.tokens
      if (current === null) {
        throw new ApiError(401, EXPIRED)
      }
      const renewed = current.accessToken === token ? await this.renew(current) : current.accessToken
      if (generation !== this.generation) {
        throw new ApiError(401, EXPIRED)
      }
      response = await this.send(path, init, renewed)
      // Only for this session: a late answer to the previous one must not end the sign-in made since.
      if (response.status === 401 && generation === this.generation) {
        await this.expire()
      }
    }
    if (response.status === 401) {
      throw new ApiError(401, EXPIRED)
    }
    if (generation !== this.generation) {
      // Signed out while it was under way: its answer belongs to no one now, and must not reach the next user (a
      // hand-over step that resumes with it would open the previous user's mail in the next user's composer).
      throw new ApiError(401, 'Signed out while this request was under way.')
    }
    if (response.status === 402) {
      this.update({ paymentRequired: true })
    } else if (response.ok && this.state.paymentRequired && !OPEN_PATHS.some((open) => path.startsWith(open))) {
      // The server serves this user again (renewed elsewhere): the notice goes.
      this.update({ paymentRequired: false })
    }
    if (!response.ok) {
      const problem = await problemOf(response)
      throw new ApiError(response.status, problem.detail, problem.violations, retryAfterMs(response.headers.get('Retry-After')))
    }
    return (response.status === 204 ? undefined : await response.json()) as T
  }

  /** The time on the server's clock (epoch ms), as well as its answers told it. */
  serverNow(): number {
    return this.clock.now()
  }

  me(): Promise<Me> {
    return this.api<Me>('/api/v1/me')
  }

  private async send(path: string, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    headers.set('Accept', 'application/json')
    const sentAt = Date.now()
    const response = await this.fetchImpl(`${this.config.apiUrl.replace(/\/+$/, '')}${path}`, { ...init, headers })
    this.clock.note(response.headers.get('Date'), sentAt)
    return response
  }

  /** A new access token for these tokens, from one refresh shared by every request that needs it. */
  private async renew(current: TokenSet): Promise<string> {
    if (current.refreshToken === null) {
      await this.expire()
      throw new ApiError(401, EXPIRED)
    }
    if (this.refreshing === null) {
      const pending: Promise<string> = this.refresh(current.refreshToken).finally(() => {
        if (this.refreshing === pending) {
          this.refreshing = null
        }
      })
      this.refreshing = pending
    }
    return this.refreshing
  }

  private async refresh(refreshToken: string): Promise<string> {
    const generation = this.generation
    const request = () => this.limited(TOKEN_TIMEOUT_MS, (fetchImpl) => refreshTokens(this.config, refreshToken, fetchImpl))
    let next: TokenSet
    try {
      try {
        next = await request()
      } catch (error) {
        if (error instanceof OAuthError || generation !== this.generation) {
          throw error
        }
        // The answer was lost (offline for a moment, the time limit): the server may have rotated the token anyway, and
        // gives the same answer again for a short while, so ask once more now rather than at the next request.
        await wait(REFRESH_RETRY_DELAY_MS)
        if (generation !== this.generation) {
          throw error
        }
        next = await request()
      }
    } catch (error) {
      if (generation !== this.generation) {
        throw new ApiError(401, 'Signed out.')
      }
      if (!(error instanceof OAuthError && error.code !== null && REFUSED_REFRESH.has(error.code))) {
        throw new RenewalFailedError(error)
      }
      await this.expire()
      throw error
    }
    if (generation !== this.generation) {
      // The sign-in ended while this was underway: the new refresh token is not kept, so it should not stay valid.
      if (next.refreshToken !== null) {
        void this.revoke(next.refreshToken)
      }
      throw new ApiError(401, 'Signed out.')
    }
    this.update({ tokens: next })
    await this.saveTokens(next)
    return next.accessToken
  }

  /**
   * The server no longer accepts the sign-in. The tokens go, but who was signed in stays, and so does their mail on
   * the phone: drafts that did not reach the server yet are still there when they sign in again.
   */
  private async expire(): Promise<void> {
    this.generation++
    this.refreshing = null
    this.update({ tokens: null, ended: 'expired', paymentRequired: false })
    try {
      await this.write(async () => {
        // A flag from an earlier sign-out that this sign-in could not clear would remove this user's mail next launch.
        if (!this.prepared) {
          await this.store.setLoginRequired(false)
        }
        await this.store.save(null)
      })
      this.prepared = true
      this.update({ storageError: null })
    } catch (error) {
      this.update({ storageError: `Your session has expired, but the sign-in could not be removed from this device: ${message(error)}` })
    }
  }

  /** Keeps a new token set, once the store is prepared for it. */
  private async saveTokens(tokens: TokenSet): Promise<void> {
    try {
      await this.write(async () => {
        if (!this.prepared) {
          await this.prepareStore()
        }
        await this.store.save(tokens)
      })
      this.update({ storageError: null })
    } catch (error) {
      this.update({ storageError: notKept(error) })
    }
  }

  /**
   * Readies the store for the tokens of a sign-in made here: who was signed in last is forgotten, so these tokens
   * never open another user's mail, and the flag of an earlier sign-out is cleared, so the next launch does not finish
   * that sign-out (and the next sign-in does not ask for the password again).
   */
  private async prepareStore(): Promise<void> {
    await this.store.forgetUser()
    await this.store.setLoginRequired(false)
    this.prepared = true
  }

  private async finishSignOut(refreshToken: string | null): Promise<void> {
    // A sign-out cut off inside the removal can leave the refresh token without the rest of the set.
    let leftover = refreshToken
    if (leftover === null) {
      try {
        leftover = await this.store.refreshToken()
      } catch {
        // Unreadable: it is removed below all the same, and runs out on its own at the server.
      }
    }
    if (leftover !== null) {
      void this.revoke(leftover)
    }
    try {
      await this.removeSignIn()
    } catch (error) {
      this.update({ storageError: `You are signed out here, but the sign-in could not be removed from this device: ${message(error)}` })
    }
  }

  /**
   * Removes the tokens and who was signed in from the store, unless a sign-in completed since: its own write, queued
   * after this one or already done, forgets the previous user, clears the sign-out flag and keeps its tokens.
   */
  private removeSignIn(): Promise<void> {
    return this.write(async () => {
      if (this.state.tokens !== null) {
        return
      }
      await this.store.save(null)
      await this.store.forgetUser()
    })
  }

  private write(operation: () => Promise<void>): Promise<void> {
    const done = this.writes.then(operation)
    this.writes = done.catch(() => undefined)
    return done
  }

  private async revoke(refreshToken: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REVOKE_WAIT_MS)
    })
    // Best effort: when the server cannot be told, the token still leaves the phone and runs out on its own.
    const revoked = revokeToken(this.config, refreshToken, this.fetchImpl).catch(() => undefined)
    await Promise.race([revoked, waited])
    clearTimeout(timer)
  }

  /**
   * Runs `run` with a fetch that is aborted after `ms`, the reading of the answer included; past it this rejects with
   * a RequestTimeoutError also when the work does not follow the signal.
   */
  private limited<T>(ms: number, run: (fetchImpl: typeof fetch) => Promise<T>): Promise<T> {
    return withDeadline((signal) => run((input, init) => this.fetchImpl(input, { ...init, signal })), null, ms)
  }

  private update(change: Partial<SessionState>): void {
    this.state = { ...this.state, ...change }
    this.listeners.forEach((listener) => listener())
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function notKept(error: unknown): string {
  return `The sign-in could not be kept on this device, so you will have to sign in again next time: ${message(error)}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What the API said went wrong (RFC 9457 problem details), with its validation violations per field. */
async function problemOf(response: Response): Promise<{ detail: string; violations: Record<string, string> }> {
  const violations: Record<string, string> = {}
  try {
    const body = (await response.json()) as { detail?: unknown; title?: unknown; violations?: unknown }
    if (Array.isArray(body.violations)) {
      for (const violation of body.violations as { propertyPath?: unknown; message?: unknown }[]) {
        if (typeof violation.propertyPath === 'string' && typeof violation.message === 'string' && !(violation.propertyPath in violations)) {
          violations[violation.propertyPath] = violation.message
        }
      }
    }
    if (typeof body.detail === 'string' && body.detail !== '') {
      return { detail: body.detail, violations }
    }
    if (typeof body.title === 'string' && body.title !== '') {
      return { detail: body.title, violations }
    }
  } catch {
    // Not a problem document; fall through to the status.
  }
  return { detail: `The request failed (${response.status}).`, violations }
}
