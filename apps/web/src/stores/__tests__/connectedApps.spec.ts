import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ConnectedApp } from '@tresso/core'
import { ApiError } from '@/api/errors'
import { useConnectedAppsStore } from '../connectedApps'

const claude: ConnectedApp = {
  id: 'consent-1',
  name: 'Claude',
  domains: ['claude.ai'],
  scopes: ['mail:read', 'todos:read'],
  connectedAt: '2026-11-01T08:00:00+00:00',
  lastUsedAt: '2026-11-03T08:00:00+00:00',
}

const inspector: ConnectedApp = {
  id: 'consent-2',
  name: 'MCP Inspector',
  domains: ['localhost'],
  scopes: ['settings:read'],
  connectedAt: '2026-11-02T08:00:00+00:00',
  lastUsedAt: null,
}

describe('connected apps store', () => {
  const requests: { method: string; path: string }[] = []
  let respond: (method: string) => Response

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    respond = (method) => (method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(JSON.stringify([claude, inspector])))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        requests.push({ method, path: new URL(String(input)).pathname })
        return respond(method)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('loads the connected apps from the API', async () => {
    const store = useConnectedAppsStore()

    expect(await store.load()).toEqual([claude, inspector])
    expect(store.apps).toEqual([claude, inspector])
    expect(requests).toEqual([{ method: 'GET', path: '/api/v1/connected-apps' }])
  })

  it('disconnects an app and drops it from the list', async () => {
    const store = useConnectedAppsStore()
    await store.load()

    await store.disconnect('consent-1')

    expect(requests[1]).toEqual({ method: 'DELETE', path: '/api/v1/connected-apps/consent-1' })
    expect(store.apps).toEqual([inspector])
  })

  it('keeps the app when disconnecting fails', async () => {
    const store = useConnectedAppsStore()
    await store.load()
    respond = () => new Response(JSON.stringify({ detail: 'Connected app not found.' }), { status: 404 })

    await expect(store.disconnect('consent-1')).rejects.toBeInstanceOf(ApiError)
    expect(store.apps).toEqual([claude, inspector])
  })
})
