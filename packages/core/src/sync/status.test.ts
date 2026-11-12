import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PullProgress } from './engine'
import { BEHIND_CHANGES, describeSync, STALE_AFTER_MS, syncProblem, SyncStatusMachine, type SyncFacts, type SyncStatus } from './status'

const NOW = Date.UTC(2026, 10, 12, 14, 30)
const LAST = NOW - 28 * 60_000
/** Times as "HH:MM" in UTC, so the tests read the same everywhere. */
const time = (at: number) => new Date(at).toISOString().slice(11, 16)

function facts(change: Partial<SyncFacts> = {}): SyncFacts {
  return {
    copy: 'open',
    confirmed: true,
    afterUpdate: false,
    pull: null,
    origin: null,
    error: null,
    stream: 'live',
    wasLive: true,
    online: true,
    lastSyncedAt: LAST,
    now: NOW,
    ...change,
  }
}

function pull(change: Partial<PullProgress> = {}): PullProgress {
  return { from: 0, cursor: 0, latest: null, items: 0, pages: 0, hasMore: null, ...change }
}

const describe_ = (change: Partial<SyncFacts>) => describeSync(facts(change), time)

describe('describeSync', () => {
  it('says nothing while no copy is open, and that one is opening', () => {
    expect(describe_({ copy: 'closed' })).toMatchObject({ kind: 'closed', text: '', notice: null })
    expect(describe_({ copy: 'opening' })).toMatchObject({ kind: 'opening', text: 'Opening your mail…', announcement: 'Opening your mail' })
  })

  it('shows the mail kept on this device while the sign-in is not confirmed', () => {
    expect(describe_({ confirmed: false, stream: 'off' })).toMatchObject({ kind: 'readOnly', text: 'Showing mail kept on this device' })
  })

  it('gets the mail of a new device with a real fraction, or counts items from a server that does not say', () => {
    expect(describe_({ pull: pull(), origin: 0, lastSyncedAt: null })).toMatchObject({ kind: 'firstSync', text: 'Getting your mail…', fraction: null })
    const halfway = describe_({ pull: pull({ cursor: 6200, latest: 10_000, items: 12_400, pages: 25, hasMore: true }), origin: 0, lastSyncedAt: null })
    expect(halfway).toMatchObject({ kind: 'firstSync', text: 'Getting your mail, 62%', fraction: 0.62, remaining: 3800, announcement: 'Getting your mail, 50%' })
    expect(halfway.notice).toContain('may be incomplete')
    expect(describe_({ pull: pull({ cursor: 900, items: 1240, pages: 3, hasMore: true }), origin: 0, lastSyncedAt: null })).toMatchObject({
      kind: 'firstSync',
      text: 'Syncing… 1,240 items so far',
      fraction: null,
      announcement: 'Getting your mail',
    })
  })

  it('reaches 100% only with the last page, as the newest number may stay ahead of the last cursor', () => {
    expect(describe_({ pull: pull({ cursor: 9999, latest: 10_000, pages: 20, hasMore: true }), origin: 0, lastSyncedAt: null }).text).toBe('Getting your mail, 99%')
    expect(describe_({ pull: pull({ cursor: 9000, latest: 10_000, pages: 21, hasMore: false }), origin: 0, lastSyncedAt: null }).text).toBe('Getting your mail, 100%')
  })

  it('keeps the fraction of the whole sync over a retry that begins further on', () => {
    const retried = describe_({ pull: pull({ from: 5000, cursor: 7500, latest: 10_000, pages: 5, hasMore: true }), origin: 0, lastSyncedAt: null })
    expect(retried).toMatchObject({ kind: 'firstSync', text: 'Getting your mail, 75%' })
  })

  it('says it is updating the copy after an update, also when the copy starts from nothing', () => {
    expect(describe_({ afterUpdate: true, pull: pull(), origin: 0 })).toMatchObject({ kind: 'updating', text: 'Updating your mail on this device after the update…' })
    const going = describe_({ afterUpdate: true, pull: pull({ cursor: 2500, latest: 10_000, items: 5000, pages: 10, hasMore: true }), origin: 0 })
    expect(going).toMatchObject({ kind: 'updating', text: 'Updating your mail on this device after the update, 25%', announcement: 'Updating your mail on this device after the update, 25%' })
    expect(going.notice).toContain('updating your mail')
    expect(describe_({ afterUpdate: true, pull: pull({ cursor: 900, items: 1240, pages: 3, hasMore: true }), origin: 0 }).text).toBe('Updating your mail on this device after the update, 1,240 items so far')
  })

  it('catches up in words when it began more than BEHIND_CHANGES behind', () => {
    const behind = describe_({ pull: pull({ from: 50_000, cursor: 50_600, latest: 63_000, items: 500, pages: 1, hasMore: true }), origin: 50_000 })
    expect(behind).toMatchObject({ kind: 'catchingUp', text: 'Catching up: 12,400 changes to go', remaining: 12_400, announcement: 'Catching up, 0%' })
    expect(behind.notice).toBe('Catching up on changes. What you see may be out of date until it is done.')
    // It stays catching up to the end, though fewer than BEHIND_CHANGES are left by then.
    expect(describe_({ pull: pull({ from: 50_000, cursor: 62_900, latest: 63_000, pages: 25, hasMore: true }), origin: 50_000 }).text).toBe('Catching up: 100 changes to go')
    expect(describe_({ pull: pull({ from: 50_000, cursor: 62_999, latest: 63_000, pages: 25, hasMore: true }), origin: 50_000 }).text).toBe('Catching up: 1 change to go')
    expect(describe_({ pull: pull({ from: 50_000, cursor: 62_000, latest: 63_000, pages: 26, hasMore: false }), origin: 50_000 }).text).toBe('Catching up: almost done')
  })

  it('says nothing new for a short pull, which a notification or a write starts', () => {
    const short = describe_({ pull: pull({ from: 50_000, cursor: 50_000, latest: 50_000 + BEHIND_CHANGES }), origin: 50_000 })
    expect(short).toMatchObject({ kind: 'live', text: 'Up to date', notice: null, fraction: null })
    expect(describe_({ pull: pull({ from: 50_000, cursor: 50_000, latest: 50_010, pages: 1, hasMore: false }), origin: 50_000, stream: 'connecting', wasLive: false }).kind).toBe('connecting')
  })

  it('catches up after a long time away when more than one page comes, however few the changes', () => {
    const away = describe_({ lastSyncedAt: NOW - STALE_AFTER_MS - 1, pull: pull({ from: 100, cursor: 300, latest: 600, pages: 1, hasMore: true }), origin: 100 })
    expect(away).toMatchObject({ kind: 'catchingUp', text: 'Catching up: 300 changes to go' })
  })

  it('catches up without a count from a server that does not say how far it is', () => {
    expect(describe_({ pull: pull({ from: 100, cursor: 600, items: 500, pages: 1, hasMore: true }), origin: 100 })).toMatchObject({ kind: 'catchingUp', text: 'Syncing… 500 items so far', fraction: null })
    expect(describe_({ pull: pull({ from: 100, cursor: 600, items: 20, pages: 1, hasMore: false }), origin: 100 }).kind).toBe('live')
  })

  it('is up to date and live, and connecting only while the first connection is being made', () => {
    expect(describe_({})).toMatchObject({ kind: 'live', text: 'Up to date', announcement: 'Up to date' })
    expect(describe_({ stream: 'connecting', wasLive: false })).toMatchObject({ kind: 'connecting', text: 'Connecting…' })
  })

  it('says it reconnects, with when it last synced, when the stream is down', () => {
    expect(describe_({ stream: 'retrying' })).toMatchObject({ kind: 'reconnecting', text: 'Reconnecting… Last synced 14:02', notice: null })
    expect(describe_({ stream: 'connecting', wasLive: true }).text).toBe('Reconnecting… Last synced 14:02')
    expect(describe_({ stream: 'retrying', lastSyncedAt: null }).text).toBe('Reconnecting…')
  })

  it('says offline with when it last synced, and that the lists may be out of date once that is long ago', () => {
    expect(describe_({ online: false, stream: 'retrying' })).toMatchObject({ kind: 'offline', text: 'Offline. Last synced 14:02', notice: null })
    const old = NOW - STALE_AFTER_MS - 60_000
    expect(describe_({ online: false, stream: 'retrying', lastSyncedAt: old })).toMatchObject({ kind: 'offline', text: 'Offline. Last synced 13:59', notice: 'Last synced 13:59. What you see may be out of date.' })
    expect(describe_({ online: false, stream: 'retrying', lastSyncedAt: null }).text).toBe('Offline')
  })

  it('says the sync stopped in the same words as the banner, and keeps saying it over a short retry', () => {
    expect(describe_({ error: 'Network down' })).toMatchObject({ kind: 'error', text: 'Sync stopped. Last synced 14:02', announcement: 'Sync stopped' })
    expect(syncProblem('Network down')).toBe('Sync stopped: Network down')
    expect(describe_({ error: 'Network down', pull: pull({ from: 10, cursor: 10 }), origin: 10 }).kind).toBe('error')
    // A long retry shows its progress: it is under way again.
    expect(describe_({ error: 'Network down', pull: pull({ from: 5000, cursor: 5000 }), origin: 0, lastSyncedAt: null }).kind).toBe('firstSync')
    expect(describe_({ error: 'Network down' }).problem).toBe('Sync stopped: Network down')
    expect(describe_({}).problem).toBeNull()
  })

  it('says when it last synced while the stream does not run (a phone in the background)', () => {
    expect(describe_({ stream: 'off' })).toMatchObject({ kind: 'idle', text: 'Last synced 14:02' })
    expect(describe_({ stream: 'off', lastSyncedAt: null }).text).toBe('Not synced yet')
  })
})

describe('describeSync, as the audit asked', () => {
  it('is up to date while the stream is live, whatever the device says of its network (a server on this machine)', () => {
    expect(describe_({ online: false, stream: 'live' })).toMatchObject({ kind: 'live', text: 'Up to date' })
  })

  it('never says up to date while the first page of a pull is on its way, and does not announce that', () => {
    const checking = describe_({ pull: pull({ from: 500, cursor: 500 }), origin: 500 })
    expect(checking).toMatchObject({ kind: 'checking', text: 'Checking for new mail…', announcement: '' })
    expect(describe_({ pull: pull({ from: 500, cursor: 520, latest: 520, pages: 1, hasMore: false }), origin: 500 }).text).toBe('Up to date')
  })

  it('says connecting, once, until the stream is live for the first time, through every retry', () => {
    const attempts = [describe_({ stream: 'connecting', wasLive: false }), describe_({ stream: 'retrying', wasLive: false }), describe_({ stream: 'connecting', wasLive: false })]
    expect(new Set(attempts.map((status) => `${status.text}|${status.announcement}`))).toEqual(new Set(['Connecting…|Connecting']))
  })

  it('takes a mailbox that finished a pull at cursor 0 for synced, not for a new device', () => {
    expect(describe_({ pull: pull(), origin: 0 }).kind).toBe('checking')
    expect(describe_({ pull: pull({ hasMore: false, pages: 0, latest: 0 }), origin: 0 }).kind).toBe('live')
    expect(describe_({ pull: pull(), origin: 0, lastSyncedAt: null }).kind).toBe('firstSync')
  })

  it('says the sync stopped when no copy could be opened', () => {
    expect(describe_({ copy: 'closed', error: 'disk full' })).toMatchObject({ kind: 'error', text: 'Sync stopped', problem: 'Sync stopped: disk full' })
  })
})

describe('SyncStatusMachine', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function machine(online = true) {
    let now = NOW
    const seen: SyncStatus[] = []
    const subject = new SyncStatusMachine({ onChange: (status) => seen.push(status), online, now: () => now, time })
    return { subject, seen, texts: () => seen.map((status) => status.text), advance: (ms: number) => (now += ms) }
  }

  it('walks a new device from opening through its first sync to live', () => {
    const { subject, texts } = machine()

    subject.opening()
    subject.opened({ confirmed: true, afterUpdate: false, lastSyncedAt: null })
    subject.streamConnecting()
    subject.progress(pull())
    subject.progress(pull({ cursor: 500, latest: 1000, items: 500, pages: 1, hasMore: true }))
    subject.streamLive()
    subject.progress(pull({ cursor: 1000, latest: 1000, items: 900, pages: 2, hasMore: false }))
    subject.synced(NOW)
    subject.progress(null)

    expect(texts()).toEqual(['Opening your mail…', 'Not synced yet', 'Connecting…', 'Getting your mail…', 'Getting your mail, 50%', 'Getting your mail, 100%', 'Up to date'])
  })

  it('reads the copy before the sign-in is confirmed, then syncs it', () => {
    const { subject, seen } = machine()

    subject.opening()
    subject.opened({ confirmed: false, afterUpdate: false, lastSyncedAt: LAST })
    expect(subject.status.kind).toBe('readOnly')
    subject.confirmed()
    subject.streamConnecting()

    expect(seen.map((status) => status.kind)).toEqual(['opening', 'readOnly', 'idle', 'connecting'])
  })

  it('keeps where a failed sync began, so its retry carries the fraction on', () => {
    const { subject } = machine()
    subject.opening()
    subject.opened({ confirmed: true, afterUpdate: true, lastSyncedAt: null })
    subject.progress(pull({ cursor: 4000, latest: 10_000, pages: 8, hasMore: true }))
    subject.failed('offline')
    subject.progress(null)
    expect(subject.status).toMatchObject({ kind: 'error', text: 'Sync stopped' })

    subject.progress(pull({ from: 4000, cursor: 5000, latest: 10_000, pages: 2, hasMore: true }))
    expect(subject.status.text).toBe('Updating your mail on this device after the update, 50%')

    subject.synced(NOW)
    subject.progress(null)
    expect(subject.status).toMatchObject({ kind: 'idle', text: 'Last synced 14:30' })
  })

  it('says offline and back, and reconnecting when the stream drops', () => {
    const { subject, texts } = machine(false)
    subject.opening()
    subject.opened({ confirmed: true, afterUpdate: false, lastSyncedAt: LAST })
    subject.online(true)
    subject.streamLive()
    subject.streamRetrying()

    expect(texts()).toEqual(['Opening your mail…', 'Offline. Last synced 14:02', 'Last synced 14:02', 'Up to date', 'Reconnecting… Last synced 14:02'])
  })

  it('tells only of changes, not of every event', () => {
    const { subject, seen } = machine()
    subject.opening()
    subject.opened({ confirmed: true, afterUpdate: false, lastSyncedAt: LAST })
    subject.streamLive()
    const before = seen.length

    subject.progress(pull({ from: 10, cursor: 10, latest: 10, pages: 1, hasMore: false }))
    subject.synced(NOW)
    subject.progress(null)

    expect(seen.length).toBe(before)
  })

  it('says the lists may be out of date once a copy that cannot sync grows stale', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const seen: SyncStatus[] = []
    const subject = new SyncStatusMachine({ onChange: (status) => seen.push(status), time })
    subject.opening()
    subject.opened({ confirmed: true, afterUpdate: false, lastSyncedAt: NOW })
    subject.streamRetrying()
    expect(seen.at(-1)?.notice).toBeNull()

    await vi.advanceTimersByTimeAsync(STALE_AFTER_MS + 10)

    expect(seen.at(-1)?.notice).toContain('may be out of date')
    subject.dispose()
  })

  it('forgets the copy it knew on close', () => {
    const { subject } = machine()
    subject.opening()
    subject.opened({ confirmed: true, afterUpdate: true, lastSyncedAt: LAST })
    subject.failed('boom')
    subject.closed()

    expect(subject.status).toMatchObject({ kind: 'closed', text: '' })
  })

  it('announces connecting once while a stream that was never live retries', () => {
    const { subject, seen } = machine()
    subject.opening()
    subject.opened({ confirmed: true, afterUpdate: false, lastSyncedAt: LAST })
    subject.streamConnecting()
    subject.streamRetrying()
    subject.streamConnecting()
    subject.streamRetrying()

    expect(seen.filter((status) => status.text === 'Connecting…')).toHaveLength(1)
  })

  it('never steps the progress of one sync back, though a pull goes round again or the newest number moves on', () => {
    const { subject } = machine()
    subject.opening()
    subject.opened({ confirmed: true, afterUpdate: false, lastSyncedAt: null })
    subject.progress(pull({ cursor: 800, latest: 1000, pages: 2, hasMore: true }))
    expect(subject.status.fraction).toBe(0.8)
    // New changes came meanwhile: the newest number moved on.
    subject.progress(pull({ cursor: 900, latest: 2000, pages: 3, hasMore: true }))
    expect(subject.status.fraction).toBe(0.8)
    subject.progress(pull({ cursor: 2000, latest: 2000, pages: 4, hasMore: false }))
    expect(subject.status.text).toBe('Getting your mail, 100%')
  })

  it('says the sync stopped and why when the copy could not be opened', () => {
    const { subject } = machine()
    subject.opening()
    subject.openFailed('disk full')

    expect(subject.status).toMatchObject({ kind: 'error', problem: 'Sync stopped: disk full' })
  })
})
