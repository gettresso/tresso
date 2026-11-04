/** Wire format of /api/v1/mail-accounts, /api/v1/mail-server-settings and the provider sign-in endpoints. */

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

/** JSON merge patch: omitted fields stay as they are. A new password also clears a sign-in failure. */
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

export interface SuggestedServerSettings {
  emailAddress: string
  found: boolean
  source: string | null
  username: string | null
  imap: ServerSettings | null
  smtp: ServerSettings | null
  authentication: SignInMethod[]
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
}

/** What finishing a provider sign-in did: the mail account connected, the grant updated, or why not. */
export interface ProviderConnection {
  provider: OAuthProviderId
  connected: string | null
  grant: string | null
  connectError: ProviderConnectError | null
}

/** Why a provider sign-in failed (`connectError` in a {@link ProviderConnection} or in the query the API redirects with). */
export type ProviderConnectError =
  | 'denied'
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
