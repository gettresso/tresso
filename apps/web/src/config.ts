import { isDesktop } from '@/platform/desktop'
import { defaultServer, server } from '@/platform/server'

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable ${name}`)
  }
  return value
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Where the web client's user signs in: the web image's TRESSO_AUTH_URL, else the build's VITE_AUTH_URL, else the
 * API address. The sign-in pages may live on the app's own host while the token endpoint stays on the API.
 */
function webAuthServer(): string {
  const runtime = typeof window === 'undefined' ? undefined : window.tressoConfig?.authUrl
  const configured = typeof runtime === 'string' && runtime.trim() !== '' ? runtime.trim() : (import.meta.env.VITE_AUTH_URL ?? '').trim()
  return configured === '' ? defaultServer : trimSlash(configured)
}

if (defaultServer === '') {
  throw new Error('Missing the server address: set VITE_API_URL for the build, or TRESSO_API_URL for the web image')
}

// The desktop app is its own OAuth client: it cannot receive a redirect to a web page, so the authorization server
// sends the browser to `tresso://auth/callback` and the shell hands that link to the app. It talks to the server the
// user chose at sign-in (the hosted Tresso by default); the web client to the server that serves it.
export const config = {
  get apiUrl(): string {
    return isDesktop ? server.value : defaultServer
  },
  /**
   * The address of the sign-in pages: /oauth/authorize and /logout. The desktop app uses the server it talks to; a
   * server whose sign-in lives elsewhere redirects there.
   */
  get authUrl(): string {
    return isDesktop ? server.value : webAuthServer()
  },
  get authorizeUrl(): string {
    return `${this.authUrl}/oauth/authorize`
  },
  clientId: isDesktop
    ? required('VITE_DESKTOP_OAUTH_CLIENT_ID', import.meta.env.VITE_DESKTOP_OAUTH_CLIENT_ID)
    : required('VITE_OAUTH_CLIENT_ID', import.meta.env.VITE_OAUTH_CLIENT_ID),
  redirectUri: isDesktop
    ? required('VITE_NATIVE_REDIRECT_URI', import.meta.env.VITE_NATIVE_REDIRECT_URI)
    : `${window.location.origin}/auth/callback`,
}
