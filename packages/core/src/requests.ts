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
 * The session ended (a sign-out, an expiry, another tab) while a request was under way: whatever the server answered is
 * dropped, as it belongs to no one now. It carries no status on purpose: nothing about it was said by the server, so
 * it proves neither that the server refused the request nor that it did what was asked (a send may have been queued).
 * Code that reads a refusal from a 4xx (a send's id cleared, say) must not read one from this. Like a refused session
 * it is final: asking again does not help.
 */
export class SessionEndedDuringRequestError extends Error {
  constructor() {
    super('Signed out while this request was under way.')
    this.name = 'SessionEndedDuringRequestError'
  }
}

/**
 * Runs a request (the fetch and the reading of its answer) with a time limit: past it the request is aborted and this
 * rejects with {@link RequestTimeoutError}, so a step waiting on it (a hand-over holding the composer, say) fails as
 * any failed request does instead of waiting for ever. A signal the caller passes aborts it too, and rejects at once
 * with the signal's reason, also while the work does not follow the signal (a token refresh before the request).
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
  let cancel!: (reason: unknown) => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = reject
  })
  const forward = () => {
    controller.abort()
    cancel(caller?.reason ?? new DOMException('The request was aborted.', 'AbortError'))
  }
  if (caller?.aborted) {
    forward()
  }
  caller?.addEventListener('abort', forward, { once: true })
  const work = run(controller.signal)
  // The losers of the race must not end as unhandled rejections.
  void work.catch(() => undefined)
  void deadline.catch(() => undefined)
  void cancelled.catch(() => undefined)
  try {
    return await Promise.race([work, deadline, cancelled])
  } catch (error) {
    throw timedOut ? new RequestTimeoutError() : error
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
    caller?.removeEventListener('abort', forward)
  }
}
