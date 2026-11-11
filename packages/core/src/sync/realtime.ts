import { SseParser } from './sse'
import type { RealtimeAccess } from './types'

export interface RealtimeOptions {
  /** GET /api/v1/realtime/token */
  fetchAccess(): Promise<RealtimeAccess>
  /** The user's changes reached this cursor. */
  onCursor(cursor: number): void
  /**
   * The stream is open. Notifications sent while it was down are not replayed, so pull the delta here to catch up.
   */
  onConnected?(): void
  onError?(error: unknown): void
  fetch?: typeof fetch
  /** Delays between failed attempts, in ms; the last one repeats. */
  retryDelays?: readonly number[]
  /** Reconnect with a fresh token this long before the current one expires, in ms. */
  renewBefore?: number
  /**
   * How long the stream may stay silent before it is taken for dead and opened again, in ms. The hub sends a comment
   * line every 40 s (Mercure's default heartbeat) when there is nothing else to say, so this is two and a half of those.
   */
  idleTimeout?: number
}

const DEFAULT_RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000]
const DEFAULT_RENEW_BEFORE = 60_000
const DEFAULT_IDLE_TIMEOUT = 100_000
/**
 * The shortest time a token is used before it is renewed, in ms. Its expiry is the server's time, read against this
 * device's clock: a clock that runs ahead would otherwise make it look expired at once, and the client would ask for
 * tokens as fast as the network answers. A token that did expire is refused by the hub, which retries with backoff.
 */
const MIN_RENEW_AFTER = 30_000

/**
 * Listens to the user's private topic on the Mercure hub. Browsers' EventSource cannot send the access token, so the
 * stream is read through fetch(). Reconnects with backoff after failures and renews the token before it expires.
 */
export class RealtimeClient {
  private stopped = true
  private loops = new Set<Promise<void>>()
  private failures = 0
  /** Which run is current: a start right after a stop must not leave the old run going next to the new one. */
  private generation = 0
  /** Every wait and request of every run, so a stop ends all of them, also of a run that was replaced. */
  private readonly controllers = new Set<AbortController>()

  constructor(private readonly options: RealtimeOptions) {}

  start(): void {
    if (!this.stopped) {
      return
    }
    this.stopped = false
    const loop = this.run(++this.generation).finally(() => this.loops.delete(loop))
    this.loops.add(loop)
  }

  /** Ends every run, including one a quick start replaced, and resolves once all of them are over. */
  async stop(): Promise<void> {
    this.stopped = true
    this.generation++
    for (const controller of this.controllers) {
      controller.abort()
    }
    await Promise.all([...this.loops])
  }

  private current(generation: number): boolean {
    return !this.stopped && generation === this.generation
  }

  private async run(generation: number): Promise<void> {
    const delays = this.options.retryDelays ?? DEFAULT_RETRY_DELAYS
    this.failures = 0
    while (this.current(generation)) {
      try {
        const connected = await this.listen(generation)
        if (!connected && this.current(generation)) {
          // Renewed before the hub even answered: wait a moment rather than ask again at once.
          await this.sleep(delays[0] ?? DEFAULT_RETRY_DELAYS[0]!, generation)
        }
      } catch (error) {
        if (!this.current(generation)) {
          return
        }
        this.options.onError?.(error)
        const delay = delays[Math.min(this.failures, delays.length - 1)] ?? DEFAULT_RETRY_DELAYS[DEFAULT_RETRY_DELAYS.length - 1]
        this.failures++
        await this.sleep(delay ?? 30_000, generation)
      }
    }
  }

  /**
   * Resolves when the token is due for renewal or the run is no longer current, saying whether the hub was reached;
   * rejects when the connection fails or goes quiet.
   */
  private async listen(generation: number): Promise<boolean> {
    const access = await this.options.fetchAccess()
    if (!this.current(generation)) {
      return false
    }
    const controller = this.track(new AbortController())
    let renewing = false
    let quiet = false
    let connected = false
    const renewIn = Date.parse(access.expiresAt) - Date.now() - (this.options.renewBefore ?? DEFAULT_RENEW_BEFORE)
    const renewal = setTimeout(
      () => {
        renewing = true
        controller.abort()
      },
      Number.isFinite(renewIn) ? Math.max(renewIn, MIN_RENEW_AFTER) : MIN_RENEW_AFTER,
    )
    // A connection that died without being closed (a laptop that slept, a proxy that dropped it) never ends a read:
    // silence longer than the heartbeat ends it instead.
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const awake = () => {
      if (watchdog !== null) {
        clearTimeout(watchdog)
      }
      watchdog = setTimeout(() => {
        quiet = true
        controller.abort()
      }, this.options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT)
    }
    awake()

    try {
      const url = new URL(access.hubUrl)
      url.searchParams.set('match', access.topic)
      const response = await (this.options.fetch ?? fetch)(url, {
        headers: { Authorization: `Bearer ${access.token}`, Accept: 'text/event-stream' },
        signal: controller.signal,
        cache: 'no-store',
      })
      if (!response.ok || response.body === null) {
        throw new Error(`The realtime hub refused the connection (${response.status}).`)
      }
      this.failures = 0
      connected = true
      awake()
      this.options.onConnected?.()

      const parser = new SseParser()
      // TextDecoder in streaming mode rather than TextDecoderStream, which not every runtime has.
      const decoder = new TextDecoder()
      const reader = response.body.getReader()
      // Ends a pending read on stop or renewal even where aborting the request does not end the body stream.
      const cancel = () => void reader.cancel().catch(() => {})
      if (controller.signal.aborted) {
        cancel()
      }
      controller.signal.addEventListener('abort', cancel, { once: true })
      for (;;) {
        const { done, value } = await reader.read()
        if (quiet) {
          throw new Error('The realtime hub went quiet.')
        }
        if (done) {
          throw new Error('The realtime hub closed the connection.')
        }
        // Any bytes count, the hub's heartbeat comments too.
        awake()
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          this.handle(event.type, event.data)
        }
      }
    } catch (error) {
      if (!this.current(generation)) {
        return connected
      }
      if (quiet) {
        throw new Error('The realtime hub went quiet.')
      }
      if (renewing) {
        return connected
      }
      throw error
    } finally {
      clearTimeout(renewal)
      if (watchdog !== null) {
        clearTimeout(watchdog)
      }
      this.controllers.delete(controller)
    }
  }

  private handle(type: string, data: string): void {
    if (type !== 'changes') {
      return
    }
    let cursor: unknown
    try {
      cursor = (JSON.parse(data) as { cursor?: unknown }).cursor
    } catch {
      return
    }
    if (typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0) {
      this.options.onCursor(cursor)
    }
  }

  /** Waits before the next attempt; a stop ends the wait, also one that came just before the wait began. */
  private sleep(ms: number, generation: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.current(generation)) {
        resolve()
        return
      }
      const controller = this.track(new AbortController())
      const done = () => {
        clearTimeout(timer)
        this.controllers.delete(controller)
        resolve()
      }
      const timer = setTimeout(done, ms)
      controller.signal.addEventListener('abort', done, { once: true })
    })
  }

  private track(controller: AbortController): AbortController {
    this.controllers.add(controller)
    return controller
  }
}
