import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { batchTimeLabel, type BatchSchedule } from '@tresso/core'
import { useBatchesStore } from '../batches'

function schedule(nextBatchAt: string): BatchSchedule {
  return { times: ['09:00', '13:00', '16:00'], timeZone: 'UTC', configured: true, nextBatchAt }
}

describe('the batch schedule', () => {
  /** What the server answers, one per request: a schedule, or null while it cannot be reached. */
  let answers: (BatchSchedule | null)[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 86_400_000 }))
    setActivePinia(createPinia())
    answers = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const answer = answers.shift()
        if (answer === null || answer === undefined) {
          throw new TypeError('Failed to fetch')
        }
        return new Response(JSON.stringify(answer))
      }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('tries again when the reload after a batch fails, until it names the next batch', async () => {
    answers = [schedule('2026-11-11T13:00:00Z'), null, null, schedule('2026-11-11T16:00:00Z')]
    const batches = useBatchesStore()
    await batches.load()

    // The reload a little after 13:00 fails (the laptop just woke up), and the first try again too.
    await vi.advanceTimersByTimeAsync(3_600_000 + 5_000)
    expect(batches.error).toBe('Failed to fetch')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(batches.nextBatchLabel).toBe(batchTimeLabel(Date.parse('2026-11-11T13:00:00Z')))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(batches.error).toBeNull()
    expect(batches.nextBatchLabel).toBe(batchTimeLabel(Date.parse('2026-11-11T16:00:00Z')))
  })

  it('loads again on a new screen when the batch it names went out a while ago', async () => {
    answers = [schedule('2026-11-11T13:00:00Z'), null, schedule('2026-11-11T16:00:00Z')]
    const batches = useBatchesStore()
    await batches.load()
    await vi.advanceTimersByTimeAsync(3_600_000 + 5_000)
    expect(batches.error).toBe('Failed to fetch')

    // The user moves to another screen a few seconds later.
    await vi.advanceTimersByTimeAsync(10_000)
    await batches.load()

    expect(batches.nextBatchLabel).toBe(batchTimeLabel(Date.parse('2026-11-11T16:00:00Z')))
  })

  it('asks nothing again while the batch it names is still to come', async () => {
    answers = [schedule('2026-11-11T13:00:00Z')]
    const batches = useBatchesStore()
    await batches.load()

    await batches.load()

    expect(fetch).toHaveBeenCalledOnce()
  })
})
