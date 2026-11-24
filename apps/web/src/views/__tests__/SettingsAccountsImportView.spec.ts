import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import type { ImportFailure, MailAccountImport, MailAccountImportEntry, ProviderConnection } from '@tresso/core'
import { handOver, isAwaited, markAwaiting } from '@/components/connect/connectChannel'
import { useAuthStore } from '@/stores/auth'
import SettingsAccountsImportView from '../SettingsAccountsImportView.vue'
import SettingsAccountsView from '../SettingsAccountsView.vue'

/**
 * "Add several accounts" as the boards AddAccountsPaste, AddAccountsList and AddAccountsStates draw it, against a fake
 * API: the paste step, the list with its groups and states, one row or all of them one after another, the password form,
 * the stop notice, the endings, the assistant's notice and another user's list.
 */
const desktop = vi.hoisted(() => ({ on: false, opened: [] as string[] }))
vi.mock('@/platform/desktop', () => ({
  get isDesktop() {
    return desktop.on
  },
  openInBrowser: async (url: string) => {
    desktop.opened.push(url)
  },
  loadKeychainTokens: async () => null,
  saveKeychainTokens: async () => {},
  clearKeychainTokens: async () => {},
}))

const LIST_ID = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const EXPIRES = '2026-11-25T10:12:00+00:00'
const APPROVAL = 'https://login.microsoftonline.com/contoso.example/adminconsent?client_id=x'

type Entry = Pick<MailAccountImportEntry, 'id' | 'address'> & { state?: MailAccountImportEntry['state']; failure?: ImportFailure | null; provider?: MailAccountImportEntry['provider'] }

class FakeApi {
  entries: MailAccountImportEntry[] = []
  createdBy: string | null = null
  connectedAccounts: string[] = []
  requests: { method: string; path: string; body: unknown }[] = []
  found: Record<string, 'google' | 'm365' | null> = {}
  /** How the next provider sign-in ends. */
  nextError: ProviderConnection['connectError'] = null
  check = { imap: 'ok', smtp: 'ok', detail: null as string | null }
  signIns = 0
  started: Record<string, string> = {}

  setList(entries: Entry[], createdBy: string | null = null): void {
    this.createdBy = createdBy
    this.entries = entries.map((entry) => ({ state: 'todo', failure: null, reason: null, mailAccountId: null, accountStatus: null, approvalUrl: null, provider: null, ...entry }) as MailAccountImportEntry)
  }

  list(): MailAccountImport {
    const progress = { todo: 0, connected: 0, already_connected: 0, failed: 0, skipped: 0 }
    for (const entry of this.entries) progress[entry.state]++
    return { id: LIST_ID, entries: this.entries, progress, createdBy: this.createdBy, pageUrl: '', createdAt: '2026-11-24T10:12:00+00:00', expiresAt: EXPIRES, leftOut: [] }
  }

  entry(address: string): MailAccountImportEntry {
    return this.entries.find((entry) => entry.address === address)!
  }

  async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    const authorization = new Headers(init?.headers).get('Authorization') ?? ''
    const path = url.pathname
    this.requests.push({ method, path, body })
    if (path === '/api/v1/oauth-providers') return Response.json([{ id: 'google', name: 'Google', features: ['mail', 'calendar'] }, { id: 'microsoft', name: 'Microsoft', features: ['mail'] }])
    if (path === '/api/v1/server-info') return Response.json({ product: 'tresso-server', apiVersion: 1, billing: false, trialDays: 0, allowUnencryptedMailServers: false })
    if (path === '/api/v1/mail-accounts' && method === 'GET') return Response.json(this.connectedAccounts.map((address, index) => ({ id: `a${index}`, emailAddress: address, displayName: address, provider: 'imap', status: 'active' })))
    if (path === '/api/v1/mail-server-settings') {
      const address = url.searchParams.get('emailAddress') ?? ''
      const provider = this.found[address] ?? null
      const domain = address.split('@')[1]
      return Response.json({
        emailAddress: address,
        found: provider === null,
        source: null,
        username: address,
        imap: provider === null ? { host: `imap.${domain}`, port: 993, security: 'tls' } : null,
        smtp: provider === null ? { host: `smtp.${domain}`, port: 465, security: 'tls' } : null,
        authentication: ['password'],
        provider,
      })
    }
    if (path === '/api/v1/mail-account-imports' && method === 'GET') return Response.json(this.entries.length > 0 ? [this.list()] : [])
    if (path === `/api/v1/mail-account-imports/${LIST_ID}` && method === 'GET') {
      return authorization.includes('lisa') ? Response.json({ detail: 'Import list not found.' }, { status: 404 }) : Response.json(this.list())
    }
    if (path === `/api/v1/mail-account-imports/${LIST_ID}` && method === 'DELETE') {
      this.entries = []
      return new Response(null, { status: 204 })
    }
    if (path === '/api/v1/mail-account-imports' && method === 'POST') {
      this.setList((body!.entries as { address: string }[]).map((entry, index) => ({ id: `n${index}`, address: entry.address })))
      return Response.json(this.list(), { status: 201 })
    }
    if (path === `/api/v1/mail-account-imports/${LIST_ID}/entry-states`) {
      const entry = this.entries.find((candidate) => candidate.id === body!.entryId)!
      entry.state = body!.state as MailAccountImportEntry['state']
      entry.failure = (body!.failure as ImportFailure | undefined) ?? null
      return Response.json(this.list())
    }
    if (path === '/api/v1/provider-authorizations') {
      this.signIns++
      const state = `state-${this.signIns}`
      this.started[state] = String(body!.emailAddress)
      return Response.json({ authorizationUrl: `https://${String(body!.provider)}.example/auth?state=${state}`, provider: body!.provider, expiresAt: new Date(Date.now() + 900_000).toISOString() }, { status: 201 })
    }
    if (path === '/api/v1/provider-connections') {
      const entry = this.entry(this.started[String(body!.state)]!)
      if (this.nextError === null) {
        entry.state = 'connected'
      } else {
        entry.state = 'failed'
        entry.failure = this.nextError as ImportFailure
        entry.approvalUrl = this.nextError === 'admin_approval_required' ? APPROVAL : null
      }
      return Response.json(this.result())
    }
    if (path === '/api/v1/mail-account-checks') return Response.json(this.check)
    if (path === '/api/v1/mail-accounts' && method === 'POST') return Response.json({ id: 'acc-new', emailAddress: body!.emailAddress }, { status: 201 })
    return Response.json({ detail: `Unexpected ${method} ${path}` }, { status: 500 })
  }

  result(): ProviderConnection {
    return { provider: 'google', connected: this.nextError === null ? 'acc-1' : null, grant: null, connectError: this.nextError, requested: ['mail'], missing: [], existing: false, approvalUrl: this.nextError === 'admin_approval_required' ? APPROVAL : null }
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function texts(wrapper: VueWrapper, selector: string): string[] {
  return wrapper.findAll(selector).map((element) => element.text())
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((candidate) => candidate.text() === label)
  expect(found, `a button "${label}"`).toBeDefined()
  return found!
}

function row(wrapper: VueWrapper, address: string) {
  const found = wrapper.findAll('li.row').find((candidate) => candidate.get('.row-address').text() === address)
  expect(found, `a row for ${address}`).toBeDefined()
  return found!
}

function day(iso: string): string {
  const date = new Date(iso)
  return `${new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(date)} at ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)}`
}

describe('Add several accounts', () => {
  let api: FakeApi
  const opened = vi.fn<(url: string) => void>()
  const close = vi.fn<() => void>()

  function token(name: string): void {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: `${name}-token`, refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
  }

  beforeEach(async () => {
    api = new FakeApi()
    desktop.on = false
    desktop.opened.length = 0
    opened.mockReset()
    close.mockReset()
    vi.stubGlobal('open', (url: string) => {
      opened(url)
      return null
    })
    vi.stubGlobal('close', close)
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => api.handle(input, init)))
    // localStorage as the tabs of one browser share it (the connect channel's notes).
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    })
    token('kim')
    setActivePinia(createPinia())
    await useAuthStore().restore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  async function mountAt(path: string) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/accounts', name: 'settings-accounts', component: SettingsAccountsView },
        { path: '/settings/accounts/new', name: 'settings-accounts-new', component: { template: '<div />' } },
        { path: '/settings/accounts/import/:importId?', name: 'settings-accounts-import', component: SettingsAccountsImportView },
      ],
    })
    await router.push(path)
    await router.isReady()
    const wrapper = mount(defineComponent({ render: () => h(RouterView) }), { global: { plugins: [router] }, attachTo: document.body })
    await settle()
    return Object.assign(wrapper, { router })
  }

  function starts() {
    return api.requests.filter((request) => request.path === '/api/v1/provider-authorizations')
  }

  /** The provider's tab came back and handed its answer to the waiting page. */
  async function answer(state: string, error: ProviderConnection['connectError'] = null) {
    api.nextError = error
    const entry = api.entry(api.started[state]!)
    entry.state = error === null ? 'connected' : 'failed'
    entry.failure = error as ImportFailure | null
    entry.approvalUrl = error === 'admin_approval_required' ? APPROVAL : null
    await handOver(state, { kind: 'result', result: api.result() }, 0)
    window.dispatchEvent(new Event('focus'))
    await settle()
  }

  describe('step 1, paste', () => {
    it('starts empty, with Continue off', async () => {
      const wrapper = await mountAt('/settings/accounts/import')

      expect(wrapper.get('h1').text()).toBe('Add several accounts')
      expect(wrapper.text()).toContain('Step 1 of 2. Paste the addresses of the mail accounts you want to add. In the next step you sign in to each one.')
      expect(wrapper.get('label[for="bulk-addresses"]').text()).toBe('Email addresses')
      expect(wrapper.get('#bulk-hint').text()).toBe('One on each line, or separated by commas. Up to 50 at a time.')
      expect(wrapper.get('#bulk-count').text()).toBe('No addresses yet.')
      expect(wrapper.get('.limit').text()).toBe('0 of 50')
      expect(wrapper.get('#check-title').text()).toBe('Nothing to check')
      expect(wrapper.get('.check-lead').text()).toBe('Addresses that need a look show up here.')
      expect(wrapper.text()).toContain('Nothing is connected in this step. Next you sign in to each account yourself, in your browser or with its password.')
      expect(button(wrapper, 'Continue').attributes('disabled')).toBeDefined()
      expect(wrapper.get('a[aria-label="Back to accounts"]').attributes('href')).toBe('/settings/accounts')
      expect(wrapper.findAll('a').find((link) => link.text() === 'Cancel')?.attributes('href')).toBe('/settings/accounts')
    })

    it('counts the addresses, names each one that needs a look with its line, and makes the list of the rest', async () => {
      api.connectedAccounts = ['kim@company.example']
      const wrapper = await mountAt('/settings/accounts/import')

      await wrapper.get('textarea').setValue('kim@company.example\ninfo@company.example\njeroen.smit.company.example\nsales@company.example, INFO@company.example\nanna@company\nkim.visser@outlook.example')

      expect(wrapper.get('#bulk-count').text()).toBe('7 addresses: 3 to add, 1 already connected, 2 not valid, 1 listed twice.')
      expect(wrapper.get('.limit').text()).toBe('3 of 50')
      expect(wrapper.get('#check-title').text()).toBe('Check these first')
      expect(wrapper.get('.check-lead').text()).toBe('4 addresses need a look. The others are ready.')
      expect(texts(wrapper, '.issue-address')).toEqual(['kim@company.example', 'jeroen.smit.company.example', 'INFO@company.example', 'anna@company'])
      expect(texts(wrapper, '.pill')).toEqual(['Already connected', 'Not valid', 'Listed twice', 'Not valid'])
      expect(texts(wrapper, '.issue-text')).toEqual([
        'Line 1. This account is already in Tresso. It is left out.',
        'Line 3. There is no @ in this address. It is left out unless you fix it.',
        'Line 4. Also on line 2. It is added once.',
        'Line 5. The part after the @ is not complete. It is left out unless you fix it.',
      ])

      await button(wrapper, 'Continue with 3 addresses').trigger('click')
      await settle()

      expect(api.requests.find((request) => request.path === '/api/v1/mail-account-imports' && request.method === 'POST')?.body).toEqual({
        entries: [{ address: 'info@company.example' }, { address: 'sales@company.example' }, { address: 'kim.visser@outlook.example' }],
      })
      expect(wrapper.router.currentRoute.value.params.importId).toBe(LIST_ID)
      expect(wrapper.text()).toContain('Step 2 of 2.')
    })

    it('says one address in the singular', async () => {
      const wrapper = await mountAt('/settings/accounts/import')

      await wrapper.get('textarea').setValue('kim@company.example\nnope')

      expect(wrapper.get('#bulk-count').text()).toBe('2 addresses: 1 to add, 1 not valid.')
      expect(wrapper.get('.check-lead').text()).toBe('1 address needs a look. The others are ready.')
      expect(button(wrapper, 'Continue with 1 address').attributes('disabled')).toBeUndefined()

      await wrapper.get('textarea').setValue('kim@company.example')
      expect(wrapper.get('#bulk-count').text()).toBe('1 address: 1 to add.')
      expect(wrapper.get('#check-title').text()).toBe('Nothing to check')
      expect(wrapper.get('.check-lead').text()).toBe('Every address looks right.')
    })

    it('stops above 50 addresses', async () => {
      const wrapper = await mountAt('/settings/accounts/import')

      await wrapper.get('textarea').setValue(Array.from({ length: 52 }, (_, i) => `p${i}@company.example`).join('\n'))

      expect(wrapper.get('.limit').text()).toBe('52 of 50')
      expect(wrapper.get('.over-line').text()).toBe('That is 2 more than 50. Remove some addresses, or add the rest in a second list.')
      expect(wrapper.get('textarea').classes()).toContain('over')
      expect(button(wrapper, 'Continue').attributes('disabled')).toBeDefined()
    })
  })

  describe('step 2, the list', () => {
    function threeRows(): void {
      api.setList([
        { id: 'p1', address: 'orders@studio.example' },
        { id: 'g1', address: 'kim@gmail.example' },
        { id: 'm1', address: 'noor@contoso.example' },
      ])
      api.found = { 'kim@gmail.example': 'google', 'noor@contoso.example': 'm365' }
    }

    it('shows the groups and starts nothing on load', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      expect(wrapper.text()).toContain('Step 2 of 2. Sign in to each account. Microsoft and Google open in your browser. Other mail asks for its password here.')
      expect(wrapper.get('a[aria-label="Back to the addresses"]').attributes('href')).toBe('/settings/accounts/import')
      expect(wrapper.get('#sum-title').text()).toBe('0 of 3 connected')
      expect(wrapper.get('.summary-line').text()).toBe('3 to go.')
      expect(wrapper.get('.run-line').text()).toBe('Nothing starts by itself. Sign in to all in one go, or do them one at a time with Next.')
      expect(wrapper.get('[role="progressbar"]').attributes()).toMatchObject({ 'aria-label': 'Accounts connected', 'aria-valuemax': '3', 'aria-valuenow': '0' })
      expect(texts(wrapper, '.group-title')).toEqual(['Microsoft 365', 'Google', 'Other mail with a password'])
      expect(texts(wrapper, '.group-how')).toEqual(['You sign in at Microsoft, in your browser', 'You sign in at Google, in your browser', 'You enter the password of each address, here in Tresso'])
      expect(texts(wrapper, '.group-count')).toEqual(['0 of 1 connected', '0 of 1 connected', '0 of 1 connected'])
      expect(texts(wrapper, '.row-address')).toEqual(['noor@contoso.example', 'kim@gmail.example', 'orders@studio.example'])
      expect(texts(wrapper, '.row-state')).toEqual(['To do', 'To do', 'To do'])
      expect(texts(wrapper, '.row-action button')).toEqual(['Sign in', 'Sign in', 'Enter password'])
      expect(row(wrapper, 'kim@gmail.example').get('button').attributes('aria-label')).toBe('Sign in: kim@gmail.example')
      expect(button(wrapper, 'Next: noor@contoso.example').classes()).toContain('secondary')
      expect(button(wrapper, 'Sign in to all, one after another').classes()).toContain('primary')
      expect(wrapper.get('.list-note').text()).toBe(`This list is kept for 24 hours, until ${day(EXPIRES)}. You can leave and continue later: choose Add several accounts in Settings, Accounts.`)
      expect(button(wrapper, 'Finish without the rest').exists()).toBe(true)
      expect(starts()).toEqual([])
      expect(opened).not.toHaveBeenCalled()
    })

    it('signs one row in with its address as the hint, waits for the browser and offers the next', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await row(wrapper, 'kim@gmail.example').get('button').trigger('click')
      await settle()

      expect(starts()[0]?.body).toEqual({ provider: 'google', features: ['mail', 'calendar'], emailAddress: 'kim@gmail.example', importId: LIST_ID })
      expect(opened).toHaveBeenCalledWith('https://google.example/auth?state=state-1')
      expect(isAwaited('state-1')).toBe(true)
      const waiting = row(wrapper, 'kim@gmail.example')
      expect(waiting.get('.row-state').text()).toBe('Waiting for the browser')
      expect(waiting.get('.row-hint').text()).toBe('Sign in at Google and allow access. This row updates by itself.')
      expect(waiting.get('button').text()).toBe('Open the page again')
      expect(wrapper.get('.run-line').text()).toBe('Signing in to kim@gmail.example. Nothing else starts after it.')
      expect(button(wrapper, 'Stop').exists()).toBe(true)

      await waiting.get('button').trigger('click')
      expect(opened).toHaveBeenCalledTimes(2)

      await answer('state-1')

      expect(row(wrapper, 'kim@gmail.example').get('.row-state').text()).toBe('Connected')
      expect(wrapper.get('#sum-title').text()).toBe('1 of 3 connected')
      expect(wrapper.get('.summary-line').text()).toBe('2 to go.')
      expect(starts()).toHaveLength(1)
      expect(document.activeElement?.textContent).toBe('Next: noor@contoso.example')
      expect(wrapper.find('.visually-hidden[role="status"]').text()).toBe('kim@gmail.example: Connected')
    })

    it('signs in to all one after another, opens the password row and waits for its password', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()
      expect(wrapper.get('.run-line').text()).toBe('Signing in one after another. Now: noor@contoso.example. Next: kim@gmail.example. After each sign-in the next one starts by itself.')
      expect(row(wrapper, 'noor@contoso.example').get('.row-hint').text()).toBe('Sign in at Microsoft and allow access. This row updates by itself.')

      await answer('state-1')
      expect(starts().map((start) => (start.body as { emailAddress: string }).emailAddress)).toEqual(['noor@contoso.example', 'kim@gmail.example'])
      expect(wrapper.get('.run-line').text()).toBe('Signing in one after another. Now: kim@gmail.example. Next: orders@studio.example. After each sign-in the next one starts by itself.')

      await answer('state-2')
      const form = wrapper.get('form[aria-label="Password for orders@studio.example"]')
      expect(wrapper.get('.run-line').text()).toBe('Signing in one after another. Now: orders@studio.example.')
      expect(form.text()).toContain('Server settings found: imap.studio.example, port 993, and smtp.studio.example, port 465.')
      const username = form.get('input[name="username"]')
      expect(username.attributes()).toMatchObject({ type: 'email', autocomplete: 'username' })
      expect(username.attributes('readonly')).toBeDefined()
      expect((username.element as HTMLInputElement).value).toBe('orders@studio.example')
      const password = form.get('input[type="password"]')
      expect(password.attributes()).toMatchObject({ name: 'password', autocomplete: 'current-password' })
      expect(form.get(`label[for="${password.attributes('id')}"]`).text()).toBe('Password for orders@studio.example')
      expect(form.text()).toContain('Your password manager can fill this in. The password is stored encrypted and is only used to read and send mail for this address.')
      expect(row(wrapper, 'orders@studio.example').get('.row-action button').attributes('aria-expanded')).toBe('true')

      await password.setValue('typed-into-tresso')
      await form.trigger('submit')
      await settle()

      expect(api.requests.find((request) => request.path === '/api/v1/mail-accounts' && request.method === 'POST')?.body).toMatchObject({ emailAddress: 'orders@studio.example', username: 'orders@studio.example', password: 'typed-into-tresso' })
      expect(api.requests.filter((request) => request.path.endsWith('/entry-states')).map((request) => request.body)).toEqual([{ entryId: 'p1', state: 'connected' }])
      // Every row is connected now: the ending replaces the summary and the list.
      expect(wrapper.get('.ending-title').text()).toBe('All 3 accounts added')
      expect(wrapper.get('.ending-sub').text()).toBe('Mail for the new accounts is coming in, newest first.')
      expect(texts(wrapper, '.added')).toEqual(['Microsoft 3651', 'Google1', 'Other mail with a password1'])
      expect(wrapper.text()).not.toContain('Go back to the skipped ones')
      expect(wrapper.findAll('a').find((link) => link.text() === 'Done')?.attributes('href')).toBe('/settings/accounts')
    })

    it('stops at the first row that does not connect, and continues with the next or tries it again', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()

      await answer('state-1', 'denied')

      const notice = wrapper.get('.stopped')
      expect(notice.attributes('role')).toBe('alert')
      expect(notice.get('.stopped-title').text()).toBe('Stopped at noor@contoso.example')
      expect(notice.get('.stopped-text').text()).toBe('Sign-in was cancelled. Nothing was connected for this address. 0 of 3 are connected so far.')
      expect(button(wrapper, 'Continue with the next').classes()).toContain('primary')
      expect(wrapper.find('.run-line').exists()).toBe(false)
      const cancelled = row(wrapper, 'noor@contoso.example')
      expect(cancelled.get('.row-state').text()).toBe('Sign-in cancelled')
      expect(cancelled.get('.row-hint').text()).toBe('You closed the page or did not give access. Nothing was connected.')
      expect(cancelled.get('button').text()).toBe('Try again')
      expect(wrapper.get('.summary-line').text()).toBe('1 needs another try. 2 to go.')
      expect(starts()).toHaveLength(1)

      await button(wrapper, 'Continue with the next').trigger('click')
      await settle()
      expect(starts()[1]?.body).toMatchObject({ emailAddress: 'kim@gmail.example' })

      await answer('state-2', 'denied')
      await button(wrapper, 'Try this one again').trigger('click')
      await settle()
      expect(starts()[2]?.body).toMatchObject({ emailAddress: 'kim@gmail.example' })
    })

    it('offers the approval link when the organization must approve Tresso', async () => {
      threeRows()
      const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()

      await answer('state-1', 'admin_approval_required')

      expect(wrapper.get('.stopped-text').text()).toBe('The IT team of contoso.example has to approve Tresso first. Other addresses of contoso.example will stop here too. 0 of 3 are connected so far.')
      const blocked = row(wrapper, 'noor@contoso.example')
      expect(blocked.get('.row-state').text()).toBe('Organization must approve')
      expect(blocked.get('.row-hint').text()).toBe(`The IT team of contoso.example has to approve Tresso first. Send them ${APPROVAL}.`)
      expect(blocked.get('button').text()).toBe('Try again')

      await button(wrapper, 'Copy approval link').trigger('click')
      expect(writeText).toHaveBeenCalledWith(APPROVAL)
    })

    it('says a refused password and an unreachable server on the row, and never sends the password elsewhere', async () => {
      api.setList([{ id: 'p1', address: 'orders@studio.example' }])
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await row(wrapper, 'orders@studio.example').get('button').trigger('click')
      await settle()
      expect(row(wrapper, 'orders@studio.example').get('.row-action button').text()).toBe('Close')
      api.check = { imap: 'auth_failed', smtp: 'not_checked', detail: null }
      await wrapper.get('input[type="password"]').setValue('wrong-one')
      await wrapper.get('form').trigger('submit')
      await settle()

      const refused = row(wrapper, 'orders@studio.example')
      expect(refused.get('.row-state').text()).toBe('Password refused')
      expect(refused.get('.row-hint').text()).toBe('studio.example did not accept this password. Check that all of it was filled in.')
      const marked = api.requests.filter((request) => request.path.endsWith('/entry-states'))
      expect(marked.map((request) => request.body)).toEqual([{ entryId: 'p1', state: 'failed', failure: 'password_refused' }])
      expect(JSON.stringify(marked)).not.toContain('wrong-one')

      api.check = { imap: 'unreachable', smtp: 'not_checked', detail: null }
      await wrapper.get('input[type="password"]').setValue('another')
      await wrapper.get('form').trigger('submit')
      await settle()
      const unreachable = row(wrapper, 'orders@studio.example')
      expect(unreachable.get('.row-state').text()).toBe('Server not reached')
      expect(unreachable.get('.row-hint').text()).toBe('imap.studio.example did not answer on port 993.')
      expect(unreachable.get('.row-action button').text()).toBe('Check settings')
    })

    it('finishes without the rest, lists what was added and skipped, and goes back to the skipped ones', async () => {
      api.setList([
        { id: 'g1', address: 'kim@gmail.example', state: 'connected' },
        { id: 'g2', address: 'team@gmail.example' },
        { id: 'p1', address: 'orders@studio.example', state: 'failed', failure: 'password_refused' },
      ])
      api.found = { 'kim@gmail.example': 'google', 'team@gmail.example': 'google' }
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await button(wrapper, 'Finish without the rest').trigger('click')
      await settle()

      expect(wrapper.get('.ending-title').text()).toBe('1 account added')
      expect(wrapper.get('.ending-sub').text()).toBe('2 were skipped. Mail for the new accounts is coming in, newest first.')
      expect(texts(wrapper, '.column-title')).toEqual(['Added', 'Skipped'])
      expect(texts(wrapper, '.added')).toEqual(['Google1'])
      expect(texts(wrapper, '.skipped')).toEqual(['team@gmail.example', 'orders@studio.example'])
      expect(wrapper.get('.small-note').text()).toBe(`You can still add the skipped ones until ${day(EXPIRES)}.`)

      await button(wrapper, 'Go back to the skipped ones').trigger('click')
      await settle()
      expect(texts(wrapper, '.row-state')).toEqual(['Connected', 'To do', 'To do'])
    })

    it('shows a skipped row with Add back, and an account added another way as already connected', async () => {
      api.setList([
        { id: 'g1', address: 'kim@gmail.example', state: 'already_connected' },
        { id: 'g2', address: 'team@gmail.example', state: 'skipped' },
        { id: 'g3', address: 'info@gmail.example' },
      ])
      api.found = { 'kim@gmail.example': 'google', 'team@gmail.example': 'google', 'info@gmail.example': 'google' }
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      const already = row(wrapper, 'kim@gmail.example')
      expect(already.get('.row-state').text()).toBe('Already connected')
      expect(already.get('.row-hint').text()).toBe('This account is already in Tresso.')
      expect(already.find('button').exists()).toBe(false)
      expect(wrapper.get('#sum-title').text()).toBe('1 of 3 connected')
      expect(wrapper.get('.group-count').text()).toBe('1 of 3 connected')

      const skipped = row(wrapper, 'team@gmail.example')
      expect(skipped.get('.row-state').text()).toBe('Skipped')
      await skipped.get('button').trigger('click')
      await settle()
      expect(row(wrapper, 'team@gmail.example').get('.row-state').text()).toBe('To do')
    })

    it('says which app made the list, until the first sign-in, and deletes it', async () => {
      api.setList([{ id: 'g1', address: 'kim@gmail.example' }], 'Claude')
      api.found = { 'kim@gmail.example': 'google' }
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      expect(wrapper.get('.assistant').text()).toBe('This list was made by Claude. Check the addresses before you sign in.Delete this list')
      await button(wrapper, 'Delete this list').trigger('click')
      await settle()

      expect(api.requests.some((request) => request.method === 'DELETE' && request.path === `/api/v1/mail-account-imports/${LIST_ID}`)).toBe(true)
      expect(wrapper.router.currentRoute.value.name).toBe('settings-accounts')
    })

    it('shows another user nothing of the list', async () => {
      api.setList([{ id: 'g1', address: 'kim@gmail.example' }])
      localStorage.clear()
      token('lisa')
      setActivePinia(createPinia())
      await useAuthStore().restore()

      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      expect(wrapper.get('.ending-title').text()).toBe('This list has expired')
      expect(wrapper.get('.ending-sub').text()).toBe('A list of addresses is kept for 24 hours.')
      expect(wrapper.text()).not.toContain('kim@gmail.example')
      expect(wrapper.findAll('a').find((link) => link.text() === 'Start a new list')?.attributes('href')).toBe('/settings/accounts/import')
    })

    it('in the tab the provider sent back, finishes the sign-in, hands it to the waiting tab and closes', async () => {
      threeRows()
      api.started['state-9'] = 'kim@gmail.example'
      markAwaiting('state-9', Date.now() + 60_000)
      const taken = new BroadcastChannel('tresso-connect')
      taken.onmessage = (event: MessageEvent<{ type: string; state: string }>) => {
        if (event.data.type === 'outcome') taken.postMessage({ type: 'taken', state: event.data.state })
      }

      await mountAt(`/settings/accounts/import/${LIST_ID}?provider=google&state=state-9&code=code-1`)
      taken.close()

      expect(api.requests.find((request) => request.path === '/api/v1/provider-connections')?.body).toEqual({ provider: 'google', state: 'state-9', code: 'code-1' })
      expect(close).toHaveBeenCalled()
    })

    it('without a waiting tab, shows the answer and starts nothing', async () => {
      threeRows()
      api.started['state-9'] = 'kim@gmail.example'

      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}?provider=google&state=state-9&code=code-1`)

      expect(close).not.toHaveBeenCalled()
      expect(wrapper.router.currentRoute.value.query).toEqual({})
      expect(row(wrapper, 'kim@gmail.example').get('.row-state').text()).toBe('Connected')
      expect(starts()).toEqual([])
    })

    it('in the desktop app goes on in the system browser when the answer comes back through the link', async () => {
      desktop.on = true
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()
      await wrapper.router.replace({ name: 'settings-accounts-import', params: { importId: LIST_ID }, query: { provider: 'microsoft', state: 'state-1', code: 'code-1' } })
      await settle()

      expect(desktop.opened).toEqual(['https://microsoft.example/auth?state=state-1', 'https://google.example/auth?state=state-2'])
      expect(opened).not.toHaveBeenCalled()
      expect(row(wrapper, 'noor@contoso.example').get('.row-state').text()).toBe('Connected')
    })
  })

  it('puts "Add several accounts" before "Add account" in Settings, Accounts, leading to the list still open', async () => {
    const wrapper = await mountAt('/settings/accounts')
    const links = wrapper.findAll('.header a')
    expect(links.map((link) => link.text())).toEqual(['Add several accounts', 'Add account'])
    expect(links[0]!.attributes('href')).toBe('/settings/accounts/import')

    api.setList([{ id: 'g1', address: 'kim@gmail.example' }])
    const again = await mountAt('/settings/accounts')
    expect(again.findAll('.header a')[0]!.attributes('href')).toBe(`/settings/accounts/import/${LIST_ID}`)
  })
})
