import { importOrder, nextProviderRow, providerSignInOutcome, type ImportEntryState, type ImportRoute, type ProviderConnection } from '@tresso/core'

/**
 * Working through the provider rows of an import list (/settings/accounts/import/:id): "Sign in" for one row, or
 * "Sign in to all, one after another", which after each sign-in that came back connected starts the next row by itself.
 *
 * A sign-in leaves the page: on the web this tab goes to the provider and comes back as a fresh page load; in the
 * desktop app the system browser opens and the answer comes back through the app's link while the page stays. Both
 * come back to the list's page with the provider's answer in the query. What was started is noted per tab (session
 * storage), so the page that comes back knows whether it started that sign-in, and in which mode:
 *
 * - Nothing starts on page load. Only an answer to the sign-in this tab noted (same list, same OAuth state, not
 *   expired) may lead to the next start, and only in "all" mode; a load without such an answer forgets the note.
 * - The first start is always the user's click: {@link noteStarted} is only called from one.
 * - A sign-in that did not connect stops the run, and Stop turns the run into a single sign-in, whose answer is still
 *   shown but starts nothing more.
 */

const KEY = 'tresso.import.run'

export type RunMode = 'all' | 'one'

/** The sign-in this tab started from an import list, waiting for the provider's answer. */
export interface RunNote {
  importId: string
  entryId: string
  mode: RunMode
  /** The OAuth state of the sign-in, which the answer carries back. */
  state: string
  expiresAt: number
}

/** What the page does once a noted sign-in came back. */
export type AfterReturn =
  /** Connected, in "all" mode, and another row waits: start it now. */
  | { kind: 'continue'; entryId: string }
  /** Connected; offer the next row (one click or keypress), or nothing when none is left. */
  | { kind: 'offer'; entryId: string | null }
  /** Did not connect: the run stops here, the row says why. */
  | { kind: 'stopped'; entryId: string }

export interface RunStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function storage(): RunStorage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

function read(store: RunStorage | null): RunNote | null {
  try {
    const note = JSON.parse(store?.getItem(KEY) ?? 'null') as Partial<RunNote> | null
    if (note === null || typeof note.importId !== 'string' || typeof note.entryId !== 'string' || typeof note.state !== 'string' || typeof note.expiresAt !== 'number') return null
    return { importId: note.importId, entryId: note.entryId, mode: note.mode === 'all' ? 'all' : 'one', state: note.state, expiresAt: note.expiresAt }
  } catch {
    return null
  }
}

function write(store: RunStorage | null, note: RunNote | null): void {
  try {
    if (note === null) store?.removeItem(KEY)
    else store?.setItem(KEY, JSON.stringify(note))
  } catch {
    // Without storage a sign-in on the web comes back unnoted: it is finished and shown, but starts nothing more.
  }
}

/** Notes a sign-in the user started (or the run started after a connected answer). */
export function noteStarted(note: RunNote, store: RunStorage | null = storage()): void {
  write(store, note)
}

/** The sign-in noted for this list, if any; for the desktop app, whose page stays while the browser is open. */
export function noted(importId: string, store: RunStorage | null = storage()): RunNote | null {
  const note = read(store)
  return note !== null && note.importId === importId && note.expiresAt > Date.now() ? note : null
}

/**
 * The answer to a sign-in came back to the list's page: the note it belongs to, taken once, or null when this tab did
 * not start that sign-in (another tab, an old link, an expired note). Either way the note is gone afterwards.
 */
export function takeReturn(importId: string, state: string | null, store: RunStorage | null = storage()): RunNote | null {
  const note = read(store)
  write(store, null)
  if (note === null || note.importId !== importId || state === null || note.state !== state || note.expiresAt <= Date.now()) return null
  return note
}

/** The page loaded without an answer, or the list is left: nothing noted may start anything later. */
export function forget(store: RunStorage | null = storage()): void {
  write(store, null)
}

/** Stop: the sign-in under way still finishes and shows, but starts nothing after it. */
export function stop(importId: string, store: RunStorage | null = storage()): void {
  const note = read(store)
  if (note !== null && note.importId === importId) write(store, { ...note, mode: 'one' })
}

/**
 * What follows a noted sign-in's answer. `rows` are the list's rows as they stand now (the answered one included),
 * with how each connects; the next is the next provider row still to do, in {@link importOrder}.
 */
export function afterReturn<T extends { id: string; state: ImportEntryState; route: ImportRoute }>(note: RunNote, result: ProviderConnection, rows: T[]): AfterReturn {
  const outcome = providerSignInOutcome(result)
  if (outcome.kind !== 'connected') return { kind: 'stopped', entryId: note.entryId }
  const next = nextProviderRow(importOrder(rows), note.entryId)
  if (next === null) return { kind: 'offer', entryId: null }
  return note.mode === 'all' ? { kind: 'continue', entryId: next.id } : { kind: 'offer', entryId: next.id }
}
