/**
 * Where a signed-out visitor was going (a link from a notification, a bookmark), kept in the tab across the trip to
 * the sign-in page, so the app opens there once signed in rather than on the Unified Inbox.
 */
const KEY = 'tresso.returnPath'

/** Starts with one slash only, and has no control characters or backslashes, which URL parsers drop or read as slashes. */
function plainPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !/[\u0000-\u001f\u007f\\]/.test(path)
}

/**
 * A path inside this app: one leading slash, no control characters or backslashes (`/\t/host` would become `//host`),
 * neither as written nor once decoded (`/%09/host`, `/%2F/host`), still on this origin once resolved, and not the
 * sign-in callback.
 */
export function returnablePath(path: unknown): string | null {
  if (typeof path !== 'string' || !plainPath(path)) {
    return null
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }
  if (!plainPath(decoded)) {
    return null
  }
  let resolved: URL
  try {
    resolved = new URL(path, window.location.origin)
  } catch {
    return null
  }
  if (resolved.origin !== window.location.origin || resolved.pathname.startsWith('//') || resolved.pathname.startsWith('/auth/')) {
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
