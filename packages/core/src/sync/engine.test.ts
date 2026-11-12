import { describe, expect, it, vi } from 'vitest'
import { SessionEndedDuringRequestError } from '../requests'
import { retryablePull, retryAfterMs, SyncEngine, type SyncStore } from './engine'
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
})
