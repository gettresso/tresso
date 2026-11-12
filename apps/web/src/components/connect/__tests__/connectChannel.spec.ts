import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConnection } from '@tresso/core'
import { abandoned, clearAwaiting, handOver, isAwaited, isCancelled, listenForSignIns, markAwaiting, markCancelled, reportSignedOutReturn, stateOf, takeNotedOutcome, type HandedOver } from '../connectChannel'

const result: ProviderConnection = { provider: 'google', connected: 'acc-g', grant: null, connectError: null, requested: ['mail'], missing: [], existing: false, approvalUrl: null }

/** localStorage as two tabs of one browser share it. */
function sharedStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  }
}

describe('connectChannel', () => {
  const stops: (() => void)[] = []

  beforeEach(() => {
    vi.stubGlobal('localStorage', sharedStorage())
  })

  afterEach(() => {
    stops.splice(0).forEach((stop) => stop())
    vi.unstubAllGlobals()
  })

  function listen(take: (state: string, outcome: HandedOver) => boolean): void {
    stops.push(listenForSignIns(take))
  }

  it('hands an outcome to the tab that waits for its state, which takes it once', async () => {
    const taken: HandedOver[] = []
    listen((state, outcome) => state === 'state-1' && taken.push(outcome) > 0)

    expect(await handOver('state-1', { kind: 'result', result })).toBe(true)
    expect(taken).toEqual([{ kind: 'result', result }])
    expect(takeNotedOutcome('state-1')).toBeNull()
  })

  it('leaves an outcome no tab took in storage, for a waiting tab that was not listening yet', async () => {
    expect(await handOver('state-1', { kind: 'result', result }, 50)).toBe(false)

    expect(takeNotedOutcome('state-2')).toBeNull()
    expect(takeNotedOutcome('state-1')).toEqual({ kind: 'result', result })
    expect(takeNotedOutcome('state-1')).toBeNull()
  })

  it('is not taken for another state, nor by a tab that stopped listening', async () => {
    listen((state) => state === 'other')
    expect(await handOver('state-1', { kind: 'result', result }, 50)).toBe(false)

    const stop = listenForSignIns(() => true)
    stop()
    expect(await handOver('state-3', { kind: 'result', result }, 50)).toBe(false)
  })

  it('takes an answer that arrives twice only once', async () => {
    let waitingFor: string | null = 'state-1'
    const taken: HandedOver[] = []
    listen((state, outcome) => {
      if (state !== waitingFor) return false
      waitingFor = null
      taken.push(outcome)
      return true
    })

    expect(await handOver('state-1', { kind: 'result', result })).toBe(true)
    expect(await handOver('state-1', { kind: 'result', result }, 50)).toBe(false)
    expect(taken).toHaveLength(1)
  })

  it('removes an outcome no tab took once it expired, when the next sign-in starts waiting', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      expect(await handOver('state-1', { kind: 'result', result }, 0)).toBe(false)
      expect(localStorage.getItem('tresso.connect.outcome')).not.toBeNull()

      // A fresh outcome stays for the tab that waits for it.
      markAwaiting('state-2', Date.now() + 15 * 60_000)
      expect(localStorage.getItem('tresso.connect.outcome')).not.toBeNull()

      vi.setSystemTime(Date.now() + 16 * 60_000)
      markAwaiting('state-3', Date.now() + 15 * 60_000)
      expect(localStorage.getItem('tresso.connect.outcome')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('notes the sign-in a tab waits for, and the ones the user cancelled, until they expire', () => {
    markAwaiting('state-1', Date.now() + 60_000)
    expect(isAwaited('state-1')).toBe(true)
    expect(isAwaited('state-2')).toBe(false)
    clearAwaiting('state-1')
    expect(isAwaited('state-1')).toBe(false)
    markAwaiting('state-1', Date.now() - 1)
    expect(isAwaited('state-1')).toBe(false)

    markCancelled('state-1', Date.now() + 60_000)
    markCancelled('state-2', Date.now() - 1)
    expect(isCancelled('state-1')).toBe(true)
    expect(isCancelled('state-2')).toBe(false)
  })

  it('keeps the sign-ins of dialogs in several tabs apart', () => {
    markAwaiting('state-1', Date.now() + 60_000)
    markAwaiting('state-2', Date.now() + 60_000)
    expect(isAwaited('state-1')).toBe(true)
    expect(isAwaited('state-2')).toBe(true)

    clearAwaiting('state-2')
    expect(isAwaited('state-1')).toBe(true)
    expect(isAwaited('state-2')).toBe(false)
  })

  it('tells the waiting tab when the provider sent back a tab that is signed out', async () => {
    const taken: HandedOver[] = []
    listen((state, outcome) => state === 'state-1' && taken.push(outcome) > 0)

    expect(reportSignedOutReturn({ provider: 'google', state: 'state-1', code: 'c' })).toBe(false)
    markAwaiting('state-1', Date.now() + 60_000)
    expect(reportSignedOutReturn({ provider: 'google', state: 'state-1', code: 'c' })).toBe(true)
    await vi.waitFor(() => expect(taken).toEqual([{ kind: 'signed-out' }]))
    expect(abandoned('state-1')).toBe('given-up')
    expect(abandoned('state-2')).toBeNull()
  })

  it('works without storage, through the channel alone', async () => {
    vi.stubGlobal('localStorage', undefined)
    listen(() => true)

    markAwaiting('state-1', Date.now() + 60_000)
    expect(isAwaited('state-1')).toBe(false)
    expect(await handOver('state-1', { kind: 'result', result })).toBe(true)
  })

  it('reads the state of an authorization URL', () => {
    expect(stateOf('https://accounts.google.example/o/oauth2/v2/auth?client_id=c&state=abc')).toBe('abc')
    expect(stateOf('not a url')).toBeNull()
  })
})
