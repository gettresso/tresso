import { describe, expect, it } from 'vitest'
import type { ImportEntryState, ImportRoute, ProviderConnection } from '@tresso/core'
import { afterRow, connectedBy } from '../importRun'

const google: ImportRoute = { kind: 'oauth', provider: 'google' }
const microsoft: ImportRoute = { kind: 'oauth', provider: 'microsoft' }
const password: ImportRoute = { kind: 'password', service: null }

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return { provider: 'google', connected: 'acc-1', grant: null, connectError: null, requested: ['mail'], missing: [], existing: false, approvalUrl: null, ...overrides }
}

const row = (id: string, route: ImportRoute, state: ImportEntryState = 'todo') => ({ id, route, state })

describe('the run of an import list', () => {
  it('goes on by itself after a connected row, in "all" mode only, password rows included', () => {
    const rows = [row('m1', microsoft, 'connected'), row('p1', password), row('g1', google)]

    expect(afterRow('m1', true, 'all', rows)).toEqual({ kind: 'continue', entryId: 'g1' })
    expect(afterRow('g1', true, 'all', [row('m1', microsoft, 'connected'), row('p1', password), row('g1', google, 'connected')])).toEqual({ kind: 'continue', entryId: 'p1' })
    expect(afterRow('m1', true, 'one', rows)).toEqual({ kind: 'done' })
    expect(afterRow('m1', true, null, rows)).toEqual({ kind: 'done' })
  })

  it('ends when nothing is left to do', () => {
    expect(afterRow('m1', true, 'all', [row('m1', microsoft, 'connected'), row('g1', google, 'skipped'), row('p1', password, 'already_connected')])).toEqual({ kind: 'done' })
  })

  it('stops a run at the first row that did not connect; a single row just ends', () => {
    const rows = [row('g1', google, 'failed'), row('g2', google)]

    expect(afterRow('g1', false, 'all', rows)).toEqual({ kind: 'stopped', entryId: 'g1' })
    expect(afterRow('g1', false, 'one', rows)).toEqual({ kind: 'done' })
  })

  it('reads whether a provider answer connected', () => {
    expect(connectedBy(connection())).toBe(true)
    for (const connectError of ['denied', 'wrong_account', 'admin_approval_required'] as const) {
      expect(connectedBy(connection({ connected: null, connectError }))).toBe(false)
    }
  })
})
