import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AppActivityEntry, AppActivityPage } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'
import { useAppActivityStore } from '../appActivity'

function entry(id: string, key: string, at: string): AppActivityEntry {
  return {
    id,
    occurredAt: at,
    app: { key, type: 'client', name: key, connectedAppId: null, personalAccessTokenId: null },
    channel: 'mcp',
    action: { name: 'get_me', title: 'Who am I' },
    kind: 'read',
    result: 'done',
    reason: null,
    durationMs: 1,
    permissions: [],
    object: null,
    lastOccurredAt: at,
    count: 1,
  }
}

function page(items: AppActivityEntry[], nextCursor: string | null = null, empty = false): AppActivityPage {
  return { items, nextCursor, apps: [{ key: 'client:a', type: 'client', name: 'A' }], empty }
}

describe('app activity store', () => {
  const asked: string[] = []
  /** Answers by query string; one held back until it is released. */
  let answers: Record<string, () => Promise<Response>>

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    asked.length = 0
    answers = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        asked.push(url.search)
        const answer = answers[url.search]
        return answer === undefined ? new Response(JSON.stringify(page([]))) : answer()
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  const json = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body)))

  it('loads a page with the filters, and the next one after it', async () => {
    answers['?period=7d&kind=read'] = json(page([entry('e1', 'client:a', '2026-11-24T10:00:00Z')], 'c2'))
    answers['?period=7d&kind=read&cursor=c2'] = json(page([entry('e2', 'client:a', '2026-11-23T10:00:00Z')]))
    const store = useAppActivityStore()

    await store.load({ period: '7d', kind: 'read' })
    expect(store.entries.map((one) => one.id)).toEqual(['e1'])
    expect(store.nextCursor).toBe('c2')
    await store.more({ period: '7d', kind: 'read' })
    expect(store.entries.map((one) => one.id)).toEqual(['e1', 'e2'])
    expect(store.nextCursor).toBeNull()
    await store.more({ period: '7d', kind: 'read' })
    expect(asked).toHaveLength(2)
  })

  it('drops an answer for filters that changed meanwhile', async () => {
    let release = () => undefined as void
    answers['?period=24h'] = () => new Promise((resolve) => (release = () => resolve(new Response(JSON.stringify(page([entry('old', 'client:a', '2026-11-24T10:00:00Z')]))))))
    answers['?period=90d'] = json(page([entry('new', 'client:a', '2026-11-24T10:00:00Z')]))
    const store = useAppActivityStore()

    const first = store.load({ period: '24h' })
    await store.load({ period: '90d' })
    release()
    await first
    expect(store.entries.map((one) => one.id)).toEqual(['new'])
  })

  it('clears everything and drops answers when another user signs in', async () => {
    answers['?period=24h'] = json(page([entry('e1', 'client:a', '2026-11-24T10:00:00Z')], 'c2', false))
    const store = useAppActivityStore()
    await store.load({ period: '24h' })
    let release = () => undefined as void
    answers['?period=24h&cursor=c2'] = () => new Promise((resolve) => (release = () => resolve(new Response(JSON.stringify(page([entry('e2', 'client:a', '2026-11-23T10:00:00Z')]))))))

    const pending = store.more({ period: '24h' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    useAuthStore().generation++
    await Promise.resolve()
    expect([store.entries, store.apps, store.nextCursor, store.empty]).toEqual([[], [], null, false])
    release()
    // The answer is for the previous user: it is refused or dropped, never shown.
    await pending.catch(() => undefined)
    expect(store.entries).toEqual([])
  })

  it('says when the log holds nothing at all', async () => {
    answers['?period=24h'] = json(page([], null, true))
    const store = useAppActivityStore()
    await store.load({ period: '24h' })
    expect(store.empty).toBe(true)
  })

  it('reads the recent activity of one app and when each app was last active', async () => {
    answers['?app=client%3Aa&limit=6'] = json(page([entry('e1', 'client:a', '2026-11-24T10:00:00Z')]))
    answers['?limit=100'] = json(page([entry('e1', 'client:a', '2026-11-24T10:00:00Z'), entry('e2', 'client:a', '2026-11-23T10:00:00Z'), entry('e3', 'client:b', '2026-11-22T10:00:00Z')]))
    const store = useAppActivityStore()

    expect((await store.recent('client:a')).map((one) => one.id)).toEqual(['e1'])
    expect(await store.lastActive()).toEqual({ 'client:a': '2026-11-24T10:00:00Z', 'client:b': '2026-11-22T10:00:00Z' })
    expect(store.entries).toEqual([])
  })
})
