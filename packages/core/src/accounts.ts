/**
 * Wire format of /api/v1/mail-accounts, /api/v1/mail-server-settings, /api/v1/mail-account-checks and the provider
 * sign-in endpoints, and the rules of connecting a mail account.
 */

import { clock, shortDate, WEEKDAYS_SHORT } from './calendar/format'
import { DAY, startOfWallDay, toWall, wallParts, weekdayOf } from './calendar/zones'
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
  /** With calendar status `unconfirmed`: the CalDAV address the sync found, for the user to confirm. */
  calendarFoundUrl?: string | null
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
 * sync error, and the account starts a fresh sync session within about two minutes.
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
  /** The MCP endpoint of this server, the one address an AI assistant connects to. */
  mcpEndpoint: string
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
   * Signing in for an address of this import list (with that address in emailAddress): the answer comes back to the
   * list's page, and signing in with another provider account fails with `wrong_account`.
   */
  importId?: string
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

/**
 * How a finished provider sign-in turned out, read the same way wherever it came back (the connect dialog, the
 * accounts page, the phone): connected, with what became of the calendars; refused at the provider; waiting for an
 * organization's approval, with the link to pass to its administrator when the API sent one; or failed otherwise.
 * `calendars` is `refused` when they were asked for and not allowed, `allowed` when they were asked for (or kept from
 * before) and are covered now, `not-asked` otherwise.
 */
export type ProviderSignInOutcome =
  | { kind: 'connected'; accountId: string; existing: boolean; calendars: 'allowed' | 'refused' | 'not-asked' }
  | { kind: 'grant'; calendars: 'allowed' | 'refused' | 'not-asked' }
  | { kind: 'denied' }
  | { kind: 'approval-required'; approvalUrl: string | null }
  | { kind: 'failed'; error: ProviderConnectError }

export function providerSignInOutcome(result: ProviderConnection): ProviderSignInOutcome {
  if (result.connectError === 'denied') return { kind: 'denied' }
  if (result.connectError === 'admin_approval_required') return { kind: 'approval-required', approvalUrl: result.approvalUrl }
  if (result.connectError !== null) return { kind: 'failed', error: result.connectError }
  const calendars = result.missing.includes('calendar') ? 'refused' : result.requested.includes('calendar') ? 'allowed' : 'not-asked'
  if (result.connected !== null) return { kind: 'connected', accountId: result.connected, existing: result.existing, calendars }
  return { kind: 'grant', calendars }
}

/**
 * What a screen says when a sign-in for an account that is connected already (signing in again, allowing its
 * calendars) came back: `ok` false when something the user asked for did not happen. With an organization's approval
 * to get, `approvalUrl` is the link for its administrator (null when the API had none).
 */
export function signedInAgainNotice(outcome: ProviderSignInOutcome, provider: OAuthProviderId): { ok: boolean; text: string; approvalUrl: string | null } {
  const name = providerName(provider)
  switch (outcome.kind) {
    case 'connected':
    case 'grant':
      if (outcome.calendars === 'refused') {
        return { ok: false, text: `Calendars were not allowed at ${name}, so they still do not sync. Mail is not affected.`, approvalUrl: null }
      }
      if (outcome.calendars === 'allowed') {
        return { ok: true, text: `Signed in with ${name}. Mail and calendars sync; calendars show up within a minute.`, approvalUrl: null }
      }
      return { ok: true, text: `Signed in with ${name} again. The account syncs again.`, approvalUrl: null }
    case 'denied':
      return { ok: false, text: connectErrorMessage('denied', provider), approvalUrl: null }
    case 'approval-required':
      return { ok: false, text: connectErrorMessage('admin_approval_required', provider), approvalUrl: outcome.approvalUrl }
    case 'failed':
      return { ok: false, text: connectErrorMessage(outcome.error, provider), approvalUrl: null }
  }
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
 * The CalDAV address the sync worker found on a server it may not trust on its own, for an account in calendar
 * status `unconfirmed`: the API's `calendarFoundUrl` when the worker reported it, else read from the status text
 * ("A calendar server was found at https://... To sync your calendars there, confirm this address in the account
 * settings."), which is all workers before that field send. Null when neither names one.
 */
export function foundCalendarUrl(account: Pick<MailAccount, 'calendarFoundUrl' | 'calendarStatusDetail'>): string | null {
  if (typeof account.calendarFoundUrl === 'string' && account.calendarFoundUrl !== '') return account.calendarFoundUrl
  const match = account.calendarStatusDetail?.match(/https:\/\/\S+/)
  return match ? match[0].replace(/[.,;:]+$/, '') : null
}

/**
 * The one line under an account in Settings, when the user has to act on it (the Needs attention and Sign-in expired
 * states of the SettingsAccounts board), and what its button does: sign in with the provider again (`sign-in`), allow
 * the calendars at the provider (`allow-calendar`), or open the server settings of a mail-server account
 * (`server-settings`). Mail that does not arrive wins over calendars. `detail` is why, as the sync said it, for the
 * problem that won: the mail sync's words as "The server said: ...", the calendar sync's as they are; null when it gave
 * none. Null when nothing needs the user, also for calendars the provider or server does not offer.
 */
export interface AccountAttention {
  tone: 'danger' | 'warning'
  text: string
  action: { kind: 'sign-in' | 'allow-calendar' | 'server-settings'; label: string }
  detail: string | null
}

export function accountAttention(account: Pick<MailAccount, 'provider' | 'status' | 'statusDetail' | 'calendarStatus' | 'calendarStatusDetail'>): AccountAttention | null {
  const server = signInProvider(account) === null
  const fix: AccountAttention['action'] = server ? { kind: 'server-settings', label: 'Server settings' } : { kind: 'sign-in', label: 'Sign in again' }
  const mailDetail = account.statusDetail ? `The server said: ${account.statusDetail}` : null
  if (account.status === 'auth_failed') {
    // A provider stops accepting an earlier sign-in; a mail server refuses the password it has.
    const text = server ? 'The server refused the password. New mail is not arriving.' : 'Sign-in expired. New mail is not arriving.'
    return { tone: 'danger', text, action: fix, detail: mailDetail }
  }
  if (account.status === 'error') {
    return { tone: 'danger', text: 'Syncing failed. New mail is not arriving.', action: fix, detail: mailDetail }
  }
  // A new calendar sign-in at the provider settles a refusal and retries at once; a server account fixes its
  // calendars in its server settings (the address to confirm, the password).
  const allow: AccountAttention['action'] = server ? fix : { kind: 'allow-calendar', label: 'Allow' }
  const calendar = (text: string, action: AccountAttention['action']): AccountAttention => ({ tone: 'warning', text, action, detail: account.calendarStatusDetail || null })
  switch (account.calendarStatus) {
    case 'not_granted':
      return calendar('Calendar access is off', allow)
    case 'auth_failed':
      return calendar(server ? 'The calendar server refused the password' : 'Calendar sign-in expired', fix)
    case 'error':
      return calendar('Calendars are not syncing', allow)
    case 'unconfirmed':
      return server ? calendar('Calendar address to confirm', fix) : calendar('Calendars are not syncing', allow)
    case 'unsupported':
    case 'unknown':
    case 'active':
      return null
  }
}

/**
 * When an account last synced, in the meta place of its row: "13:01" today, "Fri 14:20" in the six days before,
 * "Thu 23 Oct 14:20" earlier (with the year when it is another one). Times on the 24 hour clock, in `zone`.
 */
export function syncedTime(instant: number, now: number, zone: string): string {
  const wall = toWall(instant, zone)
  const day = startOfWallDay(wall)
  const today = startOfWallDay(toWall(now, zone))
  if (day === today) return clock(wall)
  if (day < today && today - day < 7 * DAY) return `${WEEKDAYS_SHORT[weekdayOf(wall)]} ${clock(wall)}`
  const year = wallParts(wall).year
  return `${shortDate(wall)}${year === wallParts(today).year ? '' : ` ${year}`} ${clock(wall)}`
}

/**
 * The quiet meta of an account row: "Synced 13:01" while it syncs, "Last synced Fri 14:20" when mail stopped arriving,
 * "Getting mail" before its first sync. Null while syncing is paused (the row shows a Paused pill instead), and for an
 * account that never synced and does not sync now.
 */
export function accountSyncMeta(account: Pick<MailAccount, 'status' | 'lastSyncedAt'>, now: number, zone: string): string | null {
  if (account.status === 'paused') return null
  const at = account.lastSyncedAt === null ? Number.NaN : Date.parse(account.lastSyncedAt)
  if (Number.isNaN(at)) return account.status === 'active' ? 'Getting mail' : null
  const when = syncedTime(at, now, zone)
  return account.status === 'active' ? `Synced ${when}` : `Last synced ${when}`
}
