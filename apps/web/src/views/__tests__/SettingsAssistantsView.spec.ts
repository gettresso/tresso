import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { AppActivityEntry, AppActivityPage, ConnectedApp } from '@tresso/core'
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

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    refusePatch = null
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
          return new Response(JSON.stringify({ product: 'tresso-server', apiVersion: 1, billing: false, trialDays: 0, allowUnencryptedMailServers: false, mcpEndpoint: ENDPOINT }))
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
          return new Response(null, { status: 204 })
        }
        if (url.pathname === '/api/v1/app-activity') {
          const app = url.searchParams.get('app')
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
          }
          return new Response(JSON.stringify(page))
        }
        return new Response('{}')
      }),
    )
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
    expect(wrapper.get('h2').text()).toBe('AI assistants')
    expect(wrapper.get('.lead').text()).toBe('Let an AI assistant work with your Tresso through MCP. You decide what each one may do.')
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
    expect(wrapper.get('.how-line').text()).toBe('VS Code has no install link. Copy your MCP endpoint below and follow these steps.')
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
    expect(wrapper.findAll('.client .client-name').map((name) => name.text())).toEqual(['Claude', 'Cursor'])
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
      'With Change settings an assistant may prepare a list of mail addresses to add. You sign in to each account yourself.',
      'File links are never given to an assistant.',
      'Tresso does not ask you again before an assistant sends a WhatsApp message: your assistant asks you. An app can queue at most 20 messages in 10 minutes and 100 a day.',
    ])

    expect(requests.some((request) => request.path === '/api/v1/app-activity' && request.query === '?app=client%3Aclaude&limit=6')).toBe(true)
    expect(wrapper.findAll('.recent-title').map((title) => title.text())).toEqual(['Get a mail account', 'List WhatsApp chats, refused'])
    expect(wrapper.findAll('.recent-tool').map((tool) => tool.text())).toEqual(['get_mail_account', 'list_whatsapp_chats (no permission)'])
    expect(wrapper.get('a.full-log').text()).toBe('Full activity log')
    expect(wrapper.get('a.full-log').attributes('href')).toBe('/settings/apps/activity?app=client:claude')
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

  it('revokes access at once and offers no undo, since the app has to ask again', async () => {
    const { wrapper } = await page()
    await wrapper.get('button.revoke').trigger('click')
    await settle()
    expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.path)).toEqual(['/api/v1/connected-apps/claude'])
    expect(wrapper.get('.revoked-note').text()).toBe('Access revoked. The next request from Claude is refused and it has to ask for permission again.')
    expect(wrapper.find('button.revoke').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Undo revoke')
    expect(wrapper.findAll('.client-meta')[1]!.text()).toBe('Access revoked')
    expect(wrapper.findAll('[role="switch"]').every((one) => one.attributes('aria-checked') === 'false' && one.attributes('aria-disabled') === 'true')).toBe(true)
  })

  it('shows no connected assistants section without any', async () => {
    apps = []
    const { wrapper } = await page()
    expect(wrapper.find('#clients-title').exists()).toBe(false)
    expect(wrapper.get('#add-title').text()).toBe('Add an assistant')
  })
})
