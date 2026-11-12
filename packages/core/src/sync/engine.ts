import { SessionEndedDuringRequestError } from '../requests'
import { CopyClosingError } from '../store/mailStore'
import type { ChangePage } from './types'

/** Local copy of the user's data. `apply` must store the page and its cursor in one transaction. */
export interface SyncStore {
  cursor(): Promise<number>
  apply(page: ChangePage): Promise<void>
  /** Notes when a pull last brought the copy up to date (epoch ms), so it can be said after a restart too. */
  markSynced?(at: number): Promise<void>
}

/** How far the pull under way got, for the sync status (see describeSync). */
export interface PullProgress {
  /** The cursor the pull began from: 0 for a copy that never synced. */
  from: number
  /** The cursor the copy reached so far. */
  cursor: number
  /** The newest change number the last page named; null before the first page, and from servers that do not say. */
  latest: number | null
  /** Entities (and removals) this pull stored so far. */
  items: number
  /** Pages this pull stored so far. */
  pages: number
  /** Whether the last page said more follow; null before the first page. */
  hasMore: boolean | null
}

/** The entities and removals a page carries. */
export function itemsIn(page: ChangePage): number {
  let items = 0
  for (const value of Object.values(page)) {
    if (Array.isArray(value)) {
      items += value.length
    }
  }
  return items
}

export interface SyncEngineOptions {
  fetchPage(since: number, limit: number): Promise<ChangePage>
  store: SyncStore
  pageSize?: number
  /** Called after each stored page, e.g. to refresh what is on screen. */
  onApplied?(page: ChangePage): void
  /** How far the pull under way got: when it begins, after every page, and null once it is over (done or failed). */
  onProgress?(progress: PullProgress | null): void
  /** The time a pull is noted as done at (see SyncStore.markSynced); Date.now by default. */
  now?(): number
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
  /** A number in [0, 1), for the spread of the retry delays; Math.random by default. */
  random?(): number
}

const DEFAULT_PAGE_SIZE = 500
const DEFAULT_RETRY_DELAYS = [2_000, 5_000, 15_000, 60_000]
/** Retry delays are spread this much either way, so clients that failed together do not all come back together. */
const JITTER = 0.2
/**
 * The longest a Retry-After is honoured, in ms: a pull is tried at least hourly whatever the server (or a device clock
 * far behind, reading an HTTP date) says, and the timer never overflows into firing at once.
 */
const MAX_RETRY_AFTER = 3_600_000

/**
 * How long the server asked to wait before trying again, from a `Retry-After` header (seconds or an HTTP date), in
 * ms; null when it did not say. Clients put it on their API errors as `retryAfterMs`, which the retry honours.
 */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (header === null || header.trim() === '') {
    return null
  }
  const value = header.trim()
  if (/^\d+$/.test(value)) {
    return Number(value) * 1000
  }
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

/**
 * Whether a failed pull may work when tried again: not when the copy is closing (a sign-out) or the session ended while
 * the pull ran, nor when the server refused the session (401), the plan (402) or the access (403), which asking again
 * does not change.
 */
export function retryablePull(error: unknown): boolean {
  if (error instanceof CopyClosingError || error instanceof SessionEndedDuringRequestError) {
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
  /** The waiting retry keeps a time the server asked for (Retry-After), which a wake does not cut short. */
  private retryAsked = false
  private stopped = false
  private pulling: PullProgress | null = null

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
        await this.options.store.markSynced?.((this.options.now ?? Date.now)())
        this.failures = 0
        this.cancelRetry()
      } catch (error) {
        this.scheduleRetry(error)
        throw error
      } finally {
        this.running = null
        this.report(null)
      }
    })()

    return this.running
  }

  /** How far the pull under way got; null while none runs. */
  get progress(): PullProgress | null {
    return this.pulling
  }

  private report(progress: PullProgress | null): void {
    this.pulling = progress
    this.options.onProgress?.(progress === null ? null : { ...progress })
  }

  /** Ends retries, e.g. on a sign-out; a pull under way still finishes. */
  stop(): void {
    this.stopped = true
    this.cancelRetry()
  }

  /**
   * Something says the network may be back (the device went online, the app became visible again): a pull that waits
   * to be tried again runs now instead of at its time, unless the server asked to wait that long (Retry-After). The
   * user asking for a pull (sync) always pulls. Returns whether one ran.
   */
  wake(): boolean {
    if (this.stopped || this.retryTimer === null || this.retryAsked) {
      return false
    }
    this.cancelRetry()
    this.runRetry()
    return true
  }

  private scheduleRetry(error: unknown): void {
    if (this.stopped || this.retryTimer !== null || !(this.options.retryable ?? retryablePull)(error)) {
      return
    }
    const delays = this.options.retryDelays ?? DEFAULT_RETRY_DELAYS
    const base = delays[Math.min(this.failures, delays.length - 1)] ?? DEFAULT_RETRY_DELAYS[DEFAULT_RETRY_DELAYS.length - 1]!
    const spread = base * (1 + JITTER * (2 * (this.options.random ?? Math.random)() - 1))
    // A server that said how long to wait (a 429 or 503 with Retry-After) is not asked again sooner.
    const asked = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs
    const honoured = typeof asked === 'number' && Number.isFinite(asked) && asked > spread ? Math.min(asked, MAX_RETRY_AFTER) : null
    const delay = honoured ?? spread
    this.retryAsked = honoured !== null
    this.failures++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryAsked = false
      this.runRetry()
    }, delay)
  }

  private runRetry(): void {
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
  }

  private cancelRetry(): void {
    this.retryAsked = false
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
    // A round that goes again (a notification came meanwhile) carries on the progress of the pull it belongs to.
    const started = this.pulling
    this.report(started === null ? { from: since, cursor: since, latest: null, items: 0, pages: 0, hasMore: null } : { ...started, cursor: since, hasMore: null })
    for (;;) {
      const page = await this.options.fetchPage(since, this.options.pageSize ?? DEFAULT_PAGE_SIZE)
      if (page.cursor < since) {
        throw new Error(`The server returned cursor ${page.cursor}, behind the local cursor ${since}.`)
      }
      if (page.cursor === since) {
        if (page.hasMore) {
          throw new Error(`The server reported more changes but did not advance past cursor ${since}.`)
        }
        this.report({ ...this.pulling!, latest: latestOf(page, this.pulling!.latest), hasMore: false })
        return
      }
      await this.options.store.apply(page)
      this.appliedCursor = page.cursor
      const before = this.pulling!
      this.report({ ...before, cursor: page.cursor, latest: latestOf(page, before.latest), items: before.items + itemsIn(page), pages: before.pages + 1, hasMore: page.hasMore })
      this.options.onApplied?.(page)
      since = page.cursor
      if (!page.hasMore) {
        return
      }
    }
  }
}

/** The newest change number a page names, never below its cursor; the one known before from a server that does not say. */
function latestOf(page: ChangePage, known: number | null): number | null {
  return typeof page.latest === 'number' && Number.isSafeInteger(page.latest) ? Math.max(page.latest, page.cursor) : known
}
