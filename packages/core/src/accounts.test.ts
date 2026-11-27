import { describe, expect, it } from 'vitest'
import {
  accountAttention,
  accountServiceProvider,
  accountSyncMeta,
  foundCalendarUrl,
  connectErrorMessage,
  connectRoute,
  defaultPort,
  guessedServers,
  normalizeAppPassword,
  oauthProviderFor,
  providerCompany,
  providerLabel,
  providerSignInOutcome,
  signedInAgainNotice,
  signInProvider,
  syncedTime,
  type ProviderConnection,
} from './accounts'

describe('defaultPort', () => {
  it('returns the registered ports', () => {
    expect(defaultPort('imap', 'tls')).toBe(993)
    expect(defaultPort('imap', 'starttls')).toBe(143)
    expect(defaultPort('smtp', 'tls')).toBe(465)
    expect(defaultPort('smtp', 'starttls')).toBe(587)
  })
})

describe('signInProvider', () => {
  it('maps the mail provider to the identity provider', () => {
    expect(signInProvider({ provider: 'gmail' })).toBe('google')
    expect(signInProvider({ provider: 'microsoft' })).toBe('microsoft')
    expect(signInProvider({ provider: 'imap' })).toBeNull()
  })
})

describe('connectErrorMessage', () => {
  it('names the provider', () => {
    expect(connectErrorMessage('scopes_missing', 'google')).toContain('Sign in with Google again')
    expect(connectErrorMessage('denied', 'microsoft')).toContain('Microsoft account')
  })

  it('treats unknown codes as a general failure', () => {
    expect(connectErrorMessage('<script>', 'google')).toBe(connectErrorMessage('failed', 'google'))
  })
})

describe('connectErrorMessage for an organization that must approve', () => {
  it('says who has to act', () => {
    expect(connectErrorMessage('admin_approval_required', 'microsoft')).toBe(
      'Your organization has to approve Tresso before you can connect this Microsoft account. Ask your IT team, then try again.',
    )
  })
})

describe('providerLabel and providerCompany', () => {
  it('names Outlook.com and Microsoft 365 apart, with Microsoft as the company', () => {
    expect(providerLabel('outlook')).toBe('Outlook')
    expect(providerLabel('m365')).toBe('Microsoft 365')
    expect(providerLabel('google')).toBe('Google')
    expect(providerCompany('m365')).toBe('Microsoft')
    expect(providerCompany('icloud')).toBe('Apple')
  })
})

describe('oauthProviderFor and accountServiceProvider', () => {
  it('signs Google, Outlook and Microsoft 365 in at their own page', () => {
    expect(oauthProviderFor('google')).toBe('google')
    expect(oauthProviderFor('outlook')).toBe('microsoft')
    expect(oauthProviderFor('m365')).toBe('microsoft')
    expect(oauthProviderFor('icloud')).toBeNull()
  })

  it('tells a personal Microsoft account from a work account by its domain', () => {
    expect(accountServiceProvider({ provider: 'microsoft', emailAddress: 'kim@Hotmail.com' })).toBe('outlook')
    expect(accountServiceProvider({ provider: 'microsoft', emailAddress: 'kim@company.example' })).toBe('m365')
    expect(accountServiceProvider({ provider: 'gmail', emailAddress: 'kim@company.example' })).toBe('google')
    expect(accountServiceProvider({ provider: 'imap', emailAddress: 'kim@icloud.com' })).toBeNull()
  })
})

describe('connectRoute', () => {
  const both = ['google', 'microsoft'] as const

  it('sends the providers that sign in at their own page there, when this server can', () => {
    expect(connectRoute({ found: true, provider: 'google' }, [...both])).toBe('oauth')
    expect(connectRoute({ found: false, provider: 'm365' }, [...both])).toBe('oauth')
    expect(connectRoute({ found: true, provider: 'outlook' }, [...both])).toBe('oauth')
  })

  it('falls back to the server form when this server cannot sign in with that provider', () => {
    expect(connectRoute({ found: true, provider: 'google' }, ['microsoft'])).toBe('manual')
    expect(connectRoute({ found: false, provider: 'm365' }, [])).toBe('manual')
  })

  it('asks iCloud and Yahoo users for an app password', () => {
    expect(connectRoute({ found: true, provider: 'icloud' }, [...both])).toBe('app-password')
    expect(connectRoute({ found: false, provider: 'yahoo' }, [])).toBe('app-password')
  })

  it('fills the server form when settings were found, and offers the provider list when nothing is known', () => {
    expect(connectRoute({ found: true, provider: null }, [...both])).toBe('manual')
    expect(connectRoute({ found: false, provider: null }, [...both])).toBe('picker')
  })
})

describe('guessedServers', () => {
  it('guesses imap. and smtp. with TLS ports', () => {
    expect(guessedServers('Studio-Noord.example')).toEqual({
      imap: { host: 'imap.studio-noord.example', port: 993, security: 'tls' },
      smtp: { host: 'smtp.studio-noord.example', port: 465, security: 'tls' },
    })
    expect(guessedServers('').imap.host).toBe('')
  })
})

describe('normalizeAppPassword', () => {
  it('drops the dashes and spaces the provider shows between the groups', () => {
    expect(normalizeAppPassword('abcd-efgh-ijkl-mnop')).toBe('abcdefghijklmnop')
    expect(normalizeAppPassword(' abcd efgh ijkl mnop ')).toBe('abcdefghijklmnop')
  })
})

describe('calendar statuses', () => {
  it('reads the address the worker found from its message', () => {
    expect(
      foundCalendarUrl({
        calendarStatusDetail: 'A calendar server was found at https://dav.studio-noord.example/caldav/. To sync your calendars there, confirm this address in the account settings.',
      }),
    ).toBe('https://dav.studio-noord.example/caldav/')
    expect(foundCalendarUrl({ calendarStatusDetail: 'A calendar server was found at the address the server named. To sync ...' })).toBeNull()
    expect(foundCalendarUrl({ calendarStatusDetail: null })).toBeNull()
  })

  it('prefers the address the API reports as its own field', () => {
    expect(foundCalendarUrl({ calendarFoundUrl: 'https://dav.studio-noord.example/caldav/?user=kim', calendarStatusDetail: 'A calendar server was found at https://dav.studio-noord.example/caldav/.' })).toBe(
      'https://dav.studio-noord.example/caldav/?user=kim',
    )
  })
})

describe('providerSignInOutcome and signedInAgainNotice', () => {
  const result = (overrides: Partial<ProviderConnection>): ProviderConnection => ({
    provider: 'microsoft',
    connected: 'acc-m',
    grant: null,
    connectError: null,
    requested: ['mail'],
    missing: [],
    existing: true,
    approvalUrl: null,
    ...overrides,
  })

  it('does not report calendars left unticked at the provider as success', () => {
    const outcome = providerSignInOutcome(result({ requested: ['mail', 'calendar'], missing: ['calendar'] }))

    expect(outcome).toEqual({ kind: 'connected', accountId: 'acc-m', existing: true, calendars: 'refused' })
    expect(signedInAgainNotice(outcome, 'microsoft')).toEqual({
      ok: false,
      text: 'Calendars were not allowed at Microsoft, so they still do not sync. Mail is not affected.',
      approvalUrl: null,
    })
  })

  it('says the calendars come once they were allowed, and only that the account syncs again otherwise', () => {
    expect(signedInAgainNotice(providerSignInOutcome(result({ requested: ['mail', 'calendar'] })), 'microsoft')).toEqual({
      ok: true,
      text: 'Signed in with Microsoft. Mail and calendars sync; calendars show up within a minute.',
      approvalUrl: null,
    })
    expect(signedInAgainNotice(providerSignInOutcome(result({})), 'google')).toEqual({ ok: true, text: 'Signed in with Google again. The account syncs again.', approvalUrl: null })
  })

  it("passes on the link for the organization's administrator", () => {
    const approvalUrl = 'https://login.microsoftonline.com/company.example/adminconsent?client_id=c'
    const outcome = providerSignInOutcome(result({ connected: null, connectError: 'admin_approval_required', approvalUrl, requested: ['mail', 'calendar'] }))

    expect(outcome).toEqual({ kind: 'approval-required', approvalUrl })
    expect(signedInAgainNotice(outcome, 'microsoft')).toEqual({ ok: false, text: connectErrorMessage('admin_approval_required', 'microsoft'), approvalUrl })
  })

  it('tells a refusal and other failures apart', () => {
    expect(providerSignInOutcome(result({ connected: null, connectError: 'denied' }))).toEqual({ kind: 'denied' })
    expect(providerSignInOutcome(result({ connected: null, connectError: 'wrong_account' }))).toEqual({ kind: 'failed', error: 'wrong_account' })
    expect(signedInAgainNotice({ kind: 'failed', error: 'wrong_account' }, 'microsoft').text).toBe(connectErrorMessage('wrong_account', 'microsoft'))
  })
})

describe('accountAttention', () => {
  const provider = { provider: 'microsoft', status: 'active', statusDetail: null, calendarStatus: 'active', calendarStatusDetail: null } as const
  const server = { provider: 'imap', status: 'active', statusDetail: null, calendarStatus: 'active', calendarStatusDetail: null } as const

  it('says nothing when nothing needs the user', () => {
    expect(accountAttention(provider)).toBeNull()
    expect(accountAttention({ ...provider, status: 'paused' })).toBeNull()
    expect(accountAttention({ ...provider, calendarStatus: 'unknown' })).toBeNull()
    expect(accountAttention({ ...provider, calendarStatus: 'unsupported' })).toBeNull()
    expect(accountAttention({ ...server, calendarStatus: 'unsupported' })).toBeNull()
  })

  it('asks a provider account to sign in again when its mail stops', () => {
    expect(accountAttention({ ...provider, status: 'auth_failed' })).toEqual({ tone: 'danger', text: 'Sign-in expired. New mail is not arriving.', action: { kind: 'sign-in', label: 'Sign in again' }, detail: null })
    expect(accountAttention({ ...provider, status: 'error' })).toEqual({ tone: 'danger', text: 'Syncing failed. New mail is not arriving.', action: { kind: 'sign-in', label: 'Sign in again' }, detail: null })
  })

  it('sends a mail-server account to its server settings when its mail stops', () => {
    expect(accountAttention({ ...server, status: 'auth_failed' })).toEqual({
      tone: 'danger',
      text: 'The server refused the password. New mail is not arriving.',
      action: { kind: 'server-settings', label: 'Server settings' },
      detail: null,
    })
    expect(accountAttention({ ...server, status: 'error' })?.action.kind).toBe('server-settings')
  })

  it('puts the mail before the calendars', () => {
    expect(accountAttention({ ...provider, status: 'auth_failed', calendarStatus: 'not_granted' })?.text).toBe('Sign-in expired. New mail is not arriving.')
    expect(accountAttention({ ...server, status: 'error', calendarStatus: 'unconfirmed' })?.text).toBe('Syncing failed. New mail is not arriving.')
  })

  it('asks a provider account to allow its calendars, or to sign in again when the provider refuses them', () => {
    expect(accountAttention({ ...provider, calendarStatus: 'not_granted' })).toEqual({ tone: 'warning', text: 'Calendar access is off', action: { kind: 'allow-calendar', label: 'Allow' }, detail: null })
    expect(accountAttention({ ...provider, calendarStatus: 'error' })).toEqual({ tone: 'warning', text: 'Calendars are not syncing', action: { kind: 'allow-calendar', label: 'Allow' }, detail: null })
    expect(accountAttention({ ...provider, calendarStatus: 'unconfirmed' })?.action.kind).toBe('allow-calendar')
    expect(accountAttention({ ...provider, calendarStatus: 'auth_failed' })).toEqual({ tone: 'warning', text: 'Calendar sign-in expired', action: { kind: 'sign-in', label: 'Sign in again' }, detail: null })
  })

  it('gives why, as the sync said it, for the problem that won', () => {
    const detailed = { ...provider, statusDetail: 'invalid_grant', calendarStatusDetail: 'Google refused the calendars of this account (forbidden).' }
    expect(accountAttention({ ...detailed, status: 'auth_failed', calendarStatus: 'error' })?.detail).toBe('The server said: invalid_grant')
    expect(accountAttention({ ...detailed, calendarStatus: 'error' })?.detail).toBe('Google refused the calendars of this account (forbidden).')
    expect(accountAttention({ ...provider, status: 'error', statusDetail: '' })?.detail).toBeNull()
    expect(accountAttention({ ...provider, calendarStatus: 'error' })?.detail).toBeNull()
  })

  it("fixes a mail-server account's calendars in its server settings", () => {
    expect(accountAttention({ ...server, calendarStatus: 'unconfirmed' })).toEqual({ tone: 'warning', text: 'Calendar address to confirm', action: { kind: 'server-settings', label: 'Server settings' }, detail: null })
    expect(accountAttention({ ...server, calendarStatus: 'auth_failed' })?.text).toBe('The calendar server refused the password')
    expect(accountAttention({ ...server, calendarStatus: 'error' })?.action.kind).toBe('server-settings')
  })
})

describe('syncedTime and accountSyncMeta', () => {
  // Friday 24 October 2025, 15:00 in Amsterdam (UTC+2).
  const now = Date.parse('2025-10-24T13:00:00Z')
  const zone = 'Europe/Amsterdam'

  it('says the time today, the weekday in the week before, and the date before that', () => {
    expect(syncedTime(Date.parse('2025-10-24T11:01:00Z'), now, zone)).toBe('13:01')
    expect(syncedTime(Date.parse('2025-10-23T22:30:00Z'), now, zone)).toBe('00:30')
    expect(syncedTime(Date.parse('2025-10-18T12:20:00Z'), now, zone)).toBe('Sat 14:20')
    // A week ago is another Friday: the date says which.
    expect(syncedTime(Date.parse('2025-10-17T12:20:00Z'), now, zone)).toBe('Fri 17 Oct 14:20')
    expect(syncedTime(Date.parse('2025-10-16T12:20:00Z'), now, zone)).toBe('Thu 16 Oct 14:20')
    expect(syncedTime(Date.parse('2024-12-30T09:00:00Z'), now, zone)).toBe('Mon 30 Dec 2024 10:00')
  })

  it('says Synced while it syncs, Last synced when mail stopped, and nothing while paused', () => {
    const lastSyncedAt = '2025-10-24T11:01:00Z'
    expect(accountSyncMeta({ status: 'active', lastSyncedAt }, now, zone)).toBe('Synced 13:01')
    expect(accountSyncMeta({ status: 'auth_failed', lastSyncedAt: '2025-10-21T12:20:00Z' }, now, zone)).toBe('Last synced Tue 14:20')
    expect(accountSyncMeta({ status: 'error', lastSyncedAt }, now, zone)).toBe('Last synced 13:01')
    expect(accountSyncMeta({ status: 'paused', lastSyncedAt }, now, zone)).toBeNull()
  })

  it('says Getting mail before the first sync, and nothing when that sync cannot start', () => {
    expect(accountSyncMeta({ status: 'active', lastSyncedAt: null }, now, zone)).toBe('Getting mail')
    expect(accountSyncMeta({ status: 'auth_failed', lastSyncedAt: null }, now, zone)).toBeNull()
  })
})
