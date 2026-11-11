import { describe, expect, it } from 'vitest'
import { accountSchema, manualSchema, providerAccountSchema } from '../accounts'
import { composeSchema } from '../compose'
import { requiredPaths } from '../required'

describe('requiredPaths', () => {
  it('reads required fields, nested ones included, from the schemas', () => {
    expect([...requiredPaths(providerAccountSchema)]).toEqual(['displayName'])
    expect([...requiredPaths(manualSchema('example.com'))]).toEqual(['imap.host', 'imap.port', 'imap.security', 'smtp.host', 'smtp.port', 'smtp.security', 'username', 'password'])
  })

  it('leaves out what may stay empty', () => {
    expect(requiredPaths(accountSchema).has('password')).toBe(false)
    expect(requiredPaths(accountSchema).has('calendarUrl')).toBe(false)
    expect(requiredPaths(composeSchema).has('subject')).toBe(false)
    expect(requiredPaths(composeSchema).has('mailAccountId')).toBe(true)
  })
})
