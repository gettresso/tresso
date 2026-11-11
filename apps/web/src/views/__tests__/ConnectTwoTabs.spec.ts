import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { MailAccount, ProviderConnection } from '@tresso/core'
import { handOver, reportSignedOutReturn } from '@/components/connect/connectChannel'
import AddAccountView from '../AddAccountView.vue'

/**
 * The web sign-in at Google or Microsoft in two tabs of one browser: the dialog opens the provider's page in a new
 * tab; the provider sends that tab back to /settings/accounts/new, which finishes the sign-in and hands the outcome to
 * the waiting tab. Both tabs share localStorage and a BroadcastChannel, as tabs of one browser do.
 */
const gmail: MailAccount = {
  id: 'acc-g',
  emailAddress: 'kim@gmail.com',
  displayName: 'Kim Visser',
  provider: 'gmail',
  status: 'active',
  statusDetail: null,
  username: null,
  imap: null,
  smtp: null,
  calendarUrl: null,
  calendarStatus: 'unknown',
  calendarStatusDetail: null,
  lastSyncedAt: null,
  createdAt: '2026-10-19T08:00:00+00:00',
  defaultSignatureId: null,
}

const connected: ProviderConnection = { provider: 'google', connected: 'acc-g', grant: null, connectError: null, requested: ['mail', 'calendar'], missing: [], existing: false, approvalUrl: null }

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('connecting through the provider in another tab', () => {
  const requests: { method: string; path: string }[] = []
  const opened = vi.fn<(url: string, target?: string, features?: string) => null>()
  const close = vi.fn<() => void>()
  let expiresIn: number

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
    vi.stubGlobal('open', opened)
    vi.spyOn(window, 'close').mockImplementation(close)
    requests.length = 0
    opened.mockReset()
    close.mockReset()
    expiresIn = 900_000
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        requests.push({ method, path: url.pathname })
        if (url.pathname === '/api/v1/mail-server-settings') {
          return Response.json({ emailAddress: 'kim@gmail.com', found: false, source: null, username: null, imap: null, smtp: null, authentication: [], provider: 'google' })
        }
        if (url.pathname === '/api/v1/oauth-providers') return Response.json([{ id: 'google', name: 'Google', features: ['mail', 'calendar'] }])
        if (url.pathname === '/api/v1/server-info') return Response.json({ product: 'tresso-server', apiVersion: 1, billing: false, trialDays: 0, allowUnencryptedMailServers: false })
        if (url.pathname === '/api/v1/provider-authorizations') {
          return Response.json({ authorizationUrl: 'https://accounts.google.example/auth?state=state-1', provider: 'google', expiresAt: new Date(Date.now() + expiresIn).toISOString() }, { status: 201 })
        }
        if (url.pathname === '/api/v1/provider-connections') return Response.json(connected)
        if (url.pathname === '/api/v1/mail-accounts') return Response.json([])
        if (url.pathname === '/api/v1/mail-accounts/acc-g') return Response.json(gmail)
        return Response.json({ detail: 'Unexpected request' }, { status: 500 })
      }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  /** One tab: its own router and stores, the browser's storage and channel. */
  async function tab(path: string) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/accounts', name: 'settings-accounts', component: { template: '<div />' } },
        { path: '/settings/accounts/new', name: 'settings-accounts-new', component: AddAccountView },
        { path: '/accounts/:accountId', name: 'account', component: { template: '<div />' } },
      ],
    })
    await router.push(path)
    await router.isReady()
    const wrapper = mount(AddAccountView, { global: { plugins: [router, pinia] } })
    await settle()
    return wrapper
  }

  function heading(wrapper: VueWrapper): string {
    return wrapper.get('dialog h1').text()
  }

  async function toSignInStep(): Promise<VueWrapper> {
    const waiting = await tab('/settings/accounts/new')
    await waiting.get('dialog input[type="email"]').setValue('kim@gmail.com')
    await waiting.get('dialog form').trigger('submit')
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 350))
    await settle()
    return waiting
  }

  async function proceed(waiting: VueWrapper): Promise<void> {
    await waiting
      .findAll('dialog button')
      .find((button) => button.text().trim() === 'Proceed in browser')!
      .trigger('click')
    await settle()
  }

  async function startWaiting(): Promise<VueWrapper> {
    const waiting = await toSignInStep()
    await proceed(waiting)
    expect(heading(waiting)).toBe('Finish in your browser')
    return waiting
  }

  it('finishes in the tab the provider sent back and shows it in the tab that waits, which closes the other', async () => {
    const waiting = await startWaiting()

    const returned = await tab('/settings/accounts/new?provider=google&state=state-1&code=code-1')
    await vi.waitFor(() => expect(heading(waiting)).toBe("You're connected"))

    expect(requests.filter((r) => r.path === '/api/v1/provider-connections')).toHaveLength(1)
    expect(close).toHaveBeenCalledOnce()
    expect(returned.find('dialog').exists()).toBe(true)
  })

  it('takes an outcome that came before it listened for it, from storage', async () => {
    const waiting = await toSignInStep()
    // The provider's tab reported before this tab started waiting for the state: no tab took the message.
    expect(await handOver('state-1', { kind: 'result', result: connected }, 10)).toBe(false)

    await proceed(waiting)

    await vi.waitFor(() => expect(heading(waiting)).toBe("You're connected"))
  })

  it('says so when the provider sent back a tab that is signed out of Tresso', async () => {
    const waiting = await startWaiting()

    expect(reportSignedOutReturn({ provider: 'google', state: 'state-1', code: 'code-1' })).toBe(true)
    await vi.waitFor(() => expect(heading(waiting)).toBe('Sign-in came back signed out'))
    expect(waiting.get('dialog').text()).toContain('nothing was connected')
    expect(waiting.findAll('dialog button').some((button) => button.text().trim() === 'Try again')).toBe(true)
  })

  it('stops waiting once the sign-in expired', async () => {
    expiresIn = 400
    const waiting = await startWaiting()

    await vi.waitFor(() => expect(heading(waiting)).toBe('No answer from Google'), { timeout: 2000 })
    expect(waiting.findAll('dialog button').some((button) => button.text().trim() === 'Try again')).toBe(true)
  })

  it('does not finish a sign-in the waiting tab cancelled', async () => {
    const waiting = await startWaiting()
    await waiting
      .findAll('dialog button')
      .find((button) => button.text().trim() === 'Cancel')!
      .trigger('click')
    await settle()

    const returned = await tab('/settings/accounts/new?provider=google&state=state-1&code=code-1')

    expect(requests.some((r) => r.path === '/api/v1/provider-connections')).toBe(false)
    expect(heading(returned)).toBe('Sign-in was cancelled')
  })
})
