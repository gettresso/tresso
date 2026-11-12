import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { SqliteMailStore, type ChangePage, type MailStore } from '@tresso/core'
import { draft, page } from '@tresso/core/testing'
import { memorySql } from '@tresso/core/testing/sql'

/** One copy per user that lives across closes, as files on the device do; what happens to each is noted. */
const device = vi.hoisted(() => ({
  copies: new Map<string, MailStore>(),
  opened: [] as string[],
  closed: [] as string[],
  deleted: [] as string[],
  /** Pages of the delta written into each user's copy. */
  applied: new Map<string, number>(),
}))

vi.mock('@/mail/store', () => ({
  openMailStore: async (userId: string): Promise<MailStore> => {
    let copy = device.copies.get(userId)
    if (copy === undefined) {
      copy = await SqliteMailStore.open(await memorySql())
      device.copies.set(userId, copy)
    }
    device.opened.push(userId)
    // Closing keeps the copy on the device; only a delete removes it.
    const kept = copy
    return new Proxy(kept, {
      get(target, property, receiver) {
        if (property === 'close') {
          return async () => {
            device.closed.push(userId)
          }
        }
        if (property === 'apply') {
          return async (changes: ChangePage) => {
            device.applied.set(userId, (device.applied.get(userId) ?? 0) + 1)
            return target.apply(changes)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
  },
  mailCopyName: (userId: string) => `copy-${userId}`,
  // No copies of an earlier release on this device.
  copiesOnDevice: async () => [],
  deleteMailStore: async (userId: string) => {
    device.deleted.push(userId)
    device.copies.delete(userId)
  },
}))

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

/** The server: who /me says is signed in (held until the test answers), and every request it saw. */
function stubServer(): { requests: string[]; answerMe: (id: string) => void } {
  const requests: string[] = []
  let answer: ((id: string) => void) | null = null
  const waiting = new Promise<string>((resolve) => (answer = resolve))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.pathname === '/api/v1/me') {
        const id = await waiting
        return Response.json({ id, email: `${id}@example.test`, displayName: id, createdAt: '2026-01-01T00:00:00+00:00' })
      }
      if (url.pathname === '/api/v1/sync/changes') {
        return Response.json(page({ cursor: Number(url.searchParams.get('since')) + 1 }))
      }
      if (url.pathname === '/api/v1/billing') {
        return Response.json({ enabled: false, entitled: true, plans: [], organizations: [] })
      }
      if (url.pathname === '/api/v1/drafts') {
        return Response.json({ detail: 'Not expected here.' }, { status: 500 })
      }
      return new Response(null, { status: 204 })
    }),
  )
  return { requests, answerMe: (id) => answer!(id) }
}

/** Requests that sync, upload or stream: none may go out for a copy whose user the server did not confirm. */
function writes(requests: string[]): string[] {
  return requests.filter((request) => /sync\/changes|\/drafts|realtime/.test(request))
}

describe('a start before the server says who is signed in', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    device.copies.clear()
    device.opened = []
    device.closed = []
    device.deleted = []
    device.applied.clear()
    // Both copies are on the device; Ben's holds a draft that never reached the server.
    for (const userId of ['anna', 'ben']) {
      const copy = await SqliteMailStore.open(await memorySql())
      device.copies.set(userId, copy)
    }
    await device.copies.get('ben')!.changeDraft('ben-draft', () => draft('ben-draft', { subject: 'Unsent', pendingSave: true }))
    localStorage.setItem(
      'tresso.mail.copies',
      JSON.stringify([
        { userId: 'anna', name: 'copy-anna' },
        { userId: 'ben', name: 'copy-ben' },
      ]),
    )
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    const { useMailStore } = await import('@/stores/mail')
    await useMailStore().stop()
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  async function app() {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'unified', component: { template: '<div />' } }] })
    await router.push('/')
    await router.isReady()
    const { default: App } = await import('../App.vue')
    return mount(App, { global: { plugins: [router] } })
  }

  it('only reads the copy of the user kept with the tokens, and opens the right one once the server names another', async () => {
    // Ben's tokens, with Anna's id kept next to them (a keychain that refused to forget Anna's sign-in).
    localStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'access-ben', refreshToken: 'refresh-ben', expiresAt: Date.now() + 3_600_000, userId: 'anna' }))
    const server = stubServer()
    const { useMailStore } = await import('@/stores/mail')
    const mail = useMailStore()
    await app()
    await vi.waitFor(() => expect(mail.ready).toBe(true))

    expect(device.opened).toEqual(['anna'])
    expect(writes(server.requests)).toEqual([])

    server.answerMe('ben')
    await vi.waitFor(() => expect(mail.synced).toBe(true))
    await flushPromises()

    expect(device.closed).toContain('anna')
    expect(device.applied.get('anna') ?? 0).toBe(0)
    expect(device.applied.get('ben')).toBeGreaterThan(0)
    expect((await mail.drafts()).map((kept) => kept.id)).toEqual(['ben-draft'])
    expect(device.deleted).not.toContain('ben')
  })

  it('shows and keeps the copy of the user another tab signed in, not the one this tab knew before', async () => {
    // This tab was Anna's before it was put to sleep (an id kept in the tab by an older Tresso); another tab has
    // signed in as Ben since, and its tokens carry Ben's id.
    sessionStorage.setItem('tresso.signedInUser', JSON.stringify({ server: 'http://localhost:8080', userId: 'anna' }))
    localStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'access-ben', refreshToken: 'refresh-ben', expiresAt: Date.now() + 3_600_000, userId: 'ben' }))
    const server = stubServer()
    const { useMailStore } = await import('@/stores/mail')
    const mail = useMailStore()
    await app()
    await vi.waitFor(() => expect(mail.ready).toBe(true))

    expect(device.opened).toEqual(['ben'])
    expect(writes(server.requests)).toEqual([])
    server.answerMe('ben')
    await vi.waitFor(() => expect(mail.synced).toBe(true))
    await flushPromises()

    expect(device.opened).toEqual(['ben'])
    expect(device.deleted).not.toContain('ben')
    expect((await mail.drafts()).map((kept) => kept.id)).toEqual(['ben-draft'])
  })
  it('removes the copy shown before the server answered when the user signs out meanwhile', async () => {
    localStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'access-anna', refreshToken: 'refresh-anna', expiresAt: Date.now() + 3_600_000, userId: 'anna' }))
    const server = stubServer()
    // The sign-in pages' logout form is not followed in a test.
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
    const { useMailStore } = await import('@/stores/mail')
    const { useAuthStore } = await import('@/stores/auth')
    const mail = useMailStore()
    await app()
    await vi.waitFor(() => expect(mail.ready).toBe(true))

    await useAuthStore().signOut()
    await flushPromises()

    expect(device.deleted).toEqual(['anna'])
    expect(writes(server.requests)).toEqual([])
    expect(mail.ready).toBe(false)
  })
})
