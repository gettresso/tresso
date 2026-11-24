import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h, onMounted } from 'vue'
import { RouterView, createMemoryHistory, createRouter, useRoute } from 'vue-router'
import type { ImportFailure, MailAccountImport, MailAccountImportEntry, ProviderConnection } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'
import { noteStarted } from '../importRun'
import { useAccountImport } from '../useAccountImport'

/**
 * The logic of the "Add several accounts" page, driven as the page drives it, against a fake API: nothing starts on
 * load, a row signs in with its address as the hint and comes back to the list, "Sign in to all" goes on by itself
 * after each connected answer and stops at the first that is not, and a password row is checked before it is created.
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

type Entry = Pick<MailAccountImportEntry, 'id' | 'address' | 'provider'> & { state?: MailAccountImportEntry['state']; failure?: ImportFailure | null }

/** A fake API holding one list of Kim's; Lisa's token gets 404 for it. */
class FakeApi {
  entries: MailAccountImportEntry[] = []
  createdBy: string | null = null
  requests: { method: string; path: string; body: unknown }[] = []
  /** Per address: the provider the lookup finds. */
  found: Record<string, 'google' | 'm365' | 'icloud' | null> = {}
  /** How the next provider sign-in ends. */
  nextResult: ProviderConnection = { provider: 'google', connected: 'acc-1', grant: null, connectError: null, requested: ['mail'], missing: [], existing: false, approvalUrl: null }
  checkResult = { imap: 'ok', smtp: 'ok', detail: null as string | null }
  signIns = 0
  /** The entry each started sign-in is for, by OAuth state. */
  started: Record<string, string> = {}

  setList(entries: Entry[], createdBy: string | null = null): void {
    this.createdBy = createdBy
    this.entries = entries.map((entry) => ({ state: 'todo', failure: null, reason: null, mailAccountId: null, accountStatus: null, ...entry, provider: entry.provider ?? null }) as MailAccountImportEntry)
  }

  list(): MailAccountImport {
    const progress = { todo: 0, connected: 0, failed: 0, skipped: 0 }
    for (const entry of this.entries) progress[entry.state]++
    return { id: LIST_ID, entries: this.entries, progress, createdBy: this.createdBy, pageUrl: `http://localhost:5173/settings/accounts/import/${LIST_ID}`, createdAt: '2026-11-24T10:00:00+00:00', expiresAt: '2026-11-25T10:00:00+00:00', leftOut: [] }
  }

  entry(address: string): MailAccountImportEntry {
    return this.entries.find((entry) => entry.address === address)!
  }

  async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    const authorization = new Headers(init?.headers).get('Authorization') ?? ''
    this.requests.push({ method, path: url.pathname, body })
    const path = url.pathname
    if (path === '/api/v1/oauth-providers') return Response.json([{ id: 'google', name: 'Google', features: ['mail', 'calendar'] }, { id: 'microsoft', name: 'Microsoft', features: ['mail'] }])
    if (path === '/api/v1/mail-server-settings') {
      const address = url.searchParams.get('emailAddress') ?? ''
      const provider = this.found[address] ?? null
      const imap = provider === null ? { host: `imap.${address.split('@')[1]}`, port: 993, security: 'tls' } : null
      return Response.json({ emailAddress: address, found: provider === null, source: null, username: address, imap, smtp: imap === null ? null : { ...imap, host: imap.host.replace('imap', 'smtp'), port: 465 }, authentication: ['password'], provider })
    }
    if (path === `/api/v1/mail-account-imports/${LIST_ID}` && method === 'GET') {
      return authorization.includes('lisa') ? Response.json({ detail: 'Import list not found.' }, { status: 404 }) : Response.json(this.list())
    }
    if (path === '/api/v1/mail-account-imports' && method === 'POST') {
      this.setList((body!.entries as { address: string }[]).map((entry, index) => ({ id: `n${index}`, address: entry.address.toLowerCase(), provider: null })))
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
      return Response.json({ authorizationUrl: `https://${String(body!.provider)}.example/auth?state=${state}&login_hint=${encodeURIComponent(String(body!.emailAddress))}`, provider: body!.provider, expiresAt: new Date(Date.now() + 900_000).toISOString() }, { status: 201 })
    }
    if (path === '/api/v1/provider-connections') {
      const address = this.started[String(body!.state)]!
      const entry = this.entry(address)
      if (this.nextResult.connectError === null) {
        entry.state = 'connected'
        entry.mailAccountId = `acc-${entry.id}`
      } else {
        entry.state = 'failed'
        entry.failure = this.nextResult.connectError as ImportFailure
      }
      return Response.json(this.nextResult)
    }
    if (path === '/api/v1/mail-account-checks') return Response.json(this.checkResult)
    if (path === '/api/v1/mail-accounts' && method === 'POST') {
      const entry = this.entry(String(body!.emailAddress))
      entry.state = 'connected'
      return Response.json({ id: `acc-${entry.id}`, emailAddress: entry.address }, { status: 201 })
    }
    return Response.json({ detail: `Unexpected ${method} ${path}` }, { status: 500 })
  }
}

type Page = ReturnType<typeof useAccountImport>

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('the logic of the "Add several accounts" page', () => {
  let api: FakeApi
  const assign = vi.fn<(url: string) => void>()
  let page: Page

  function token(name: string): void {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: `${name}-token`, refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
  }

  beforeEach(async () => {
    api = new FakeApi()
    desktop.on = false
    desktop.opened.length = 0
    assign.mockReset()
    vi.stubGlobal('location', { ...window.location, assign })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => api.handle(input, init)))
    token('kim')
    setActivePinia(createPinia())
    await useAuthStore().restore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  /** Opens the page as the browser would, at the list's address with this query. */
  async function openPage(query: Record<string, string> = {}) {
    const Host = defineComponent({
      setup() {
        const route = useRoute()
        page = useAccountImport(computed(() => (typeof route.params.importId === 'string' ? route.params.importId : null)))
        onMounted(() => void page.open())
        return () => h('div')
      },
    })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/accounts/import/:importId?', name: 'settings-accounts-import', component: Host },
        { path: '/settings/accounts', name: 'settings-accounts', component: Host },
      ],
    })
    await router.push({ name: 'settings-accounts-import', params: { importId: LIST_ID }, query })
    await router.isReady()
    mount(defineComponent({ render: () => h(RouterView) }), { global: { plugins: [router] } })
    await settle()
    return router
  }

  /** The provider sends this tab back with its answer to the sign-in with this state, as a fresh page load. */
  async function comeBack(state: string, provider = 'google') {
    setActivePinia(createPinia())
    await useAuthStore().restore()
    return openPage({ provider, state, code: 'code-1' })
  }

  function starts() {
    return api.requests.filter((request) => request.path === '/api/v1/provider-authorizations')
  }

  it('starts nothing on load, also with a run noted from before', async () => {
    api.setList([{ id: 'g1', address: 'kim@gmail.example', provider: null }])
    api.found = { 'kim@gmail.example': 'google' }
    noteStarted({ importId: LIST_ID, entryId: 'g1', mode: 'all', state: 'state-old', expiresAt: Date.now() + 60_000 })

    await openPage()

    expect(page.status.value).toBe('ready')
    expect(starts()).toEqual([])
    expect(assign).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('tresso.import.run')).toBeNull()
  })

  it('finds how each row connects: the lookup first, the hint when it finds nothing, grouped by provider', async () => {
    api.setList([
      { id: 'p1', address: 'anna@partner.example', provider: 'google' },
      { id: 'm1', address: 'kim@contoso.example', provider: null },
      { id: 'g1', address: 'kim@gmail.example', provider: 'microsoft' },
      { id: 'h1', address: 'bob@unknown.example', provider: 'google' },
      { id: 'i1', address: 'kim@icloud.example', provider: null },
    ])
    api.found = { 'kim@contoso.example': 'm365', 'kim@gmail.example': 'google', 'bob@unknown.example': null, 'kim@icloud.example': 'icloud' }
    // bob@unknown.example: the lookup finds servers, so the hint is not used.

    await openPage()

    expect(page.ordered.value.map((row) => [row.id, row.route])).toEqual([
      ['g1', { kind: 'oauth', provider: 'google' }],
      ['m1', { kind: 'oauth', provider: 'microsoft' }],
      ['p1', { kind: 'password', service: null }],
      ['h1', { kind: 'password', service: null }],
      ['i1', { kind: 'password', service: 'icloud' }],
    ])
    expect(page.ordered.value.find((row) => row.id === 'i1')?.servers?.imap.host).toBe('imap.mail.me.com')
  })

  it('signs a row in with its address as the hint, and comes back to the list with the next one offered', async () => {
    api.setList([
      { id: 'g1', address: 'kim@gmail.example', provider: null },
      { id: 'g2', address: 'team@gmail.example', provider: null },
    ])
    api.found = { 'kim@gmail.example': 'google', 'team@gmail.example': 'google' }
    await openPage()

    await page.signIn('g1')

    expect(starts()[0]?.body).toEqual({ provider: 'google', features: ['mail', 'calendar'], emailAddress: 'kim@gmail.example', importId: LIST_ID })
    expect(assign).toHaveBeenCalledWith('https://google.example/auth?state=state-1&login_hint=kim%40gmail.example')

    const router = await comeBack('state-1')

    expect(router.currentRoute.value.query).toEqual({})
    expect(api.requests.find((request) => request.path === '/api/v1/provider-connections')?.body).toEqual({ provider: 'google', state: 'state-1', code: 'code-1' })
    expect(page.rows.value.find((row) => row.id === 'g1')?.state).toBe('connected')
    expect(page.lastEvent.value).toEqual({ kind: 'connected', entryId: 'g1' })
    expect(page.offer.value).toBe('g2')
    expect(starts()).toHaveLength(1)

    await page.takeOffer()
    expect(starts()[1]?.body).toMatchObject({ emailAddress: 'team@gmail.example', importId: LIST_ID })
  })

  it('signs in to all one after another, and stops at the first that does not connect', async () => {
    api.setList([
      { id: 'm1', address: 'kim@contoso.example', provider: null },
      { id: 'g1', address: 'kim@gmail.example', provider: null },
      { id: 'g2', address: 'team@gmail.example', provider: null },
      { id: 'p1', address: 'anna@partner.example', provider: null },
    ])
    api.found = { 'kim@contoso.example': 'm365', 'kim@gmail.example': 'google', 'team@gmail.example': 'google' }
    await openPage()

    await page.signInAll()
    expect(starts().map((start) => (start.body as { emailAddress: string }).emailAddress)).toEqual(['kim@gmail.example'])
    expect(page.running.value).toBe(true)

    await comeBack('state-1')
    expect(starts().map((start) => (start.body as { emailAddress: string }).emailAddress)).toEqual(['kim@gmail.example', 'team@gmail.example'])
    expect(assign).toHaveBeenCalledTimes(2)

    api.nextResult = { ...api.nextResult, connected: null, connectError: 'denied' }
    await comeBack('state-2')

    expect(starts()).toHaveLength(2)
    expect(page.running.value).toBe(false)
    expect(page.lastEvent.value).toEqual({ kind: 'failed', entryId: 'g2' })
    expect(page.rows.value.find((row) => row.id === 'g2')).toMatchObject({ state: 'failed', failure: 'denied' })
    expect(page.offer.value).toBeNull()
  })

  it('starts nothing more after Stop; the sign-in under way still finishes', async () => {
    desktop.on = true
    api.setList([
      { id: 'g1', address: 'kim@gmail.example', provider: null },
      { id: 'g2', address: 'team@gmail.example', provider: null },
    ])
    api.found = { 'kim@gmail.example': 'google', 'team@gmail.example': 'google' }
    const router = await openPage()

    await page.signInAll()
    expect(desktop.opened).toHaveLength(1)
    page.stopAll()
    // The desktop app's link brings the answer while the page stays.
    await router.replace({ name: 'settings-accounts-import', params: { importId: LIST_ID }, query: { provider: 'google', state: 'state-1', code: 'code-1' } })
    await settle()

    expect(page.rows.value.find((row) => row.id === 'g1')?.state).toBe('connected')
    expect(desktop.opened).toHaveLength(1)
    expect(page.offer.value).toBe('g2')
    expect(assign).not.toHaveBeenCalled()
  })

  it('in the desktop app goes on by itself in the system browser', async () => {
    desktop.on = true
    api.setList([
      { id: 'g1', address: 'kim@gmail.example', provider: null },
      { id: 'm1', address: 'kim@contoso.example', provider: null },
    ])
    api.found = { 'kim@gmail.example': 'google', 'kim@contoso.example': 'm365' }
    const router = await openPage()

    await page.signInAll()
    await router.replace({ name: 'settings-accounts-import', params: { importId: LIST_ID }, query: { provider: 'google', state: 'state-1', code: 'code-1' } })
    await settle()

    expect(desktop.opened).toEqual(['https://google.example/auth?state=state-1&login_hint=kim%40gmail.example', 'https://microsoft.example/auth?state=state-2&login_hint=kim%40contoso.example'])
    expect(starts()[1]?.body).toMatchObject({ provider: 'microsoft', features: ['mail'] })
  })

  it('finishes an answer it did not start, but starts nothing after it', async () => {
    api.setList([
      { id: 'g1', address: 'kim@gmail.example', provider: null },
      { id: 'g2', address: 'team@gmail.example', provider: null },
    ])
    api.found = { 'kim@gmail.example': 'google', 'team@gmail.example': 'google' }
    api.started['state-elsewhere'] = 'kim@gmail.example'

    await openPage({ provider: 'google', state: 'state-elsewhere', code: 'code-1' })

    expect(page.rows.value.find((row) => row.id === 'g1')?.state).toBe('connected')
    expect(starts()).toEqual([])
    expect(page.offer.value).toBeNull()
  })

  it('checks a password row before connecting it, and records a refused password on the row', async () => {
    api.setList([{ id: 'p1', address: 'anna@partner.example', provider: 'imap' }])
    await openPage()
    const row = page.rows.value[0]!
    expect(row.route).toEqual({ kind: 'password', service: null })
    const values = { imap: row.servers!.imap, smtp: row.servers!.smtp, username: 'anna@partner.example', password: 'typed-into-tresso' }

    api.checkResult = { imap: 'auth_failed', smtp: 'not_checked', detail: null }
    expect(await page.connectWithPassword('p1', values)).toBe(false)
    expect(page.rows.value[0]).toMatchObject({ state: 'failed', failure: 'password_refused' })
    const marked = api.requests.find((request) => request.path.endsWith('/entry-states'))
    expect(marked?.body).toEqual({ entryId: 'p1', state: 'failed', failure: 'password_refused' })
    expect(JSON.stringify(marked)).not.toContain('typed-into-tresso')

    api.checkResult = { imap: 'ok', smtp: 'ok', detail: null }
    expect(await page.connectWithPassword('p1', values)).toBe(true)
    expect(api.requests.find((request) => request.path === '/api/v1/mail-accounts' && request.method === 'POST')?.body).toMatchObject({ emailAddress: 'anna@partner.example', password: 'typed-into-tresso', imap: { host: 'imap.partner.example' } })
    expect(page.rows.value[0]?.state).toBe('connected')
    expect(page.lastEvent.value).toEqual({ kind: 'connected', entryId: 'p1' })
  })

  it('skips a row and takes it back', async () => {
    api.setList([{ id: 'g1', address: 'kim@gmail.example', provider: null }])
    api.found = { 'kim@gmail.example': 'google' }
    await openPage()

    await page.setSkipped('g1', true)
    expect(page.rows.value[0]?.state).toBe('skipped')
    expect(page.providerRowsLeft.value).toBe(false)
    await page.setSkipped('g1', false)
    expect(page.rows.value[0]?.state).toBe('todo')
  })

  it('names the app that made the list', async () => {
    api.setList([{ id: 'g1', address: 'kim@gmail.example', provider: null }], 'Claude')

    await openPage()

    expect(page.createdBy.value).toBe('Claude')
  })

  it('shows another user nothing of the list', async () => {
    api.setList([{ id: 'g1', address: 'kim@gmail.example', provider: null }])
    token('lisa')
    setActivePinia(createPinia())
    await useAuthStore().restore()

    await openPage()

    expect(page.status.value).toBe('missing')
    expect(page.rows.value).toEqual([])
  })

  it('drops the list and the run when another user signs in', async () => {
    api.setList([{ id: 'g1', address: 'kim@gmail.example', provider: null }])
    api.found = { 'kim@gmail.example': 'google' }
    desktop.on = true
    await openPage()
    await page.signInAll()

    useAuthStore().generation++
    await settle()

    expect(page.rows.value).toEqual([])
    expect(page.running.value).toBe(false)
    expect(sessionStorage.getItem('tresso.import.run')).toBeNull()
  })

  it('makes a list from pasted addresses and opens its page', async () => {
    const router = await openPage()

    const outcome = await page.createFromText('Kim@Gmail.example\nanna@partner.example, bob@partner.example')
    await settle()

    expect(outcome).toMatchObject({ ok: true })
    expect(api.requests.find((request) => request.path === '/api/v1/mail-account-imports' && request.method === 'POST')?.body).toEqual({
      entries: [{ address: 'Kim@Gmail.example' }, { address: 'anna@partner.example' }, { address: 'bob@partner.example' }],
    })
    expect(router.currentRoute.value.params.importId).toBe(LIST_ID)
    expect(await page.createFromText(' \n ,')).toMatchObject({ ok: false, problem: 'empty' })
    expect(await page.createFromText(Array.from({ length: 51 }, (_, i) => `p${i}@partner.example`).join('\n'))).toMatchObject({ ok: false, problem: 'too-many' })
  })
})
