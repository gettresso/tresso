import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { MailAccount, SyncedMailAccount } from '@tresso/core'
import { useMailStore } from '@/stores/mail'
import { useAuthStore } from '@/stores/auth'
import AddAccountView from '../AddAccountView.vue'

const created: MailAccount = {
  id: 'acc-1',
  emailAddress: 'kim@fastmail.com',
  displayName: 'Kim',
  provider: 'imap',
  status: 'active',
  statusDetail: null,
  username: 'kim@fastmail.com',
  imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
  smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
  calendarUrl: null,
  calendarStatus: 'unknown',
  calendarStatusDetail: null,
  lastSyncedAt: null,
  createdAt: '2026-10-19T08:00:00+00:00',
  defaultSignatureId: null,
}

function synced(account: MailAccount): SyncedMailAccount {
  const { id, emailAddress, displayName, provider, status, statusDetail, lastSyncedAt, defaultSignatureId, calendarStatus, calendarStatusDetail } = account
  return { id, emailAddress, displayName, provider, status, statusDetail, lastSyncedAt, defaultSignatureId, calendarStatus, calendarStatusDetail }
}

/** Form validation runs asynchronously; let it and the requests it starts finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('AddAccountView', () => {
  let server: MailAccount
  let gmail: MailAccount
  const requests: { method: string; path: string; body: unknown }[] = []

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    server = { ...created }
    gmail = { ...created, id: 'acc-g', emailAddress: 'kim@gmail.example', provider: 'gmail', username: null, imap: null, smtp: null }
    requests.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        requests.push({ method, path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
        if (url.pathname === '/api/v1/mail-server-settings') {
          return json({
            emailAddress: 'kim@fastmail.com',
            found: true,
            source: 'ispdb',
            username: 'kim@fastmail.com',
            imap: created.imap,
            smtp: created.smtp,
            authentication: ['password'],
          })
        }
        if (url.pathname === '/api/v1/oauth-providers') {
          return json([
            { id: 'google', name: 'Google', features: ['mail'] },
            { id: 'microsoft', name: 'Microsoft', features: ['mail'] },
          ])
        }
        if (url.pathname === '/api/v1/provider-authorizations' && method === 'POST') {
          return json({ authorizationUrl: 'https://accounts.google.example/o/oauth2/v2/auth?state=s', provider: 'google', expiresAt: '2026-10-19T08:15:00+00:00' }, 201)
        }
        if (url.pathname === '/api/v1/provider-connections' && method === 'POST') {
          const answer = JSON.parse(String(init?.body)) as { provider: string; code?: string }
          return answer.code === 'code-unticked'
            ? json({ provider: answer.provider, connected: null, grant: null, connectError: 'scopes_missing' })
            : json({ provider: answer.provider, connected: 'acc-g', grant: null, connectError: null })
        }
        if (url.pathname === '/api/v1/mail-accounts/acc-g') {
          return json(gmail)
        }
        if (url.pathname === '/api/v1/mail-accounts' && method === 'POST') {
          return json(server, 201)
        }
        if (url.pathname === '/api/v1/mail-accounts/acc-1' && method === 'PATCH') {
          server = { ...server, status: 'active', statusDetail: null }
          return json(server)
        }
        if (url.pathname === '/api/v1/mail-accounts/acc-1') {
          return json(server)
        }
        return json({ detail: 'Unexpected request' }, 500)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  async function mountView(path = '/settings/accounts/new') {
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

    const wrapper = mount(AddAccountView, { global: { plugins: [router] } })
    return Object.assign(wrapper, { router })
  }

  it('fills in detected settings, reports a failed sign-in and connects after the fix', async () => {
    const wrapper = await mountView()
    const mail = useMailStore()

    await wrapper.get('input[type="email"]').setValue('kim@fastmail.com')
    await wrapper.findAll('input')[1]!.setValue('Kim')
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(wrapper.text()).toContain('We filled in the settings we found for fastmail.com')
    expect((wrapper.find('input[autocomplete="off"]').element as HTMLInputElement).value).toBe('kim@fastmail.com')
    expect(wrapper.findAll('input').some((input) => (input.element as HTMLInputElement).value === 'imap.fastmail.com')).toBe(true)

    await wrapper.get('input[type="password"]').setValue('wrong-password')
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(requests.find((r) => r.method === 'POST')?.body).toMatchObject({ emailAddress: 'kim@fastmail.com', displayName: 'Kim', password: 'wrong-password', imap: created.imap })
    expect(wrapper.text()).toContain('Signing in and fetching your folders')

    server = { ...server, status: 'auth_failed', statusDetail: 'Invalid credentials' }
    mail.accounts = [synced(server)]
    await settle()
    expect(wrapper.text()).toContain('Signing in failed.')
    expect(wrapper.text()).toContain('The server said: Invalid credentials')

    await wrapper.get('button.button-primary').trigger('click')
    await wrapper.get('input[type="password"]').setValue('right-password')
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1)
    expect(requests.find((r) => r.method === 'PATCH')?.body).toMatchObject({ password: 'right-password' })
    expect(wrapper.text()).toContain('Signing in and fetching your folders')

    server = { ...server, lastSyncedAt: '2026-10-19T08:01:00+00:00' }
    mail.accounts = [synced(server)]
    await settle()
    expect(wrapper.text()).toContain('Connected. Your mail is arriving')
  })

  it('sends the browser to the provider to sign in', async () => {
    const assign = vi.fn<(url: string) => void>()
    vi.stubGlobal('location', { ...window.location, assign })
    const wrapper = await mountView()
    await settle()

    const buttons = wrapper.findAll('button.provider')
    expect(buttons.map((button) => button.text())).toEqual(['Sign in with Google', 'Sign in with Microsoft'])
    await buttons[0]!.trigger('click')
    await settle()

    expect(requests.find((r) => r.path === '/api/v1/provider-authorizations')?.body).toEqual({ provider: 'google', features: ['mail'] })
    expect(assign).toHaveBeenCalledWith('https://accounts.google.example/o/oauth2/v2/auth?state=s')
  })

  it('asks for calendars only when the user chooses to sync them', async () => {
    vi.stubGlobal('location', { ...window.location, assign: vi.fn<(url: string) => void>() })
    const wrapper = await mountView()
    await settle()

    await wrapper.get('.calendars input[type="checkbox"]').setValue(true)
    await wrapper.findAll('button.provider')[1]!.trigger('click')
    await settle()

    expect(requests.find((r) => r.path === '/api/v1/provider-authorizations')?.body).toEqual({ provider: 'microsoft', features: ['mail', 'calendar'] })
  })

  it('waits for the account the provider sign-in connected, and offers to sign in again when it fails', async () => {
    const assign = vi.fn<(url: string) => void>()
    vi.stubGlobal('location', { ...window.location, assign })
    const wrapper = await mountView('/settings/accounts/new?provider=google&state=state-1&code=code-1')
    const mail = useMailStore()
    await settle()

    // The web app finishes the sign-in with its own token, so it never needs the API's browser session.
    expect(requests.find((r) => r.path === '/api/v1/provider-connections')).toEqual({
      method: 'POST',
      path: '/api/v1/provider-connections',
      body: { provider: 'google', state: 'state-1', code: 'code-1' },
    })
    expect(useAuthStore().isAuthenticated).toBe(true)
    expect(wrapper.text()).toContain('kim@gmail.example')
    expect(wrapper.text()).toContain('Signing in and fetching your folders')
    expect(wrapper.router.currentRoute.value.query).toEqual({})

    gmail = { ...gmail, status: 'auth_failed', statusDetail: 'Google no longer lets Tresso use this account.' }
    mail.accounts = [synced(gmail)]
    await settle()
    expect(wrapper.text()).toContain('Signing in failed.')
    await wrapper.get('button.button-primary').trigger('click')
    await settle()

    expect(wrapper.get('button.button-primary').text()).toBe('Sign in with Google again')
    expect(requests.find((r) => r.path === '/api/v1/provider-authorizations')?.body).toEqual({ provider: 'google', features: ['mail'], mailAccountId: 'acc-g' })
    expect(assign).toHaveBeenCalledOnce()
  })

  it('explains a failed provider sign-in', async () => {
    const wrapper = await mountView('/settings/accounts/new?provider=microsoft&state=state-1&code=code-unticked')
    await settle()

    expect(wrapper.get('[role="alert"]').text()).toBe('Tresso needs permission to read and send your mail. Sign in with Microsoft again and leave those boxes ticked.')
    expect(wrapper.find('input[type="email"]').exists()).toBe(true)
    expect(wrapper.router.currentRoute.value.query).toEqual({})
  })

  it('hands a refusal at the provider in, and says an unknown sign-in expired without asking', async () => {
    const refused = await mountView('/settings/accounts/new?provider=google&state=state-1&error=access_denied')
    await settle()
    expect(requests.find((r) => r.path === '/api/v1/provider-connections')?.body).toEqual({ provider: 'google', state: 'state-1', error: 'access_denied' })
    refused.unmount()

    requests.length = 0
    const expired = await mountView('/settings/accounts/new?provider=google&connectError=expired')
    await settle()
    expect(expired.get('[role="alert"]').text()).toBe('That sign-in took too long or was already used. Try again.')
    expect(requests.some((r) => r.path === '/api/v1/provider-connections')).toBe(false)
  })
})
