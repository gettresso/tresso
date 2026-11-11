/**
 * Where a signed-out visitor was going (a link from a notification, a bookmark), kept in the tab across the trip to
 * the sign-in page, so the app opens there once signed in rather than on the Unified Inbox.
 */
const KEY = 'tresso.returnPath'

/** A path inside this app: one leading slash (not `//host`), and not the sign-in callback itself. */
export function returnablePath(path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\') || path.startsWith('/auth/')) {
    return null
  }
  return path
}

/** Keeps where to go after signing in; the Unified Inbox (or a path from elsewhere) keeps nothing. */
export function keepReturnPath(path: unknown): void {
  const returnable = returnablePath(path)
  if (returnable === null || returnable === '/') {
    sessionStorage.removeItem(KEY)
    return
  }
  sessionStorage.setItem(KEY, returnable)
}

/** Where to go now that the user is signed in, once: null for the Unified Inbox. */
export function takeReturnPath(): string | null {
  const kept = sessionStorage.getItem(KEY)
  sessionStorage.removeItem(KEY)
  return returnablePath(kept)
}
