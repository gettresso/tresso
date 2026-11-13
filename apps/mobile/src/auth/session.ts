import {
  exchangeCode,
  OAuthError,
  refreshRefusalEndsSession,
  refreshTokens,
  RequestTimeoutError,
  retryAfterMs,
  revokeToken,
  ServerClock,
  SessionEndedDuringRequestError,
  withDeadline,
  type Me,
  type OAuthClientConfig,
  type TokenSet,
} from '@tresso/core'

/** Refresh slightly before expiry so a request never leaves with a token that dies in flight. */
const EXPIRY_MARGIN_MS = 30_000
/** How long a sign-out waits for the server to revoke the refresh token before it goes on without it. */
const REVOKE_WAIT_MS = 5_000
/**
 * How long a sign-out waits for the server in all: removing this phone's push device, then revoking the refresh
 * token. The tokens are gone from the app before it starts.
 */
const SIGN_OUT_BUDGET_MS = 6_000
/**
 * The part of that budget the push device removal gets. It goes first: revoking the refresh token also revokes the
 * access token it is sent with, so after it the server would refuse it.
 */
const PUSH_BUDGET_MS = 2_500
/**
 * How long the token endpoint gets to answer, the body included. Every request that needs a token waits on the one
 * shared refresh, and Android sets no time limit of its own on a connection that died silently.
 */
const TOKEN_TIMEOUT_MS = 20_000
/**
 * The wait before a refresh whose answer never came is sent again. The server may have rotated the token already; it
 * answers the same refresh token with the same new pair for 30 seconds, so the retry has to come well within that.
 * After the time limit the retry goes out 22 seconds after the first request, leaving 8 of those seconds; when it
 * reaches the server later than that, the server refuses the old token and the session expires, the mail kept.
 */
const REFRESH_RETRY_DELAY_MS = 2_000
const EXPIRED = 'Your session has expired. Sign in again.'

/** Where the tokens are kept between launches. */
export interface TokenStore {
  load(): Promise<TokenSet | null>
  /** Keeps this token set, or removes the kept one (null). */
  save(tokens: TokenSet | null): Promise<void>
  /** Keeps who is signed in, so the next launch opens their mail before the server answers (see MailProvider). */
  rememberUser(userId: string): Promise<void>
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
  /** A sign-out the user asked for still tells the server (a few seconds at most); signed out here already. */
  signingOut: boolean
}

/**
 * A request for the sign-out's own calls to the server, with the access token as the sign-out found it: no refresh
 * and no retry, so nothing it does can sign the user back in.
 */
export type SignOutApi = <T>(path: string, init?: RequestInit) => Promise<T>

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
    /** The problem's `code`, which a client acts on (the chat endpoints' `already_going_out`, say); null when it named none. */
    readonly code: string | null = null,
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
  private state: SessionState = { tokens: null, storageError: null, restoreFailed: false, restored: false, ended: null, paymentRequired: false, signingOut: false }
  private readonly listeners = new Set<() => void>()
  /** Refresh tokens rotate: two refreshes with the same one would sign the user out, so they share one request. */
  private refreshing: Promise<string> | null = null
  /** The sign-out under way, which a second tap on Sign out joins. */
  private signingOut: Promise<void> | null = null
  /** Goes up whenever a sign-in ends, so a refresh that finishes afterwards cannot sign the user back in. */
  private generation = 0
  /** How the sign-in ended that last moved {@link generation} on, for requests that were under way then. */
  private lastEnd: SessionEnd = 'signedOut'
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
   * here: it ends as signed out, so the mail on the phone is removed too, and the server is told with `beforeRevoke`
   * (see {@link signOut}).
   */
  async restore(beforeRevoke?: (api: SignOutApi) => Promise<void>): Promise<void> {
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
      await this.finishSignOut(tokens, beforeRevoke)
    } catch (error) {
      if (generation === this.generation && this.state.tokens === null) {
        this.update({ restoreFailed: true, storageError: `The saved sign-in could not be read: ${message(error)}` })
      }
    }
  }

  /**
   * Exchanges the authorization code from the browser for tokens and keeps them. The store is prepared first (see
   * {@link prepareStore}); while that fails, the tokens are not kept. The exchange has the token endpoint's time
   * limit and is not asked again: a code is good for one exchange only.
   */
  async completeSignIn(code: string, codeVerifier: string): Promise<void> {
    const tokens = await this.limited(TOKEN_TIMEOUT_MS, (fetchImpl) => exchangeCode(this.config, code, codeVerifier, fetchImpl))
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
   * The sign-out the user asked for. The tokens leave the app at once. Then the server is told, within a few seconds
   * in all ({@link tellServer}): `beforeRevoke` (removing this phone's push device), then the revocation of the refresh
   * token, which ends the access token too. Last the tokens and who was signed in are removed from the phone, and with
   * them the mail on it (MailProvider). The next sign-in asks for the password again ({@link loginRequired}). Signed
   * out either way; rejects with the failure of `beforeRevoke` once all that is done.
   */
  signOut(beforeRevoke?: (api: SignOutApi) => Promise<void>): Promise<void> {
    if (this.signingOut === null) {
      const signingOut = this.endSignIn(beforeRevoke).finally(() => {
        this.signingOut = null
        this.update({ signingOut: false })
      })
      this.signingOut = signingOut
    }
    return this.signingOut
  }

  private async endSignIn(beforeRevoke?: (api: SignOutApi) => Promise<void>): Promise<void> {
    const ending = this.state.tokens
    this.generation++
    this.lastEnd = 'signedOut'
    this.refreshing = null
    // Signed out at once: a request made while the server is told finds no tokens and starts no refresh.
    this.update({ tokens: null, restored: false, ended: 'signedOut', paymentRequired: false, signingOut: true })
    let failure: unknown = null
    try {
      // First, so a sign-out cut off from here on is finished at the next launch (see restore).
      await this.write(() => this.store.setLoginRequired(true))
    } catch (error) {
      failure = error
    }
    let untold: unknown = null
    try {
      await this.tellServer(ending, beforeRevoke)
    } catch (error) {
      untold = error
    }
    try {
      await this.removeSignIn()
    } catch (error) {
      failure ??= error
    }
    // A sign-in completed while the server was told: its own write prepared the store and kept its tokens, and its
    // state is not this sign-out's to report on.
    if (this.state.tokens === null) {
      this.update({ storageError: failure === null ? null : `You are signed out here, but the sign-in could not be removed from this device: ${message(failure)}` })
    }
    if (untold !== null) {
      throw untold
    }
  }

  /**
   * Tells the server about a sign-out, within {@link SIGN_OUT_BUDGET_MS}: `beforeRevoke` first (2.5 seconds at most),
   * with an access token renewed first when it is about to expire, then the revocation of the newest refresh token.
   * Rejects with the failure of `beforeRevoke` once the revocation is done too.
   */
  private async tellServer(ending: TokenSet | null, beforeRevoke?: (api: SignOutApi) => Promise<void>): Promise<void> {
    let untold: unknown = null
    const deadline = Date.now() + SIGN_OUT_BUDGET_MS
    let refreshToken = ending?.refreshToken ?? null
    if (beforeRevoke !== undefined) {
      try {
        await withDeadline(
          async (signal) => {
            let accessToken = ending?.accessToken ?? null
            // A token about to expire is renewed first, as for any request, or the server would refuse the call. The
            // refresh token to revoke is then the new one; when its answer is lost, revoking the old one ends both.
            if (ending !== null && !isFresh(ending) && ending.refreshToken !== null) {
              const next = await refreshTokens(this.config, ending.refreshToken, (input, init) => this.fetchImpl(input, { ...init, signal }))
              accessToken = next.accessToken
              refreshToken = next.refreshToken ?? ending.refreshToken
            }
            await beforeRevoke(this.signOutApi(accessToken, signal))
          },
          null,
          PUSH_BUDGET_MS,
        )
      } catch (error) {
        untold = error instanceof RequestTimeoutError ? new Error('The server did not answer in time.') : error
      }
    }
    if (refreshToken !== null) {
      await this.revoke(refreshToken, Math.min(REVOKE_WAIT_MS, deadline - Date.now()))
    }
    if (untold !== null) {
      throw untold
    }
  }

  private signOutApi(accessToken: string | null, signal: AbortSignal): SignOutApi {
    return async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      if (accessToken === null) {
        throw new ApiError(401, 'Not signed in.')
      }
      const response = await this.send(path, { ...init, signal }, accessToken)
      if (!response.ok) {
        const problem = await problemOf(response)
        throw new ApiError(response.status, problem.detail, problem.violations, retryAfterMs(response.headers.get('Retry-After')), problem.code)
      }
      return (response.status === 204 ? undefined : await response.json()) as T
    }
  }

  async accessToken(): Promise<string> {
    const current = this.state.tokens
    if (current === null) {
      throw new ApiError(401, 'Not signed in.')
    }
    if (isFresh(current)) {
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

  /**
   * A request that `send` makes itself (a file upload through the platform's own uploader, which reads the file from its
   * URI and reports progress): with this session's token, renewed and sent once more when the server refused it, as `api`
   * does; the server's refusal as ApiError, a session that ended meanwhile as SessionEndedDuringRequestError.
   */
  async upload<T>(path: string, send: (url: string, token: string) => Promise<Response>): Promise<T> {
    const url = `${this.config.apiUrl.replace(/\/+$/, '')}${path}`
    const token = await this.accessToken()
    const generation = this.generation
    let response = await send(url, token)
    if (response.status === 401 && generation === this.generation) {
      const current = this.state.tokens
      if (current === null) {
        throw new ApiError(401, EXPIRED)
      }
      response = await send(url, current.accessToken === token ? await this.renew(current) : current.accessToken)
      if (response.status === 401 && generation === this.generation) {
        await this.expire()
      }
    }
    if (response.status === 401) {
      throw new ApiError(401, EXPIRED)
    }
    if (generation !== this.generation) {
      throw new SessionEndedDuringRequestError()
    }
    if (!response.ok) {
      const problem = await problemOf(response)
      throw new ApiError(response.status, problem.detail, problem.violations, retryAfterMs(response.headers.get('Retry-After')), problem.code)
    }
    return (response.status === 204 ? undefined : await response.json()) as T
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
      // hand-over step that resumes with it would open the previous user's mail in the next user's composer). Not a
      // 401: the server said nothing of the kind, and may have done what was asked (a send may be queued).
      throw new SessionEndedDuringRequestError()
    }
    if (response.status === 402) {
      this.update({ paymentRequired: true })
    } else if (response.ok && this.state.paymentRequired && !OPEN_PATHS.some((open) => path.startsWith(open))) {
      // The server serves this user again (renewed elsewhere): the notice goes.
      this.update({ paymentRequired: false })
    }
    if (!response.ok) {
      const problem = await problemOf(response)
      throw new ApiError(response.status, problem.detail, problem.violations, retryAfterMs(response.headers.get('Retry-After')), problem.code)
    }
    return (response.status === 204 ? undefined : await response.json()) as T
  }

  /**
   * Keeps who is signed in, once the server said who it is. It goes through the store's queue: a sign-in made here
   * forgets the previous user before its tokens are kept, and that must not land after this. Not for a sign-in that
   * ended since.
   */
  rememberUser(userId: string): Promise<void> {
    const generation = this.generation
    return this.write(async () => {
      if (generation !== this.generation || this.state.tokens === null) {
        return
      }
      if (!this.prepared) {
        // The sign-in's own write could not prepare the store, so its tokens were not kept: they go in with the user.
        await this.prepareStore()
        await this.store.save(this.state.tokens)
        this.update({ storageError: null })
      }
      await this.store.rememberUser(userId)
    })
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
        throw new ApiError(401, this.endedMessage())
      }
      if (!refreshRefusalEndsSession(error)) {
        throw new RenewalFailedError(error)
      }
      await this.expire()
      throw new ApiError(401, EXPIRED)
    }
    if (generation !== this.generation) {
      // The sign-in ended while this was underway: the new refresh token is not kept, so it should not stay valid.
      if (next.refreshToken !== null) {
        void this.revoke(next.refreshToken)
      }
      throw new ApiError(401, this.endedMessage())
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
    this.lastEnd = 'expired'
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

  /**
   * Finishes a sign-out cut off by the app's end. The server is told as the sign-out would have (the push device and
   * the revocation, best effort, within the same few seconds) while the sign-in is removed from the phone; a sign-in
   * waits for it ({@link SessionState.signingOut}).
   */
  private async finishSignOut(tokens: TokenSet | null, beforeRevoke?: (api: SignOutApi) => Promise<void>): Promise<void> {
    // A sign-out cut off inside the removal can leave the refresh token without the rest of the set.
    let leftover = tokens?.refreshToken ?? null
    if (leftover === null) {
      try {
        leftover = await this.store.refreshToken()
      } catch {
        // Unreadable: it is removed below all the same, and runs out on its own at the server.
      }
    }
    // Without a set, only the refresh token is left: an access token for the push device comes from renewing it.
    const ending = tokens ?? (leftover === null ? null : { accessToken: '', refreshToken: leftover, expiresAt: 0 })
    if (ending !== null && this.signingOut === null) {
      const told = this.tellServer(ending, beforeRevoke)
        .catch(() => undefined)
        .finally(() => {
          this.signingOut = null
          this.update({ signingOut: false })
        })
      this.signingOut = told
      this.update({ signingOut: true })
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

  /** Revokes a refresh token within `waitMs`, past which the request is aborted. */
  private async revoke(refreshToken: string, waitMs: number = REVOKE_WAIT_MS): Promise<void> {
    // Best effort: when the server cannot be told, the token still leaves the phone and runs out on its own.
    await this.limited(Math.max(0, waitMs), (fetchImpl) => revokeToken(this.config, refreshToken, fetchImpl)).catch(() => undefined)
  }

  private endedMessage(): string {
    return this.lastEnd === 'expired' ? EXPIRED : 'Signed out.'
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

function isFresh(tokens: TokenSet): boolean {
  return tokens.expiresAt - EXPIRY_MARGIN_MS > Date.now()
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
async function problemOf(response: Response): Promise<{ detail: string; violations: Record<string, string>; code: string | null }> {
  const violations: Record<string, string> = {}
  let code: string | null = null
  try {
    const body = (await response.json()) as { detail?: unknown; title?: unknown; violations?: unknown; code?: unknown }
    if (Array.isArray(body.violations)) {
      for (const violation of body.violations as { propertyPath?: unknown; message?: unknown }[]) {
        if (typeof violation.propertyPath === 'string' && typeof violation.message === 'string' && !(violation.propertyPath in violations)) {
          violations[violation.propertyPath] = violation.message
        }
      }
    }
    code = typeof body.code === 'string' && body.code !== '' ? body.code : null
    if (typeof body.detail === 'string' && body.detail !== '') {
      return { detail: body.detail, violations, code }
    }
    if (typeof body.title === 'string' && body.title !== '') {
      return { detail: body.title, violations, code }
    }
  } catch {
    // Not a problem document; fall through to the status.
  }
  return { detail: `The request failed (${response.status}).`, violations, code }
}
