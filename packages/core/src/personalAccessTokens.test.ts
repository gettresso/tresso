import { describe, expect, it } from 'vitest'
import { CHAT_SCOPES, PERSONAL_ACCESS_TOKEN_SCOPES, personalAccessTokenScopeLabel, personalAccessTokenStatus } from './personalAccessTokens'
import { USER_SCOPES } from './oauth'

describe('personal access tokens', () => {
  it('offers user scopes only, without the reserved ones', () => {
    const offered = PERSONAL_ACCESS_TOKEN_SCOPES.map((scope) => scope.value)
    const known: readonly string[] = [...USER_SCOPES, ...CHAT_SCOPES]

    expect(offered.every((scope) => known.includes(scope))).toBe(true)
    expect(offered).not.toContain('teams:read')
    expect(offered).not.toContain('teams:write')
    expect(offered).not.toContain('webhooks:manage')
    expect(offered.some((scope) => scope.startsWith('sync:'))).toBe(false)
    expect(new Set(offered).size).toBe(offered.length)
  })

  it('offers the WhatsApp scopes apart from mail, which our own apps never ask for', () => {
    const offered = PERSONAL_ACCESS_TOKEN_SCOPES.map((scope) => scope.value)

    expect(offered).toContain('chat:read')
    expect(offered).toContain('chat:send')
    expect(USER_SCOPES as readonly string[]).not.toContain('chat:read')
    expect(USER_SCOPES as readonly string[]).not.toContain('chat:send')
    expect(personalAccessTokenScopeLabel('chat:read')).toBe('Read your WhatsApp chats')
    expect(personalAccessTokenScopeLabel('chat:send')).toBe('Send WhatsApp messages as you')
  })

  it('names scopes in plain words and keeps unknown ones as they are', () => {
    expect(personalAccessTokenScopeLabel('mail:read')).toBe('Read mail')
    expect(personalAccessTokenScopeLabel('future:scope')).toBe('future:scope')
  })

  it('tells active, expired and revoked tokens apart', () => {
    const now = new Date('2026-11-03T12:00:00Z')

    expect(personalAccessTokenStatus({ expiresAt: '2026-12-01T00:00:00+00:00', revokedAt: null }, now)).toBe('active')
    expect(personalAccessTokenStatus({ expiresAt: '2026-11-03T12:00:00+00:00', revokedAt: null }, now)).toBe('expired')
    expect(personalAccessTokenStatus({ expiresAt: '2026-12-01T00:00:00+00:00', revokedAt: '2026-11-02T00:00:00+00:00' }, now)).toBe('revoked')
  })
})
