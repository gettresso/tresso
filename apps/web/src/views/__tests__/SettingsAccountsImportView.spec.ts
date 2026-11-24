import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import type { ImportFailure, MailAccountImport, MailAccountImportEntry, MailCheckStatus, ProviderConnection } from '@tresso/core'
import { abandoned, handOverAndGoOn, isAwaited, markAwaiting } from '@/components/connect/connectChannel'
import { listTime } from '@/components/connect/importTexts'
import { useAuthStore } from '@/stores/auth'
import SettingsAccountsImportView from '../SettingsAccountsImportView.vue'
import SettingsAccountsView from '../SettingsAccountsView.vue'

/**
 * "Add several accounts" as the boards AddAccountsPaste, AddAccountsList and AddAccountsStates draw it, against a fake
 * API: the paste step, the list with its groups and states, one row or all of them one after another (going on in the
 * tab the provider sent back), the password form, Stop, the stop notice, the endings, a list an app made, and another
 * user's list.
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
const APPROVAL = 'https://login.microsoftonline.com/contoso.example/adminconsent?client_id=x'
const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth'
const MICROSOFT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'

type Entry = Pick<MailAccountImportEntry, 'id' | 'address'> & { state?: MailAccountImportEntry['state']; failure?: ImportFailure | null; provider?: MailAccountImportEntry['provider'] }

/** A promise the test settles when it wants to. */
function later<T>() {
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => (settle = resolve))
  return { promise, settle }
}

class FakeApi {
  entries: MailAccountImportEntry[] = []
  createdBy: string | null = null
  confirmed = true
  expiresAt = new Date(Date.now() + 86_400_000).toISOString()
  connectedAccounts: string[] = []
  requests: { method: string; path: string; body: unknown }[] = []
  found: Record<string, 'google' | 'm365' | null> = {}
  /** How long a sign-in started now may take. */
  signInMs = 900_000
  check: { imap: MailCheckStatus; smtp: MailCheckStatus; detail: string | null } = { imap: 'ok', smtp: 'ok', detail: null }
  /** Holds back the next server check until the test settles it. */
  heldCheck: ReturnType<typeof later<void>> | null = null
  heldLookup: ReturnType<typeof later<void>> | null = null
  leftOut: MailAccountImport['leftOut'] = []
  signIns = 0
  started: Record<string, string> = {}
  /** Runs when a sign-in starts, before the API answers. */
  onStart: (() => void) | null = null
  /** The next delete of a list fails. */
  failDelete = false

  setList(entries: Entry[], createdBy: string | null = null): void {
    this.createdBy = createdBy
    this.confirmed = createdBy === null
    this.entries = entries.map((entry) => ({ state: 'todo', failure: null, reason: null, mailAccountId: null, accountStatus: null, approvalUrl: null, provider: null, ...entry }) as MailAccountImportEntry)
  }

  list(): MailAccountImport {
    const progress = { todo: 0, connected: 0, already_connected: 0, failed: 0, skipped: 0 }
    for (const entry of this.entries) progress[entry.state]++
    return { id: LIST_ID, entries: this.entries.map((entry) => ({ ...entry })), progress, createdBy: this.createdBy, createdWithToken: false, confirmed: this.confirmed, pageUrl: '', createdAt: '2026-11-24T10:12:00+00:00', expiresAt: this.expiresAt, leftOut: this.leftOut }
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
      // The page always names the list; an app's list is not looked up before the user confirmed it.
      if (url.searchParams.get('importId') !== LIST_ID || !this.confirmed) return Response.json({ detail: 'Not this list.', violations: [{ propertyPath: 'importId', message: 'No.' }] }, { status: 422 })
      if (this.heldLookup !== null) await this.heldLookup.promise
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
      if (authorization.includes('lisa') || this.entries.length === 0 || Date.parse(this.expiresAt) <= Date.now()) return Response.json({ detail: 'Import list not found.' }, { status: 404 })
      return Response.json(this.list())
    }
    if (path === `/api/v1/mail-account-imports/${LIST_ID}` && method === 'DELETE') {
      if (this.failDelete) return Response.json({ detail: 'Try again later.' }, { status: 503 })
      this.entries = []
      return new Response(null, { status: 204 })
    }
    if (path === `/api/v1/mail-account-imports/${LIST_ID}/confirmation`) {
      this.confirmed = true
      return Response.json(this.list())
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
      this.onStart?.()
      return Response.json({ authorizationUrl: `${body!.provider === 'google' ? GOOGLE : MICROSOFT}?state=${state}`, provider: body!.provider, expiresAt: new Date(Date.now() + this.signInMs).toISOString() }, { status: 201 })
    }
    if (path === '/api/v1/provider-connections') {
      this.entry(this.started[String(body!.state)]!).state = 'connected'
      return Response.json(connection())
    }
    if (path === '/api/v1/mail-account-checks') {
      if (this.heldCheck !== null) await this.heldCheck.promise
      return Response.json(this.check)
    }
    if (path === '/api/v1/mail-accounts' && method === 'POST') return Response.json({ id: 'acc-new', emailAddress: body!.emailAddress }, { status: 201 })
    return Response.json({ detail: `Unexpected ${method} ${path}` }, { status: 500 })
  }
}

function connection(error: ProviderConnection['connectError'] = null): ProviderConnection {
  return { provider: 'google', connected: error === null ? 'acc-1' : null, grant: null, connectError: error, requested: ['mail'], missing: [], existing: false, approvalUrl: error === 'admin_approval_required' ? APPROVAL : null }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
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

/** A tab the click opened: where it was sent, and whether it still knows its opener. */
interface FakeTab {
  opener: unknown
  location: { href: string }
  close: () => void
  closed: boolean
}

describe('Add several accounts', () => {
  let api: FakeApi
  let tabs: FakeTab[]
  /** False: the browser blocks the next tab. */
  let allowTabs: boolean
  const opened = vi.fn<(url: string | undefined, target: string | undefined) => void>()
  const close = vi.fn<() => void>()
  const assign = vi.fn<(url: string) => void>()

  function token(name: string): void {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: `${name}-token`, refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
  }

  beforeEach(async () => {
    api = new FakeApi()
    tabs = []
    allowTabs = true
    desktop.on = false
    desktop.opened.length = 0
    opened.mockReset()
    close.mockReset()
    assign.mockReset()
    vi.stubGlobal('open', (url?: string, target?: string) => {
      opened(url, target)
      if (!allowTabs) return null
      const tab: FakeTab = { opener: window, location: { href: url ?? '' }, closed: false, close: () => (tab.closed = true) }
      tabs.push(tab)
      return tab
    })
    vi.stubGlobal('close', close)
    vi.stubGlobal('location', { ...window.location, assign })
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

  function startedFor(): string[] {
    return starts().map((start) => (start.body as { emailAddress: string }).emailAddress)
  }

  /**
   * The provider sent its tab back to the list's page, which finished the sign-in (the API wrote on the row how it
   * ended) and hands the answer to the waiting page. Returns what the waiting page told that tab.
   */
  async function answer(state: string, error: ProviderConnection['connectError'] = null, rowFailure: ImportFailure | null = error as ImportFailure | null) {
    const address = api.started[state]
    if (address !== undefined) {
      const entry = api.entry(address)
      entry.state = rowFailure === null ? 'connected' : 'failed'
      entry.failure = rowFailure
      entry.approvalUrl = rowFailure === 'admin_approval_required' ? APPROVAL : null
    }
    const reply = await handOverAndGoOn(state, { kind: 'result', result: connection(error) }, 2000)
    await settle()
    return reply
  }

  function threeRows(): void {
    api.setList([
      { id: 'p1', address: 'orders@studio.example' },
      { id: 'g1', address: 'kim@gmail.example' },
      { id: 'm1', address: 'noor@contoso.example' },
    ])
    api.found = { 'kim@gmail.example': 'google', 'noor@contoso.example': 'm365' }
  }

  describe('step 1, paste', () => {
    it('starts empty, with Continue off', async () => {
      const wrapper = await mountAt('/settings/accounts/import')

      expect(wrapper.get('h2.title').text()).toBe('Add several accounts')
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

      await wrapper.get('textarea').setValue('kim@company.example\ninfo@company.example\njeroen.smit.company.example\nsales@company.example, INFO@company.example\nanna@company\nKim Visser <kim.visser@outlook.example>')

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
    })

    it('says one address in the singular, and stops above 50', async () => {
      const wrapper = await mountAt('/settings/accounts/import')

      await wrapper.get('textarea').setValue('kim@company.example\nnope')
      expect(wrapper.get('#bulk-count').text()).toBe('2 addresses: 1 to add, 1 not valid.')
      expect(wrapper.get('.check-lead').text()).toBe('1 address needs a look. The others are ready.')
      expect(button(wrapper, 'Continue with 1 address').attributes('disabled')).toBeUndefined()

      await wrapper.get('textarea').setValue('kim@company.example')
      expect(wrapper.get('#bulk-count').text()).toBe('1 address: 1 to add.')
      expect(wrapper.get('.check-lead').text()).toBe('Every address looks right.')

      await wrapper.get('textarea').setValue(Array.from({ length: 52 }, (_, i) => `p${i}@company.example`).join('\n'))
      expect(wrapper.get('.limit').text()).toBe('52 of 50')
      expect(wrapper.get('.over-line').text()).toBe('That is 2 more than 50. Remove some addresses, or add the rest in a second list.')
      expect(button(wrapper, 'Continue').attributes('disabled')).toBeDefined()
    })

    it('names the addresses the API left out after all, and then opens the list', async () => {
      api.leftOut = [
        { address: 'kim@gmaіl.com', reason: 'invalid', message: 'This is not an email address.' },
        { address: 'Anna@company.example', reason: 'duplicate', message: 'This address is in the list already.' },
        { address: 'bob@company.example', reason: 'already_connected', message: 'This address is connected already.' },
      ]
      const wrapper = await mountAt('/settings/accounts/import')

      await wrapper.get('textarea').setValue('anna@company.example\nkim@gmaіl.com\ncarl@company.example\nbob@company.example')
      await button(wrapper, 'Continue with 4 addresses').trigger('click')
      await settle()

      expect(wrapper.router.currentRoute.value.params.importId).toBeUndefined()
      expect(texts(wrapper, '.issue-text')).toEqual([
        'The part after the @ is not complete. It is left out unless you fix it.',
        'It is added once.',
        'This account is already in Tresso. It is left out.',
      ])
      await button(wrapper, 'Continue with 1 address').trigger('click')
      await settle()
      expect(wrapper.router.currentRoute.value.params.importId).toBe(LIST_ID)
      expect(api.requests.filter((request) => request.path === '/api/v1/mail-account-imports' && request.method === 'POST')).toHaveLength(1)
    })

    it('back from a list, holds its addresses not connected yet, and Continue replaces that list', async () => {
      threeRows()
      api.entry('kim@gmail.example').state = 'connected'
      const wrapper = await mountAt(`/settings/accounts/import?from=${LIST_ID}`)

      expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('orders@studio.example\nnoor@contoso.example')
      await button(wrapper, 'Continue with 2 addresses').trigger('click')
      await settle()

      const calls = api.requests.filter((request) => request.path.startsWith('/api/v1/mail-account-imports') && request.method !== 'GET').map((request) => `${request.method} ${request.path}`)
      expect(calls).toEqual(['POST /api/v1/mail-account-imports', `DELETE /api/v1/mail-account-imports/${LIST_ID}`])
    })

    it('opens the new list even when the old one cannot be deleted', async () => {
      threeRows()
      api.failDelete = true
      const wrapper = await mountAt(`/settings/accounts/import?from=${LIST_ID}`)

      await button(wrapper, 'Continue with 3 addresses').trigger('click')
      await settle()

      expect(wrapper.router.currentRoute.value.params.importId).toBe(LIST_ID)
      expect(wrapper.find('.over-line').exists()).toBe(false)
    })
  })

  describe('step 2, the list', () => {
    it('shows the groups and starts nothing on load', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      expect(wrapper.get('h2.title').text()).toBe('Add several accounts')
      expect(wrapper.text()).toContain('Step 2 of 2. Sign in to each account. Microsoft and Google open in your browser. Other mail asks for its password here.')
      expect(wrapper.get('a[aria-label="Back to the addresses"]').attributes('href')).toBe(`/settings/accounts/import?from=${LIST_ID}`)
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
      expect(wrapper.get('.group-head .provider-mark').attributes('style')).toContain('font-size: 15px')
      expect(row(wrapper, 'kim@gmail.example').get('.provider-mark').attributes('style')).toContain('font-size: 12px')
      expect(button(wrapper, 'Next: noor@contoso.example').classes()).toContain('secondary')
      expect(button(wrapper, 'Sign in to all, one after another').classes()).toContain('primary')
      expect(wrapper.get('.list-note').text()).toBe(`This list is kept for 24 hours, until ${listTime(api.expiresAt)}. You can leave and continue later: choose Add several accounts in Settings, Accounts.`)
      expect(starts()).toEqual([])
      expect(opened).not.toHaveBeenCalled()
    })

    it('shows how it looks the addresses up, the second step once the first is done', async () => {
      threeRows()
      api.heldLookup = later<void>()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      expect(texts(wrapper, '.checks .label')).toEqual(['Checking which service handles each address', 'Choosing the easiest way to connect'])
      expect(wrapper.get('.checks li.running .label').text()).toBe('Checking which service handles each address')
      expect(wrapper.find('.next-button').exists()).toBe(false)

      api.heldLookup.settle()
      await settle()
      expect(wrapper.find('.checks').exists()).toBe(false)
      expect(texts(wrapper, '.group-title')).toEqual(['Microsoft 365', 'Google', 'Other mail with a password'])
    })

    it('opens the provider page in a tab the click opened, with the row address as hint, and offers the next', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await row(wrapper, 'kim@gmail.example').get('button').trigger('click')
      expect(opened).toHaveBeenCalledWith('', '_blank')
      await settle()

      expect(starts()[0]?.body).toEqual({ provider: 'google', features: ['mail', 'calendar'], emailAddress: 'kim@gmail.example', importId: LIST_ID })
      expect(tabs[0]).toMatchObject({ opener: null, location: { href: `${GOOGLE}?state=state-1` } })
      expect(isAwaited('state-1')).toBe(true)
      const waiting = row(wrapper, 'kim@gmail.example')
      expect(waiting.get('.row-state').text()).toBe('Waiting for the browser')
      expect(waiting.get('.row-hint').text()).toBe('Sign in at Google and allow access. This row updates by itself.')
      expect(waiting.get('button').text()).toBe('Open the page again')
      expect(wrapper.get('.run-line').text()).toBe('Signing in to kim@gmail.example. Nothing else starts after it.')

      const reply = await answer('state-1')

      expect(reply).toEqual({ taken: true, next: null })
      expect(row(wrapper, 'kim@gmail.example').get('.row-state').text()).toBe('Connected')
      expect(wrapper.get('#sum-title').text()).toBe('1 of 3 connected')
      expect(document.activeElement?.textContent).toBe('Next: noor@contoso.example')
      expect(wrapper.find('.visually-hidden[role="status"]').text()).toBe('Nothing starts by itself. Sign in to all in one go, or do them one at a time with Next.')
    })

    it('says when the browser blocked the page, and opens it again on a click', async () => {
      threeRows()
      allowTabs = false
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await row(wrapper, 'kim@gmail.example').get('button').trigger('click')
      await settle()
      expect(row(wrapper, 'kim@gmail.example').get('.row-hint').text()).toBe('The sign-in page did not open. Choose Open the page again.')

      allowTabs = true
      await row(wrapper, 'kim@gmail.example').get('button').trigger('click')
      await settle()
      expect(tabs[0]?.location.href).toBe(`${GOOGLE}?state=state-1`)
      expect(row(wrapper, 'kim@gmail.example').get('.row-hint').text()).toBe('Sign in at Google and allow access. This row updates by itself.')
    })

    it('signs in to all in the one tab the provider sends back, then opens the password row with its field focused', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()
      expect(opened).toHaveBeenCalledTimes(1)
      expect(document.activeElement?.textContent).toBe('Stop')
      expect(wrapper.get('.run-line').text()).toBe('Signing in one after another. Now: noor@contoso.example. Next: kim@gmail.example. After each sign-in the next one starts by itself.')
      expect(wrapper.find('.visually-hidden[role="status"]').text()).toBe('Signing in one after another. Now: noor@contoso.example. Next: kim@gmail.example. After each sign-in the next one starts by itself.')

      expect(await answer('state-1')).toEqual({ taken: true, next: `${GOOGLE}?state=state-2` })
      expect(startedFor()).toEqual(['noor@contoso.example', 'kim@gmail.example'])
      expect(opened).toHaveBeenCalledTimes(1)

      expect(await answer('state-2')).toEqual({ taken: true, next: null })
      const form = wrapper.get('form[aria-label="Password for orders@studio.example"]')
      expect(wrapper.get('.run-line').text()).toBe('Signing in one after another. Now: orders@studio.example.')
      expect(form.text()).toContain('Server settings found: imap.studio.example, port 993, and smtp.studio.example, port 465.')
      const username = form.get('input[name="username"]')
      expect(username.attributes()).toMatchObject({ type: 'email', autocomplete: 'username' })
      expect((username.element as HTMLInputElement).value).toBe('orders@studio.example')
      const password = form.get('input[type="password"]')
      expect(password.attributes()).toMatchObject({ name: 'password', autocomplete: 'current-password' })
      expect(form.get(`label[for="${password.attributes('id')}"]`).text()).toBe('Password for orders@studio.example')
      expect(document.activeElement).toBe(password.element)

      await password.setValue('typed-into-tresso')
      await form.trigger('submit')
      await settle()

      expect(api.requests.filter((request) => request.path.endsWith('/entry-states')).map((request) => request.body)).toEqual([{ entryId: 'p1', state: 'connected' }])
      expect(wrapper.get('.ending-title').text()).toBe('All 3 accounts added')
      expect(wrapper.get('.ending-sub').text()).toBe('Mail for the new accounts is coming in, newest first.')
      expect(texts(wrapper, '.added')).toEqual(['Microsoft 3651', 'Google1', 'Other mail with a password1'])
    })

    it('Stop gives up the row that waits: it is on To do again, and its answer finishes nothing', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()

      await button(wrapper, 'Stop').trigger('click')
      await settle()

      expect(row(wrapper, 'noor@contoso.example').get('.row-state').text()).toBe('To do')
      expect(wrapper.get('.run-line').text()).toBe('Nothing starts by itself. Sign in to all in one go, or do them one at a time with Next.')
      expect(wrapper.find('.visually-hidden[role="status"]').text()).toBe('Nothing starts by itself. Sign in to all in one go, or do them one at a time with Next.')
      expect(abandoned('state-1')).toBe('cancelled')
      expect(await answer('state-1')).toEqual({ taken: false, next: null })
      expect(starts()).toHaveLength(1)
    })

    it('takes no answer to a sign-in it does not wait for', async () => {
      threeRows()
      await mountAt(`/settings/accounts/import/${LIST_ID}`)

      expect(await answer('state-unknown')).toEqual({ taken: false, next: null })
    })

    it('lets only the row the run is at decide what follows', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await row(wrapper, 'kim@gmail.example').get('button').trigger('click')
      await settle()
      await row(wrapper, 'noor@contoso.example').get('button').trigger('click')
      await settle()

      await answer('state-1')

      expect(row(wrapper, 'kim@gmail.example').get('.row-state').text()).toBe('Connected')
      expect(row(wrapper, 'noor@contoso.example').get('.row-state').text()).toBe('Waiting for the browser')
      expect(wrapper.get('.run-line').text()).toBe('Signing in to noor@contoso.example. Nothing else starts after it.')
    })

    it('goes by the row as the API wrote it, not by the message', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()

      await answer('state-1', null, 'wrong_account')

      expect(wrapper.get('.stopped-title').text()).toBe('Stopped at noor@contoso.example')
      expect(starts()).toHaveLength(1)
    })

    it('stops at the first row that does not connect, focuses the way on, and continues or tries again', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()

      await answer('state-1', 'denied')

      const notice = wrapper.get('.stopped')
      expect(notice.attributes('role')).toBe('alert')
      expect(notice.get('.stopped-title').text()).toBe('Stopped at noor@contoso.example')
      expect(notice.get('.stopped-text').text()).toBe('Sign-in was cancelled. Nothing was connected for this address. 0 of 3 are connected so far.')
      expect(document.activeElement?.textContent).toBe('Continue with the next')
      const cancelled = row(wrapper, 'noor@contoso.example')
      expect(cancelled.get('.row-state').text()).toBe('Sign-in cancelled')
      expect(cancelled.get('.row-hint').text()).toBe('You closed the page or did not give access. Nothing was connected.')
      expect(cancelled.get('button').text()).toBe('Try again')
      expect(wrapper.get('.summary-line').text()).toBe('1 needs another try. 2 to go.')

      await button(wrapper, 'Continue with the next').trigger('click')
      await settle()
      expect(startedFor()).toEqual(['noor@contoso.example', 'kim@gmail.example'])
      expect(opened).toHaveBeenCalledTimes(2)

      await answer('state-2', 'denied')
      await button(wrapper, 'Try this one again').trigger('click')
      await settle()
      expect(startedFor()).toEqual(['noor@contoso.example', 'kim@gmail.example', 'kim@gmail.example'])
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
      expect(blocked.get('.row-hint').text()).toBe(`The IT team of contoso.example has to approve Tresso first. Send them ${APPROVAL}`)
      await button(wrapper, 'Copy approval link').trigger('click')
      expect(writeText).toHaveBeenCalledWith(APPROVAL)
    })

    it('shows every provider failure with its own words and action', async () => {
      const failures: ImportFailure[] = ['wrong_account', 'already_connected', 'unverified_address', 'no_mailbox', 'expired', 'scopes_missing', 'different_user', 'failed']
      api.setList(failures.map((failure, index) => ({ id: `g${index}`, address: `${failure.replace(/_/g, '-')}@gmail.example`, state: 'failed', failure })))
      api.found = Object.fromEntries(failures.map((failure) => [`${failure.replace(/_/g, '-')}@gmail.example`, 'google' as const]))
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      const shown = failures.map((failure) => {
        const line = row(wrapper, `${failure.replace(/_/g, '-')}@gmail.example`)
        return [line.get('.row-state').text(), line.get('.row-hint').text(), line.find('.row-action button').exists() ? line.get('.row-action button').text() : null]
      })
      expect(shown).toEqual([
        ['Signed in with another account', 'You signed in with a different Google account than this one. Sign in again with the address of this account.', 'Try again'],
        ['Already connected', 'This account is already in Tresso.', null],
        ['Sign-in failed', 'Google has not verified the address of this account yet, so Tresso cannot use it.', null],
        ['Sign-in failed', 'This Google account has no mailbox Tresso can sync.', null],
        ['Sign-in failed', 'That sign-in took too long or was already used. Try again.', 'Try again'],
        ['Sign-in failed', 'Tresso needs permission to read and send your mail. Sign in with Google again and leave those boxes ticked.', 'Try again'],
        ['Sign-in failed', 'The sign-in was started by another Tresso user. Sign in to Tresso as yourself, then try again.', 'Try again'],
        ['Sign-in failed', 'Connecting to Google failed. Try again in a moment.', 'Try again'],
      ])
    })

    it('says a sign-in came back signed out, on the row and in the stop notice', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()

      await handOverAndGoOn('state-1', { kind: 'signed-out' }, 2000)
      await settle()

      expect(wrapper.get('.stopped-text').text()).toBe('The sign-in came back in a tab that is signed out of Tresso. Sign in to Tresso there, then try again. 0 of 3 are connected so far.')
      expect(row(wrapper, 'noor@contoso.example').get('.row-hint').text()).toBe('The sign-in came back in a tab that is signed out of Tresso. Sign in to Tresso there, then try again.')
    })

    it('marks a sign-in that expires without an answer, and stops the run there', async () => {
      threeRows()
      api.signInMs = 30
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()

      await new Promise((resolve) => setTimeout(resolve, 60))
      await settle()

      expect(api.requests.find((request) => request.path.endsWith('/entry-states'))?.body).toEqual({ entryId: 'm1', state: 'failed', failure: 'expired' })
      expect(row(wrapper, 'noor@contoso.example').get('.row-state').text()).toBe('Sign-in failed')
      expect(wrapper.get('.stopped-title').text()).toBe('Stopped at noor@contoso.example')
      expect(abandoned('state-1')).toBe('cancelled')
    })

    it('shows the list as expired once its day is over while the page is open', async () => {
      threeRows()
      api.expiresAt = new Date(Date.now() + 80).toISOString()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await new Promise((resolve) => setTimeout(resolve, 120))
      await settle()

      expect(wrapper.get('.ending-title').text()).toBe('This list has expired')
      expect(wrapper.get('.ending-sub').text()).toBe(`A list of addresses is kept for 24 hours. This one was made on ${listTime('2026-11-24T10:12:00+00:00')}.`)
      expect(wrapper.get('.ending-text').text()).toBe('The 3 accounts were not added.')
    })

    it('says a refused password and the server problems on the row, empties the field, and never sends the password elsewhere', async () => {
      api.setList([{ id: 'p1', address: 'orders@studio.example' }])
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await row(wrapper, 'orders@studio.example').get('button').trigger('click')
      await settle()
      api.check = { imap: 'auth_failed', smtp: 'not_checked', detail: null }
      await wrapper.get('input[type="password"]').setValue('wrong-one')
      await wrapper.get('form').trigger('submit')
      await settle()

      const refused = row(wrapper, 'orders@studio.example')
      expect(refused.get('.row-state').text()).toBe('Password refused')
      expect(refused.get('.row-hint').text()).toBe('studio.example did not accept this password. Check that all of it was filled in.')
      expect(wrapper.find('form').exists()).toBe(false)
      expect(document.activeElement?.textContent?.trim()).toBe('Enter password')
      const marked = api.requests.filter((request) => request.path.endsWith('/entry-states'))
      expect(JSON.stringify(marked)).not.toContain('wrong-one')

      await refused.get('.row-action button').trigger('click')
      expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe('')

      for (const [status, sentence] of [
        ['unreachable', 'imap.studio.example did not answer on port 993.'],
        ['certificate', 'The security certificate of imap.studio.example could not be verified.'],
        ['blocked', 'Tresso does not connect to imap.studio.example: it is a private address.'],
        ['failed', 'imap.studio.example did not answer like a mail server.'],
      ] as const) {
        if (!wrapper.find('form').exists()) await row(wrapper, 'orders@studio.example').get('.row-action button').trigger('click')
        api.check = { imap: status, smtp: 'not_checked', detail: null }
        await wrapper.get('input[type="password"]').setValue('another')
        await wrapper.get('form').trigger('submit')
        await settle()
        const line = row(wrapper, 'orders@studio.example')
        expect(line.get('.row-state').text()).toBe('Server not reached')
        expect(line.get('.row-hint').text()).toBe(sentence)
        expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe('')
      }
      expect(row(wrapper, 'orders@studio.example').get('.row-action button').text()).toBe('Check settings')
    })

    it('names where the password goes when the servers are typed by hand', async () => {
      api.setList([{ id: 'p1', address: 'orders@studio.example' }])
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await row(wrapper, 'orders@studio.example').get('button').trigger('click')
      await settle()

      await button(wrapper, 'Change settings').trigger('click')

      expect(wrapper.get('.goes-to').text()).toBe('Tresso uses this password only to sign in at imap.studio.example and smtp.studio.example.')
    })

    it('checks once on a double submit, and Cancel on one row leaves the check of another', async () => {
      api.setList([
        { id: 'p1', address: 'orders@studio.example' },
        { id: 'p2', address: 'sales@studio.example' },
      ])
      api.heldCheck = later<void>()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await row(wrapper, 'orders@studio.example').get('button').trigger('click')
      await settle()
      await wrapper.get('input[type="password"]').setValue('one')
      await wrapper.get('form').trigger('submit')
      await wrapper.get('form').trigger('submit')
      await settle()
      expect(api.requests.filter((request) => request.path === '/api/v1/mail-account-checks')).toHaveLength(1)

      await row(wrapper, 'sales@studio.example').get('.row-action button').trigger('click')
      await settle()
      await wrapper.get('form[aria-label="Password for sales@studio.example"] input[type="password"]').setValue('two')
      await wrapper.get('form[aria-label="Password for sales@studio.example"]').trigger('submit')
      await settle()
      expect(row(wrapper, 'sales@studio.example').get('.row-state').text()).toBe('Signing in')

      await row(wrapper, 'orders@studio.example').get('.row-action button').trigger('click')
      await settle()
      expect(row(wrapper, 'orders@studio.example').get('.row-state').text()).toBe('To do')

      api.heldCheck.settle()
      await settle()
      expect(row(wrapper, 'sales@studio.example').get('.row-state').text()).toBe('Connected')
      expect(row(wrapper, 'orders@studio.example').get('.row-state').text()).toBe('To do')
    })

    it('finishes without the rest, lists what was added and skipped, and goes back to the skipped ones', async () => {
      api.setList([
        { id: 'g1', address: 'kim@gmail.example', state: 'connected' },
        { id: 'g2', address: 'team@gmail.example' },
        { id: 'g3', address: 'info@gmail.example', state: 'already_connected' },
        { id: 'p1', address: 'orders@studio.example', state: 'failed', failure: 'password_refused' },
      ])
      api.found = { 'kim@gmail.example': 'google', 'team@gmail.example': 'google', 'info@gmail.example': 'google' }
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await button(wrapper, 'Finish without the rest').trigger('click')
      await settle()

      expect(wrapper.get('.ending-title').text()).toBe('1 account added')
      expect(wrapper.get('.ending-sub').text()).toBe('2 were skipped. Mail for the new accounts is coming in, newest first.')
      expect(texts(wrapper, '.column-title')).toEqual(['Added', 'Skipped'])
      expect(texts(wrapper, '.added')).toEqual(['Google1'])
      expect(texts(wrapper, '.skipped')).toEqual(['team@gmail.example', 'orders@studio.example'])
      expect(wrapper.get('.small-note').text()).toBe(`You can still add the skipped ones until ${listTime(api.expiresAt)}.`)
      expect(document.activeElement?.textContent).toBe('Done')

      await button(wrapper, 'Go back to the skipped ones').trigger('click')
      await settle()
      expect(texts(wrapper, '.row-state')).toEqual(['Connected', 'To do', 'Already connected', 'To do'])
      expect(document.activeElement?.textContent).toBe('Next: team@gmail.example')
    })

    it('says no accounts were added when none were', async () => {
      api.setList([
        { id: 'g1', address: 'kim@gmail.example', state: 'skipped' },
        { id: 'g2', address: 'team@gmail.example', state: 'already_connected' },
      ])
      api.found = { 'kim@gmail.example': 'google', 'team@gmail.example': 'google' }
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      expect(wrapper.get('.ending-title').text()).toBe('No accounts added')
      expect(wrapper.get('.ending-sub').text()).toBe('1 was skipped.')
      expect(texts(wrapper, '.column-title')).toEqual(['Skipped'])
    })

    it('shows a list an app made only as addresses until the user uses them', async () => {
      threeRows()
      api.createdBy = 'Claude'
      api.confirmed = false
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      expect(wrapper.get('.assistant-text').text()).toBe('This list was made by Claude. Check the addresses before you sign in.')
      expect(button(wrapper, 'Use these addresses').classes()).toContain('primary')
      expect(button(wrapper, 'Delete this list').exists()).toBe(true)
      expect(texts(wrapper, '.row-address')).toEqual(['orders@studio.example', 'kim@gmail.example', 'noor@contoso.example'])
      expect(wrapper.findAll('.row-state, .row-action button, .summary')).toHaveLength(0)
      expect(api.requests.some((request) => request.path === '/api/v1/mail-server-settings')).toBe(false)

      await button(wrapper, 'Use these addresses').trigger('click')
      await settle()

      expect(api.requests.some((request) => request.method === 'POST' && request.path === `/api/v1/mail-account-imports/${LIST_ID}/confirmation`)).toBe(true)
      expect(texts(wrapper, '.group-title')).toEqual(['Microsoft 365', 'Google', 'Other mail with a password'])
      expect(wrapper.text()).not.toContain('Use these addresses')
      expect(wrapper.get('.assistant-text').text()).toBe('This list was made by Claude. Check the addresses before you sign in.')
      expect(starts()).toEqual([])
    })

    it('shows the app name as text, cut at 60 characters, and deletes the list', async () => {
      threeRows()
      api.createdBy = `<b>Assistant</b> ${'x'.repeat(80)}`
      api.confirmed = false
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      expect(wrapper.get('.assistant-text').text()).toBe(`This list was made by <b>Assistant</b> ${'x'.repeat(43)}…. Check the addresses before you sign in.`)
      expect(wrapper.find('.assistant-text b').exists()).toBe(false)

      await button(wrapper, 'Delete this list').trigger('click')
      await settle()
      expect(api.requests.some((request) => request.method === 'DELETE' && request.path === `/api/v1/mail-account-imports/${LIST_ID}`)).toBe(true)
      expect(wrapper.router.currentRoute.value.name).toBe('settings-accounts')
    })

    it('shows another user nothing of the list', async () => {
      threeRows()
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

    it('drops the list and gives up the run when another user signs in while the page is open', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()

      useAuthStore().generation++
      await settle()

      expect(wrapper.text()).not.toContain('noor@contoso.example')
      expect(abandoned('state-1')).toBe('cancelled')
    })

    it('after a reload mid-run starts nothing, and the sign-in under way finishes nothing', async () => {
      threeRows()
      const first = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await button(first, 'Sign in to all, one after another').trigger('click')
      await settle()
      first.unmount()

      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      expect(abandoned('state-1')).toBe('cancelled')
      expect(starts()).toHaveLength(1)
      expect(wrapper.get('.run-line').text()).toBe('Nothing starts by itself. Sign in to all in one go, or do them one at a time with Next.')
      expect(button(wrapper, 'Next: noor@contoso.example').exists()).toBe(true)
    })

    it('in the tab the provider sent back, finishes the sign-in, hands it over and goes on to the next page', async () => {
      threeRows()
      api.started['state-9'] = 'kim@gmail.example'
      markAwaiting('state-9', Date.now() + 60_000)
      const waiting = new BroadcastChannel('tresso-connect')
      waiting.onmessage = (event: MessageEvent<{ type: string; state: string }>) => {
        if (event.data.type === 'outcome') waiting.postMessage({ type: 'taken', state: event.data.state, next: `${MICROSOFT}?state=next` })
      }

      await mountAt(`/settings/accounts/import/${LIST_ID}?provider=google&state=state-9&code=code-1`)
      waiting.close()

      expect(api.requests.find((request) => request.path === '/api/v1/provider-connections')?.body).toEqual({ provider: 'google', state: 'state-9', code: 'code-1' })
      expect(assign).toHaveBeenCalledWith(`${MICROSOFT}?state=next`)
      expect(close).not.toHaveBeenCalled()
    })

    it('in the tab the provider sent back, closes when the run is over and shows the list should the browser keep it', async () => {
      threeRows()
      api.started['state-9'] = 'kim@gmail.example'
      markAwaiting('state-9', Date.now() + 60_000)
      const waiting = new BroadcastChannel('tresso-connect')
      waiting.onmessage = (event: MessageEvent<{ type: string; state: string }>) => {
        if (event.data.type === 'outcome') waiting.postMessage({ type: 'taken', state: event.data.state, next: null })
      }

      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}?provider=google&state=state-9&code=code-1`)
      waiting.close()

      expect(close).toHaveBeenCalled()
      expect(row(wrapper, 'kim@gmail.example').get('.row-state').text()).toBe('Connected')
    })

    it('in the tab the provider sent back, follows only a provider sign-in page', async () => {
      threeRows()
      api.started['state-9'] = 'kim@gmail.example'
      for (const next of ['https://evil.example/o/oauth2/v2/auth?state=x', 'http://accounts.google.com/o/oauth2/v2/auth?state=x', `${GOOGLE}?client_id=x`, 'javascript:alert(1)']) {
        markAwaiting('state-9', Date.now() + 60_000)
        const waiting = new BroadcastChannel('tresso-connect')
        waiting.onmessage = (event: MessageEvent<{ type: string; state: string }>) => {
          if (event.data.type === 'outcome') waiting.postMessage({ type: 'taken', state: event.data.state, next })
        }
        const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}?provider=google&state=state-9&code=code-1`)
        waiting.close()

        expect(assign).not.toHaveBeenCalled()
        expect(row(wrapper, 'kim@gmail.example').get('.row-state').text()).toBe('Connected')
        wrapper.unmount()
      }
    })

    it('in the tab the provider sent back, says it finishes the sign-in while it hands it over', async () => {
      threeRows()
      api.started['state-9'] = 'kim@gmail.example'
      markAwaiting('state-9', Date.now() + 60_000)
      const waiting = new BroadcastChannel('tresso-connect')
      let reply: (() => void) | null = null
      waiting.onmessage = (event: MessageEvent<{ type: string; state: string }>) => {
        if (event.data.type === 'outcome') reply = () => waiting.postMessage({ type: 'taken', state: event.data.state, next: null })
      }

      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}?provider=google&state=state-9&code=code-1`)

      expect(wrapper.get('.returning').text()).toBe('Finishing the sign-in\u2026')
      reply!()
      await settle()
      waiting.close()
      expect(wrapper.find('.returning').exists()).toBe(false)
    })

    it('in the tab the provider sent back after Stop, finishes nothing, closes, and says so should it stay', async () => {
      threeRows()
      const first = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await button(first, 'Sign in to all, one after another').trigger('click')
      await settle()
      await button(first, 'Stop').trigger('click')
      await settle()
      first.unmount()

      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}?provider=microsoft&state=state-1&code=code-1`)

      expect(api.requests.some((request) => request.path === '/api/v1/provider-connections')).toBe(false)
      expect(close).toHaveBeenCalled()
      expect(wrapper.get('.returning').text()).toBe('This sign-in was stopped. Nothing was connected.')
    })

    it('gives up what waits when the tab is closed or reloaded', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()

      window.dispatchEvent(new Event('pagehide'))

      expect(abandoned('state-1')).toBe('cancelled')
    })

    it('says the page did not open when the tab that came back waited too long for the next one', async () => {
      threeRows()
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)
      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()
      const now = Date.now()
      api.onStart = () => {
        vi.spyOn(Date, 'now').mockReturnValue(now + 21_000)
      }

      expect(await answer('state-1')).toEqual({ taken: true, next: null })
      vi.restoreAllMocks()

      expect(row(wrapper, 'kim@gmail.example').get('.row-hint').text()).toBe('The sign-in page did not open. Choose Open the page again.')
    })

    it('focuses the password field when a run starts at a password row', async () => {
      api.setList([{ id: 'p1', address: 'orders@studio.example' }])
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      await button(wrapper, 'Sign in to all, one after another').trigger('click')
      await settle()

      expect(document.activeElement).toBe(wrapper.get('input[type="password"]').element)
    })

    it('counts a row that cannot be tried again as no try left, and an already connected one as finished', async () => {
      api.setList([
        { id: 'g1', address: 'kim@gmail.example', state: 'failed', failure: 'no_mailbox' },
        { id: 'g2', address: 'team@gmail.example', state: 'failed', failure: 'denied' },
        { id: 'g3', address: 'info@gmail.example' },
      ])
      api.found = { 'kim@gmail.example': 'google', 'team@gmail.example': 'google', 'info@gmail.example': 'google' }
      const wrapper = await mountAt(`/settings/accounts/import/${LIST_ID}`)

      expect(wrapper.get('.summary-line').text()).toBe('1 needs another try. 1 to go.')
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

      expect(desktop.opened).toEqual([`${MICROSOFT}?state=state-1`, `${GOOGLE}?state=state-2`])
      expect(opened).not.toHaveBeenCalled()
      expect(row(wrapper, 'noor@contoso.example').get('.row-state').text()).toBe('Connected')
    })
  })

  it('puts "Add several accounts" before "Add account" in Settings, Accounts, leading to the list still open', async () => {
    const wrapper = await mountAt('/settings/accounts')
    const links = wrapper.findAll('.header a')
    expect(links.map((link) => link.text())).toEqual(['Add several accounts', 'Add account'])
    expect(links[0]!.attributes('href')).toBe('/settings/accounts/import')

    api.setList([{ id: 'g1', address: 'kim@gmail.example', state: 'skipped' }])
    const again = await mountAt('/settings/accounts')
    expect(again.findAll('.header a')[0]!.attributes('href')).toBe(`/settings/accounts/import/${LIST_ID}`)
  })
})
