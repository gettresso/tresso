/**
 * OAuth2 authorization code flow with PKCE (RFC 7636) for public clients: web and desktop.
 * Mobile uses expo-auth-session, which implements the same flow natively.
 */

export const USER_SCOPES = [
  'mail:read',
  'mail:write',
  'mail:send',
  'todos:read',
  'todos:write',
  'calendar:read',
  'calendar:write',
  'settings:read',
  'settings:write',
  'signatures:read',
  'signatures:write',
  'teams:read',
  'teams:write',
  'webhooks:manage',
] as const

export interface OAuthClientConfig {
  apiUrl: string
  clientId: string
  redirectUri: string
  scopes?: readonly string[]
  /**
   * Where the browser signs in, when the human-facing pages live on another address than the API (the app's own host,
   * say). Defaults to `<apiUrl>/oauth/authorize`. The token and revocation endpoints always stay on the API address.
   */
  authorizeUrl?: string
}

export interface PendingAuthorization {
  url: string
  state: string
  codeVerifier: string
}

export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  /** Epoch milliseconds. */
  expiresAt: number
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

/**
 * The one rule of every first-party client (web, desktop, phone) for a refused refresh: only an answer of the token
 * endpoint that says this sign-in itself is over ends the session. `invalid_grant` (revoked, expired, rotated already)
 * and `invalid_request` (a request the server will never accept) do. `invalid_client` and `unauthorized_client` do
 * not: they say the server does not know or allow the app (a deploy that briefly misconfigured the clients), which a
 * new sign-in would not cure either, and which must not sign out everyone who refreshes meanwhile. The tokens stay and
 * the next request tries again, as after a network error.
 */
export function refreshRefusalEndsSession(error: unknown): boolean {
  return error instanceof OAuthError && (error.code === 'invalid_grant' || error.code === 'invalid_request')
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomToken(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

export interface AuthorizationOptions {
  /**
   * `login` asks the authorization server to have the user enter the password again, whatever session the browser
   * holds (OpenID Connect `prompt`). Clients send it for the first sign-in after the user signed out. A server that does
   * not know the parameter ignores it.
   */
  prompt?: 'login'
}

export async function startAuthorization(config: OAuthClientConfig, options: AuthorizationOptions = {}): Promise<PendingAuthorization> {
  const state = randomToken(16)
  const codeVerifier = randomToken(48)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: (config.scopes ?? USER_SCOPES).join(' '),
    state,
    code_challenge: await codeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  })
  if (options.prompt !== undefined) {
    params.set('prompt', options.prompt)
  }

  return { url: `${authorizeEndpoint(config)}?${params}`, state, codeVerifier }
}

/** Validates the redirect back from the authorization server and returns the authorization code. */
export function parseCallback(callbackUrl: string, expectedState: string): string {
  const params = new URL(callbackUrl).searchParams
  const error = params.get('error')
  if (error !== null) {
    throw new OAuthError(params.get('error_description') ?? error, error)
  }
  if (params.get('state') !== expectedState) {
    throw new OAuthError('The sign-in response does not match the request (state mismatch).', 'invalid_state')
  }
  const code = params.get('code')
  if (code === null || code === '') {
    throw new OAuthError('The sign-in response contains no authorization code.', 'invalid_response')
  }
  return code
}

export function exchangeCode(
  config: OAuthClientConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  return requestToken(
    config,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier,
    },
    fetchImpl,
  )
}

export function refreshTokens(
  config: OAuthClientConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  return requestToken(
    config,
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.clientId },
    fetchImpl,
  )
}

/**
 * Revokes a refresh token at the authorization server (RFC 7009), so a copy of it stops working once the user signed
 * out. The server answers 200 whether or not it knew the token; anything else, and a network failure, throws, and the
 * caller decides whether that may stop the sign-out (it should not: forgetting the tokens matters more).
 */
export async function revokeToken(
  config: OAuthClientConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${trimSlash(config.apiUrl)}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: config.clientId }),
  })
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null)
    const error = isErrorResponse(payload) ? payload : null
    throw new OAuthError(error?.error_description ?? `Revoking the token failed (${response.status}).`, error?.error ?? null)
  }
}

async function requestToken(
  config: OAuthClientConfig,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  const response = await fetchImpl(`${trimSlash(config.apiUrl)}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body),
  })
  // Read as text first: a body that fails to arrive (the caller's signal aborted it) must fail the request, while a
  // body that is not JSON is only an unexpected answer.
  const payload = parseJson(await response.text())

  if (!response.ok || !isTokenResponse(payload)) {
    const error = isErrorResponse(payload) ? payload : null
    throw new OAuthError(error?.error_description ?? `Token request failed (${response.status}).`, error?.error ?? null)
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: Date.now() + payload.expires_in * 1000,
  }
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

function isTokenResponse(value: unknown): value is TokenResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TokenResponse).access_token === 'string' &&
    typeof (value as TokenResponse).expires_in === 'number'
  )
}

function isErrorResponse(value: unknown): value is { error: string; error_description?: string } {
  return typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string'
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function authorizeEndpoint(config: OAuthClientConfig): string {
  const custom = config.authorizeUrl?.trim() ?? ''
  return custom !== '' ? custom : `${trimSlash(config.apiUrl)}/oauth/authorize`
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
