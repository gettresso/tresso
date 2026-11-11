/**
 * Where a signed-out visitor was going (a link from a notification, a bookmark), kept in the tab across the trip to
 * the sign-in page, so the app opens there once signed in rather than on the Unified Inbox.
 */
const KEY = 'tresso.returnPath'

/** Starts with one slash only, and has no control characters or backslashes, which URL parsers drop or read as slashes. */
function plainPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && ![...path].some((character) => character === '\\' || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
}

/** Where the app runs: the page's own location, or another for a test. */
export interface AppLocation {
  protocol: string
  host: string
  href: string
}

/**
 * A path inside this app: one leading slash, no control characters or backslashes (`/\t/host` would become `//host`),
 * neither as written nor, in the path, once decoded (`/%09/host`, `/%2F/host`), still on this app's scheme and host
 * once resolved, and not the sign-in callback in any case (the router matches paths in any case). Scheme and host
 * are compared rather than origins: under the desktop app's own scheme (`tauri://localhost`) an origin is "null".
 */
export function returnablePath(path: unknown, app: AppLocation = window.location): string | null {
  if (typeof path !== 'string' || !plainPath(path)) {
    return null
  }
  // The query and fragment may hold encoded slashes of their own (a search for "a/b"); only the path leads somewhere.
  const pathOnly = path.split(/[?#]/, 1)[0]!
  let decoded: string
  try {
    decoded = decodeURIComponent(pathOnly)
  } catch {
    return null
  }
  if (!plainPath(decoded)) {
    return null
  }
  let resolved: URL
  try {
    resolved = new URL(path, app.href)
  } catch {
    return null
  }
  const pathname = resolved.pathname.toLowerCase()
  if (resolved.protocol !== app.protocol || resolved.host !== app.host || pathname.startsWith('//') || pathname.startsWith('/auth/')) {
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
