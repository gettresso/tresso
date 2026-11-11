import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { TokenSet } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'
import { useAccountsStore } from '@/stores/accounts'
import { useBriefStore } from '@/stores/brief'
import { useConnectedAppsStore } from '@/stores/connectedApps'
import { usePersonalAccessTokensStore } from '@/stores/personalAccessTokens'
import { useSearchStore } from '@/stores/search'

const ANNA: TokenSet = { accessToken: 'anna', refreshToken: null, expiresAt: Date.now() + 3_600_000 }
const BEN: TokenSet = { accessToken: 'ben', refreshToken: null, expiresAt: Date.now() + 3_600_000 }

/** What the API answers per path for each user's token; a path left out waits until the test answers it. */
type Answers = Record<string, Record<string, unknown>>

function stubApi(answers: Answers): Map<string, (body: unknown) => void> {
  const waiting = new Map<string, (body: unknown) => void>()
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const token = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '') ?? ''
      const answer = answers[token]?.[url.pathname]
      if (answer !== undefined) {
        return Promise.resolve(Response.json(answer))
      }
      return new Promise<Response>((resolve) => waiting.set(`${token} ${url.pathname}`, (body) => resolve(Response.json(body))))
    }),
  )
  return waiting
}

describe('stores that load through the API, when another user signs in without a reload (the desktop app)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('location', { ...window.location, assign: vi.fn<(url: string) => void>() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('show nothing of the previous user once the session ends', async () => {
    stubApi({
      anna: {
        '/api/v1/mail-accounts': [{ id: 'anna-account', email: 'anna@example.com' }],
        '/api/v1/connected-apps': [{ id: 'anna-app' }],
        '/api/v1/personal-access-tokens': [{ id: 'anna-token' }],
        '/api/v1/daily-brief-settings': { enabled: true },
        '/api/v1/search': { messages: [{ id: 'anna-hit' }], totalHits: 1, page: 1, totalPages: 1 },
      },
    })
    const auth = useAuthStore()
    auth.tokens = ANNA
    const accounts = useAccountsStore()
    const apps = useConnectedAppsStore()
    const tokens = usePersonalAccessTokensStore()
    const brief = useBriefStore()
    const search = useSearchStore()
    await Promise.all([accounts.load(), apps.load(), tokens.load(), brief.load(), search.run('invoice')])
    expect(accounts.accounts).toHaveLength(1)

    await auth.signOut()

    expect(accounts.accounts).toEqual([])
    expect(accounts.loaded).toBe(false)
    expect(apps.apps).toEqual([])
    expect(tokens.tokens).toEqual([])
    expect(brief.settings).toBeNull()
    expect(search.hits).toEqual([])
    expect(search.query).toBe('')
  })

  it('drop an answer for the previous user that arrives after the next one signed in', async () => {
    const waiting = stubApi({})
    const auth = useAuthStore()
    auth.tokens = ANNA
    const accounts = useAccountsStore()
    const loading = accounts.load()
    await vi.waitFor(() => expect(waiting.has('anna /api/v1/mail-accounts')).toBe(true))

    await auth.signOut()
    auth.tokens = BEN
    waiting.get('anna /api/v1/mail-accounts')!([{ id: 'anna-account', email: 'anna@example.com' }])

    await expect(loading).rejects.toThrow('Signed out while this request was under way.')
    expect(accounts.accounts).toEqual([])
    expect(accounts.loaded).toBe(false)
  })
})
