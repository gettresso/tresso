/**
 * Wire format of /api/v1/mail-account-imports, and how a client works through such a list: a short list of addresses
 * the user wants to add (made in Tresso or by an assistant), connected one by one by the user.
 */
import { APP_PASSWORD_SERVERS, connectRoute, oauthProviderFor, type OAuthProviderId, type ServerSettings, type SuggestedServerSettings } from './accounts'

/** At most this many addresses in one list. */
export const MAX_IMPORT_ENTRIES = 50

/** How an address is expected to connect, as the one who made the list said. Only used when the lookup finds nothing. */
export type ImportProviderHint = 'google' | 'microsoft' | 'imap'

/** `connected` follows from the user's mail accounts; the others are stored. */
export type ImportEntryState = 'todo' | 'connected' | 'failed' | 'skipped'

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
  state: 'todo' | 'skipped' | 'failed'
  failure?: ImportFailure
}

/**
 * The addresses in pasted text: one per line, or separated by commas or semicolons. "Name <address>" and "mailto:"
 * are reduced to the address; empty parts are dropped. Nothing is checked or removed otherwise: the API says per
 * address what it left out, so the user sees the same reasons wherever the list was made.
 */
export function parseAddressList(text: string): string[] {
  return text
    .split(/[\n\r,;]+/)
    .map((part) => {
      const trimmed = part.trim()
      const angled = /<([^<>]+)>\s*$/.exec(trimmed)
      return (angled?.[1] ?? trimmed).replace(/^mailto:/i, '').trim()
    })
    .filter((address) => address !== '')
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

const GROUP_ORDER: Record<string, number> = { google: 0, microsoft: 1, password: 2 }

function groupOf(route: ImportRoute): number {
  return GROUP_ORDER[route.kind === 'oauth' ? route.provider : 'password']!
}

/**
 * The rows in the order they are worked through: Google, then Microsoft, then those with a password, each group in
 * the order of the list. Rows of one provider follow each other, so the provider's own session in the browser can
 * serve the next sign-in where the provider allows it.
 */
export function importOrder<T extends { route: ImportRoute }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => groupOf(a.row.route) - groupOf(b.row.route) || a.index - b.index)
    .map(({ row }) => row)
}

/**
 * The next row to sign in at a provider after `afterId` (or the first), in {@link importOrder}, wrapping around: one
 * still to do (or failed, when `includeFailed`), with a provider sign-in, never `afterId` itself. Null when none is
 * left.
 */
export function nextProviderRow<T extends { id: string; state: ImportEntryState; route: ImportRoute }>(ordered: T[], afterId: string | null, includeFailed = false): T | null {
  const start = afterId === null ? 0 : ordered.findIndex((row) => row.id === afterId) + 1
  const waiting = (row: T): boolean => row.id !== afterId && row.route.kind === 'oauth' && (row.state === 'todo' || (includeFailed && row.state === 'failed'))
  return ordered.slice(start).find(waiting) ?? ordered.slice(0, start).find(waiting) ?? null
}
