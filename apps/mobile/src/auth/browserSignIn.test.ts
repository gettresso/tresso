import { describe, expect, it, vi } from 'vitest'
import type { AuthSessionResult } from 'expo-auth-session'

vi.mock('expo-auth-session', () => ({ AuthRequest: class {}, Prompt: { Login: 'login' } }))
vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://api.example.test')
vi.stubEnv('EXPO_PUBLIC_OAUTH_CLIENT_ID', 'mobile')
vi.stubEnv('EXPO_PUBLIC_NATIVE_REDIRECT_URI', 'tresso://auth/callback')

const { authorizationCode, authRequestConfig } = await import('./browserSignIn')

function completed(type: 'success' | 'error', params: Record<string, string>, error: { code: string; description?: string } | null = null): AuthSessionResult {
  return { type, params, errorCode: null, error, authentication: null, url: 'tresso://auth/callback' } as AuthSessionResult
}

describe('authorizationCode', () => {
  it('returns the code with the verifier that goes with it', () => {
    expect(authorizationCode(completed('success', { code: 'abc', state: 'xyz' }), 'verifier')).toEqual({ code: 'abc', codeVerifier: 'verifier' })
  })

  it('returns nothing when the user closed the browser', () => {
    expect(authorizationCode({ type: 'cancel' }, 'verifier')).toBeNull()
    expect(authorizationCode({ type: 'dismiss' }, 'verifier')).toBeNull()
  })

  it('explains what went wrong', () => {
    expect(() => authorizationCode(completed('error', { error: 'access_denied' }, { code: 'access_denied', description: 'The user denied access.' }), 'v')).toThrow('The user denied access.')
    expect(() => authorizationCode(completed('error', { error: 'access_denied', error_description: 'Denied.' }), 'v')).toThrow('Denied.')
    expect(() => authorizationCode({ type: 'locked' }, 'v')).toThrow('Another sign-in is already open.')
  })

  it('refuses a success without a code or verifier', () => {
    expect(() => authorizationCode(completed('success', { state: 'xyz' }), 'verifier')).toThrow('no authorization code')
    expect(() => authorizationCode(completed('success', { code: 'abc' }), undefined)).toThrow('no authorization code')
  })
})

describe('authRequestConfig', () => {
  it('asks for the password again when the user signed out', () => {
    expect(authRequestConfig({ promptLogin: true })).toMatchObject({ clientId: 'mobile', redirectUri: 'tresso://auth/callback', usePKCE: true, prompt: 'login' })
  })

  it('leaves the prompt to the server otherwise', () => {
    expect(authRequestConfig({ promptLogin: false })).not.toHaveProperty('prompt')
  })
})
