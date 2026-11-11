import { OAuthError, type OAuthClientConfig } from '@tresso/core'

export async function revokeToken(config: OAuthClientConfig, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(`${config.apiUrl.replace(/\/+$/, '')}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: config.clientId }),
  })
  if (!response.ok) {
    throw new OAuthError(`Token revocation failed (${response.status}).`)
  }
}
