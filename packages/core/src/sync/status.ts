import type { PullProgress } from './engine'

/**
 * A pull that began more than this many change numbers behind the newest one is "catching up": the status says how many
 * are left, and the lists say what they show may be out of date until it is done. Two pages hold up to 1,000 entities,
 * and a change number holds at least one, so a client this far behind needs more than a page or two.
 */
export const BEHIND_CHANGES = 1_000

/**
 * A copy whose last completed pull is older than this (30 minutes) may be out of date: while it cannot sync (offline,
 * the stream down, a sync error) the lists say so, and a pull of more than one page after this long away counts as
 * catching up whatever the number of changes.
 */
export const STALE_AFTER_MS = 30 * 60_000

/** The realtime stream: not started (or stopped), a connection being made, open, or waiting to try again. */
export type StreamState = 'off' | 'connecting' | 'live' | 'retrying'

/** What a client knows about its copy and its sync; {@link describeSync} turns it into what the user is told. */
export interface SyncFacts {
  /** The local copy: none open, being opened (and read onto the screens), or open. */
  copy: 'closed' | 'opening' | 'open'
  /** The server confirmed who is signed in; until then the copy is only read, nothing syncs. */
  confirmed: boolean
  /** The copy syncs again from the start because an update changed its shape (see SqliteMailStore.open). */
  afterUpdate: boolean
  /** The pull under way; null while none runs. */
  pull: PullProgress | null
  /**
   * Where the sync under way began, kept over a failed pull and its retry until a pull completes: 0 for a copy that
   * never synced. Null while the copy is up to date.
   */
  origin: number | null
  /** Why the last pull failed; null once one worked. */
  error: string | null
  stream: StreamState
  /** The stream was open before in this session, so a new attempt reconnects. */
  wasLive: boolean
  /** The device says it has a network. */
  online: boolean
  /** When a pull last completed (epoch ms), also in an earlier session; null for a copy that never synced. */
  lastSyncedAt: number | null
  now: number
}

export type SyncStatusKind =
  | 'closed'
  | 'opening'
  | 'readOnly'
  | 'updating'
  | 'firstSync'
  | 'catchingUp'
  | 'error'
  | 'offline'
  | 'live'
  | 'connecting'
  | 'reconnecting'
  | 'idle'

export interface SyncStatus {
  kind: SyncStatusKind
  /** The line for the footer (or the phone's header). Empty while no copy is open. */
  text: string
  /** How much of the sync under way is done, in [0, 1]; null when that is not known (draw no progress line then). */
  fraction: number | null
  /** Changes left in the sync under way, when the server says. */
  remaining: number | null
  /** A quiet line above the lists: what they show may be out of date. Null when it is current. */
  notice: string | null
  /**
   * The text for a polite live region. It changes with the kind and with every quarter of progress, not with every
   * percent or item, so a screen reader is not talked over.
   */
  announcement: string
}

/** How times are written: "14:02" today, with the day before it on other days. */
export type SyncTimeFormat = (at: number, now: number) => string

export function syncTime(at: number, now: number): string {
  const when = new Date(at)
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return when.toDateString() === new Date(now).toDateString() ? time : `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

const NUMBER = new Intl.NumberFormat('en-US')

/** The words of a failed sync, the same in the banner and in the status line. */
export const SYNC_STOPPED = 'Sync stopped'

/** The banner of a failed sync. */
export function syncProblem(error: string): string {
  return `${SYNC_STOPPED}: ${error}`
}

const UPDATING = 'Updating your mail on this device after the update'

/** What the user is told about the sync, from what the client knows. */
export function describeSync(facts: SyncFacts, time: SyncTimeFormat = syncTime): SyncStatus {
  if (facts.copy === 'closed') {
    return status('closed', '', { announcement: '' })
  }
  if (facts.copy === 'opening') {
    return status('opening', 'Opening your mail…')
  }
  if (!facts.confirmed) {
    return status('readOnly', 'Showing mail kept on this device')
  }
  const lastSynced = facts.lastSyncedAt === null ? null : time(facts.lastSyncedAt, facts.now)
  const stale = facts.lastSyncedAt !== null && facts.now - facts.lastSyncedAt > STALE_AFTER_MS
  const pull = facts.pull
  if (pull !== null) {
    const origin = Math.min(facts.origin ?? pull.from, pull.from)
    const latest = pull.latest
    const remaining = latest === null ? null : pull.hasMore === false ? 0 : Math.max(0, latest - pull.cursor)
    const fraction = progressOf(pull, origin)
    const percent = fraction === null ? null : Math.floor(fraction * 100)
    const quarter = fraction === null ? null : Math.floor(fraction * 4) * 25
    const items = NUMBER.format(pull.items)
    if (facts.afterUpdate) {
      return status('updating', percent !== null ? `${UPDATING}, ${percent}%` : pull.items > 0 ? `${UPDATING}, ${items} items so far` : `${UPDATING}…`, {
        fraction,
        remaining,
        notice: 'Tresso is updating your mail on this device. What you see may be out of date until it is done.',
        announcement: quarter === null ? UPDATING : `${UPDATING}, ${quarter}%`,
      })
    }
    if (origin === 0) {
      return status('firstSync', percent !== null ? `Getting your mail, ${percent}%` : pull.items > 0 ? `Syncing… ${items} items so far` : 'Getting your mail…', {
        fraction,
        remaining,
        notice: 'Your mail is still arriving on this device. What you see may be incomplete until it is done.',
        announcement: quarter === null ? 'Getting your mail' : `Getting your mail, ${quarter}%`,
      })
    }
    const morePages = pull.hasMore === true || pull.pages > 1
    const far = latest === null ? morePages : latest - origin > BEHIND_CHANGES
    if (far || (stale && morePages)) {
      const text = remaining === null ? `Syncing… ${items} items so far` : remaining === 0 ? 'Catching up: almost done' : `Catching up: ${NUMBER.format(remaining)} ${remaining === 1 ? 'change' : 'changes'} to go`
      return status('catchingUp', text, {
        fraction,
        remaining,
        notice: 'Catching up on changes. What you see may be out of date until it is done.',
        announcement: quarter === null ? 'Catching up' : `Catching up, ${quarter}%`,
      })
    }
    // A short pull (a notification, a write): nothing to say beyond the connection.
  }
  const staleNotice = stale && lastSynced !== null ? `Last synced ${lastSynced}. What you see may be out of date.` : null
  if (facts.error !== null) {
    return status('error', lastSynced === null ? SYNC_STOPPED : `${SYNC_STOPPED}. Last synced ${lastSynced}`, { notice: staleNotice, announcement: SYNC_STOPPED })
  }
  if (!facts.online) {
    return status('offline', lastSynced === null ? 'Offline' : `Offline. Last synced ${lastSynced}`, { notice: staleNotice, announcement: 'Offline' })
  }
  switch (facts.stream) {
    case 'live':
      return status('live', 'Up to date')
    case 'connecting':
      if (!facts.wasLive) {
        return status('connecting', 'Connecting…')
      }
      break
    case 'off':
      return status('idle', lastSynced === null ? 'Not synced yet' : `Last synced ${lastSynced}`, { notice: staleNotice, announcement: '' })
    case 'retrying':
      break
  }
  return status('reconnecting', lastSynced === null ? 'Reconnecting…' : `Reconnecting… Last synced ${lastSynced}`, { notice: staleNotice, announcement: 'Reconnecting' })
}

/** How much of the sync since `origin` is done; 1 once the last page is in. */
function progressOf(pull: PullProgress, origin: number): number | null {
  if (pull.hasMore === false && pull.pages > 0) {
    return 1
  }
  if (pull.latest === null || pull.latest <= origin) {
    return null
  }
  // Not 100% before the last page: the newest number can stay ahead of the last cursor.
  return Math.min(0.99, Math.max(0, (pull.cursor - origin) / (pull.latest - origin)))
}

function status(kind: SyncStatusKind, text: string, extra: Partial<Omit<SyncStatus, 'kind' | 'text'>> = {}): SyncStatus {
  return { kind, text, fraction: null, remaining: null, notice: null, announcement: text.replace(/…$/, ''), ...extra }
}

/** What the sync machine is told by the client. */
export interface SyncStatusOptions {
  onChange(status: SyncStatus): void
  /** Whether the device has a network when the machine starts; true by default. */
  online?: boolean
  now?(): number
  time?: SyncTimeFormat
}

/**
 * Keeps the facts of one client's sync and says the status whenever it changes: the copy opening and opened, the
 * sign-in confirmed, the engine's progress and outcome, the stream, the network. A state machine in the small: every
 * event moves the facts, {@link describeSync} says what that means. It also notices when a copy that cannot sync grows
 * stale (see STALE_AFTER_MS) and says so then.
 */
export class SyncStatusMachine {
  private facts: SyncFacts
  private last: SyncStatus | null = null
  private staleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: SyncStatusOptions) {
    this.facts = {
      copy: 'closed',
      confirmed: false,
      afterUpdate: false,
      pull: null,
      origin: null,
      error: null,
      stream: 'off',
      wasLive: false,
      online: options.online ?? true,
      lastSyncedAt: null,
      now: this.now(),
    }
  }

  get status(): SyncStatus {
    return describeSync({ ...this.facts, now: this.now() }, this.options.time)
  }

  /** A copy is being opened; whatever was known about the one before goes. */
  opening(): void {
    this.set({ copy: 'opening', confirmed: false, afterUpdate: false, pull: null, origin: null, error: null, stream: 'off', wasLive: false, lastSyncedAt: null })
  }

  /** The copy is open and on screen. */
  opened(copy: { confirmed: boolean; afterUpdate: boolean; lastSyncedAt: number | null }): void {
    this.set({ copy: 'open', ...copy })
  }

  /** The server confirmed the user of a copy opened before it answered: the sync begins. */
  confirmed(): void {
    this.set({ confirmed: true })
  }

  /** No copy is open (a sign-out, a session that ended). */
  closed(): void {
    this.set({ copy: 'closed', confirmed: false, afterUpdate: false, pull: null, origin: null, error: null, stream: 'off', wasLive: false, lastSyncedAt: null })
  }

  /** The engine's progress (see SyncEngineOptions.onProgress). */
  progress(pull: PullProgress | null): void {
    this.set(pull === null ? { pull } : { pull, origin: this.facts.origin ?? pull.from })
  }

  /** A pull completed: the copy is up to date as of now, also after an update. */
  synced(at: number = this.now()): void {
    this.set({ error: null, origin: null, afterUpdate: false, lastSyncedAt: at })
  }

  /** A pull failed; the engine tries again by itself. */
  failed(error: string): void {
    this.set({ error })
  }

  /** The failure of a pull did not count (the copy is closing): nothing is wrong. */
  cleared(): void {
    this.set({ error: null })
  }

  streamConnecting(): void {
    this.set({ stream: 'connecting' })
  }

  streamLive(): void {
    this.set({ stream: 'live', wasLive: true })
  }

  streamRetrying(): void {
    this.set({ stream: 'retrying' })
  }

  streamStopped(): void {
    this.set({ stream: 'off' })
  }

  online(online: boolean): void {
    this.set({ online })
  }

  /** Stops the timer that says when the copy grows stale. */
  dispose(): void {
    this.clearStaleTimer()
  }

  private set(change: Partial<SyncFacts>): void {
    this.facts = { ...this.facts, ...change }
    this.emit()
  }

  private emit(): void {
    const next = this.status
    if (this.last === null || !sameStatus(this.last, next)) {
      this.last = next
      this.options.onChange(next)
    }
    this.watchStale(next)
  }

  /** While the copy cannot sync, says it is out of date once its last pull is older than STALE_AFTER_MS. */
  private watchStale(current: SyncStatus): void {
    this.clearStaleTimer()
    const at = this.facts.lastSyncedAt
    if (at === null || current.notice !== null || current.kind === 'live' || current.kind === 'closed') {
      return
    }
    const due = at + STALE_AFTER_MS + 1 - this.now()
    if (due > 0) {
      this.staleTimer = setTimeout(() => {
        this.staleTimer = null
        this.emit()
      }, due)
    }
  }

  private clearStaleTimer(): void {
    if (this.staleTimer !== null) {
      clearTimeout(this.staleTimer)
      this.staleTimer = null
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}

function sameStatus(a: SyncStatus, b: SyncStatus): boolean {
  return a.kind === b.kind && a.text === b.text && a.fraction === b.fraction && a.remaining === b.remaining && a.notice === b.notice && a.announcement === b.announcement
}
