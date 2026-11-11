import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import type { MailAccount } from '@tresso/core'
import { signInRoute } from '@/platform/signInLinks'
import { useAuthStore } from '@/stores/auth'
import AddAccountView from '../AddAccountView.vue'
import SettingsAccountsView from '../SettingsAccountsView.vue'
import ProviderAccountForm from '@/components/ProviderAccountForm.vue'

/**
 * Connecting Gmail or Microsoft 365 in the desktop app. Its window must never leave for the provider: the callback
 * would then take it to the web app, another origin without the desktop app's tokens, and the user looked signed out.
 */
const desktop = vi.hoisted(() => ({
  keychain: null as string | null,
  opened: [] as string[],
}))

vi.mock('@/platform/desktop', () => ({
  isDesktop: true,
  loadKeychainTokens: async () => desktop.keychain,
  saveKeychainTokens: async (tokens: string) => {
    desktop.keychain = tokens
  },
  clearKeychainTokens: async () => {
    desktop.keychain = null
  },
  openInBrowser: async (url: string) => {
    desktop.opened.push(url)
  },
}))

const REDIRECT = 'tresso://auth/callback'
const App = defineComponent({ render: () => h(RouterView) })
const Empty = defineComponent({ render: () => h('div') })
const AUTHORIZATION_URL = 'https://accounts.google.example/o/oauth2/v2/auth?state=s'

const gmail: MailAccount = {
  id: 'acc-g',
  emailAddress: 'kim@gmail.example',
  displayName: 'Kim',
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

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('connecting a provider account in the desktop app', () => {
  const requests: { method: string; path: string; body: unknown; authorization: string | null }[] = []
  const assign = vi.fn<(url: string) => void>()
  const tokens = JSON.stringify({ accessToken: 'desktop-token', refreshToken: 'desktop-refresh', expiresAt: Date.now() + 3_600_000 })

  beforeEach(async () => {
    desktop.keychain = tokens
    desktop.opened.length = 0
    requests.length = 0
    assign.mockReset()
    vi.stubGlobal('location', { ...window.location, assign })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const authorization = new Headers(init?.headers).get('Authorization')
        requests.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization })
        if (url.pathname === '/api/v1/oauth-providers') {
          return Response.json([{ id: 'google', name: 'Google', features: ['mail', 'calendar'] }])
        }
        if (url.pathname === '/api/v1/mail-server-settings') {
          return Response.json({ emailAddress: 'kim@gmail.example', found: false, source: null, username: null, imap: null, smtp: null, authentication: [], provider: 'google' })
        }
        if (url.pathname === '/api/v1/server-info') {
          return Response.json({ product: 'tresso-server', apiVersion: 1, billing: false, trialDays: 0, allowUnencryptedMailServers: false })
        }
        if (url.pathname === '/api/v1/provider-authorizations' && method === 'POST') {
          return Response.json({ authorizationUrl: AUTHORIZATION_URL, provider: 'google', expiresAt: '2026-10-19T08:15:00+00:00' }, { status: 201 })
        }
        if (url.pathname === '/api/v1/provider-connections' && method === 'POST') {
          return Response.json({ provider: 'google', connected: 'acc-g', grant: null, connectError: null, requested: ['mail', 'calendar'], missing: [], existing: false, approvalUrl: null })
        }
        if (url.pathname === '/api/v1/mail-accounts/acc-g') {
          return Response.json(gmail)
        }
        if (url.pathname === '/api/v1/mail-accounts') {
          return Response.json([gmail])
        }
        return Response.json({ detail: 'Unexpected request' }, { status: 500 })
      }),
    )
    setActivePinia(createPinia())
    // As main.ts does before the first screen.
    await useAuthStore().restore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** The last sign-in started at the API. */
  function lastStart() {
    const started = requests.filter((r) => r.path === '/api/v1/provider-authorizations')
    return started[started.length - 1]
  }

  function makeRouter() {
    return createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/accounts', name: 'settings-accounts', component: SettingsAccountsView },
        { path: '/settings/accounts/new', name: 'settings-accounts-new', component: AddAccountView },
        { path: '/accounts/:accountId', name: 'account', component: Empty },
        { path: '/auth/callback', name: 'auth-callback', component: Empty },
      ],
    })
  }

  /** The system browser opens the `tresso://` link the API sent it to, and main.ts routes it. */
  async function openLink(router: ReturnType<typeof makeRouter>, link: string): Promise<void> {
    const route = signInRoute(link, REDIRECT)
    expect(route).not.toBeNull()
    await router.replace(route!)
    await settle()
  }

  it('opens the provider in the system browser, finishes from the link back, and stays signed in', async () => {
    const router = makeRouter()
    await router.push('/settings/accounts/new')
    await router.isReady()
    const wrapper = mount(App, { global: { plugins: [router] } })
    await settle()

    // Another address than the connected one; the provider may still sign in a different account, and the dialog
    // then names the one that was connected.
    await wrapper.get('dialog input[type="email"]').setValue('kim.visser@gmail.example')
    await wrapper.get('dialog form').trigger('submit')
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 350))
    await settle()
    const proceed = wrapper.findAll('dialog button').find((button) => button.text().trim() === 'Proceed in browser')
    expect(proceed).toBeDefined()
    await proceed!.trigger('click')
    await settle()

    expect(lastStart()?.body).toEqual({
      provider: 'google',
      features: ['mail', 'calendar'],
      emailAddress: 'kim.visser@gmail.example',
      returnTo: 'native',
    })
    expect(desktop.opened).toEqual([AUTHORIZATION_URL])
    expect(assign).not.toHaveBeenCalled()
    expect(wrapper.get('dialog h1').text()).toBe('Finish in your browser')

    await openLink(router, `${REDIRECT}?next=%2Fsettings%2Faccounts%2Fnew&provider=google&state=state-1&code=code-1`)

    expect(requests.find((r) => r.path === '/api/v1/provider-connections')).toEqual({
      method: 'POST',
      path: '/api/v1/provider-connections',
      body: { provider: 'google', state: 'state-1', code: 'code-1' },
      authorization: 'Bearer desktop-token',
    })
    expect(router.currentRoute.value.name).toBe('settings-accounts-new')
    expect(router.currentRoute.value.query).toEqual({})
    expect(wrapper.get('dialog h1').text()).toBe("You're connected")
    expect(wrapper.get('dialog').text()).toContain('kim@gmail.example, Google')
    expect(useAuthStore().isAuthenticated).toBe(true)
    expect(desktop.keychain).toBe(tokens)
  })

  it('takes the answer to signing in again to the accounts page, wherever the window is', async () => {
    const router = makeRouter()
    await router.push('/accounts/acc-g')
    await router.isReady()
    const wrapper = mount(App, { global: { plugins: [router] } })

    await openLink(router, `${REDIRECT}?next=%2Fsettings%2Faccounts&provider=google&state=state-2&code=code-2`)

    expect(router.currentRoute.value.name).toBe('settings-accounts')
    expect(requests.find((r) => r.path === '/api/v1/provider-connections')?.body).toEqual({ provider: 'google', state: 'state-2', code: 'code-2' })
    expect(wrapper.get('[role="status"]').text()).toBe('Signed in with Google again. The account syncs again.')
    expect(router.currentRoute.value.query).toEqual({})
    expect(useAuthStore().isAuthenticated).toBe(true)
  })

  it('finishes signing in again when the link arrives while the accounts page is open', async () => {
    const router = makeRouter()
    await router.push('/settings/accounts')
    await router.isReady()
    const wrapper = mount(App, { global: { plugins: [router] } })
    await settle()
    expect(requests.some((r) => r.path === '/api/v1/provider-connections')).toBe(false)

    await openLink(router, `${REDIRECT}?next=%2Fsettings%2Faccounts&provider=google&connectError=expired`)

    expect(wrapper.get('[role="alert"]').text()).toBe('That sign-in took too long or was already used. Try again.')
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('signs an account in again from its settings in the system browser', async () => {
    const wrapper = mount(ProviderAccountForm, { props: { account: { ...gmail, calendarStatus: 'not_granted' }, provider: 'google' } })

    await wrapper.findAll('button').find((button) => button.text() === 'Allow calendar access')!.trigger('click')
    await settle()

    expect(requests.find((r) => r.path === '/api/v1/provider-authorizations')?.body).toEqual({ provider: 'google', features: ['calendar'], mailAccountId: 'acc-g', returnTo: 'native' })
    expect(desktop.opened).toEqual([AUTHORIZATION_URL])
    expect(assign).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Continue in your browser.')
    expect(wrapper.text()).toContain('Sign in with Google again')
  })
})
