import { describe, expect, it, vi } from 'vitest'
import { SessionEndedDuringRequestError } from '../requests'
import { chat, chatAccount, chatMessage, chatOutgoing } from '../store/contract'
import { itemsIn, retryablePull, retryAfterMs, SyncEngine, type PullProgress, type SyncStore } from './engine'
import type { ChangePage } from './types'

function page(cursor: number, hasMore = false, ids: string[] = []): ChangePage {
  return {
    cursor,
    hasMore,
    mailAccounts: [],
    folders: [],
    threads: ids.map((id) => ({
      id,
      mailAccountId: 'a',
      subject: id,
      messageCount: 1,
      lastMessageAt: '2026-10-19T08:00:00+00:00',
      smartInboxId: null,
      verdict: null,
      classificationReason: null,
    })),
    messages: [],
    outgoingMessages: [],
    signatures: [],
    drafts: [],
    smartInboxes: [],
    calendars: [],
    calendarEvents: [],
    notifications: [],
    eventNotes: [],
    todos: [],
    mailNotifications: [],
    handOvers: [],
    deleted: [],
  }
}

class MemoryStore implements SyncStore {
  stored = 0
  applied: number[] = []
  async cursor(): Promise<number> {
    return this.stored
  }
  async apply(p: ChangePage): Promise<void> {
    this.applied.push(p.cursor)
    this.stored = p.cursor
  }
}

describe('itemsIn', () => {
  it('counts the chat lists and their removals with the rest of a page', () => {
    const at = '2026-11-12T10:00:00+00:00'
    const withChats: ChangePage = {
      ...page(5, false, ['t1']),
      chatAccounts: [chatAccount('acct')],
      chats: [chat('anna', 'acct'), chat('bram', 'acct')],
      chatMessages: [chatMessage('a1', 'anna', 'acct', at), chatMessage('a2', 'anna', 'acct', at), chatMessage('b1', 'bram', 'acct', at)],
      chatOutgoing: [chatOutgoing('r1', 'anna', 'acct')],
      deleted: [{ type: 'chat', id: 'old' }, { type: 'chatMessage', id: 'gone' }],
    }

    expect(itemsIn(withChats)).toBe(1 + 1 + 2 + 3 + 1 + 2)
    expect(itemsIn(page(5, false, ['t1']))).toBe(1)
  })
})

describe('retryablePull', () => {
  it('gives up on a pull whose session ended while it ran, though the error carries no status', () => {
    expect(retryablePull(new SessionEndedDuringRequestError())).toBe(false)
    expect(retryablePull({ status: 401 })).toBe(false)
    expect(retryablePull(new Error('offline'))).toBe(true)
  })
})

describe('SyncEngine', () => {
  it('pulls every page from the stored cursor', async () => {
    const store = new MemoryStore()
    const pages = new Map([[0, page(5, true)], [5, page(9)]])
    const fetchPage = vi.fn(async (since: number) => pages.get(since)!)

    await new SyncEngine({ fetchPage, store, pageSize: 2 }).sync()

    expect(fetchPage.mock.calls).toEqual([[0, 2], [5, 2]])
    expect(store.applied).toEqual([5, 9])
  })

  it('stores nothing when nothing changed', async () => {
    const store = new MemoryStore()
    store.stored = 7

    await new SyncEngine({ fetchPage: async () => page(7), store }).sync()

    expect(store.applied).toEqual([])
  })

  it('never runs two pulls at once and honors a request made during a pull', async () => {
    const store = new MemoryStore()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let active = 0
    let maxActive = 0
    const responses = [page(1), page(2)]
    const fetchPage = vi.fn(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      if (fetchPage.mock.calls.length === 1) {
        await gate
      }
      active--
      return responses.shift() ?? page(2)
    })
    const engine = new SyncEngine({ fetchPage, store })

    const first = engine.sync()
    const second = engine.sync()
    release()
    await Promise.all([first, second])

    expect(maxActive).toBe(1)
    expect(store.applied).toEqual([1, 2])
  })

  it('ignores notifications it already has', async () => {
    const store = new MemoryStore()
    const fetchPage = vi.fn(async () => page(3))
    const engine = new SyncEngine({ fetchPage, store })
    await engine.sync()

    await engine.notify(3)
    expect(fetchPage).toHaveBeenCalledTimes(1)

    fetchPage.mockResolvedValueOnce(page(4)).mockResolvedValueOnce(page(4))
    await engine.notify(4)
    expect(store.applied).toEqual([3, 4])
  })

  it('reports each stored page', async () => {
    const onApplied = vi.fn()
    await new SyncEngine({ fetchPage: async () => page(2, false, ['t1']), store: new MemoryStore(), onApplied }).sync()

    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ cursor: 2 }))
  })

  it('refuses a server that goes backwards or does not advance', async () => {
    const store = new MemoryStore()
    store.stored = 5

    await expect(new SyncEngine({ fetchPage: async () => page(4), store, retryable: () => false }).sync()).rejects.toThrow('behind')
    await expect(new SyncEngine({ fetchPage: async () => page(5, true), store, retryable: () => false }).sync()).rejects.toThrow('did not advance')
  })

  it('can sync again after a failure', async () => {
    const store = new MemoryStore()
    const fetchPage = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page(1))
    const engine = new SyncEngine({ fetchPage, store })

    await expect(engine.sync()).rejects.toThrow('offline')
    await engine.sync()

    expect(store.applied).toEqual([1])
  })

  it('tries a failed pull again by itself, backing off, until one works', async () => {
    vi.useFakeTimers()
    try {
      const store = new MemoryStore()
      const failure = Object.assign(new Error('Bad gateway'), { status: 502 })
      const fetchPage = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockResolvedValue(page(1))
      const retried: Promise<void>[] = []
      const engine = new SyncEngine({ fetchPage, store, retryDelays: [2_000, 5_000], random: () => 0.5, retry: (pull) => retried.push(pull().catch(() => undefined)) })

      await expect(engine.sync()).rejects.toThrow('Bad gateway')
      await vi.advanceTimersByTimeAsync(1_999)
      expect(fetchPage).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchPage).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(fetchPage).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await Promise.all(retried)

      expect(retried).toHaveLength(2)
      expect(store.applied).toEqual([1])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchPage).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not try again a pull the session or the plan refused, nor after a stop', async () => {
    vi.useFakeTimers()
    try {
      const refused = vi.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }))
      await expect(new SyncEngine({ fetchPage: refused, store: new MemoryStore() }).sync()).rejects.toThrow('Unauthorized')

      const offline = vi.fn().mockRejectedValue(new Error('offline'))
      const engine = new SyncEngine({ fetchPage: offline, store: new MemoryStore() })
      await expect(engine.sync()).rejects.toThrow('offline')
      engine.stop()

      await vi.advanceTimersByTimeAsync(120_000)
      expect(refused).toHaveBeenCalledTimes(1)
      expect(offline).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('spreads the retries of clients that failed together, and waits as long as the server asked', async () => {
    vi.useFakeTimers()
    try {
      const busy = Object.assign(new Error('Too many requests'), { status: 429, retryAfterMs: 30_000 })
      const early = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page(1))
      const late = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue(page(1))
      await expect(new SyncEngine({ fetchPage: early, store: new MemoryStore(), random: () => 0 }).sync()).rejects.toThrow('offline')
      await expect(new SyncEngine({ fetchPage: late, store: new MemoryStore(), random: () => 0 }).sync()).rejects.toThrow('Too many')

      // 2 s less a fifth for the first; the second waits the 30 s the server asked for.
      await vi.advanceTimersByTimeAsync(1_600)
      expect(early).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(28_000)
      expect(late).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(400)
      expect(late).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tries a waiting pull at once when the network may be back', async () => {
    vi.useFakeTimers()
    try {
      const fetchPage = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page(1))
      const store = new MemoryStore()
      const engine = new SyncEngine({ fetchPage, store })
      expect(engine.wake()).toBe(false)
      await expect(engine.sync()).rejects.toThrow('offline')

      expect(engine.wake()).toBe(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(store.applied).toEqual([1])
      expect(engine.wake()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads Retry-After as seconds or as a date', () => {
    const now = Date.parse('2026-11-11T10:00:00Z')
    expect(retryAfterMs('120', now)).toBe(120_000)
    expect(retryAfterMs('Wed, 11 Nov 2026 10:01:00 GMT', now)).toBe(60_000)
    expect(retryAfterMs(null, now)).toBeNull()
    expect(retryAfterMs('soon', now)).toBeNull()
  })

  it('honours a Retry-After of at most an hour, and a wake does not cut it short', async () => {
    vi.useFakeTimers()
    try {
      const busy = Object.assign(new Error('Too many requests'), { status: 429, retryAfterMs: 90 * 24 * 3_600_000 })
      const fetchPage = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue(page(1))
      const engine = new SyncEngine({ fetchPage, store: new MemoryStore() })
      await expect(engine.sync()).rejects.toThrow('Too many')

      expect(engine.wake()).toBe(false)
      await vi.advanceTimersByTimeAsync(3_599_000)
      expect(fetchPage).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetchPage).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pulls when asked to while a Retry-After waits', async () => {
    vi.useFakeTimers()
    try {
      const busy = Object.assign(new Error('Too many requests'), { status: 429, retryAfterMs: 600_000 })
      const fetchPage = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue(page(1))
      const store = new MemoryStore()
      const engine = new SyncEngine({ fetchPage, store })
      await expect(engine.sync()).rejects.toThrow('Too many')

      await engine.sync()

      expect(store.applied).toEqual([1])
      await vi.advanceTimersByTimeAsync(600_000)
      expect(fetchPage).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says how far a pull got, page by page, with the newest change number the server names', async () => {
    const store = new MemoryStore()
    const synced: number[] = []
    const syncing: SyncStore = { cursor: () => store.cursor(), apply: (p) => store.apply(p), markSynced: async (at) => void synced.push(at) }
    const pages = [
      { ...page(400, true, ['t1', 't2']), latest: 1000 },
      { ...page(800, true, ['t3']), latest: 1200 },
      { ...page(1150, false, []), latest: 1200 },
    ]
    const reports: (PullProgress | null)[] = []
    const engine = new SyncEngine({ store: syncing, fetchPage: async () => pages.shift()!, onProgress: (p) => reports.push(p), now: () => 42 })

    await engine.sync()

    expect(reports).toEqual([
      { from: 0, cursor: 0, latest: null, items: 0, pages: 0, hasMore: null },
      { from: 0, cursor: 400, latest: 1000, items: 2, pages: 1, hasMore: true },
      { from: 0, cursor: 800, latest: 1200, items: 3, pages: 2, hasMore: true },
      { from: 0, cursor: 1150, latest: 1200, items: 3, pages: 3, hasMore: false },
      null,
    ])
    expect(engine.progress).toBeNull()
    expect(synced).toEqual([42])
  })

  it('keeps the newest number unknown from a server that does not say, and counts what it stored', async () => {
    const reports: (PullProgress | null)[] = []
    const engine = new SyncEngine({ store: new MemoryStore(), fetchPage: async (since) => (since === 0 ? page(5, true, ['a']) : page(9, false, ['b', 'c'])), onProgress: (p) => reports.push(p) })

    await engine.sync()

    expect(reports.at(-2)).toEqual({ from: 0, cursor: 9, latest: null, items: 3, pages: 2, hasMore: false })
  })

  it('carries the progress on when a notification makes the pull go round again, and notes no sync when it fails', async () => {
    const store = new MemoryStore()
    const markSynced = vi.fn(async () => undefined)
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    const reports: (PullProgress | null)[] = []
    const engine = new SyncEngine({
      store: { cursor: () => store.cursor(), apply: (p) => store.apply(p), markSynced },
      fetchPage: async (since) => {
        calls++
        if (calls === 1) {
          await held
          return { ...page(3, false, ['a']), latest: 3 }
        }
        return since === 3 ? { ...page(4, false, ['b']), latest: 4 } : page(since)
      },
      onProgress: (p) => reports.push(p),
      retryDelays: [60_000],
    })

    const pulling = engine.sync()
    void engine.notify(4)
    release()
    await pulling

    expect(reports.filter((r) => r !== null).at(-1)).toEqual({ from: 0, cursor: 4, latest: 4, items: 2, pages: 2, hasMore: false })
    expect(markSynced).toHaveBeenCalledTimes(1)

    const failing = new SyncEngine({ store: { cursor: async () => 0, apply: async () => undefined, markSynced }, fetchPage: async () => Promise.reject(new Error('offline')), retryable: () => false })
    await expect(failing.sync()).rejects.toThrow('offline')
    expect(markSynced).toHaveBeenCalledTimes(1)
    expect(failing.progress).toBeNull()
  })

  it('tells the caller a notification pulled nothing, but pulls after a failure whatever the cursor says', async () => {
    const store = new MemoryStore()
    let fail = false
    const fetchPage = vi.fn(async (since: number) => {
      if (fail) {
        throw new Error('offline')
      }
      return since === 0 ? page(5) : page(since)
    })
    const engine = new SyncEngine({ store, fetchPage, retryable: () => false })
    await engine.sync()
    expect(await engine.notify(5)).toBe(false)
    expect(fetchPage).toHaveBeenCalledTimes(1)

    fail = true
    await expect(engine.sync()).rejects.toThrow('offline')
    fail = false
    const calls = fetchPage.mock.calls.length
    expect(await engine.notify(3)).toBe(true)
    expect(fetchPage.mock.calls.length).toBe(calls + 1)
    // Current again: a notification at the stored cursor is a no-op once more.
    expect(await engine.notify(5)).toBe(false)
  })

  it("keeps a finished page's 100% on a round that goes again, until its page says more", async () => {
    const reports: (PullProgress | null)[] = []
    const engine: SyncEngine = new SyncEngine({
      store: new MemoryStore(),
      fetchPage: async (since) => (since === 0 ? { ...page(10, false, ['a']), latest: 10 } : { ...page(12, false, ['b']), latest: 12 }),
      onProgress: (p) => reports.push(p),
      // A notification while the pull runs makes it go round once more.
      onApplied: (p) => {
        if (p.cursor === 10) {
          void engine.notify(12)
        }
      },
    })

    await engine.sync()

    const live = reports.filter((r): r is PullProgress => r !== null)
    expect(live.map((r) => [r.cursor, r.hasMore])).toEqual([
      [0, null],
      [10, false],
      [10, false],
      [12, false],
    ])
  })
})
