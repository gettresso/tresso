import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { MailAccount, MailAccountCheck, ProviderConnection, SuggestedServerSettings, SyncedMailAccount } from '@tresso/core'
import { useMailStore } from '@/stores/mail'
import AddAccountView from '../AddAccountView.vue'

const created: MailAccount = {
  id: 'acc-1',
  emailAddress: 'kim@fastmail.com',
  displayName: 'kim',
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

const gmail: MailAccount = { ...created, id: 'acc-g', emailAddress: 'kim@gmail.com', displayName: 'Kim Visser', provider: 'gmail', username: null, imap: null, smtp: null }

function suggestion(emailAddress: string, overrides: Partial<SuggestedServerSettings> = {}): SuggestedServerSettings {
  return { emailAddress, found: false, source: null, username: null, imap: null, smtp: null, authentication: [], provider: null, ...overrides }
}

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return { provider: 'google', connected: 'acc-g', grant: null, connectError: null, requested: ['mail', 'calendar'], missing: [], existing: false, approvalUrl: null, ...overrides }
}

function synced(account: MailAccount): SyncedMailAccount {
  const { id, emailAddress, displayName, provider, status, statusDetail, lastSyncedAt, defaultSignatureId, calendarStatus, calendarStatusDetail } = account
  return { id, emailAddress, displayName, provider, status, statusDetail, lastSyncedAt, defaultSignatureId, calendarStatus, calendarStatusDetail }
}

/** Lookups, checks and the steps' short pauses; let them all finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('connecting a mail account', () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  let suggestions: Record<string, SuggestedServerSettings>
  let checkResult: MailAccountCheck
  let connected: ProviderConnection
  let existingAccounts: MailAccount[]
  let providers: { id: string; name: string; features: string[] }[]
  let accounts: Record<string, MailAccount>
  /** While set, checks wait for it: to see the checking step. */
  let holdCheck: Promise<void> | null
  /** While set, creating an account waits for it. */
  let holdCreate: Promise<void> | null
  /** While set, the provider list waits for it. */
  let holdProviders: Promise<void> | null
  const opened = vi.fn<(url: string, target?: string, features?: string) => null>()

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    suggestions = {}
    checkResult = { emailAddress: 'kim@fastmail.com', imap: 'ok', smtp: 'ok', folders: 4, detail: null }
    connected = connection()
    existingAccounts = []
    providers = [
      { id: 'google', name: 'Google', features: ['mail', 'calendar'] },
      { id: 'microsoft', name: 'Microsoft', features: ['mail', 'calendar'] },
    ]
    accounts = { 'acc-g': gmail, 'acc-1': created }
    holdCheck = null
    holdCreate = null
    holdProviders = null
    opened.mockReset()
    vi.stubGlobal('open', opened)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        requests.push({ method, path: url.pathname + url.search, body })
        const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
        if (url.pathname === '/api/v1/mail-server-settings') {
          const address = url.searchParams.get('emailAddress') ?? ''
          return json(suggestions[address] ?? suggestion(address))
        }
        if (url.pathname === '/api/v1/oauth-providers') {
          if (holdProviders) await holdProviders
          return json(providers)
        }
        if (url.pathname === '/api/v1/server-info') return json({ product: 'tresso-server', apiVersion: 1, billing: false, trialDays: 0, allowUnencryptedMailServers: false })
        if (url.pathname === '/api/v1/provider-authorizations' && method === 'POST') {
          return json({ authorizationUrl: `https://accounts.google.example/o/oauth2/v2/auth?state=state-${requests.length}`, provider: body.provider, expiresAt: new Date(Date.now() + 900_000).toISOString() }, 201)
        }
        if (url.pathname === '/api/v1/provider-connections' && method === 'POST') return json(connected)
        if (url.pathname === '/api/v1/mail-account-checks' && method === 'POST') {
          if (holdCheck) await holdCheck
          return json(checkResult)
        }
        if (url.pathname.startsWith('/api/v1/mail-accounts/') && method === 'DELETE') return new Response(null, { status: 204 })
        if (url.pathname === '/api/v1/mail-accounts' && method === 'POST') {
          if (holdCreate) await holdCreate
          accounts['acc-1'] = { ...created, emailAddress: body.emailAddress, displayName: body.displayName, username: body.username, imap: body.imap, smtp: body.smtp }
          return json(accounts['acc-1'], 201)
        }
        if (url.pathname === '/api/v1/mail-accounts') return json(existingAccounts)
        const id = url.pathname.split('/').pop() ?? ''
        if (url.pathname.startsWith('/api/v1/mail-accounts/') && method === 'PATCH') {
          accounts[id] = { ...accounts[id]!, ...body }
          return json(accounts[id])
        }
        if (url.pathname.startsWith('/api/v1/mail-accounts/') && accounts[id]) return json(accounts[id])
        return json({ detail: 'Unexpected request' }, 500)
      }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    sessionStorage.clear()
    globalThis.localStorage?.clear()
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
    await settle()
    return Object.assign(wrapper, { router })
  }

  /** The last sign-in the dialog started at the API. */
  function lastStart() {
    const started = requests.filter((r) => r.path === '/api/v1/provider-authorizations')
    return started[started.length - 1]
  }

  function dialog(wrapper: VueWrapper) {
    return wrapper.get('dialog.connect-dialog')
  }

  function button(wrapper: VueWrapper, text: string) {
    const found = dialog(wrapper)
      .findAll('button')
      .find((candidate) => candidate.text().trim() === text)
    if (!found) throw new Error(`No button "${text}" in: ${dialog(wrapper).text()}`)
    return found
  }

  async function enterAddress(wrapper: VueWrapper, address: string): Promise<void> {
    await dialog(wrapper).get('input[type="email"]').setValue(address)
    await dialog(wrapper).get('form').trigger('submit')
    await settle()
    await vi.advanceTimersByTimeAsync(400)
    await settle()
  }

  it('starts with the address alone', async () => {
    const wrapper = await mountView()

    expect(dialog(wrapper).text()).toContain('Step 1 of 3')
    expect(dialog(wrapper).get('h1').text()).toBe('Connect a mail account')
    expect(dialog(wrapper).text()).toContain('Your mail stays with your provider. Passwords and sign-in tokens are encrypted, and you can disconnect at any time.')
    expect(dialog(wrapper).findAll('input').map((input) => input.attributes('type'))).toEqual(['email'])
    expect(dialog(wrapper).find('[aria-label="Back"]').exists()).toBe(false)
    expect(dialog(wrapper).findAll('button').map((candidate) => candidate.text().trim())).toEqual(['', 'Choose my provider myself', 'Continue'])
  })

  it('says when the address cannot be one, without looking anything up', async () => {
    const wrapper = await mountView()

    await enterAddress(wrapper, 'kim.company.example')

    expect(dialog(wrapper).get('[role="alert"]').text()).toBe('This does not look like an email address. Check for a missing @ or a typo.')
    expect(dialog(wrapper).get('input[type="email"]').attributes('aria-invalid')).toBe('true')
    expect(requests.some((r) => r.path.startsWith('/api/v1/mail-server-settings'))).toBe(false)
  })

  it('says at once that an address is connected already', async () => {
    existingAccounts = [{ ...created, emailAddress: 'kim@fastmail.com' }]
    const wrapper = await mountView()

    await enterAddress(wrapper, 'Kim@FastMail.com')

    expect(dialog(wrapper).get('[role="alert"]').text()).toBe('This address is already connected. You find it under Settings, Accounts.')
    expect(requests.some((r) => r.path.startsWith('/api/v1/mail-server-settings'))).toBe(false)
  })

  it('shows what it is doing while it finds the provider, and can be cancelled', async () => {
    const wrapper = await mountView()
    await dialog(wrapper).get('input[type="email"]').setValue('kim@company.example')
    await dialog(wrapper).get('form').trigger('submit')
    await flushPromises()

    expect(dialog(wrapper).get('h1').text()).toBe('Finding your provider')
    expect(dialog(wrapper).text()).toContain('Looking at company.example')
    await button(wrapper, 'Cancel').trigger('click')
    await settle()
    expect(dialog(wrapper).get('h1').text()).toBe('Connect a mail account')
  })

  describe('a provider with its own sign-in page', () => {
    beforeEach(() => {
      suggestions['kim@company.example'] = suggestion('kim@company.example', { provider: 'm365' })
      suggestions['kim@gmail.com'] = suggestion('kim@gmail.com', { found: true, provider: 'google', imap: { host: 'imap.gmail.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' } })
    })

    it('explains the sign-in, with calendars on by default', async () => {
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@company.example')

      expect(dialog(wrapper).text()).toContain('Step 2 of 3')
      expect(dialog(wrapper).get('h1').text()).toBe('Open your browser to link your Microsoft 365 account')
      expect(dialog(wrapper).text()).toContain("You sign in on Microsoft's own page and allow Tresso to read and send your mail. Tresso never sees your password.")
      expect(dialog(wrapper).text()).toContain('kim@company.example uses Microsoft 365')
      expect(dialog(wrapper).get('[role="switch"]').attributes('aria-checked')).toBe('true')
      expect(dialog(wrapper).find('input[type="password"]').exists()).toBe(false)
    })

    it('opens the sign-in page in a new tab and waits, asking for calendars and naming the address', async () => {
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@company.example')

      await button(wrapper, 'Proceed in browser').trigger('click')
      await settle()

      const started = requests.filter((r) => r.path === '/api/v1/provider-authorizations')
      expect(started[started.length - 1]?.body).toEqual({ provider: 'microsoft', features: ['mail', 'calendar'], emailAddress: 'kim@company.example' })
      expect(opened).toHaveBeenCalledWith(expect.stringContaining('https://accounts.google.example/'), '_blank', 'noopener')
      expect(dialog(wrapper).get('h1').text()).toBe('Finish in your browser')
      expect(dialog(wrapper).text()).toContain('Waiting for Microsoft...')

      await button(wrapper, 'Open the page again').trigger('click')
      await settle()
      expect(opened).toHaveBeenCalledTimes(2)
      expect(opened.mock.calls[1]![0]).toBe(opened.mock.calls[0]![0])

      await button(wrapper, 'Cancel').trigger('click')
      await settle()
      expect(dialog(wrapper).get('h1').text()).toBe('Open your browser to link your Microsoft 365 account')
    })

    it('asks for mail alone when calendars are switched off', async () => {
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@gmail.com')

      await dialog(wrapper).get('[role="switch"]').trigger('click')
      await settle()
      await button(wrapper, 'Proceed in browser').trigger('click')
      await settle()

      expect(lastStart()?.body).toEqual({ provider: 'google', features: ['mail'], emailAddress: 'kim@gmail.com' })
    })

    it('goes to the server form when this server cannot sign in with the provider', async () => {
      providers = [{ id: 'microsoft', name: 'Microsoft', features: ['mail'] }]
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@gmail.com')

      expect(dialog(wrapper).get('h1').text()).toBe('Set up manually')
      expect(dialog(wrapper).text()).toContain('Google normally signs you in through its own page, which this server does not offer.')
      expect((dialog(wrapper).find('input.mono').element as HTMLInputElement).value).toBe('imap.gmail.com')
    })
  })

  describe('back from the provider', () => {
    it('is connected right away, before the first sync is done, and saves the name on Done', async () => {
      const wrapper = await mountView('/settings/accounts/new?provider=google&state=state-1&code=code-1')

      expect(requests.find((r) => r.path === '/api/v1/provider-connections')?.body).toEqual({ provider: 'google', state: 'state-1', code: 'code-1' })
      expect(wrapper.router.currentRoute.value.query).toEqual({})
      expect(dialog(wrapper).text()).toContain('Step 3 of 3')
      expect(dialog(wrapper).get('h1').text()).toBe("You're connected")
      expect(dialog(wrapper).text()).toContain('kim@gmail.com, Google')
      expect(dialog(wrapper).text()).toContain('Newest mail first.')
      expect(dialog(wrapper).text()).toContain('Looking for your calendars...')

      await dialog(wrapper).get('input:not([type])').setValue('Kim V.')
      expect(dialog(wrapper).text()).toContain('People see this when you write from this account: Kim V. <kim@gmail.com>')
      await button(wrapper, 'Done').trigger('click')
      await settle()

      expect(requests.find((r) => r.method === 'PATCH')).toMatchObject({ path: '/api/v1/mail-accounts/acc-g', body: { displayName: 'Kim V.' } })
      expect(wrapper.router.currentRoute.value.name).toBe('account')
    })

    it('shows the calendars that arrived, and offers them when they were not allowed', async () => {
      connected = connection({ missing: ['calendar'] })
      accounts['acc-g'] = { ...gmail, calendarStatus: 'not_granted', calendarStatusDetail: 'Tresso is not allowed to use the calendars of this account yet.' }
      const wrapper = await mountView('/settings/accounts/new?provider=google&state=state-1&code=code-1')

      expect(dialog(wrapper).text()).toContain('Calendars were not allowed. You can allow them now or later in Settings.')
      expect(button(wrapper, 'Allow calendar access').exists()).toBe(true)

      const mail = useMailStore()
      mail.accounts = [synced({ ...gmail, calendarStatus: 'active', lastSyncedAt: '2026-10-19T08:05:00+00:00' })]
      mail.calendars = [{ id: 'c1', mailAccountId: 'acc-g' }, { id: 'c2', mailAccountId: 'acc-g' }, { id: 'other', mailAccountId: 'acc-1' }] as typeof mail.calendars
      await settle()
      expect(dialog(wrapper).text()).toContain('2 calendars found. They show up in Calendar in a minute.')
    })

    it('says when calendars were not asked for, and turns them on from here', async () => {
      const assign = vi.fn<(url: string) => void>()
      vi.stubGlobal('location', { ...window.location, assign })
      // What the API answers for a sign-in with calendars switched off: the calendar status is still unknown.
      connected = connection({ requested: ['mail'] })
      accounts['acc-g'] = { ...gmail, calendarStatus: 'unknown' }
      const wrapper = await mountView('/settings/accounts/new?provider=google&state=state-1&code=code-1')

      expect(dialog(wrapper).text()).toContain('Not synced. You can turn this on now or later in Settings.')
      await button(wrapper, 'Turn on').trigger('click')
      await settle()

      expect(lastStart()?.body).toEqual({ provider: 'google', features: ['calendar'], mailAccountId: 'acc-g' })
    })

    it('says when the account was connected already', async () => {
      connected = connection({ existing: true })
      const wrapper = await mountView('/settings/accounts/new?provider=google&state=state-1&code=code-1')

      expect(dialog(wrapper).get('h1').text()).toBe('Already connected')
      expect(dialog(wrapper).text()).toContain('kim@gmail.com was already connected. We signed it in again.')
    })

    it('says the sign-in was cancelled, and offers mail alone when calendars were asked for', async () => {
      connected = connection({ provider: 'microsoft', connected: null, connectError: 'denied' })
      const wrapper = await mountView('/settings/accounts/new?provider=microsoft&state=state-1&error=access_denied')

      expect(dialog(wrapper).get('h1').text()).toBe('Sign-in was cancelled')
      expect(dialog(wrapper).text()).toContain('You closed the Microsoft page or chose not to give access. Nothing was connected.')
      await button(wrapper, 'Connect mail only').trigger('click')
      await settle()

      expect(lastStart()?.body).toEqual({ provider: 'microsoft', features: ['mail'] })
      expect(dialog(wrapper).get('h1').text()).toBe('Finish in your browser')
    })

    it('says when the organization has to approve Tresso, with the link for the IT team', async () => {
      const approvalUrl = 'https://login.microsoftonline.com/company.example/adminconsent?client_id=c'
      connected = connection({ provider: 'microsoft', connected: null, connectError: 'admin_approval_required', approvalUrl })
      const wrapper = await mountView('/settings/accounts/new?provider=microsoft&state=state-1&error=access_denied&error_description=AADSTS90094%3A+Admin+consent')

      expect(requests.find((r) => r.path === '/api/v1/provider-connections')?.body).toEqual({ provider: 'microsoft', state: 'state-1', error: 'access_denied', errorDescription: 'AADSTS90094: Admin consent' })
      expect(dialog(wrapper).get('h1').text()).toBe('Your organization has to approve Tresso first')
      expect(dialog(wrapper).get('.cf-url').text()).toBe(approvalUrl)
      expect(button(wrapper, 'Copy link').exists()).toBe(true)
      expect(button(wrapper, 'Connect mail only').exists()).toBe(true)
    })

    it('offers mail alone after a failure when calendars were asked for', async () => {
      connected = connection({ provider: 'microsoft', connected: null, connectError: 'failed' })
      const wrapper = await mountView('/settings/accounts/new?provider=microsoft&state=state-1&error=server_error')

      expect(dialog(wrapper).get('[role="alert"]').text()).toBe('Connecting to Microsoft failed. Try again in a moment.')
      expect(button(wrapper, 'Connect mail only').exists()).toBe(true)
    })

    it('waits for the provider list before it decides where an address goes', async () => {
      suggestions['kim@gmail.com'] = suggestion('kim@gmail.com', { provider: 'google' })
      let release: () => void = () => {}
      holdProviders = new Promise((resolve) => (release = resolve))
      const wrapper = await mountView()
      await dialog(wrapper).get('input[type="email"]').setValue('kim@gmail.com')
      await dialog(wrapper).get('form').trigger('submit')
      await settle()
      expect(dialog(wrapper).get('h1').text()).toBe('Finding your provider')

      release()
      await settle()
      await vi.advanceTimersByTimeAsync(400)
      await settle()
      expect(dialog(wrapper).get('h1').text()).toBe('Open your browser to link your Google account')
    })

    it('says an approval came back without claiming it', async () => {
      const wrapper = await mountView('/settings/accounts/new?provider=microsoft&adminConsent=granted')

      expect(dialog(wrapper).text()).toContain('If your organization approved Tresso, enter your work address to connect it.')
    })

    it('says other failures on the explanation, not on the address', async () => {
      const wrapper = await mountView('/settings/accounts/new?provider=google&connectError=expired')

      expect(dialog(wrapper).get('[role="alert"]').text()).toBe('That sign-in took too long or was already used. Try again.')
      expect(dialog(wrapper).get('h1').text()).toBe('Open your browser to link your Google account')
      expect(requests.some((r) => r.path === '/api/v1/provider-connections')).toBe(false)
    })
  })

  describe('an app password', () => {
    beforeEach(() => {
      suggestions['kim@icloud.com'] = suggestion('kim@icloud.com', {
        found: true,
        provider: 'icloud',
        username: 'kim@icloud.com',
        imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
        smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
      })
    })

    it('explains how to make one and asks for nothing else', async () => {
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@icloud.com')

      expect(dialog(wrapper).get('h1').text()).toBe('Connect iCloud Mail with an app password')
      expect(dialog(wrapper).findAll('li').map((item) => item.text())).toEqual([
        '1Go to account.apple.com and sign in with your Apple Account.',
        '2Open Sign-In and Security, then choose App-Specific Passwords.',
        '3Click the + button, type Tresso as the name and click Create.',
        '4Copy the password Apple shows you and paste it below.',
      ])
      expect(dialog(wrapper).text()).toContain('App password for kim@icloud.com')
      expect(dialog(wrapper).find('input.mono[type="number"]').exists()).toBe(false)
      expect(dialog(wrapper).get('input[type="password"]').attributes('autocomplete')).toBe('off')
    })

    it('stays on the step when Apple refuses the password, and creates nothing', async () => {
      checkResult = { emailAddress: 'kim@icloud.com', imap: 'auth_failed', smtp: 'not_checked', folders: null, detail: 'The server said: [AUTHENTICATIONFAILED]' }
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@icloud.com')

      await dialog(wrapper).get('input[type="password"]').setValue('abcd-efgh-ijkl')
      await dialog(wrapper).get('form').trigger('submit')
      await settle()

      expect(requests.find((r) => r.path === '/api/v1/mail-account-checks')?.body).toEqual({
        emailAddress: 'kim@icloud.com',
        username: 'kim@icloud.com',
        password: 'abcdefghijkl',
        imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
        smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
      })
      expect(dialog(wrapper).get('h1').text()).toBe('Connect iCloud Mail with an app password')
      expect(dialog(wrapper).get('[role="alert"]').text()).toBe('Apple did not accept this password. Check that you copied all of it, or make a new one and paste that.')
      expect(requests.some((r) => r.method === 'POST' && r.path === '/api/v1/mail-accounts')).toBe(false)
    })
  })

  describe('the provider list', () => {
    it('opens when nothing is known about the address, and each choice leads to its way of connecting', async () => {
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@studio-noord.example')

      expect(dialog(wrapper).get('h1').text()).toBe('Select your email provider')
      expect(dialog(wrapper).text()).toContain('We could not tell who handles mail for kim@studio-noord.example.')
      expect(dialog(wrapper).findAll('.tile-name').map((name) => name.text())).toEqual(['Google', 'Outlook', 'Microsoft 365', 'iCloud', 'Yahoo', 'Exchange', 'Set up manually'])

      await button(wrapper, 'YYahooYahoo Mail').trigger('click')
      expect(dialog(wrapper).get('h1').text()).toBe('Connect Yahoo Mail with an app password')
      await dialog(wrapper).get('[aria-label="Back"]').trigger('click')

      await button(wrapper, 'OOutlookOutlook.com, Hotmail and Live').trigger('click')
      expect(dialog(wrapper).get('h1').text()).toBe('Open your browser to link your Outlook account')
      await dialog(wrapper).get('[aria-label="Back"]').trigger('click')

      await button(wrapper, "EExchangeYour company's own mail server").trigger('click')
      expect(dialog(wrapper).text()).toContain('Exchange servers often have IMAP turned off.')
    })

    it('leaves out the providers this server cannot sign in with', async () => {
      providers = []
      const wrapper = await mountView()
      await button(wrapper, 'Choose my provider myself').trigger('click')

      expect(dialog(wrapper).findAll('.tile').filter((tile) => tile.attributes('disabled') !== undefined).map((tile) => tile.get('.tile-name').text())).toEqual(['Google', 'Outlook', 'Microsoft 365'])
      expect(dialog(wrapper).text()).toContain('Signing in with Google or Microsoft is not available right now; you can still connect with a password.')
    })

    it('asks for the address on the next step when it was skipped', async () => {
      const wrapper = await mountView()
      await button(wrapper, 'Choose my provider myself').trigger('click')
      await button(wrapper, '@Set up manuallyAny provider with IMAP and SMTP').trigger('click')

      expect(dialog(wrapper).find('input[type="email"]').exists()).toBe(true)
      await dialog(wrapper).get('input[type="email"]').setValue('kim@studio-noord.example')
      await settle()
      expect((dialog(wrapper).find('input.mono').element as HTMLInputElement).value).toBe('imap.studio-noord.example')
    })
  })

  describe('setting up by hand', () => {
    beforeEach(() => {
      suggestions['kim@fastmail.com'] = suggestion('kim@fastmail.com', { found: true, source: 'ispdb', username: 'kim@fastmail.com', imap: created.imap, smtp: created.smtp, authentication: ['password'] })
    })

    it('fills in what was found, in the order incoming, outgoing, sign in', async () => {
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@fastmail.com')

      expect(dialog(wrapper).get('h1').text()).toBe('Set up manually')
      expect(dialog(wrapper).findAll('legend').map((legend) => legend.text())).toEqual(['Incoming mail (IMAP)', 'Outgoing mail (SMTP)', 'Sign in'])
      expect(dialog(wrapper).findAll('input.mono').map((input) => (input.element as HTMLInputElement).value)).toEqual(['imap.fastmail.com', '993', 'smtp.fastmail.com', '465'])
      expect(dialog(wrapper).text()).not.toContain('Use the same username and password for outgoing mail')
    })

    it('does not carry the servers of one address over to the next', async () => {
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@fastmail.com')
      await dialog(wrapper).get('[aria-label="Back"]').trigger('click')

      await enterAddress(wrapper, 'kim@studio-noord.example')
      await button(wrapper, '@Set up manuallyAny provider with IMAP and SMTP').trigger('click')

      expect(dialog(wrapper).findAll('input.mono').map((input) => (input.element as HTMLInputElement).value)).toEqual(['imap.studio-noord.example', '993', 'smtp.studio-noord.example', '465'])
      expect((dialog(wrapper).find('input[type="password"]').element as HTMLInputElement).value).toBe('')
    })

    it('says which fields to fix', async () => {
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@fastmail.com')
      const inputs = dialog(wrapper).findAll('input.mono')
      await inputs[0]!.setValue('')
      await inputs[1]!.setValue('99999')
      await dialog(wrapper).get('form').trigger('submit')
      await settle()

      expect(dialog(wrapper).text()).toContain('Enter the server name, for example imap.fastmail.com.')
      expect(dialog(wrapper).text()).toContain('Use a number from 1 to 65535.')
      expect(dialog(wrapper).text()).toContain('Enter the password for this mail account.')
      expect(requests.some((r) => r.path === '/api/v1/mail-account-checks')).toBe(false)
    })

    it('checks before creating, and shows a server that did not answer on the form', async () => {
      checkResult = { emailAddress: 'kim@fastmail.com', imap: 'unreachable', smtp: 'not_checked', folders: null, detail: 'No answer after 15 seconds (imap.fastmail.com:993).' }
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@fastmail.com')
      await dialog(wrapper).get('input[type="password"]').setValue('secret')
      await dialog(wrapper).get('form').trigger('submit')
      await settle()

      expect(dialog(wrapper).get('h1').text()).toBe('Set up manually')
      const banner = dialog(wrapper).get('.banner')
      expect(banner.text()).toContain('We could not reach imap.fastmail.com')
      expect(banner.text()).toContain('The server did not answer on port 993. Check the server name and the port, or ask your mail provider for the right settings. Outgoing mail was not checked yet.')
      expect(banner.text()).toContain('No answer after 15 seconds (imap.fastmail.com:993).')
      expect(dialog(wrapper).findAll('legend .status').map((chip) => chip.text())).toEqual(['No answer', 'Not checked yet'])
      expect(requests.some((r) => r.method === 'POST' && r.path === '/api/v1/mail-accounts')).toBe(false)
    })

    it('shows the checks while it connects, and Cancel goes back to the form', async () => {
      let release: () => void = () => {}
      holdCheck = new Promise((resolve) => (release = resolve))
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@fastmail.com')
      await dialog(wrapper).get('input[type="password"]').setValue('secret')
      await dialog(wrapper).get('form').trigger('submit')
      await settle()

      expect(dialog(wrapper).get('h1').text()).toBe('Connecting kim@fastmail.com')
      expect(dialog(wrapper).text()).toContain('We are checking that Tresso can sign in, read your mail and send mail for you.')
      expect(dialog(wrapper).findAll('li').map((item) => item.find('.label').text())).toEqual(['Signing in to imap.fastmail.com', 'Checking that Tresso can send mail', 'Finding your folders'])

      await button(wrapper, 'Cancel').trigger('click')
      release()
      await settle()

      expect(dialog(wrapper).get('h1').text()).toBe('Set up manually')
      expect(requests.some((r) => r.method === 'POST' && r.path === '/api/v1/mail-accounts')).toBe(false)
    })

    it('removes an account whose creation was cancelled, so nothing is left behind', async () => {
      let release: () => void = () => {}
      holdCreate = new Promise((resolve) => (release = resolve))
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@fastmail.com')
      await dialog(wrapper).get('input[type="password"]').setValue('secret')
      await dialog(wrapper).get('form').trigger('submit')
      await settle()
      expect(dialog(wrapper).get('h1').text()).toBe('Connecting kim@fastmail.com')

      await button(wrapper, 'Cancel').trigger('click')
      release()
      await settle()

      expect(dialog(wrapper).get('h1').text()).toBe('Set up manually')
      expect(requests.some((r) => r.method === 'POST' && r.path === '/api/v1/mail-accounts')).toBe(true)
      expect(requests.find((r) => r.method === 'DELETE')?.path).toBe('/api/v1/mail-accounts/acc-1')
    })

    it('creates the account once the check passed, named after the user', async () => {
      const wrapper = await mountView()
      await enterAddress(wrapper, 'kim@fastmail.com')
      await dialog(wrapper).get('input[type="password"]').setValue('secret')
      await dialog(wrapper).get('form').trigger('submit')
      await settle()
      await vi.advanceTimersByTimeAsync(400)
      await settle()

      expect(requests.find((r) => r.path === '/api/v1/mail-account-checks')?.body).toEqual({
        emailAddress: 'kim@fastmail.com',
        username: 'kim@fastmail.com',
        password: 'secret',
        imap: created.imap,
        smtp: created.smtp,
      })
      expect(requests.find((r) => r.method === 'POST' && r.path === '/api/v1/mail-accounts')?.body).toEqual({
        emailAddress: 'kim@fastmail.com',
        displayName: 'kim',
        username: 'kim@fastmail.com',
        password: 'secret',
        imap: created.imap,
        smtp: created.smtp,
      })
      expect(dialog(wrapper).get('h1').text()).toBe("You're connected")
      expect(dialog(wrapper).text()).toContain('kim@fastmail.com, IMAP')
      expect(dialog(wrapper).text()).toContain('Looking for your calendars...')

      await button(wrapper, 'Add another account').trigger('click')
      expect(dialog(wrapper).get('h1').text()).toBe('Connect a mail account')
      expect((dialog(wrapper).get('input[type="email"]').element as HTMLInputElement).value).toBe('')
    })
  })

  it('closes back to the accounts', async () => {
    const wrapper = await mountView()

    await dialog(wrapper).get('[aria-label="Close"]').trigger('click')
    await settle()

    expect(wrapper.router.currentRoute.value.name).toBe('settings-accounts')
  })
})
