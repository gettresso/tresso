import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { AppActivityEntry, AppActivityPage, ConnectedApp } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'
import SettingsAssistantsView from '../SettingsAssistantsView.vue'

const ENDPOINT = 'https://mcp.tresso.example/mcp'

function app(id: string, name: string, scopes: string[], extra: Partial<ConnectedApp> = {}): ConnectedApp {
  return { id, name, domains: ['claude.ai'], scopes, grantedScopes: scopes, connectedAt: '2026-09-02T08:00:00+00:00', lastUsedAt: null, activityKey: `client:${id}`, ...extra }
}

function entry(id: string, key: string, extra: Partial<AppActivityEntry> = {}): AppActivityEntry {
  return {
    id,
    occurredAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    app: { key, type: 'client', name: 'Claude', connectedAppId: 'claude', personalAccessTokenId: null },
    channel: 'mcp',
    action: { name: 'get_mail_account', title: 'Get a mail account' },
    kind: 'read',
    result: 'done',
    reason: null,
    durationMs: 84,
    permissions: [],
    object: null,
    lastOccurredAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    count: 1,
    ...extra,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('Settings, Apps, AI assistants', () => {
  const requests: { method: string; path: string; query: string; body: unknown }[] = []
  let apps: ConnectedApp[]
  let refusePatch: string | null
  let info: Record<string, unknown> | null
  let recentHold: Promise<void> | null
  let failDelete: boolean

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    refusePatch = null
    info = { product: 'tresso-server', apiVersion: 1, billing: false, trialDays: 0, allowUnencryptedMailServers: false, mcpEndpoint: ENDPOINT }
    recentHold = null
    failDelete = false
    apps = [
      app('claude', 'Claude', ['mail:read', 'settings:read', 'chat:read'], { grantedScopes: ['mail:read', 'settings:read', 'chat:read', 'todos:read'] }),
      app('cursor', 'Cursor', ['mail:read']),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
        requests.push({ method, path: url.pathname, query: url.search, body })
        if (url.pathname === '/api/v1/server-info') {
          return info === null ? new Response(JSON.stringify({ detail: 'The server is busy.' }), { status: 503, headers: { 'Content-Type': 'application/problem+json' } }) : new Response(JSON.stringify(info))
        }
        if (url.pathname === '/api/v1/connected-apps') {
          return new Response(JSON.stringify(apps))
        }
        if (url.pathname.startsWith('/api/v1/connected-apps/') && method === 'PATCH') {
          if (refusePatch !== null) {
            return new Response(JSON.stringify({ detail: refusePatch }), { status: 422, headers: { 'Content-Type': 'application/problem+json' } })
          }
          const id = url.pathname.split('/').pop()!
          const known = apps.find((one) => one.id === id)!
          const changed = { ...known, scopes: (body as { scopes: string[] }).scopes }
          apps = apps.map((one) => (one.id === id ? changed : one))
          return new Response(JSON.stringify(changed))
        }
        if (url.pathname.startsWith('/api/v1/connected-apps/') && method === 'DELETE') {
          return failDelete ? new Response(JSON.stringify({ detail: 'Connected app not found.' }), { status: 404, headers: { 'Content-Type': 'application/problem+json' } }) : new Response(null, { status: 204 })
        }
        if (url.pathname === '/api/v1/app-activity') {
          const app = url.searchParams.get('app')
          if (app !== null && recentHold !== null) await recentHold
          const page: AppActivityPage = {
            items:
              app === 'client:claude'
                ? [
                    entry('e1', 'client:claude', { occurredAt: new Date().toISOString() }),
                    entry('e2', 'client:claude', { action: { name: 'list_whatsapp_chats', title: 'List WhatsApp chats' }, result: 'refused', reason: { code: 'no_permission', label: 'No permission', sentence: 'x' } }),
                  ]
                : app === null
                  ? [entry('e1', 'client:claude', { occurredAt: new Date(Date.now() - 4 * 60_000).toISOString() })]
                  : [],
            nextCursor: null,
            apps: [],
            empty: false,
          }
          return new Response(JSON.stringify(page))
        }
        return new Response('{}')
      }),
    )
    // jsdom has no modal dialogs: opening one marks it open, as a browser does, so what is inside can take the focus.
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { value: function (this: HTMLDialogElement) { this.setAttribute('open', '') }, configurable: true, writable: true })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { value: function (this: HTMLDialogElement) { this.removeAttribute('open') }, configurable: true, writable: true })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn<(text: string) => Promise<void>>(async () => undefined) }, configurable: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  async function page(query: Record<string, string> = {}) {
    const stub = { template: '<div />' }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/apps/assistants', name: 'settings-apps-assistants', component: stub },
        { path: '/settings/apps', name: 'settings-apps', component: stub },
        { path: '/settings/apps/activity', name: 'settings-apps-activity', component: stub },
      ],
    })
    await router.push({ name: 'settings-apps-assistants', query })
    const wrapper = mount(SettingsAssistantsView, { global: { plugins: [router] }, attachTo: document.body })
    await settle()
    return { wrapper, router }
  }

  it('shows the add section with the endpoint, the OAuth note and the board words', async () => {
    const { wrapper } = await page()
    expect(wrapper.get('h2').text()).toBe('AI assistants and apps')
    expect(wrapper.get('.lead').text()).toBe('Let an AI assistant or another app work with your Tresso. You decide what each one may do.')
    expect(wrapper.get('a.back').attributes('aria-label')).toBe('Back to apps')
    expect(wrapper.get('#add-title').text()).toBe('Add an assistant')
    expect(wrapper.findAll('[role="tab"] .tile-name').map((name) => name.text())).toEqual(['Claude', 'Claude Code', 'Cursor', 'VS Code', 'ChatGPT', 'Other'])
    expect((wrapper.get('#mcp-url').element as HTMLInputElement).value).toBe(ENDPOINT)
    expect(wrapper.get('#mcp-url-note').text()).toBe('Streamable HTTP.')
    expect(wrapper.get('.oauth span').text()).toBe('Every assistant signs in with OAuth, in your browser. You never paste a password or a token into an AI tool.')
  })

  it('has a panel per assistant: the steps, the command and the documented install link, never a secret', async () => {
    const { wrapper } = await page()
    const tab = (name: string) => wrapper.findAll('[role="tab"]').find((found) => found.get('.tile-name').text() === name)!

    expect(wrapper.get('[role="tabpanel"]').attributes('aria-label')).toBe('Add Tresso to Claude')
    expect(wrapper.get('.how-line').text()).toBe('Claude has no install link. Copy your MCP endpoint below and follow these steps.')
    expect(wrapper.findAll('.steps li').map((step) => step.text())).toEqual(['1In Claude, add a custom connector.', '2Paste your endpoint URL.', '3Sign in and approve the permissions it asks for.', '4It shows up below. Narrow its permissions any time.'])

    await tab('Claude Code').trigger('click')
    expect(wrapper.get('.how-line').text()).toBe('Paste this line in your terminal. Then type /mcp in Claude Code and choose tresso to sign in.')
    expect((wrapper.get('#mcp-command').element as HTMLInputElement).value).toBe(`claude mcp add --transport http tresso ${ENDPOINT}`)
    await wrapper.get('.copy-row .button-primary').trigger('click')
    await settle()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`claude mcp add --transport http tresso ${ENDPOINT}`)
    expect(wrapper.get('.copy-row .button-primary').text()).toBe('Copied')

    await tab('Cursor').trigger('click')
    const link = wrapper.get('a.how-link')
    expect(link.text()).toBe('Add to Cursor')
    const href = new URL(link.attributes('href')!)
    expect(href.protocol).toBe('cursor:')
    expect(href.searchParams.get('name')).toBe('tresso')
    expect(JSON.parse(atob(href.searchParams.get('config')!))).toEqual({ url: ENDPOINT })

    await tab('VS Code').trigger('click')
    expect(wrapper.get('.how-line').text()).toBe('Copy your MCP endpoint below and follow these steps.')
    expect(wrapper.get('.steps li').text()).toBe('1In VS Code, add an MCP server.')
    await tab('ChatGPT').trigger('click')
    expect(wrapper.get('.how-line').text()).toBe('ChatGPT has no install link. Copy your MCP endpoint below and follow these steps.')
    expect(wrapper.get('.steps li').text()).toBe('1In ChatGPT, add a custom connector.')
    await tab('Other').trigger('click')
    expect(wrapper.get('.how-title').text()).toBe('Add Tresso to another AI tool')

    // No panel ever carries a token or a secret.
    for (const name of ['Claude', 'Claude Code', 'Cursor', 'VS Code', 'ChatGPT', 'Other']) {
      await tab(name).trigger('click')
      expect(wrapper.get('.add').html()).not.toMatch(/token=|secret|tresso_pat_|Bearer/i)
    }
  })

  it('marks each assistant to add with its own logo, the first one chosen, and Other with a plus', async () => {
    const { wrapper } = await page()
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false'])
    const marks = tabs.map((tab) => tab.get('.tile-mark'))
    for (const mark of marks) {
      expect(mark.attributes('aria-hidden')).toBe('true')
      expect(mark.text()).toBe('')
      expect(mark.findAll('svg')).toHaveLength(1)
    }
    // The five products: a filled logo, in its brand colour or the text colour.
    expect(marks.slice(0, 5).map((mark) => mark.get('svg').attributes('fill'))).toEqual(['#D97757', '#D97757', 'currentColor', '#007ACC', 'currentColor'])
    for (const mark of marks.slice(0, 5)) expect(mark.get('path').attributes('d')!.length).toBeGreaterThan(100)
    // Other: a stroked plus.
    const plus = marks[5]!.get('svg')
    expect(plus.attributes('fill')).toBe('none')
    expect(plus.attributes('stroke')).toBe('currentColor')
    expect(plus.get('path').attributes('d')).toBe('M12 5v14M5 12h14')
    // The tile's name stays its text.
    expect(tabs[2]!.text()).toBe('CursorOne click')
  })

  it('copies the endpoint and says so', async () => {
    const { wrapper } = await page()
    await wrapper.get('.copy-plain').trigger('click')
    await settle()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ENDPOINT)
    expect(wrapper.get('.copy-plain').text()).toBe('Copied')
    expect(wrapper.get('.endpoint [role="status"]').text()).toBe('Copied')
  })

  it('moves between the assistants to add with the arrow keys', async () => {
    const { wrapper } = await page()
    const tabs = () => wrapper.findAll('[role="tab"]')
    await tabs()[0]!.trigger('keydown', { key: 'ArrowRight' })
    await settle()
    expect(tabs()[1]!.attributes('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[1]!.element)
    await tabs()[1]!.trigger('keydown', { key: 'End' })
    await settle()
    expect(tabs()[5]!.attributes('aria-selected')).toBe('true')
  })

  it('lists the connected assistants and shows the chosen one with its switches, notes and recent activity', async () => {
    const { wrapper } = await page()
    expect(wrapper.get('#clients-title').text()).toBe('Connected assistants and apps')
    expect(wrapper.findAll('.client .client-name').map((name) => name.text())).toEqual(['Claude', 'Cursor'])
    // A connected app names itself, so it keeps its initials and never gets a logo by its name.
    expect(wrapper.findAll('.client .client-mark').map((mark) => mark.text())).toEqual(['CL', 'CU'])
    expect(wrapper.find('.client .client-mark svg').exists()).toBe(false)
    expect(wrapper.findAll('.client .client-meta').map((meta) => meta.text())).toEqual(['Active 4 min ago', 'Never used'])
    expect(wrapper.get('#client-title').text()).toBe('Claude')
    expect(wrapper.get('.detail-text .sub').text()).toBe('Connected 2 Sep by you.')

    const switches = wrapper.findAll('[role="switch"]')
    expect(switches.map((one) => one.attributes('aria-label'))).toEqual([
      'Read mail for Claude',
      'Organize mail for Claude',
      'Send mail for Claude',
      'See todos for Claude',
      'Change todos for Claude',
      'See calendar for Claude',
      'Change calendar for Claude',
      'See settings for Claude',
      'Change settings for Claude',
      'See signatures for Claude',
      'Change signatures for Claude',
      'Read your WhatsApp chats for Claude',
      'Send WhatsApp messages as you for Claude',
    ])
    expect(switches.filter((one) => one.attributes('aria-checked') === 'true').map((one) => one.attributes('aria-label'))).toEqual(['Read mail for Claude', 'See settings for Claude', 'Read your WhatsApp chats for Claude'])
    expect(wrapper.findAll('.perm-foot').map((note) => note.text())).toEqual([
      'An assistant only prepares the list of mail addresses. You sign in to each account yourself.',
      'File links are never given to an assistant.',
      'Tresso does not ask you again before an assistant sends a WhatsApp message: your assistant asks you. An app can queue at most 20 messages in 10 minutes and 100 a day.',
    ])

    expect(requests.some((request) => request.path === '/api/v1/app-activity' && request.query === '?app=client%3Aclaude&limit=6')).toBe(true)
    expect(wrapper.findAll('.recent-title').map((title) => title.text())).toEqual(['Get a mail account', 'List WhatsApp chats, refused'])
    expect(wrapper.findAll('.recent-tool').map((tool) => tool.text())).toEqual(['get_mail_account', 'list_whatsapp_chats (no permission)'])
    expect(wrapper.get('a.full-log').text()).toBe('Full activity log')
    expect(wrapper.get('a.full-log').attributes('href')).toBe('/settings/apps/activity?app=client:claude&period=90d')
  })

  it('opens on the assistant the address names, and switches assistants', async () => {
    const { wrapper, router } = await page({ app: 'cursor' })
    expect(wrapper.get('#client-title').text()).toBe('Cursor')
    await wrapper.findAll('.client')[0]!.trigger('click')
    await settle()
    expect(wrapper.get('#client-title').text()).toBe('Claude')
    expect(router.currentRoute.value.query.app).toBe('claude')
    expect(wrapper.findAll('.client').map((client) => client.attributes('aria-pressed'))).toEqual(['true', 'false'])
  })

  it('saves a switch at once: off and on again, within what was granted', async () => {
    const { wrapper } = await page()
    const toggle = (label: string) => wrapper.findAll('[role="switch"]').find((one) => one.attributes('aria-label') === label)!

    await toggle('See settings for Claude').trigger('click')
    expect(toggle('See settings for Claude').attributes('aria-checked')).toBe('false')
    await settle()
    expect(requests.filter((request) => request.method === 'PATCH').map((request) => [request.path, request.body])).toEqual([['/api/v1/connected-apps/claude', { scopes: ['mail:read', 'chat:read'] }]])
    expect(toggle('See settings for Claude').attributes('aria-checked')).toBe('false')

    // Granted on the consent screen, off now: it can be switched on.
    await toggle('See todos for Claude').trigger('click')
    await settle()
    expect(requests.filter((request) => request.method === 'PATCH')[1]!.body).toEqual({ scopes: ['mail:read', 'chat:read', 'todos:read'] })
    expect(toggle('See todos for Claude').attributes('aria-checked')).toBe('true')

    // Never granted: needs the consent screen, so nothing is sent.
    expect(toggle('Send mail for Claude').attributes('aria-disabled')).toBe('true')
    await toggle('Send mail for Claude').trigger('click')
    await settle()
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(2)
    expect(toggle('Send mail for Claude').attributes('aria-checked')).toBe('false')
  })

  it('puts a switch back and says why when saving fails', async () => {
    refusePatch = 'You did not give Claude this permission when you connected it.'
    const { wrapper } = await page()
    const toggle = () => wrapper.findAll('[role="switch"]').find((one) => one.attributes('aria-label') === 'Read mail for Claude')!
    await toggle().trigger('click')
    await settle()
    expect(toggle().attributes('aria-checked')).toBe('true')
    expect(wrapper.get('.perm [role="alert"]').text()).toBe('You did not give Claude this permission when you connected it.')
  })

  it('asks before revoking, with the focus on Keep it, and keeps the app when it is kept', async () => {
    const { wrapper } = await page()
    await wrapper.get('button.revoke').trigger('click')
    await settle()
    const dialog = wrapper.get('dialog.confirm-dialog')
    expect(dialog.attributes('role')).toBe('alertdialog')
    expect(dialog.get('h2').text()).toBe('Revoke access for Claude?')
    expect(dialog.get('#revoke-description').text()).toBe('It stops working with your account right away. To use it again, connect it again.')
    expect(dialog.findAll('button').map((button) => button.text())).toEqual(['Revoke access', 'Keep it'])
    expect(document.activeElement).toBe(dialog.findAll('button')[1]!.element)

    await dialog.findAll('button')[1]!.trigger('click')
    await settle()
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(0)
    expect(document.activeElement).toBe(wrapper.get('button.revoke').element)
  })

  it('revokes once confirmed, says so in a live note that takes the focus, and offers no undo', async () => {
    const { wrapper } = await page()
    await wrapper.get('button.revoke').trigger('click')
    await settle()
    await wrapper.get('dialog').findAll('button')[0]!.trigger('click')
    await settle()
    expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.path)).toEqual(['/api/v1/connected-apps/claude'])
    const note = wrapper.get('.revoked-note')
    expect(note.attributes('role')).toBe('status')
    expect(note.text()).toBe('Access revoked. The next request from Claude is refused and it has to ask for permission again.')
    expect(document.activeElement).toBe(note.element)
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(wrapper.find('button.revoke').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Undo revoke')
    expect(wrapper.findAll('.client-meta')[1]!.text()).toBe('Access revoked')
    expect(wrapper.findAll('[role="switch"]').every((one) => one.attributes('aria-checked') === 'false' && one.attributes('aria-disabled') === 'true')).toBe(true)
  })

  it('says why revoking failed and keeps the app', async () => {
    failDelete = true
    const { wrapper } = await page()
    await wrapper.get('button.revoke').trigger('click')
    await settle()
    await wrapper.get('dialog').findAll('button')[0]!.trigger('click')
    await settle()
    expect(wrapper.get('dialog [role="alert"]').text()).toBe('Connected app not found.')
    expect(wrapper.get('.revoked-note').text()).toBe('')
    expect(wrapper.findAll('.client-meta')[0]!.text()).not.toBe('Access revoked')
  })

  it('marks a permission that was never granted, and says so to a screen reader too', async () => {
    const { wrapper } = await page()
    const perm = wrapper.findAll('.perm').find((one) => one.get('.perm-label').text() === 'Send mail')!
    expect(perm.classes()).toContain('never')
    expect(perm.get('.perm-never').text()).toBe('Not allowed when this app was connected. Connect it again to allow it.')
    expect(perm.get('[role="switch"]').attributes('aria-describedby')).toBe('perm-never-mail:send')
    const todos = wrapper.findAll('.perm').find((one) => one.get('.perm-label').text() === 'See todos')!
    expect(todos.classes()).not.toContain('never')
    expect(todos.get('[role="switch"]').attributes('aria-describedby')).toBe('perm-note-todos:read')
  })

  it('sends a quick double toggle as its last state, without flicker', async () => {
    const { wrapper } = await page()
    const toggle = () => wrapper.findAll('[role="switch"]').find((one) => one.attributes('aria-label') === 'See settings for Claude')!
    await toggle().trigger('click')
    expect(toggle().attributes('aria-checked')).toBe('false')
    await toggle().trigger('click')
    expect(toggle().attributes('aria-checked')).toBe('true')
    await settle()
    const patches = requests.filter((request) => request.method === 'PATCH').map((request) => (request.body as { scopes: string[] }).scopes)
    // The first save left before the second click; the second sends the last state, and no third follows.
    expect(patches).toHaveLength(2)
    expect([...patches[1]!].sort()).toEqual(['chat:read', 'mail:read', 'settings:read'])
    expect(toggle().attributes('aria-checked')).toBe('true')
    expect(apps.find((one) => one.id === 'claude')!.scopes.includes('settings:read')).toBe(true)
  })

  it('shows recent activity loading, then nothing yet for an app without entries', async () => {
    let release = () => undefined as void
    recentHold = new Promise<void>((resolve) => (release = resolve))
    const { wrapper } = await page({ app: 'cursor' })
    expect(wrapper.get('.recent-state').text()).toContain('Loading recent activity…')
    release()
    await settle()
    expect(wrapper.get('.recent-state').text()).toBe('Nothing yet')
    expect(wrapper.find('.recent-list').exists()).toBe(false)
  })

  it('says when copying is not allowed', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn<(text: string) => Promise<void>>(async () => Promise.reject(new Error('denied'))) }, configurable: true })
    const { wrapper } = await page()
    await wrapper.get('.copy-plain').trigger('click')
    await settle()
    expect(wrapper.get('.endpoint [role="alert"]').text()).toBe('Copying did not work. Select the text and copy it yourself.')
    expect(wrapper.get('.copy-plain').text()).toBe('Copy')
  })

  it.each([
    ['http on another host', 'http://mcp.tresso.example/mcp'],
    ['a user and password', 'https://kim:secret@mcp.tresso.example/mcp'],
    ['a query', 'https://mcp.tresso.example/mcp?token=x'],
    ['shell characters', "https://mcp.tresso.example/mcp';rm -rf ~;'"],
    ['whitespace', 'https://mcp.tresso.example/m cp'],
    ['non-Latin-1 text', 'https://mcp.例え.example/mcp'],
    ['another scheme', 'javascript:alert(1)'],
    ['nothing', ''],
  ])('offers no command, link or Copy for an endpoint with %s', async (_, value) => {
    info = { ...info, mcpEndpoint: value }
    const { wrapper } = await page()
    expect(wrapper.find('#mcp-url').exists()).toBe(false)
    await expectNoEndpoint(wrapper, value === '' ? 'Reload the page to try again.' : 'Ask whoever runs this server to check its MCP endpoint.')
  })

  it('offers no command, link or Copy when the server info has no endpoint or fails', async () => {
    info = { product: 'tresso-server', apiVersion: 1 }
    let { wrapper } = await page()
    await expectNoEndpoint(wrapper, 'Reload the page to try again.')
    wrapper.unmount()
    info = null
    ;({ wrapper } = await page())
    await expectNoEndpoint(wrapper, 'Reload the page to try again.')
    expect(wrapper.get('.form-error').text()).toBe('The server is busy.')
  })

  it('accepts http on this computer', async () => {
    info = { ...info, mcpEndpoint: 'http://localhost:8080/mcp' }
    const { wrapper } = await page()
    expect((wrapper.get('#mcp-url').element as HTMLInputElement).value).toBe('http://localhost:8080/mcp')
  })

  it('forgets the revoked app, its activity and the switches once another user signs in', async () => {
    const { wrapper } = await page()
    await wrapper.get('button.revoke').trigger('click')
    await settle()
    await wrapper.get('dialog').findAll('button')[0]!.trigger('click')
    await settle()
    useAuthStore().generation++
    await settle()
    expect(wrapper.find('.client').exists()).toBe(false)
    expect(wrapper.find('.revoked-note').exists()).toBe(false)
    expect(wrapper.find('.recent-list').exists()).toBe(false)
  })

  async function expectNoEndpoint(wrapper: Awaited<ReturnType<typeof page>>['wrapper'], next: string): Promise<void> {
    const said = `Tresso could not read this server's MCP endpoint, so there is nothing to copy or open. ${next}`
    expect(wrapper.find('#mcp-url').exists()).toBe(false)
    expect(wrapper.find('.copy-plain').exists()).toBe(false)
    expect(wrapper.get('.endpoint-error').text()).toBe(said)
    const tab = (name: string) => wrapper.findAll('[role="tab"]').find((found) => found.get('.tile-name').text() === name)!
    for (const name of ['Claude Code', 'Cursor']) {
      await tab(name).trigger('click')
      // Only the error: no "Paste this line" or "Opens Cursor" with nothing under it.
      expect(wrapper.get('#install-panel').text()).toBe(said)
      expect(wrapper.find('#mcp-command').exists()).toBe(false)
      expect(wrapper.find('a.how-link').exists()).toBe(false)
    }
  }

  it('keeps the heading and says so without any connected app', async () => {
    apps = []
    const { wrapper } = await page()
    expect(wrapper.get('#clients-title').text()).toBe('Connected assistants and apps')
    expect(wrapper.get('.clients-empty').text()).toBe('No connected assistants or apps. When an assistant or app asks to use your Tresso and you allow it, it shows up here.')
    expect(wrapper.find('.clients-warning').exists()).toBe(false)
    expect(wrapper.find('#client-title').exists()).toBe(false)
  })

  it('shows where each app sends you back to, and that Tresso has not checked the apps', async () => {
    apps = [app('claude', 'Claude', ['mail:read'], { domains: ['claude.ai', 'localhost'], connectedAt: '2025-09-02T08:00:00+00:00' })]
    const { wrapper } = await page()
    expect(wrapper.get('.clients-warning').text()).toBe('Tresso has not checked these apps: disconnect any you do not recognize.')
    expect(wrapper.get('.detail-text .domains').text()).toBe('claude.ai, localhost')
    expect(wrapper.get('.detail-text .sub').text()).toBe('Connected 2 Sep 2025 by you.')
  })

  it('closes the revoke dialog with Escape and keeps the app', async () => {
    const { wrapper } = await page()
    await wrapper.get('button.revoke').trigger('click')
    await settle()
    await wrapper.get('dialog').trigger('cancel')
    await settle()
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(0)
    expect(document.activeElement).toBe(wrapper.get('button.revoke').element)
  })
})
