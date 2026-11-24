import { afterEach, describe, expect, it } from 'vitest'
import type { ImportEntryState, ImportRoute, ProviderConnection } from '@tresso/core'
import { afterReturn, forget, noted, noteStarted, stop, takeReturn, type RunNote } from '../importRun'

const LIST = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const google: ImportRoute = { kind: 'oauth', provider: 'google' }
const microsoft: ImportRoute = { kind: 'oauth', provider: 'microsoft' }
const password: ImportRoute = { kind: 'password', service: null }

function note(overrides: Partial<RunNote> = {}): RunNote {
  return { importId: LIST, entryId: 'g1', mode: 'all', state: 'state-1', expiresAt: Date.now() + 60_000, ...overrides }
}

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return { provider: 'google', connected: 'acc-1', grant: null, connectError: null, requested: ['mail'], missing: [], existing: false, approvalUrl: null, ...overrides }
}

const row = (id: string, route: ImportRoute, state: ImportEntryState = 'todo') => ({ id, route, state })

describe('the run of an import list', () => {
  afterEach(() => sessionStorage.clear())

  it('takes the answer to the sign-in this tab noted, once', () => {
    noteStarted(note())

    expect(noted(LIST)?.entryId).toBe('g1')
    expect(takeReturn(LIST, 'state-1')).toEqual(note({ expiresAt: expect.any(Number) as number }))
    expect(takeReturn(LIST, 'state-1')).toBeNull()
  })

  it('takes no answer it did not note: another state, another list, none, or an expired note', () => {
    for (const [importId, state] of [
      [LIST, 'other-state'],
      ['another-list', 'state-1'],
      [LIST, null],
    ] as const) {
      noteStarted(note())
      expect(takeReturn(importId, state)).toBeNull()
      expect(noted(LIST)).toBeNull()
    }

    noteStarted(note({ expiresAt: Date.now() - 1 }))
    expect(takeReturn(LIST, 'state-1')).toBeNull()
  })

  it('forgets the note when the page loads without an answer, so nothing starts later', () => {
    noteStarted(note())
    forget()
    expect(takeReturn(LIST, 'state-1')).toBeNull()
  })

  it('stop keeps the sign-in under way but makes it a single one', () => {
    noteStarted(note())
    stop(LIST)
    expect(takeReturn(LIST, 'state-1')?.mode).toBe('one')
  })

  it('goes on to the next provider row by itself after a connected answer, in "all" mode only', () => {
    const rows = [row('g1', google, 'connected'), row('p1', password), row('m1', microsoft), row('g2', google)]

    expect(afterReturn(note(), connection(), rows)).toEqual({ kind: 'continue', entryId: 'g2' })
    expect(afterReturn(note({ mode: 'one' }), connection(), rows)).toEqual({ kind: 'offer', entryId: 'g2' })
  })

  it('offers nothing more once no provider row is left', () => {
    const rows = [row('g1', google, 'connected'), row('m1', microsoft, 'skipped'), row('p1', password)]

    expect(afterReturn(note(), connection(), rows)).toEqual({ kind: 'offer', entryId: null })
  })

  it('stops at the first answer that did not connect', () => {
    const rows = [row('g1', google, 'failed'), row('g2', google)]

    for (const result of [connection({ connected: null, connectError: 'denied' }), connection({ connected: null, connectError: 'wrong_account' }), connection({ connected: null, connectError: 'admin_approval_required' })]) {
      expect(afterReturn(note(), result, rows)).toEqual({ kind: 'stopped', entryId: 'g1' })
    }
  })
})
