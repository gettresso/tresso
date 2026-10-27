import { ref } from 'vue'

const KEY = 'tresso.server'
/** Plain http is only for a server on this machine (development, or a self-hosted stack started locally). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * The Tresso server an address names: https (or http on this machine), with an optional path, and nothing else.
 * "mail.example.com" means https://mail.example.com. Throws with a message for the user when it names none.
 */
export function normalizeServer(input: string): string {
  const text = input.trim()
  if (text === '') {
    throw new Error('Enter the address of a Tresso server.')
  }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    throw new Error(`"${text}" is not a web address.`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error('Use an https:// address. Plain http only works for a server on this computer.')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('Use the address of the server only, without a name, password, query or #.')
  }

  return trimSlash(`${url.origin}${url.pathname}`)
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function stored(fallback: string): string {
  const saved = read()
  if (saved === null) {
    return fallback
  }
  try {
    return normalizeServer(saved)
  } catch {
    return fallback
  }
}

/** The server the build points at: the hosted Tresso in a release, the local stack in development. */
export const defaultServer = trimSlash(import.meta.env.VITE_API_URL ?? '')

/**
 * The server the desktop app talks to: the default until the user picks their own at sign-in. The web client is
 * served by its server, so it always uses the default.
 */
export const server = ref(stored(defaultServer))

/** Uses another server from now on; null goes back to the default. Only while signed out: tokens belong to one server. */
export function chooseServer(address: string | null): void {
  const next = address === null ? defaultServer : normalizeServer(address)
  try {
    if (next === defaultServer) {
      localStorage.removeItem(KEY)
    } else {
      localStorage.setItem(KEY, next)
    }
  } catch (error) {
    throw new Error(`The server could not be kept on this device: ${String(error)}`)
  }
  server.value = next
}

/** How long a server gets to answer the check: an address that drops packets would otherwise hang for a minute. */
const CHECK_TIMEOUT_MS = 10_000

/**
 * Whether a server answers at all. A server that is down, a wrong address and a server that does not allow the desktop
 * app (CORS) look the same from here, so the message names all three. `signal` lets the user give up on the check.
 */
export async function reachServer(address: string, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS)
  try {
    await fetch(`${address}/api/v1/me`, {
      headers: { Accept: 'application/json' },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
  } catch (error) {
    if (signal?.aborted === true) {
      throw error
    }
    throw new Error(
      `Tresso could not reach ${address}. Check the address, that the server is up, and that it allows the desktop app (CORS_ALLOW_ORIGIN).`,
    )
  }
}

/**
 * A short, stable tag for a server, for names of things that belong to one server (the local mail copy). The default
 * server has none, so copies made before servers could be chosen keep their names.
 */
export function serverTag(address: string): string {
  if (address === defaultServer) {
    return ''
  }
  // FNV-1a: names only need to differ between servers, not to be secret.
  let hash = 0x811c9dc5
  for (let i = 0; i < address.length; i++) {
    hash = Math.imul(hash ^ address.charCodeAt(i), 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
