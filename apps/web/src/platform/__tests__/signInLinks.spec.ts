import { describe, expect, it } from 'vitest'
import { desktopLinkRoute, signInRoute } from '../signInLinks'

const REDIRECT = 'tresso://auth/callback'

describe('signInRoute', () => {
  it('routes a sign-in result to the callback screen with its parameters', () => {
    expect(signInRoute(`${REDIRECT}?code=abc&state=xyz`, REDIRECT)).toEqual({ name: 'auth-callback', query: { code: 'abc', state: 'xyz' } })
  })

  it('keeps an error the authorization server sent back', () => {
    expect(signInRoute(`${REDIRECT}?error=access_denied&error_description=Denied%20by%20you&state=xyz`, REDIRECT)).toEqual({
      name: 'auth-callback',
      query: { error: 'access_denied', error_description: 'Denied by you', state: 'xyz' },
    })
  })

  it('routes the answer to connecting a mail account to the page it started on, without its next', () => {
    expect(signInRoute(`${REDIRECT}?next=%2Fsettings%2Faccounts%2Fnew&provider=google&state=xyz&code=abc`, REDIRECT)).toEqual({
      name: 'settings-accounts-new',
      query: { provider: 'google', state: 'xyz', code: 'abc' },
    })
    expect(signInRoute(`${REDIRECT}?next=%2Fsettings%2Faccounts&provider=microsoft&connectError=expired`, REDIRECT)).toEqual({
      name: 'settings-accounts',
      query: { provider: 'microsoft', connectError: 'expired' },
    })
  })

  it('ignores a next that is not a page connecting a mail account comes back to', () => {
    expect(signInRoute(`${REDIRECT}?next=%2Fsettings%2Faccess-tokens&provider=google&state=xyz&code=abc`, REDIRECT)).toBeNull()
    expect(signInRoute(`${REDIRECT}?next=https%3A%2F%2Fevil.example%2F&provider=google&state=xyz`, REDIRECT)).toBeNull()
    expect(signInRoute(`${REDIRECT}?next=toString&provider=google&state=xyz`, REDIRECT)).toBeNull()
  })

  it('ignores links that are not this app\'s redirect URI', () => {
    expect(signInRoute('tresso://compose?to=kim@example.com', REDIRECT)).toBeNull()
    expect(signInRoute('tresso://auth/callback-other?code=abc', REDIRECT)).toBeNull()
    expect(signInRoute('https://evil.example/auth/callback?code=abc', REDIRECT)).toBeNull()
  })
})

describe('desktopLinkRoute', () => {
  it('routes a sign-in answer to the callback screen while a sign-in is under way', () => {
    expect(desktopLinkRoute(`${REDIRECT}?code=abc&state=xyz`, REDIRECT, true)).toEqual({ name: 'auth-callback', query: { code: 'abc', state: 'xyz' } })
  })

  it('ignores a sign-in answer when no sign-in is under way, instead of showing a failed sign-in', () => {
    expect(desktopLinkRoute(`${REDIRECT}?code=abc&state=xyz`, REDIRECT, false)).toBeNull()
    expect(desktopLinkRoute(`${REDIRECT}?error=access_denied&state=xyz`, REDIRECT, false)).toBeNull()
  })

  it('still routes the answer to connecting a mail account, which keeps its own sign-in state', () => {
    expect(desktopLinkRoute(`${REDIRECT}?next=%2Fsettings%2Faccounts&provider=google&state=xyz&code=abc`, REDIRECT, false)).toEqual({
      name: 'settings-accounts',
      query: { provider: 'google', state: 'xyz', code: 'abc' },
    })
  })
})
