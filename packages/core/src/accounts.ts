/**
 * Wire format of /api/v1/mail-accounts, /api/v1/mail-server-settings, /api/v1/mail-account-checks and the provider
 * sign-in endpoints, and the rules of connecting a mail account.
 */

import type { CalendarSyncStatus, MailAccountStatus } from './sync/types'

export type ConnectionSecurity = 'tls' | 'starttls' | 'none'

export interface ServerSettings {
  host: string
  port: number
  security: ConnectionSecurity
}

export interface MailAccount {
  id: string
  emailAddress: string
  displayName: string
  /** "imap", or "gmail" and "microsoft" for accounts that sign in with Google or Microsoft. */
  provider: string
  status: MailAccountStatus
  statusDetail: string | null
  /** Null for Gmail and Microsoft 365 accounts: they have no password or servers. */
  username: string | null
  imap: ServerSettings | null
  smtp: ServerSettings | null
  /** CalDAV address of the account's calendars, set by the user or found by the sync worker. */
  calendarUrl: string | null
  calendarStatus: CalendarSyncStatus
  calendarStatusDetail: string | null
  lastSyncedAt: string | null
  createdAt: string
  /** Changed through the signature's `defaultFor`. */
  defaultSignatureId: string | null
}

export interface NewMailAccount {
  emailAddress: string
  displayName: string
  username: string
  password: string
  imap: ServerSettings
  smtp: ServerSettings
  calendarUrl?: string | null
}

/**
 * JSON merge patch: omitted fields stay as they are. A new password, username or server clears a sign-in failure or a
 * sync error, and the worker tries the account again at once.
 */
export interface MailAccountUpdate {
  displayName?: string
  username?: string
  password?: string
  imap?: ServerSettings
  smtp?: ServerSettings
  status?: 'active' | 'paused'
  /** An empty string finds the address automatically again. */
  calendarUrl?: string
}

export type SignInMethod = 'password' | 'oauth2'

/**
 * A large provider an address belongs to, by its domain or mail exchanger: Google, Outlook.com (personal Microsoft
 * accounts), Microsoft 365 (work or school), iCloud and Yahoo.
 */
export type MailServiceProvider = 'google' | 'outlook' | 'm365' | 'icloud' | 'yahoo'

export interface SuggestedServerSettings {
  emailAddress: string
  found: boolean
  source: string | null
  username: string | null
  imap: ServerSettings | null
  smtp: ServerSettings | null
  authentication: SignInMethod[]
  /** The large provider behind the address; null for any other. */
  provider: MailServiceProvider | null
}

/** POST /api/v1/mail-account-checks: a new account's settings, checked before it is created. */
export type CheckMailAccount = Omit<NewMailAccount, 'displayName' | 'calendarUrl'>

/**
 * How checking one side went: `auth_failed` (username or password refused), `unreachable` (not found, refused or no
 * answer), `certificate` (TLS certificate not valid), `blocked` (private address), `failed` (the server answered
 * oddly), `not_checked` (SMTP, when IMAP failed first).
 */
export type MailCheckStatus = 'ok' | 'auth_failed' | 'unreachable' | 'certificate' | 'blocked' | 'failed' | 'not_checked'

export interface MailAccountCheck {
  emailAddress: string
  imap: MailCheckStatus
  smtp: MailCheckStatus
  /** Folders the IMAP server listed; null when signing in failed. */
  folders: number | null
  /** One technical line about what failed: host and port, or what the server said. */
  detail: string | null
}

/** GET /api/v1/server-info: what the server is, open to everyone. */
export interface ServerInfo {
  product: string
  apiVersion: number
  billing: boolean
  trialDays: number
  /** Mail accounts may connect without TLS (local test servers only). */
  allowUnencryptedMailServers: boolean
}

/** The usual ports, to fill in when the user picks a security mode. */
export function defaultPort(protocol: 'imap' | 'smtp', security: ConnectionSecurity): number {
  if (protocol === 'imap') {
    return security === 'tls' ? 993 : 143
  }
  return security === 'tls' ? 465 : 587
}

/** Identity providers a mail account can sign in with instead of a password. */
export type OAuthProviderId = 'google' | 'microsoft'

/** What a provider sign-in is for. Calendars can also be allowed later, for an account that has mail already. */
export type ProviderFeature = 'mail' | 'calendar'

/** A provider this server can sign in with (GET /api/v1/oauth-providers). */
export interface OAuthProviderInfo {
  id: OAuthProviderId
  name: string
  features: ProviderFeature[]
}

/** POST /api/v1/provider-authorizations. */
export interface StartProviderAuthorization {
  provider: OAuthProviderId
  features?: ProviderFeature[]
  /** Signing in again for this account. */
  mailAccountId?: string
  /** The address typed for a new account; the provider gets it as a login hint. */
  emailAddress?: string
  /**
   * Where the provider's answer goes: `web` (the default) to the page the sign-in started from, `native` to the
   * desktop app's own link (NATIVE_REDIRECT_URI), with that page in `next`, for a sign-in opened in the system browser.
   */
  returnTo?: 'web' | 'native'
}

/**
 * Send the browser to `authorizationUrl`. It comes back to the web app with the provider's answer in the query (`state`
 * with `code` or `error`), to hand in with {@link CompleteProviderAuthorization}, or with `connectError=expired` when
 * the API did not know the sign-in. With `returnTo: 'native'` the same query arrives through the desktop app's link.
 */
export interface ProviderAuthorization {
  authorizationUrl: string
  provider: OAuthProviderId
  expiresAt: string
}

/** POST /api/v1/provider-connections: the provider's answer, handed in by the user who started the sign-in. */
export interface CompleteProviderAuthorization {
  provider: OAuthProviderId
  state: string
  code?: string
  error?: string
  /** The provider's explanation of `error` (`error_description` in the query). */
  errorDescription?: string
}

/** What finishing a provider sign-in did: the mail account connected, the grant updated, or why not. */
export interface ProviderConnection {
  provider: OAuthProviderId
  connected: string | null
  grant: string | null
  connectError: ProviderConnectError | null
  /** What the sign-in asked for; also on a failure, so a client can offer mail alone. Empty when not known. */
  requested: ProviderFeature[]
  /** Asked for and not allowed at the provider (calendars left unticked). */
  missing: ProviderFeature[]
  /** A new sign-in found the account connected already, and signed it in again. */
  existing: boolean
  /** Where an administrator approves Tresso, with `connectError: admin_approval_required`. */
  approvalUrl: string | null
}

/** Why a provider sign-in failed (`connectError` in a {@link ProviderConnection} or in the query the API redirects with). */
export type ProviderConnectError =
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

/** The provider a mail account signs in with, or null for accounts with a password. */
export function signInProvider(account: Pick<MailAccount, 'provider'>): OAuthProviderId | null {
  if (account.provider === 'gmail') return 'google'
  if (account.provider === 'microsoft') return 'microsoft'
  return null
}

export function providerName(provider: OAuthProviderId): string {
  return provider === 'google' ? 'Google' : 'Microsoft'
}

/** Words for a failed provider sign-in; unknown codes (a hand-edited link) read as a general failure. */
export function connectErrorMessage(code: string, provider: OAuthProviderId): string {
  const name = providerName(provider)
  const messages: Record<ProviderConnectError, string> = {
    denied: `You did not allow Tresso to use your ${name} account, so nothing was connected.`,
    admin_approval_required: `Your organization has to approve Tresso before you can connect this ${name} account. Ask your IT team, then try again.`,
    expired: 'That sign-in took too long or was already used. Try again.',
    different_user: `The sign-in was started by another Tresso user. Sign in to Tresso as yourself, then try again.`,
    scopes_missing: `Tresso needs permission to read and send your mail. Sign in with ${name} again and leave those boxes ticked.`,
    wrong_account: `You signed in with a different ${name} account than this one. Sign in again with the address of this account.`,
    already_connected: 'This address is already connected with a password. Remove that account first to connect it this way.',
    unverified_address: `${name} has not verified the address of this account yet, so Tresso cannot use it.`,
    no_mailbox: `This ${name} account has no mailbox Tresso can sync.`,
    failed: `Connecting to ${name} failed. Try again in a moment.`,
  }

  return code in messages ? messages[code as ProviderConnectError] : messages.failed
}

/** How a provider is called on screen: Outlook for Outlook.com, Hotmail and Live; Microsoft 365 for work accounts. */
export function providerLabel(provider: MailServiceProvider): string {
  const labels: Record<MailServiceProvider, string> = { google: 'Google', outlook: 'Outlook', m365: 'Microsoft 365', icloud: 'iCloud', yahoo: 'Yahoo' }
  return labels[provider]
}

/** The company behind a provider, for sentences like "You sign in on Microsoft's own page". */
export function providerCompany(provider: MailServiceProvider): string {
  const companies: Record<MailServiceProvider, string> = { google: 'Google', outlook: 'Microsoft', m365: 'Microsoft', icloud: 'Apple', yahoo: 'Yahoo' }
  return companies[provider]
}

/** The identity provider to sign in with, for the providers that connect through their own sign-in page. */
export function oauthProviderFor(provider: MailServiceProvider): OAuthProviderId | null {
  if (provider === 'google') return 'google'
  if (provider === 'outlook' || provider === 'm365') return 'microsoft'
  return null
}

/** The large provider of a connected account, as far as its kind tells: Gmail, or Microsoft (Outlook or 365). */
export function accountServiceProvider(account: Pick<MailAccount, 'provider' | 'emailAddress'>): MailServiceProvider | null {
  if (account.provider === 'gmail') return 'google'
  if (account.provider === 'microsoft') {
    const domain = (account.emailAddress.split('@')[1] ?? '').toLowerCase()
    return ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain) ? 'outlook' : 'm365'
  }
  return null
}

/**
 * Where connecting an address goes after its provider was looked up: the provider's sign-in page (`oauth`) when this
 * server can sign in with it, an app password for iCloud and Yahoo, the server form when settings were found or a
 * provider is known that this server cannot sign in with, and the provider list when nothing is known.
 */
export function connectRoute(suggestion: Pick<SuggestedServerSettings, 'found' | 'provider'>, signInProviders: OAuthProviderId[]): 'oauth' | 'app-password' | 'manual' | 'picker' {
  const provider = suggestion.provider
  if (provider === 'icloud' || provider === 'yahoo') return 'app-password'
  if (provider !== null) {
    const oauth = oauthProviderFor(provider)
    return oauth !== null && signInProviders.includes(oauth) ? 'oauth' : 'manual'
  }
  return suggestion.found ? 'manual' : 'picker'
}

/** Server settings to start from when nothing was found: the usual names and ports for the domain. */
export function guessedServers(domain: string): { imap: ServerSettings; smtp: ServerSettings } {
  const base = domain.trim().toLowerCase()
  return {
    imap: { host: base === '' ? '' : `imap.${base}`, port: defaultPort('imap', 'tls'), security: 'tls' },
    smtp: { host: base === '' ? '' : `smtp.${base}`, port: defaultPort('smtp', 'tls'), security: 'tls' },
  }
}

/**
 * The servers of the providers that connect with an app password, for when the lookup found none (it usually finds
 * them in Mozilla's ISPDB).
 */
export const APP_PASSWORD_SERVERS: Record<'icloud' | 'yahoo', { imap: ServerSettings; smtp: ServerSettings }> = {
  icloud: { imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' } },
  yahoo: { imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' } },
}

/** App passwords are shown in groups (abcd-efgh-ijkl-mnop); the server wants them without the dashes and spaces. */
export function normalizeAppPassword(value: string): string {
  return value.replace(/[\s-]+/g, '')
}

/**
 * The CalDAV address the sync worker found on a server it may not trust on its own, from the calendar status of an
 * account in status `unconfirmed` ("A calendar server was found at https://... To sync your calendars there, confirm
 * this address in the account settings."). Null when the text names none.
 */
export function foundCalendarUrl(detail: string | null): string | null {
  const match = detail?.match(/https:\/\/\S+/)
  return match ? match[0].replace(/[.,;:]+$/, '') : null
}

/** Calendar statuses that need the user: shown on the account and in the calendar. */
export function calendarNeedsAttention(status: CalendarSyncStatus): boolean {
  return status === 'not_granted' || status === 'auth_failed' || status === 'error' || status === 'unconfirmed'
}

/** A short label for a calendar status that needs the user, for a badge next to the account. */
export function calendarStatusLabel(status: CalendarSyncStatus): string | null {
  const labels: Partial<Record<CalendarSyncStatus, string>> = {
    not_granted: 'Calendars not allowed',
    auth_failed: 'Calendar sign-in failed',
    error: 'Calendar problem',
    unconfirmed: 'Calendar address to confirm',
  }
  return labels[status] ?? null
}
