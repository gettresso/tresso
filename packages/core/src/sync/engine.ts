import { CopyClosingError } from '../store/mailStore'
import type { ChangePage } from './types'

/** Local copy of the user's data. `apply` must store the page and its cursor in one transaction. */
export interface SyncStore {
  cursor(): Promise<number>
  apply(page: ChangePage): Promise<void>
}

export interface SyncEngineOptions {
  fetchPage(since: number, limit: number): Promise<ChangePage>
  store: SyncStore
  pageSize?: number
  /** Called after each stored page, e.g. to refresh what is on screen. */
  onApplied?(page: ChangePage): void
  /**
   * Delays before a failed pull is tried again, in ms; the last one repeats until a pull works. A pull also runs on
   * every realtime notification and reconnect, but on a quiet mailbox those may not come for hours.
   */
  retryDelays?: readonly number[]
  /** Whether a failed pull is worth trying again; by default all but a closing copy and a refused session or plan. */
  retryable?(error: unknown): boolean
  /**
   * Runs a retry, so the caller can show it as any other pull (syncing, then idle or the error); without it the
   * engine runs it on its own.
   */
  retry?(pull: () => Promise<void>): void
}

const DEFAULT_PAGE_SIZE = 500
const DEFAULT_RETRY_DELAYS = [2_000, 5_000, 15_000, 60_000]

/**
 * Whether a failed pull may work when tried again: not when the copy is closing (a sign-out), nor when the server
 * refused the session (401), the plan (402) or the access (403), which asking again does not change.
 */
export function retryablePull(error: unknown): boolean {
  if (error instanceof CopyClosingError) {
    return false
  }
  const status = (error as { status?: unknown } | null)?.status
  return status !== 401 && status !== 402 && status !== 403
}

/**
 * Pulls the delta into the local store. Calls never overlap: a request while a pull runs makes that pull go round
 * once more, so every notification is honored without parallel requests or skipped pages.
 */
export class SyncEngine {
  private running: Promise<void> | null = null
  private again = false
  private appliedCursor: number | null = null
  /** Pulls that failed in a row, for the backoff; a pull that works starts it over. */
  private failures = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly options: SyncEngineOptions) {}

  /**
   * Pulls every change. A pull that fails is tried again by itself after a while (see retryDelays), also when nothing
   * else asks for one; the promise still rejects, so the caller can show why.
   */
  sync(): Promise<void> {
    this.again = true
    if (this.running !== null) {
      return this.running
    }
    this.running = (async () => {
      try {
        while (this.again) {
          this.again = false
          await this.pullAll()
        }
        this.failures = 0
        this.cancelRetry()
      } catch (error) {
        this.scheduleRetry(error)
        throw error
      } finally {
        this.running = null
      }
    })()

    return this.running
  }

  /** Ends retries, e.g. on a sign-out; a pull under way still finishes. */
  stop(): void {
    this.stopped = true
    this.cancelRetry()
  }

  private scheduleRetry(error: unknown): void {
    if (this.stopped || this.retryTimer !== null || !(this.options.retryable ?? retryablePull)(error)) {
      return
    }
    const delays = this.options.retryDelays ?? DEFAULT_RETRY_DELAYS
    const delay = delays[Math.min(this.failures, delays.length - 1)] ?? DEFAULT_RETRY_DELAYS[DEFAULT_RETRY_DELAYS.length - 1]!
    this.failures++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.stopped) {
        return
      }
      const pull = () => this.sync()
      if (this.options.retry === undefined) {
        // Its failure schedules the next try; there is no one to tell.
        void pull().catch(() => undefined)
      } else {
        this.options.retry(pull)
      }
    }, delay)
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  /** A realtime notification: pull only when it is beyond what is stored. */
  notify(cursor: number): Promise<void> {
    if (this.appliedCursor !== null && cursor <= this.appliedCursor) {
      return this.running ?? Promise.resolve()
    }

    return this.sync()
  }

  private async pullAll(): Promise<void> {
    let since = await this.options.store.cursor()
    this.appliedCursor = since
    for (;;) {
      const page = await this.options.fetchPage(since, this.options.pageSize ?? DEFAULT_PAGE_SIZE)
      if (page.cursor < since) {
        throw new Error(`The server returned cursor ${page.cursor}, behind the local cursor ${since}.`)
      }
      if (page.cursor === since) {
        if (page.hasMore) {
          throw new Error(`The server reported more changes but did not advance past cursor ${since}.`)
        }
        return
      }
      await this.options.store.apply(page)
      this.appliedCursor = page.cursor
      this.options.onApplied?.(page)
      since = page.cursor
      if (!page.hasMore) {
        return
      }
    }
  }
}
