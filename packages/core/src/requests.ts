/** How long one API request may take before it is given up, in ms: generous, so only a request that hangs ends so. */
export const REQUEST_TIMEOUT_MS = 120_000

/** An API request that got no answer within its time limit; it was aborted, so whatever waited on it goes on. */
export class RequestTimeoutError extends Error {
  constructor() {
    super('The server did not answer in time. Try again.')
    this.name = 'RequestTimeoutError'
  }
}

/**
 * Runs a request (the fetch and the reading of its answer) with a time limit: past it the request is aborted and this
 * rejects with {@link RequestTimeoutError}, so a step waiting on it (a hand-over holding the composer, say) fails as
 * any failed request does instead of waiting for ever. A signal the caller passes still aborts it too.
 */
export async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal | null, ms: number = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // Also rejects when the work does not follow the signal (a token refresh that hangs before the request starts).
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new RequestTimeoutError())
    }, ms)
  })
  const forward = () => controller.abort()
  if (caller?.aborted) {
    controller.abort()
  }
  caller?.addEventListener('abort', forward, { once: true })
  const work = run(controller.signal)
  // The loser of the race must not end as an unhandled rejection.
  void work.catch(() => undefined)
  void deadline.catch(() => undefined)
  try {
    return await Promise.race([work, deadline])
  } catch (error) {
    throw timedOut ? new RequestTimeoutError() : error
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
    caller?.removeEventListener('abort', forward)
  }
}
