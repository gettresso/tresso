import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { MailAccountImport } from '@tresso/core'
import { ApiError } from '@/api/errors'
import { useAuthStore } from '@/stores/auth'
import { useAccountImportsStore } from '../accountImports'

const LIST: MailAccountImport = {
  id: 'list-1',
  entries: [{ id: 'e1', address: 'kim@gmail.example', provider: 'google', state: 'todo', failure: null, reason: null, mailAccountId: null, accountStatus: null }],
  progress: { todo: 1, connected: 0, failed: 0, skipped: 0 },
  createdBy: 'Claude',
  pageUrl: 'http://localhost:5173/settings/accounts/import/list-1',
  createdAt: '2026-11-24T10:00:00+00:00',
  expiresAt: '2026-11-25T10:00:00+00:00',
  leftOut: [],
}

describe('import lists store', () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  let respond: (method: string, path: string) => Response

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    respond = (method, path) => (method === 'DELETE' ? new Response(null, { status: 204 }) : path.endsWith('/mail-account-imports') && method === 'GET' ? Response.json([LIST]) : Response.json(LIST))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const path = new URL(String(input)).pathname
        requests.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        return respond(method, path)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('makes a list of the addresses and keeps it as the current one', async () => {
    const store = useAccountImportsStore()

    await store.create([{ address: 'kim@gmail.example' }, { address: 'anna@partner.example', provider: 'imap' }])

    expect(requests).toEqual([{ method: 'POST', path: '/api/v1/mail-account-imports', body: { entries: [{ address: 'kim@gmail.example' }, { address: 'anna@partner.example', provider: 'imap' }] } }])
    expect(store.current).toEqual(LIST)
    expect(store.lists).toEqual([LIST])
  })

  it('reads, marks and deletes a list', async () => {
    const store = useAccountImportsStore()

    await store.load('list-1')
    await store.mark('list-1', 'e1', 'failed', 'password_refused')
    await store.mark('list-1', 'e1', 'skipped')
    await store.remove('list-1')

    expect(requests).toEqual([
      { method: 'GET', path: '/api/v1/mail-account-imports/list-1', body: undefined },
      { method: 'POST', path: '/api/v1/mail-account-imports/list-1/entry-states', body: { entryId: 'e1', state: 'failed', failure: 'password_refused' } },
      { method: 'POST', path: '/api/v1/mail-account-imports/list-1/entry-states', body: { entryId: 'e1', state: 'skipped' } },
      { method: 'DELETE', path: '/api/v1/mail-account-imports/list-1', body: undefined },
    ])
    expect(store.current).toBeNull()
  })

  it('says a list of another user is not found, and keeps nothing of it', async () => {
    respond = () => Response.json({ detail: 'Import list not found.' }, { status: 404 })
    const store = useAccountImportsStore()

    await expect(store.load('list-of-lisa')).rejects.toBeInstanceOf(ApiError)
    expect(store.current).toBeNull()
  })

  it('drops every list when another user signs in', async () => {
    const store = useAccountImportsStore()
    await store.loadLists()
    await store.load('list-1')

    useAuthStore().generation++
    await Promise.resolve()

    expect(store.lists).toEqual([])
    expect(store.current).toBeNull()
  })
})
