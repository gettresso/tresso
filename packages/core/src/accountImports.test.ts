import { describe, expect, it } from 'vitest'
import { importOrder, importRoute, importServers, nextProviderRow, parseAddressList, type ImportEntryState, type ImportRoute } from './accountImports'
import type { SuggestedServerSettings } from './accounts'

function suggestion(provider: SuggestedServerSettings['provider'], found = provider !== null): SuggestedServerSettings {
  return {
    emailAddress: 'kim@example.com',
    found,
    source: found ? 'ispdb' : null,
    provider,
    imap: found ? { host: 'imap.example.com', port: 993, security: 'tls' } : null,
    smtp: found ? { host: 'smtp.example.com', port: 465, security: 'tls' } : null,
    username: found ? 'kim@example.com' : null,
    authentication: ['password'],
  }
}

describe('parseAddressList', () => {
  it('reads one address per line, or separated by commas or semicolons', () => {
    expect(parseAddressList('kim@example.com\nanna@example.com, bob@example.com;  lisa@example.com \r\n')).toEqual(['kim@example.com', 'anna@example.com', 'bob@example.com', 'lisa@example.com'])
  })

  it('reduces "Name <address>" and mailto: to the address and drops empty parts', () => {
    expect(parseAddressList('Kim Visser <kim@example.com>,,\n\nmailto:anna@example.com')).toEqual(['kim@example.com', 'anna@example.com'])
  })

  it('keeps what is not an address, and doubles, for the API to report per address', () => {
    expect(parseAddressList('kim@example.com, not an address, kim@example.com')).toEqual(['kim@example.com', 'not an address', 'kim@example.com'])
  })
})

describe('importRoute', () => {
  const both: ('google' | 'microsoft')[] = ['google', 'microsoft']

  it('goes by what the lookup found, as the single add account flow does', () => {
    expect(importRoute(suggestion('google'), 'imap', both)).toEqual({ kind: 'oauth', provider: 'google' })
    expect(importRoute(suggestion('m365'), null, both)).toEqual({ kind: 'oauth', provider: 'microsoft' })
    expect(importRoute(suggestion('outlook'), 'google', both)).toEqual({ kind: 'oauth', provider: 'microsoft' })
    expect(importRoute(suggestion('icloud'), null, both)).toEqual({ kind: 'password', service: 'icloud' })
    expect(importRoute(suggestion(null, true), 'google', both)).toEqual({ kind: 'password', service: null })
  })

  it('uses the hint only when the lookup found nothing', () => {
    expect(importRoute(suggestion(null, false), 'google', both)).toEqual({ kind: 'oauth', provider: 'google' })
    expect(importRoute(null, 'microsoft', both)).toEqual({ kind: 'oauth', provider: 'microsoft' })
    expect(importRoute(suggestion(null, false), 'imap', both)).toEqual({ kind: 'password', service: null })
    expect(importRoute(suggestion(null, false), null, both)).toEqual({ kind: 'password', service: null })
  })

  it('falls back to the server form for a provider this server cannot sign in with', () => {
    expect(importRoute(suggestion('google'), null, ['microsoft'])).toEqual({ kind: 'password', service: null })
    expect(importRoute(null, 'google', [])).toEqual({ kind: 'password', service: null })
  })
})

describe('importServers', () => {
  it('starts from the found servers, else those of iCloud and Yahoo, else none', () => {
    expect(importServers(suggestion(null, true), { kind: 'password', service: null })?.imap.host).toBe('imap.example.com')
    expect(importServers(suggestion('icloud', false), { kind: 'password', service: 'icloud' })?.imap.host).toBe('imap.mail.me.com')
    expect(importServers(null, { kind: 'password', service: null })).toBeNull()
  })
})

describe('importOrder and nextProviderRow', () => {
  const google: ImportRoute = { kind: 'oauth', provider: 'google' }
  const microsoft: ImportRoute = { kind: 'oauth', provider: 'microsoft' }
  const password: ImportRoute = { kind: 'password', service: null }
  const row = (id: string, route: ImportRoute, state: ImportEntryState = 'todo') => ({ id, route, state })

  it('groups rows of one provider, Google first, then Microsoft, then passwords, keeping the list order', () => {
    const rows = [row('a', password), row('b', microsoft), row('c', google), row('d', microsoft), row('e', google)]

    expect(importOrder(rows).map((r) => r.id)).toEqual(['c', 'e', 'b', 'd', 'a'])
  })

  it('offers the next provider row still to do, wrapping around, and never a password row', () => {
    const rows = importOrder([row('g1', google, 'connected'), row('g2', google), row('m1', microsoft, 'skipped'), row('m2', microsoft, 'failed'), row('p', password)])

    expect(nextProviderRow(rows, null)?.id).toBe('g2')
    expect(nextProviderRow(rows, 'g2')).toBeNull()
    expect(nextProviderRow(rows, 'g2', true)?.id).toBe('m2')
    expect(nextProviderRow(rows, 'm2', true)?.id).toBe('g2')
  })
})
