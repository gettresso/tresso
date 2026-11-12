import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import SettingsAccountsView from '../SettingsAccountsView.vue'

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('SettingsAccountsView', () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  let connectError: string | null
  let answer: Record<string, unknown>

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    connectError = null
    answer = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        requests.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        if (url.pathname === '/api/v1/provider-connections' && method === 'POST') {
          return Response.json({
            provider: 'microsoft',
            connected: connectError === null ? 'acc-m' : null,
            grant: null,
            connectError,
            requested: ['mail'],
            missing: [],
            existing: false,
            approvalUrl: null,
            ...answer,
          })
        }
        if (url.pathname === '/api/v1/mail-accounts') {
          return Response.json([])
        }
        return Response.json({ detail: 'Unexpected request' }, { status: 500 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  async function mountView(path: string) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/accounts', name: 'settings-accounts', component: SettingsAccountsView },
        { path: '/settings/accounts/new', name: 'settings-accounts-new', component: { template: '<div />' } },
      ],
    })
    await router.push(path)
    await router.isReady()

    const wrapper = mount(SettingsAccountsView, { global: { plugins: [router] } })
    return Object.assign(wrapper, { router })
  }

  it('finishes signing in again with its own token, so the user stays signed in to Tresso', async () => {
    const wrapper = await mountView('/settings/accounts?provider=microsoft&state=state-1&code=code-1')
    await settle()

    expect(requests.find((r) => r.path === '/api/v1/provider-connections')?.body).toEqual({ provider: 'microsoft', state: 'state-1', code: 'code-1' })
    expect(wrapper.get('[role="status"]').text()).toBe('Signed in with Microsoft again. The account syncs again.')
    expect(wrapper.router.currentRoute.value.query).toEqual({})
    expect(useAuthStore().isAuthenticated).toBe(true)
  })

  it('does not report success when the calendars were not allowed at the provider', async () => {
    answer = { requested: ['mail', 'calendar'], missing: ['calendar'] }
    const wrapper = await mountView('/settings/accounts?provider=microsoft&state=state-1&code=code-1')
    await settle()

    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.get('p[role="alert"]').text()).toBe('Calendars were not allowed at Microsoft, so they still do not sync. Mail is not affected.')
  })

  it('says the calendars follow once calendar access was allowed', async () => {
    answer = { requested: ['mail', 'calendar'] }
    const wrapper = await mountView('/settings/accounts?provider=microsoft&state=state-1&code=code-1')
    await settle()

    expect(wrapper.get('[role="status"]').text()).toBe('Signed in with Microsoft. Mail and calendars sync; calendars show up within a minute.')
  })

  it("offers the link for the organization's administrator when the organization has to approve Tresso", async () => {
    const approvalUrl = 'https://login.microsoftonline.com/company.example/adminconsent?client_id=c'
    connectError = 'admin_approval_required'
    answer = { requested: ['mail', 'calendar'], approvalUrl }
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const wrapper = await mountView('/settings/accounts?provider=microsoft&state=state-1&code=code-1')
    await settle()

    expect(wrapper.get('p[role="alert"]').text()).toBe('Your organization has to approve Tresso before you can connect this Microsoft account. Ask your IT team, then try again.')
    expect(wrapper.get('.approval-link .url').text()).toBe(approvalUrl)
    await wrapper.get('.approval-link button').trigger('click')
    await settle()

    expect(writeText).toHaveBeenCalledWith(approvalUrl)
    expect(wrapper.get('.approval-link button').text()).toBe('Copied')
  })

  it('says why signing in again did not work', async () => {
    connectError = 'wrong_account'
    const wrapper = await mountView('/settings/accounts?provider=microsoft&state=state-1&code=code-1')
    await settle()

    expect(wrapper.get('p[role="alert"]').text()).toBe('You signed in with a different Microsoft account than this one. Sign in again with the address of this account.')
  })
})
