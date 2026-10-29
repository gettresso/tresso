import { exchangeCode, refreshTokens, type Me, type OAuthClientConfig, type TokenSet } from '@tresso/core'

/** Refresh slightly before expiry so a request never leaves with a token that dies in flight. */
const EXPIRY_MARGIN_MS = 30_000

/** Where the tokens are kept between launches. */
export interface TokenStore {
  load(): Promise<TokenSet | null>
  save(tokens: TokenSet | null): Promise<void>
}

export interface SessionState {
  tokens: TokenSet | null
  /** Keeping or forgetting the tokens failed; shown to the user. */
  storageError: string | null
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
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * The signed-in user's tokens: kept in the store, refreshed before they expire, and handed to API requests. Plain
 * TypeScript without React Native, so it is tested directly; the screens read it through `AuthProvider`.
 */
export class Session {
  private state: SessionState = { tokens: null, storageError: null, paymentRequired: false }
  private readonly listeners = new Set<() => void>()
  /** Refresh tokens rotate: two refreshes with the same one would sign the user out, so they share one request. */
  private refreshing: Promise<string> | null = null
  /** Goes up on every sign-out, so a refresh that finishes afterwards cannot sign the user back in. */
  private generation = 0

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

  /** Reads the sign-in kept from the previous launch. */
  async restore(): Promise<void> {
    try {
      this.update({ tokens: await this.store.load() })
    } catch (error) {
      this.update({ storageError: `The saved sign-in could not be read: ${message(error)}` })
    }
  }

  /** Exchanges the authorization code from the browser for tokens and keeps them. */
  async completeSignIn(code: string, codeVerifier: string): Promise<void> {
    await this.keep(await exchangeCode(this.config, code, codeVerifier, this.fetchImpl))
  }

  async signOut(): Promise<void> {
    this.generation++
    this.refreshing = null
    this.update({ paymentRequired: false })
    await this.keep(null)
  }

  async accessToken(): Promise<string> {
    const current = this.state.tokens
    if (current === null) {
      throw new ApiError(401, 'Not signed in.')
    }
    if (current.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
      return current.accessToken
    }
    if (current.refreshToken === null) {
      await this.signOut()
      throw new ApiError(401, 'Your session has expired. Sign in again.')
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

  async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await this.accessToken()}`)
    headers.set('Accept', 'application/json')

    const generation = this.generation
    const response = await this.fetchImpl(`${this.config.apiUrl.replace(/\/+$/, '')}${path}`, { ...init, headers })
    if (response.status === 401) {
      // Only for this session: a late answer to the previous one must not sign out the user who signed in since.
      if (generation === this.generation) {
        await this.signOut()
      }
      throw new ApiError(401, 'Your session has expired. Sign in again.')
    }
    if (generation !== this.generation) {
      // Signed out while it was underway: the answer says nothing about the next session.
    } else if (response.status === 402) {
      this.update({ paymentRequired: true })
    } else if (response.ok && this.state.paymentRequired && !OPEN_PATHS.some((open) => path.startsWith(open))) {
      // The server serves this user again (renewed elsewhere): the notice goes.
      this.update({ paymentRequired: false })
    }
    if (!response.ok) {
      const problem = await problemOf(response)
      throw new ApiError(response.status, problem.detail, problem.violations)
    }
    return (response.status === 204 ? undefined : await response.json()) as T
  }

  me(): Promise<Me> {
    return this.api<Me>('/api/v1/me')
  }

  private async refresh(refreshToken: string): Promise<string> {
    const generation = this.generation
    let next: TokenSet
    try {
      next = await refreshTokens(this.config, refreshToken, this.fetchImpl)
    } catch (error) {
      if (generation === this.generation) {
        await this.signOut()
      }
      throw error
    }
    if (generation !== this.generation) {
      throw new ApiError(401, 'Signed out.')
    }
    await this.keep(next)
    return next.accessToken
  }

  private async keep(tokens: TokenSet | null): Promise<void> {
    this.update({ tokens })
    try {
      await this.store.save(tokens)
      this.update({ storageError: null })
    } catch (error) {
      this.update({
        storageError:
          tokens === null
            ? `You are signed out here, but the sign-in could not be removed from this device: ${message(error)}`
            : `The sign-in could not be kept on this device, so you will have to sign in again next time: ${message(error)}`,
      })
    }
  }

  private update(change: Partial<SessionState>): void {
    this.state = { ...this.state, ...change }
    this.listeners.forEach((listener) => listener())
  }
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
