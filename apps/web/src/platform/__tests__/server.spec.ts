import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The browser's local storage, kept in memory.
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

/** Loads the module fresh, so it reads the stored server again. */
async function serverModule() {
  vi.resetModules()
  return import('@/platform/server')
}

describe('the server the desktop app talks to', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['mail.example.com', 'https://mail.example.com'],
    ['  https://mail.example.com/  ', 'https://mail.example.com'],
    ['https://example.com/tresso/', 'https://example.com/tresso'],
    ['HTTPS://Mail.Example.com', 'https://mail.example.com'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
  ])('reads %j as %s', async (input, expected) => {
    const { normalizeServer } = await serverModule()

    expect(normalizeServer(input)).toBe(expected)
  })

  it.each([
    ['', 'Enter the address'],
    ['http://mail.example.com', 'https://'],
    ['ftp://mail.example.com', 'https://'],
    ['https://user:secret@mail.example.com', 'without a name, password'],
    ['https://mail.example.com/?server=1', 'without a name, password'],
    ['https://', 'not a web address'],
  ])('refuses %j', async (input, message) => {
    const { normalizeServer } = await serverModule()

    expect(() => normalizeServer(input)).toThrow(message)
  })

  it('starts on the server the build points at', async () => {
    const { server, defaultServer } = await serverModule()

    expect(defaultServer).toBe('http://localhost:8080')
    expect(server.value).toBe(defaultServer)
  })

  it('keeps a chosen server for the next launch, and forgets it on going back to the default', async () => {
    const first = await serverModule()
    first.chooseServer('mail.example.com')
    expect(first.server.value).toBe('https://mail.example.com')

    const next = await serverModule()
    expect(next.server.value).toBe('https://mail.example.com')

    next.chooseServer(null)
    expect(next.server.value).toBe(next.defaultServer)
    expect(localStorage.getItem('tresso.server')).toBeNull()
  })

  it('falls back to the default when the stored server is no longer valid', async () => {
    localStorage.setItem('tresso.server', 'http://mail.example.com')

    const { server, defaultServer } = await serverModule()

    expect(server.value).toBe(defaultServer)
  })

  it('names the likely causes when a server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Promise.reject(new TypeError('Load failed'))))
    const { reachServer } = await serverModule()

    await expect(reachServer('https://mail.example.com')).rejects.toThrow('CORS_ALLOW_ORIGIN')
  })

  it('takes any answer as a server that is there, a 401 too', async () => {
    const request = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', request)
    const { reachServer } = await serverModule()

    await expect(reachServer('https://mail.example.com')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('https://mail.example.com/api/v1/me', expect.anything())
  })
})
