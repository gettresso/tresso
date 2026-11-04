import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
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

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    connectError = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        requests.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        if (url.pathname === '/api/v1/provider-connections' && method === 'POST') {
          return Response.json({ provider: 'microsoft', connected: connectError === null ? 'acc-m' : null, grant: null, connectError })
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
    expect(sessionStorage.getItem('auth.tokens')).not.toBeNull()
  })

  it('says why signing in again did not work', async () => {
    connectError = 'wrong_account'
    const wrapper = await mountView('/settings/accounts?provider=microsoft&state=state-1&code=code-1')
    await settle()

    expect(wrapper.get('p[role="alert"]').text()).toBe('You signed in with a different Microsoft account than this one. Sign in again with the address of this account.')
  })
})
