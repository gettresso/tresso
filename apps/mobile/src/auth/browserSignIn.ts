import { AuthRequest, Prompt, type AuthRequestConfig, type AuthSessionResult } from 'expo-auth-session'
import { USER_SCOPES } from '@tresso/core'
import { config } from '@/config'
import { authorizationEndpoint } from '@/auth/authorizationEndpoint'

const TOKEN_ENDPOINT = `${config.apiUrl.replace(/\/+$/, '')}/oauth/token`

export interface AuthorizationCode {
  code: string
  codeVerifier: string
}

/**
 * Opens the authorization page in the system's authentication browser (ASWebAuthenticationSession on iOS, Custom
 * Tabs on Android), so the user's saved passwords and sessions work, and waits for the redirect to
 * `tresso://auth/callback`, at the sign-in address the server names (see authorizationEndpoint). Returns null when the
 * user closes the browser. The state is checked by AuthRequest.
 * `promptLogin` asks the server for the password again whatever session the browser holds (after a sign-out the
 * user asked for, see `Session.loginRequired`).
 */
export async function signInInBrowser(options: { promptLogin: boolean }): Promise<AuthorizationCode | null> {
  const request = new AuthRequest(authRequestConfig(options))
  const discovery = { authorizationEndpoint: await authorizationEndpoint(config.apiUrl), tokenEndpoint: TOKEN_ENDPOINT }
  return authorizationCode(await request.promptAsync(discovery), request.codeVerifier)
}

/** The authorization request: PKCE, every user scope, and `prompt=login` when the password has to be typed again. */
export function authRequestConfig({ promptLogin }: { promptLogin: boolean }): AuthRequestConfig {
  return {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: [...USER_SCOPES],
    usePKCE: true,
    ...(promptLogin ? { prompt: Prompt.Login } : {}),
  }
}

export function authorizationCode(result: AuthSessionResult, codeVerifier: string | undefined): AuthorizationCode | null {
  switch (result.type) {
    case 'success': {
      const code = result.params.code
      if (code === undefined || code === '' || codeVerifier === undefined) {
        throw new Error('The sign-in response contains no authorization code.')
      }
      return { code, codeVerifier }
    }
    case 'cancel':
    case 'dismiss':
      return null
    case 'locked':
      throw new Error('Another sign-in is already open.')
    case 'error':
      throw new Error(result.error?.description ?? result.params.error_description ?? result.error?.code ?? 'Sign-in failed.')
    case 'opened':
      throw new Error('The browser did not return to Tresso.')
  }
}
