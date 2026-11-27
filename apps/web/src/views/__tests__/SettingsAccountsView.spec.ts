import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useChatsStore } from '@/stores/chats'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
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
  let accounts: unknown[]

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    connectError = null
    answer = {}
    accounts = []
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
          return Response.json(accounts)
        }
        return Response.json({ detail: 'Unexpected request' }, { status: 500 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  async function mountView(path: string, attach = false) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/accounts', name: 'settings-accounts', component: SettingsAccountsView },
        { path: '/settings/accounts/new', name: 'settings-accounts-new', component: { template: '<div />' } },
        { path: '/settings/accounts/import/:importId?', name: 'settings-accounts-import', component: { template: '<div />' } },
        { path: '/settings/whatsapp', name: 'settings-whatsapp', component: { template: '<div />' } },
        { path: '/settings/whatsapp/connect', name: 'settings-whatsapp-connect', component: { template: '<div />' } },
      ],
    })
    await router.push(path)
    await router.isReady()

    const wrapper = mount(SettingsAccountsView, { global: { plugins: [router] }, ...(attach ? { attachTo: document.body } : {}) })
    return Object.assign(wrapper, { router })
  }

  const KIM = { id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', emailAddress: 'kim@company.example', displayName: 'Kim', provider: 'imap', status: 'active', statusDetail: null, username: 'kim', imap: { host: 'imap.company.example', port: 993, security: 'tls' }, smtp: { host: 'smtp.company.example', port: 465, security: 'tls' }, calendarUrl: null, calendarStatus: 'unknown', calendarStatusDetail: null, lastSyncedAt: null, createdAt: '2026-10-19T08:00:00+00:00', defaultSignatureId: null }

  it('has one heading, one sentence and the two ways to add accounts, the second the only ink button', async () => {
    const wrapper = await mountView('/settings/accounts')
    await settle()

    expect(wrapper.findAll('h1, h2, h3').map((h) => h.text())).toEqual(['Accounts'])
    expect(wrapper.get('h2').text()).toBe('Accounts')
    expect(wrapper.get('header p').text()).toBe('Mail stays with your provider. Sign-ins are stored encrypted.')
    expect(wrapper.text()).not.toContain('mail account.')
    const links = wrapper.findAll('header a')
    expect(links.map((a) => a.text())).toEqual(['Add several', 'Add account'])
    expect(links[0]!.attributes('href')).toBe('/settings/accounts/import')
    expect(links[0]!.classes()).toContain('button-quiet')
    expect(links[1]!.attributes('href')).toBe('/settings/accounts/new')
    expect(links[1]!.classes()).toContain('button-primary')
    expect(wrapper.findAll('.button-primary')).toHaveLength(1)
  })

  it('says there are no accounts yet, without an empty card', async () => {
    const wrapper = await mountView('/settings/accounts')
    await settle()

    expect(wrapper.get('p.state').text()).toBe('No mail accounts yet. Add one to see your mail in Tresso.')
    expect(wrapper.find('[role="list"]').exists()).toBe(false)
  })

  it('puts the accounts in one list', async () => {
    accounts = [KIM, { ...KIM, id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c', emailAddress: 'kim@home.example' }]
    const wrapper = await mountView('/settings/accounts')
    await settle()

    const lists = wrapper.findAll('[role="list"]')
    expect(lists).toHaveLength(1)
    expect(lists[0]!.attributes('aria-label')).toBe('Accounts')
    expect(lists[0]!.find(`#account-${KIM.id}`).exists()).toBe(true)
    expect(lists[0]!.find('#account-0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c').exists()).toBe(true)
  })

  it('shows no WhatsApp row where WhatsApp is not turned on and no Mac relays it', async () => {
    const wrapper = await mountView('/settings/accounts')
    await settle()

    expect(wrapper.find('[aria-label="WhatsApp"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('WhatsApp')
  })

  it('offers to connect WhatsApp on a Mac where it is turned on but not connected', async () => {
    const whatsapp = useWhatsAppRelayStore()
    whatsapp.available = true
    whatsapp.configLoaded = true
    const wrapper = await mountView('/settings/accounts')
    await settle()

    const row = wrapper.get('[role="listitem"][aria-label="WhatsApp"]')
    expect(row.find('.provider-mark.whatsapp').exists()).toBe(true)
    expect(row.find('.wa-mark').exists()).toBe(false)
    expect(row.get('.title').text()).toBe('WhatsApp')
    expect(row.get('.line').text()).toBe('Chats next to your mail, on this Mac.')
    const action = row.get('.action a')
    expect(action.text()).toBe('Connect WhatsApp')
    expect(action.attributes('href')).toBe('/settings/whatsapp/connect')
    expect(row.findAll('a')).toHaveLength(1)
  })

  it('puts WhatsApp as the last row of the accounts card, under a hairline', async () => {
    accounts = [KIM]
    useWhatsAppRelayStore().available = true
    const wrapper = await mountView('/settings/accounts')
    await settle()

    const lists = wrapper.findAll('[role="list"]')
    expect(lists).toHaveLength(1)
    const rows = lists[0]!.element.children
    expect(rows).toHaveLength(2)
    expect(rows[0]!.id).toBe(`account-${KIM.id}`)
    expect(rows[1]!.getAttribute('aria-label')).toBe('WhatsApp')
    expect(rows[1]!.getAttribute('role')).toBe('listitem')
    expect(rows[1]!.classList.contains('after-accounts')).toBe(true)
  })

  it('holds only the WhatsApp row, under the sentence about no accounts, while there are no mail accounts', async () => {
    useWhatsAppRelayStore().available = true
    const wrapper = await mountView('/settings/accounts')
    await settle()

    const list = wrapper.get('[role="list"][aria-label="Accounts"]')
    expect(list.element.children).toHaveLength(1)
    expect(list.get('[role="listitem"]').attributes('aria-label')).toBe('WhatsApp')
    expect(list.get('[role="listitem"]').classes()).not.toContain('after-accounts')
    const empty = wrapper.get('p.state')
    expect(empty.text()).toBe('No mail accounts yet. Add one to see your mail in Tresso.')
    expect(empty.element.compareDocumentPosition(list.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('offers no button while it is not yet known whether WhatsApp is connected', async () => {
    useWhatsAppRelayStore().available = true
    const wrapper = await mountView('/settings/accounts')
    await settle()

    const row = wrapper.get('[role="listitem"][aria-label="WhatsApp"]')
    expect(row.find('a').exists()).toBe(false)
  })

  it('shows the linked number and the settings of WhatsApp once it is connected on this Mac', async () => {
    const whatsapp = useWhatsAppRelayStore()
    whatsapp.available = true
    whatsapp.configLoaded = true
    whatsapp.config = { mode: 'local' } as never
    whatsapp.identity = { number: '31698765432', name: null }
    const wrapper = await mountView('/settings/accounts')
    await settle()

    const row = wrapper.get('[role="listitem"][aria-label="WhatsApp"]')
    expect(row.find('.provider-mark.whatsapp').exists()).toBe(true)
    expect(row.find('.wa-mark').exists()).toBe(false)
    expect(row.get('.line').text()).toMatch(/^\+31.*, via this Mac$/)
    const action = row.get('.action a')
    expect(action.text()).toBe('Settings')
    expect(action.attributes('href')).toBe('/settings/whatsapp')
  })

  it('shows the WhatsApp row in the browser while a Mac relays the chats', async () => {
    useChatsStore().serverAccount = { id: 'wa-1', address: '31698765432', relayDeviceId: 'mac-1', relayDeviceName: 'Kim\'s MacBook' } as never
    const wrapper = await mountView('/settings/accounts')
    await settle()

    const row = wrapper.get('[role="listitem"][aria-label="WhatsApp"]')
    expect(row.find('.provider-mark.whatsapp').exists()).toBe(true)
    expect(row.get('.line').text()).toMatch(/, via Kim's MacBook$/)
    expect(row.get('.action a').text()).toBe('Settings')
    expect(row.get('.action a').attributes('href')).toBe('/settings/whatsapp')
  })

  it('opens at the account a link names (#account-<id>), focused, as reconnect_mail_account links to it', async () => {
    const id = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
    accounts = [
      { id, emailAddress: 'kim@company.example', displayName: 'Kim', provider: 'imap', status: 'auth_failed', statusDetail: 'Login refused', username: 'kim', imap: { host: 'imap.company.example', port: 993, security: 'tls' }, smtp: { host: 'smtp.company.example', port: 465, security: 'tls' }, calendarUrl: null, calendarStatus: 'unknown', calendarStatusDetail: null, lastSyncedAt: null, createdAt: '2026-10-19T08:00:00+00:00', defaultSignatureId: null },
    ]
    const scrolled = vi.fn<() => void>()
    Element.prototype.scrollIntoView = scrolled
    const wrapper = await mountView(`/settings/accounts#account-${id}`, true)
    await settle()

    const card = wrapper.get(`#account-${id}`)
    expect(card.attributes('tabindex')).toBe('-1')
    expect(scrolled).toHaveBeenCalled()
    expect(document.activeElement).toBe(card.element)
    wrapper.unmount()
  })

  it('goes to the account a link names while the page is already open', async () => {
    const id = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
    accounts = [
      { id, emailAddress: 'kim@company.example', displayName: 'Kim', provider: 'imap', status: 'auth_failed', statusDetail: 'Login refused', username: 'kim', imap: { host: 'imap.company.example', port: 993, security: 'tls' }, smtp: { host: 'smtp.company.example', port: 465, security: 'tls' }, calendarUrl: null, calendarStatus: 'unknown', calendarStatusDetail: null, lastSyncedAt: null, createdAt: '2026-10-19T08:00:00+00:00', defaultSignatureId: null },
    ]
    const scrolled = vi.fn<() => void>()
    Element.prototype.scrollIntoView = scrolled
    const wrapper = await mountView('/settings/accounts', true)
    await settle()
    expect(scrolled).not.toHaveBeenCalled()

    await wrapper.router.push(`/settings/accounts#account-${id}`)
    await settle()

    expect(scrolled).toHaveBeenCalled()
    expect(document.activeElement).toBe(wrapper.get(`#account-${id}`).element)
    wrapper.unmount()
  })

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
