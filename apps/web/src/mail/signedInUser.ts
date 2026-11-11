import { config } from '@/config'
import { isDesktop } from '@/platform/desktop'

const KEY = 'tresso.signedInUser'

/**
 * Kept as long as the tokens are: in the tab on the web (sessionStorage, as the tokens), on the device in the desktop
 * app. Another tab of the same browser may be signed in as someone else, so the web never shares it between tabs.
 */
function storage(): Storage {
  return isDesktop ? localStorage : sessionStorage
}

/**
 * The id of the user signed in here, as the server last confirmed it, on the server Tresso talks to now. It lets the
 * mail copy open before the server answers again, so the mail is there when the app starts offline.
 */
export function signedInUser(): string | null {
  const raw = storage().getItem(KEY)
  if (raw === null) {
    return null
  }
  let kept: unknown
  try {
    kept = JSON.parse(raw)
  } catch {
    kept = null
  }
  if (typeof kept !== 'object' || kept === null || typeof (kept as { server?: unknown }).server !== 'string' || typeof (kept as { userId?: unknown }).userId !== 'string') {
    // Not what this Tresso keeps: dropped, so the start goes on as if nothing was kept.
    storage().removeItem(KEY)
    return null
  }
  const { server, userId } = kept as { server: string; userId: string }
  // User ids are only unique per server.
  return server === config.apiUrl ? userId : null
}

export function rememberSignedInUser(userId: string): void {
  storage().setItem(KEY, JSON.stringify({ server: config.apiUrl, userId }))
}

export function forgetSignedInUser(): void {
  storage().removeItem(KEY)
}
