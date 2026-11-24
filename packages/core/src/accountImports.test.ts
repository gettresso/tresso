import { describe, expect, it } from 'vitest'
import fixture from '../../../apps/api/tests/Fixtures/import-addresses.json'
import { importAddress, importOrder, importRoute, importServers, nextImportRow, readPastedAddresses, type ImportEntryState, type ImportRoute } from './accountImports'
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

describe('readPastedAddresses', () => {
  it('reads one address per line, or separated by commas, semicolons or spaces', () => {
    const read = readPastedAddresses('kim@example.com\nAnna@Example.com, bob@example.com;  lisa@example.com \n\n', [])

    expect(read.toAdd).toEqual(['kim@example.com', 'anna@example.com', 'bob@example.com', 'lisa@example.com'])
    expect(read.total).toBe(4)
    expect(read.issues).toEqual([])
  })

  it('names what needs a look with its line: not valid, listed twice, already connected', () => {
    const read = readPastedAddresses('kim@company.example\njeroen.smit.company.example\nanna@company.example\nanna@company\nANNA@company.example, sales@company.example', ['kim@company.example'])

    expect(read.issues).toEqual([
      { kind: 'connected', address: 'kim@company.example', line: 1 },
      { kind: 'invalid', address: 'jeroen.smit.company.example', line: 2, noAt: true },
      { kind: 'invalid', address: 'anna@company', line: 4, noAt: false },
      { kind: 'twice', address: 'ANNA@company.example', line: 5, firstLine: 3 },
    ])
    expect(read.toAdd).toEqual(['anna@company.example', 'sales@company.example'])
    expect([read.total, read.already, read.invalid, read.twice]).toEqual([6, 1, 2, 1])
  })

  it('strips <>, quotes, mailto: and a dot ending a sentence, and reads "Name <address>" as the address', () => {
    const read = readPastedAddresses('<kim@company.example>\r\n"anna@company.example"\rmailto:bob@company.example, lisa@company.example.\nKim Visser <kim.visser@company.example>; \'eva@company.example\'', [])

    expect(read.toAdd).toEqual(['kim@company.example', 'anna@company.example', 'bob@company.example', 'lisa@company.example', 'kim.visser@company.example', 'eva@company.example'])
    expect(read.issues).toEqual([])
    expect(readPastedAddresses('a@company.example\r\nnope', []).issues).toEqual([{ kind: 'invalid', address: 'nope', line: 2, noAt: true }])
  })

  it('counts more than 50 all the same', () => {
    const read = readPastedAddresses(Array.from({ length: 60 }, (_, i) => `p${i}@company.example`).join('\n'), [])

    expect(read.toAdd).toHaveLength(60)
    expect(read.total).toBe(60)
  })

  it('agrees with the API on what is an address (the shared cases, as a list made in Tresso)', () => {
    for (const { input, firstParty } of fixture.cases) {
      expect(importAddress(input), input).toBe(firstParty)
    }
  })

  it('takes the addresses an app list leaves out for their letters, since the paste step is the user\'s own', () => {
    const lookalikes = fixture.cases.filter((entry) => entry.lookalike)
    expect(lookalikes.map((entry) => entry.input)).toContain('kim@gmaіl.com')
    for (const { input } of lookalikes) {
      expect(importAddress(input), input).not.toBeNull()
    }
  })

  it('counts a connected address given twice as listed twice', () => {
    const read = readPastedAddresses('kim@company.example\nkim@company.example', ['kim@company.example'])

    expect(read.issues.map((issue) => issue.kind)).toEqual(['connected', 'twice'])
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

describe('importOrder and nextImportRow', () => {
  const google: ImportRoute = { kind: 'oauth', provider: 'google' }
  const microsoft: ImportRoute = { kind: 'oauth', provider: 'microsoft' }
  const password: ImportRoute = { kind: 'password', service: null }
  const row = (id: string, route: ImportRoute, state: ImportEntryState = 'todo') => ({ id, route, state })

  it('groups rows of one provider, Microsoft first, then Google, then passwords, keeping the list order', () => {
    const rows = [row('a', password), row('b', google), row('c', microsoft), row('d', google), row('e', microsoft)]

    expect(importOrder(rows).map((r) => r.id)).toEqual(['c', 'e', 'b', 'd', 'a'])
  })

  it('offers the next row still to do, password rows included, wrapping around, and failed ones last', () => {
    const rows = importOrder([row('m1', microsoft, 'connected'), row('m2', microsoft), row('g1', google, 'skipped'), row('g2', google, 'failed'), row('p', password), row('q', password, 'already_connected')])

    expect(nextImportRow(rows, null)?.id).toBe('m2')
    expect(nextImportRow(rows, 'm2')?.id).toBe('p')
    expect(nextImportRow(rows, 'p')?.id).toBe('m2')
    expect(nextImportRow([row('g2', google, 'failed')], null)).toBeNull()
    expect(nextImportRow([row('g2', google, 'failed'), row('g3', google, 'failed')], 'g2', true)?.id).toBe('g3')
  })
})
