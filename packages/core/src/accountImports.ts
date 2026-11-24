/**
 * Wire format of /api/v1/mail-account-imports, and how a client works through such a list: a short list of addresses
 * the user wants to add (made in Tresso or by an assistant), connected one by one by the user.
 */
import { APP_PASSWORD_SERVERS, connectRoute, oauthProviderFor, type OAuthProviderId, type ServerSettings, type SuggestedServerSettings } from './accounts'

/** At most this many addresses in one list. */
export const MAX_IMPORT_ENTRIES = 50

/** How an address is expected to connect, as the one who made the list said. Only used when the lookup finds nothing. */
export type ImportProviderHint = 'google' | 'microsoft' | 'imap'

/**
 * Whether the user has the account follows from their mail accounts: `connected` when it was added from this list,
 * `already_connected` when it was added another way. The others are stored.
 */
export type ImportEntryState = 'todo' | 'connected' | 'already_connected' | 'failed' | 'skipped'

/** Why connecting an entry failed: the codes of a provider sign-in, and two of the server form. */
export type ImportFailure =
  | 'denied'
  | 'admin_approval_required'
  | 'expired'
  | 'different_user'
  | 'scopes_missing'
  | 'wrong_account'
  | 'already_connected'
  | 'unverified_address'
  | 'no_mailbox'
  | 'failed'
  | 'password_refused'
  | 'server_unreachable'

export interface MailAccountImportEntry {
  id: string
  /** Lowercase. */
  address: string
  provider: ImportProviderHint | null
  state: ImportEntryState
  failure: ImportFailure | null
  /** The failure in a sentence, from the API. */
  reason: string | null
  /** Set once connected. */
  mailAccountId: string | null
  accountStatus: string | null
  /** For `admin_approval_required`: where the organization's administrator approves Tresso. */
  approvalUrl: string | null
}

export interface LeftOutAddress {
  address: string
  reason: 'invalid' | 'duplicate' | 'already_connected'
  message: string
}

export interface MailAccountImport {
  id: string
  entries: MailAccountImportEntry[]
  progress: Record<ImportEntryState, number>
  /** The app that made the list when it is not one of Tresso's own; null when the user made it in Tresso. */
  createdBy: string | null
  pageUrl: string
  createdAt: string
  expiresAt: string
  /** Only when the list was just made: the addresses not taken, and why. */
  leftOut: LeftOutAddress[]
}

export interface NewMailAccountImport {
  entries: { address: string; provider?: ImportProviderHint }[]
}

export interface UpdateImportEntry {
  entryId: string
  /** `connected` only once the account exists: it says the account was added from this list. */
  state: 'todo' | 'skipped' | 'failed' | 'connected'
  failure?: ImportFailure
}

/** What a pasted address needs before the list is made, as the paste step names it. */
export type PastedIssue =
  | { kind: 'invalid'; address: string; line: number; noAt: boolean }
  | { kind: 'twice'; address: string; line: number; firstLine: number }
  | { kind: 'connected'; address: string; line: number }

/** The pasted text, read the way the paste step counts it. */
export interface PastedAddresses {
  /** Every address-like part, valid or not. */
  total: number
  /** The addresses that go on the list, once each, in the order pasted. */
  toAdd: string[]
  issues: PastedIssue[]
  already: number
  invalid: number
  twice: number
}

const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Reads pasted addresses: one per line, or separated by commas, semicolons or spaces. Each part is an address to add,
 * or one that needs a look with its line: not valid (left out unless fixed), listed twice (added once) or already
 * connected (left out). The API checks every address again and says per address what it left out.
 *
 * @param connected the addresses of the user's mail accounts, lowercase
 */
export function readPastedAddresses(text: string, connected: readonly string[]): PastedAddresses {
  const seen = new Map<string, number>()
  const result: PastedAddresses = { total: 0, toAdd: [], issues: [], already: 0, invalid: 0, twice: 0 }
  text.split('\n').forEach((content, index) => {
    const line = index + 1
    for (const raw of content.split(/[,;\s]+/)) {
      const address = raw.trim()
      if (address === '') continue
      const key = address.toLowerCase()
      result.total++
      if (!ADDRESS.test(address)) {
        result.invalid++
        result.issues.push({ kind: 'invalid', address, line, noAt: !address.includes('@') })
      } else if (seen.has(key)) {
        result.twice++
        result.issues.push({ kind: 'twice', address, line, firstLine: seen.get(key)! })
      } else if (connected.includes(key)) {
        seen.set(key, line)
        result.already++
        result.issues.push({ kind: 'connected', address, line })
      } else {
        seen.set(key, line)
        result.toAdd.push(key)
      }
    }
  })
  return result
}

/** How one row of the list connects, once its address was looked up. */
export type ImportRoute =
  /** At Google or Microsoft, in the browser, with the address as the login hint. */
  | { kind: 'oauth'; provider: OAuthProviderId }
  /** With a password typed into Tresso: an app password for iCloud and Yahoo, else the server form. */
  | { kind: 'password'; service: 'icloud' | 'yahoo' | null }

/**
 * The way a row connects: what the lookup found, as the single "Add account" flow decides it ({@link connectRoute});
 * the hint of the one who made the list only when the lookup found nothing; the server form when neither says more.
 * A hint for a provider this server cannot sign in with leads to the server form too.
 */
export function importRoute(suggestion: Pick<SuggestedServerSettings, 'found' | 'provider'> | null, hint: ImportProviderHint | null, signInProviders: OAuthProviderId[]): ImportRoute {
  const route = suggestion === null ? 'picker' : connectRoute(suggestion, signInProviders)
  if (route === 'oauth') return { kind: 'oauth', provider: oauthProviderFor(suggestion!.provider!)! }
  if (route === 'app-password') return { kind: 'password', service: suggestion!.provider as 'icloud' | 'yahoo' }
  if (route === 'manual') return { kind: 'password', service: null }
  if ((hint === 'google' || hint === 'microsoft') && signInProviders.includes(hint)) return { kind: 'oauth', provider: hint }
  return { kind: 'password', service: null }
}

/** The servers a password row starts from: what the lookup found, the known ones of iCloud and Yahoo, else none. */
export function importServers(suggestion: SuggestedServerSettings | null, route: ImportRoute): { imap: ServerSettings; smtp: ServerSettings } | null {
  if (suggestion?.found && suggestion.imap && suggestion.smtp) return { imap: suggestion.imap, smtp: suggestion.smtp }
  if (route.kind === 'password' && route.service !== null) return APP_PASSWORD_SERVERS[route.service]
  return null
}

/** The groups of the list page, in their order. */
export type ImportGroup = 'microsoft' | 'google' | 'password'

export const IMPORT_GROUPS: ImportGroup[] = ['microsoft', 'google', 'password']

export function importGroup(route: ImportRoute): ImportGroup {
  return route.kind === 'oauth' ? route.provider : 'password'
}

/**
 * The rows in the order they are worked through: Microsoft, then Google, then those with a password, each group in
 * the order of the list. Rows of one provider follow each other, so the provider's own session in the browser can
 * serve the next sign-in where the provider allows it.
 */
export function importOrder<T extends { route: ImportRoute }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => IMPORT_GROUPS.indexOf(importGroup(a.row.route)) - IMPORT_GROUPS.indexOf(importGroup(b.row.route)) || a.index - b.index)
    .map(({ row }) => row)
}

/**
 * The next row to connect after `afterId` (or the first), in {@link importOrder}, wrapping around and never `afterId`
 * itself: one still to do, else (with `includeFailed`) one that failed. Password rows count: a run opens them and waits
 * for the password. Null when none is left.
 */
export function nextImportRow<T extends { id: string; state: ImportEntryState }>(ordered: T[], afterId: string | null, includeFailed = false): T | null {
  const start = afterId === null ? 0 : ordered.findIndex((row) => row.id === afterId) + 1
  const around = [...ordered.slice(start), ...ordered.slice(0, start)].filter((row) => row.id !== afterId)
  return around.find((row) => row.state === 'todo') ?? (includeFailed ? (around.find((row) => row.state === 'failed') ?? null) : null)
}
