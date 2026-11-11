import { describe, expect, it } from 'vitest'
import {
  accountServiceProvider,
  calendarNeedsAttention,
  calendarStatusLabel,
  foundCalendarUrl,
  connectErrorMessage,
  connectRoute,
  defaultPort,
  guessedServers,
  normalizeAppPassword,
  oauthProviderFor,
  providerCompany,
  providerLabel,
  signInProvider,
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

  it('names the statuses that need the user', () => {
    expect(calendarNeedsAttention('not_granted')).toBe(true)
    expect(calendarNeedsAttention('unconfirmed')).toBe(true)
    expect(calendarNeedsAttention('active')).toBe(false)
    expect(calendarNeedsAttention('unsupported')).toBe(false)
    expect(calendarStatusLabel('not_granted')).toBe('Calendars not allowed')
    expect(calendarStatusLabel('unknown')).toBeNull()
  })
})
