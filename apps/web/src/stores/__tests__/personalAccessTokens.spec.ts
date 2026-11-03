import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CreatedPersonalAccessToken, PersonalAccessToken } from '@tresso/core'
import { ApiError } from '@/api/errors'
import { usePersonalAccessTokensStore } from '../personalAccessTokens'

const listed: PersonalAccessToken = {
  id: 'pat-1',
  name: 'Backup script',
  prefix: 'tresso_pat_Xk3f9a',
  scopes: ['mail:read'],
  createdAt: '2026-11-01T08:00:00+00:00',
  expiresAt: '2027-01-30T08:00:00+00:00',
  lastUsedAt: null,
  revokedAt: null,
}

const created: CreatedPersonalAccessToken = {
  id: 'pat-2',
  name: 'Calendar export',
  prefix: 'tresso_pat_Ab12Cd',
  scopes: ['calendar:read'],
  createdAt: '2026-11-03T08:00:00+00:00',
  expiresAt: '2026-12-03T08:00:00+00:00',
  token: 'tresso_pat_Ab12Cd-secret-part-of-the-token-for-tests',
}

describe('personal access tokens store', () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  let respond: (method: string) => Response

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    respond = (method) => {
      if (method === 'DELETE') return new Response(null, { status: 204 })
      if (method === 'POST') return new Response(JSON.stringify(created), { status: 201 })
      return new Response(JSON.stringify([listed]))
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        requests.push({ method, path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        return respond(method)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('loads the tokens from the API', async () => {
    const store = usePersonalAccessTokensStore()

    expect(await store.load()).toEqual([listed])
    expect(store.tokens).toEqual([listed])
    expect(requests).toEqual([{ method: 'GET', path: '/api/v1/personal-access-tokens', body: undefined }])
  })

  it('returns the secret of a new token but keeps only the token itself', async () => {
    const store = usePersonalAccessTokensStore()
    await store.load()

    const result = await store.create({ name: 'Calendar export', scopes: ['calendar:read'], expiresInDays: 30 })

    expect(result.token).toBe(created.token)
    expect(requests[1]).toEqual({ method: 'POST', path: '/api/v1/personal-access-tokens', body: { name: 'Calendar export', scopes: ['calendar:read'], expiresInDays: 30 } })
    expect(store.tokens.map((t) => t.id)).toEqual(['pat-2', 'pat-1'])
    expect(store.tokens[0]).toMatchObject({ lastUsedAt: null, revokedAt: null })
    expect(JSON.stringify(store.tokens)).not.toContain(created.token)
  })

  it('revokes a token and reloads the list', async () => {
    const store = usePersonalAccessTokensStore()

    await store.revoke('pat-1')

    expect(requests).toEqual([
      { method: 'DELETE', path: '/api/v1/personal-access-tokens/pat-1', body: undefined },
      { method: 'GET', path: '/api/v1/personal-access-tokens', body: undefined },
    ])
  })

  it('passes on what the API refuses', async () => {
    respond = () => new Response(JSON.stringify({ detail: 'scopes[0]: no', violations: [{ propertyPath: 'scopes[0]', message: 'A personal access token cannot have this permission.' }] }), { status: 422 })

    await expect(usePersonalAccessTokensStore().create({ name: 'Sync', scopes: ['sync:lease'], expiresInDays: 90 })).rejects.toBeInstanceOf(ApiError)
    expect(usePersonalAccessTokensStore().tokens).toEqual([])
  })
})
