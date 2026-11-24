import { importOrder, nextImportRow, providerSignInOutcome, type ImportEntryState, type ImportRoute, type ProviderConnection } from '@tresso/core'

/**
 * Working through an import list (/settings/accounts/import/:id): "Next: <address>" connects one row and then starts
 * nothing; "Sign in to all, one after another" goes through every row still to do, Microsoft, Google, then the password
 * rows. A provider row opens the provider's page (a new tab on the web, the system browser in the desktop app) and waits
 * for the answer; a password row opens in place and waits for the password. A run stops at the first row that does not
 * connect, and on Stop. It lives in the page only: nothing is kept that could start a sign-in on a later page load, so
 * the first start is always the user's own click.
 */

export type RunMode = 'all' | 'one'

/** What the page does once a row it started has ended. */
export type AfterRow =
  /** Connected, in "all" mode, and another row waits: start it now. */
  | { kind: 'continue'; entryId: string }
  /** Connected, and the run is over (a single row, Stop, or nothing left). */
  | { kind: 'done' }
  /** Did not connect: a run stops here, with the notice for this row. */
  | { kind: 'stopped'; entryId: string }

/** Whether a provider's answer connected the row. */
export function connectedBy(result: ProviderConnection): boolean {
  return providerSignInOutcome(result).kind === 'connected'
}

/**
 * What follows a row that ended. `rows` are the list's rows as they stand now (the ended one included), with how each
 * connects; the next is the next row still to do in {@link importOrder}.
 */
export function afterRow<T extends { id: string; state: ImportEntryState; route: ImportRoute }>(entryId: string, connected: boolean, mode: RunMode | null, rows: T[]): AfterRow {
  if (!connected) return mode === 'all' ? { kind: 'stopped', entryId } : { kind: 'done' }
  if (mode !== 'all') return { kind: 'done' }
  const next = nextImportRow(importOrder(rows), entryId)
  return next === null ? { kind: 'done' } : { kind: 'continue', entryId: next.id }
}
