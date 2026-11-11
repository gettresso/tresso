import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequestTimeoutError, withDeadline } from './requests'

/** A request that only ends when it is aborted, as fetch does. */
const hanging = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))

describe('withDeadline', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts a request that does not answer in time, and says so', async () => {
    vi.useFakeTimers()
    const outcome = withDeadline(hanging, null, 120_000)
    const settled = expect(outcome).rejects.toBeInstanceOf(RequestTimeoutError)

    await vi.advanceTimersByTimeAsync(120_000)

    await settled
  })

  it('gives up in time also when the work does not follow the signal (a token refresh that hangs)', async () => {
    vi.useFakeTimers()
    const outcome = withDeadline(() => new Promise<never>(() => undefined), null, 1_000)
    const settled = expect(outcome).rejects.toBeInstanceOf(RequestTimeoutError)

    await vi.advanceTimersByTimeAsync(1_000)

    await settled
  })

  it("passes an answer in time and a failure of its own through, and follows the caller's abort", async () => {
    await expect(withDeadline(async () => 'answer')).resolves.toBe('answer')
    await expect(withDeadline(async () => Promise.reject(new Error('HTTP 502')))).rejects.toThrow('HTTP 502')

    const caller = new AbortController()
    const outcome = withDeadline(hanging, caller.signal)
    caller.abort()
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' })
  })
})
