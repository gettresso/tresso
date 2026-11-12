import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequestTimeoutError, SessionEndedDuringRequestError, withDeadline } from './requests'

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

  it("follows the caller's abort at once also when the work does not follow the signal (a token refresh that hangs)", async () => {
    const caller = new AbortController()
    const outcome = withDeadline(() => new Promise<never>(() => undefined), caller.signal)
    caller.abort(new Error('signed out'))

    await expect(outcome).rejects.toThrow('signed out')
    // Aborted before it began: it does not start waiting at all.
    await expect(withDeadline(() => new Promise<never>(() => undefined), caller.signal)).rejects.toThrow('signed out')
  })
})

describe('SessionEndedDuringRequestError', () => {
  it('has no status: it is not an answer of the server', () => {
    const error = new SessionEndedDuringRequestError()

    expect(error.message).toBe('Signed out while this request was under way.')
    expect('status' in error).toBe(false)
  })
})
