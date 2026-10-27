import { isDesktop } from '@/platform/desktop'
import { defaultServer, server } from '@/platform/server'

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable ${name}`)
  }
  return value
}

required('VITE_API_URL', import.meta.env.VITE_API_URL)

// The desktop app is its own OAuth client: it cannot receive a redirect to a web page, so the authorization server
// sends the browser to `tresso://auth/callback` and the shell hands that link to the app. It talks to the server the
// user chose at sign-in (the hosted Tresso by default); the web client to the server that serves it.
export const config = {
  get apiUrl(): string {
    return isDesktop ? server.value : defaultServer
  },
  clientId: isDesktop
    ? required('VITE_DESKTOP_OAUTH_CLIENT_ID', import.meta.env.VITE_DESKTOP_OAUTH_CLIENT_ID)
    : required('VITE_OAUTH_CLIENT_ID', import.meta.env.VITE_OAUTH_CLIENT_ID),
  redirectUri: isDesktop
    ? required('VITE_NATIVE_REDIRECT_URI', import.meta.env.VITE_NATIVE_REDIRECT_URI)
    : `${window.location.origin}/auth/callback`,
}
