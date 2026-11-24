import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { AppActivityPage, ConnectedApp, MailAccount, MeetingPreferences, PersonalAccessToken, SyncedChatAccount } from '@tresso/core'
import { calendar } from '@tresso/core/testing'
import { useAuthStore } from '@/stores/auth'
import { useChatsStore } from '@/stores/chats'
import { useMailStore } from '@/stores/mail'
import SettingsAppsView from '../SettingsAppsView.vue'

function account(id: string, provider: string, emailAddress: string, extra: Partial<MailAccount> = {}): MailAccount {
  return {
    id,
    emailAddress,
    displayName: emailAddress,
    provider,
    status: 'active',
    statusDetail: null,
    username: null,
    imap: null,
    smtp: null,
    calendarUrl: null,
    calendarStatus: 'active',
    calendarStatusDetail: null,
    lastSyncedAt: null,
    createdAt: '2026-01-01T00:00:00+00:00',
    defaultSignatureId: null,
    ...extra,
  } as MailAccount
}

function app(id: string, name: string, scopes: string[], extra: Partial<ConnectedApp> = {}): ConnectedApp {
  return { id, name, domains: ['claude.ai'], scopes, grantedScopes: scopes, connectedAt: '2026-09-02T08:00:00+00:00', lastUsedAt: null, activityKey: `client:${id}`, ...extra }
}

function token(id: string, extra: Partial<PersonalAccessToken> = {}): PersonalAccessToken {
  return { id, name: id, prefix: `tresso_pat_${id}`, scopes: ['mail:read'], createdAt: '2026-11-01T08:00:00+00:00', expiresAt: '2099-01-01T00:00:00+00:00', lastUsedAt: null, revokedAt: null, activityKey: `token:${id}`, ...extra }
}

const SUPPORT = account('support', 'gmail', 'support@company.example', { status: 'auth_failed' })
const WORK = account('work', 'microsoft', 'kim@company.example')

const CALENDARS = [
  calendar('g', 'support', { source: 'google', name: 'Support', isDefault: true, conferenceProviders: ['meet'] }),
  calendar('w', 'work', { source: 'microsoft', name: 'Work', isDefault: true, conferenceProviders: ['teams'] }),
]

const WHATSAPP: SyncedChatAccount = {
  id: 'wa',
  channel: 'whatsapp',
  address: '31698765432',
  displayName: null,
  relayDeviceId: 'mac',
  relayDeviceName: 'Kim’s Mac',
  relayOnline: true,
  relayOfflineSince: null,
  bridge: 'running',
  link: 'linked',
  linkedAt: '2026-11-01T08:00:00+00:00',
  loopbackOnly: true,
  includeGroups: true,
  notify: true,
} as SyncedChatAccount

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('Settings, Apps', () => {
  let preferences: MeetingPreferences
  let apps: ConnectedApp[]
  let tokens: PersonalAccessToken[]
  let activity: AppActivityPage

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    preferences = { ownLink: 'https://meet.example/kim', addWithGuests: true, defaults: {}, defaultOther: null, disabled: [], apps: ['meet', 'teams', 'own'] }
    apps = [app('claude', 'Claude', ['mail:read', 'todos:read', 'todos:write', 'settings:read', 'settings:write', 'signatures:read', 'signatures:write']), app('chatgpt', 'ChatGPT', ['mail:read', 'todos:read', 'todos:write'])]
    tokens = [token('backup'), token('old', { revokedAt: '2026-11-02T08:00:00+00:00' })]
    activity = {
      items: [
        {
          id: 'e1',
          occurredAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          app: { key: 'client:claude', type: 'client', name: 'Claude', connectedAppId: 'claude', personalAccessTokenId: null },
          channel: 'mcp',
          action: { name: 'get_me', title: 'Who am I' },
          kind: 'read',
          result: 'done',
          reason: null,
          durationMs: 10,
          permissions: [],
          object: null,
          lastOccurredAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          count: 1,
        },
      ],
      nextCursor: null,
      apps: [],
      empty: false,
    }
    useMailStore().calendars = CALENDARS
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        const path = new URL(String(input)).pathname
        const body: Record<string, unknown> = {
          '/api/v1/calendar/meeting-preferences': preferences,
          '/api/v1/mail-accounts': [SUPPORT, WORK],
          '/api/v1/connected-apps': apps,
          '/api/v1/personal-access-tokens': tokens,
          '/api/v1/app-activity': activity,
        }
        return new Response(JSON.stringify(body[path] ?? {}))
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  async function page() {
    const stub = { template: '<div />' }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: ['settings-apps', 'settings-apps-assistants', 'settings-apps-activity', 'settings-meeting-apps', 'settings-access-tokens', 'settings-connected-apps', 'settings-whatsapp', 'settings-whatsapp-connect'].map((name) => ({ path: `/${name}`, name, component: stub })),
    })
    const wrapper = mount(SettingsAppsView, { global: { plugins: [router] }, attachTo: document.body })
    await settle()
    return wrapper
  }

  const row = (wrapper: Awaited<ReturnType<typeof page>>, key: string) => wrapper.find(`[data-row="${key}"]`)
  const summary = (wrapper: Awaited<ReturnType<typeof page>>, key: string) => {
    const found = row(wrapper, key)
    return {
      name: found.get('.name').text(),
      cat: found.get('.cat').text(),
      line: found.get('.line').text(),
      pill: found.find('.pill').exists() ? found.get('.pill').text() : null,
      detail: found.get('.detail').text(),
      action: found.find('a.action').exists() ? found.get('a.action').text() : null,
    }
  }

  it('shows the two groups with the board words and a row per real app', async () => {
    const wrapper = await page()
    expect(wrapper.get('h2').text()).toBe('Apps')
    expect(wrapper.get('.lead').text()).toBe('Everything that is connected to Tresso, in one place: the apps Tresso uses for you, and the apps that may use your Tresso.')
    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('Category')
    expect(wrapper.findAll('.filter').map((chip) => chip.text())).toEqual(['All', 'Meetings', 'Messaging', 'AI assistants and apps', 'Developer'])
    expect(wrapper.findAll('.filter').map((chip) => [chip.attributes('aria-pressed'), chip.attributes('tabindex')])).toEqual([
      ['true', undefined],
      ['false', undefined],
      ['false', undefined],
      ['false', undefined],
      ['false', undefined],
    ])
    expect(wrapper.findAll('.group h3').map((heading) => heading.text())).toEqual(['Tresso uses these', 'These can use your Tresso'])
    expect(wrapper.findAll('.group .sub').map((sub) => sub.text())).toEqual([
      'Tresso reaches out to these apps for you, to make meeting links and to bring in your chats.',
      'These apps reach into Tresso. Each one signs in with your permission and can only do what you allow.',
    ])
    expect(wrapper.findAll('[data-row]').map((found) => found.attributes('data-row'))).toEqual(['meet', 'teams', 'own', 'zoom', 'assistant-claude', 'assistant-chatgpt', 'add', 'tokens'])

    expect(summary(wrapper, 'meet')).toEqual({ name: 'Google Meet', cat: 'Meetings', line: 'Makes meeting links on Google calendars.', pill: 'Needs attention', detail: 'The permission for support@company.example expired.', action: 'Review' })
    expect(row(wrapper, 'meet').get('a.action').classes()).toContain('primary')
    expect(summary(wrapper, 'teams')).toEqual({ name: 'Microsoft Teams', cat: 'Meetings', line: 'Makes meeting links on Microsoft 365 calendars.', pill: 'Connected', detail: 'kim@company.example', action: 'Manage' })
    expect(summary(wrapper, 'own')).toEqual({ name: 'My own link', cat: 'Meetings', line: 'One room link that you paste, the same for every event.', pill: 'Connected', detail: 'Your room link is set', action: 'Manage' })
    expect(summary(wrapper, 'zoom')).toEqual({ name: 'Zoom', cat: 'Meetings', line: 'Meeting links made by Zoom.', pill: 'Not available yet', detail: '', action: null })
    expect(row(wrapper, 'zoom').classes()).toContain('soon')

    expect(summary(wrapper, 'assistant-claude')).toEqual({ name: 'Claude', cat: 'AI assistants and apps', line: 'May read mail, change todos and signatures, and change settings.', pill: 'Connected', detail: 'claude.ai · Active 4 min ago', action: 'Manage' })
    expect(row(wrapper, 'assistant-claude').get('.mark').text()).toBe('CL')
    expect(summary(wrapper, 'assistant-chatgpt')).toEqual({ name: 'ChatGPT', cat: 'AI assistants and apps', line: 'May read mail and change todos.', pill: 'Connected', detail: 'claude.ai · Never used', action: 'Manage' })
    expect(row(wrapper, 'assistant-chatgpt').get('.mark').text()).toBe('CG')
    expect(summary(wrapper, 'add')).toEqual({ name: 'Add an AI assistant', cat: 'AI assistants and apps', line: 'Install in a few clicks. No password or token to paste.', pill: null, detail: '', action: 'Add' })
    expect(wrapper.text()).not.toContain('Connected apps')
    expect(summary(wrapper, 'tokens')).toEqual({ name: 'Personal access tokens', cat: 'Developer', line: 'Keys for your own scripts. A token acts as you.', pill: 'Connected', detail: '1 active token', action: 'Manage' })
    expect(wrapper.text()).not.toContain('Webhooks')

    expect(wrapper.get('.log-line span').text()).toBe('Everything these apps do through MCP and the API is written to the activity log.')
    expect(wrapper.get('.log-line a').text()).toBe('Open the activity log')
  })

  it('leads each row to the page that exists', async () => {
    const wrapper = await page()
    const href = (key: string) => row(wrapper, key).get('a.action').attributes('href')
    expect(href('meet')).toBe('/settings-meeting-apps')
    expect(href('own')).toBe('/settings-meeting-apps')
    expect(href('assistant-claude')).toBe('/settings-apps-assistants?app=claude')
    expect(href('add')).toBe('/settings-apps-assistants')
    expect(href('tokens')).toBe('/settings-access-tokens')
    expect(row(wrapper, 'assistant-claude').get('a.action').attributes('aria-label')).toBe('Manage Claude')
    expect(wrapper.get('.log-line a').attributes('href')).toBe('/settings-apps-activity')
  })

  it('filters by category with pressed buttons and hides a group without rows', async () => {
    const wrapper = await page()
    const chips = () => wrapper.findAll('.filter')

    await chips()[3]!.trigger('click')
    expect(chips().map((chip) => chip.attributes('aria-pressed'))).toEqual(['false', 'false', 'false', 'true', 'false'])
    expect(wrapper.findAll('.group h3').map((heading) => heading.text())).toEqual(['These can use your Tresso'])
    expect(wrapper.findAll('[data-row]').map((found) => found.attributes('data-row'))).toEqual(['assistant-claude', 'assistant-chatgpt', 'add'])

    await chips()[2]!.trigger('click')
    // Messaging without WhatsApp has no rows at all.
    expect(wrapper.findAll('.group')).toHaveLength(0)

    await chips()[0]!.trigger('click')
    expect(wrapper.findAll('[data-row]')).toHaveLength(8)
  })

  it('says what an app with every permission switched off can still see', async () => {
    apps = [app('quiet', 'Quiet app', [], { grantedScopes: ['mail:read'] })]
    const wrapper = await page()
    expect(row(wrapper, 'assistant-quiet').get('.line').text()).toBe('Every permission is switched off. It can still see your name, email address and organizations.')
    expect(row(wrapper, 'assistant-quiet').get('a.action').attributes('href')).toBe('/settings-apps-assistants?app=quiet')
  })

  it('forgets when apps were active once another user signs in', async () => {
    const wrapper = await page()
    expect(row(wrapper, 'assistant-claude').get('.detail').text()).toBe('claude.ai · Active 4 min ago')
    useAuthStore().generation++
    await settle()
    expect(row(wrapper, 'assistant-claude').exists()).toBe(false)
  })

  it('shows WhatsApp as the browser has it, and a Mac that is offline as needing attention', async () => {
    useChatsStore().serverAccount = WHATSAPP
    let wrapper = await page()
    expect(summary(wrapper, 'whatsapp')).toEqual({ name: 'WhatsApp', cat: 'Messaging', line: 'Brings your WhatsApp chats into the inbox.', pill: 'Connected', detail: '+31698765432', action: 'Manage' })
    expect(row(wrapper, 'whatsapp').get('.mark').text()).toBe('WA')
    expect(row(wrapper, 'whatsapp').get('a.action').attributes('href')).toBe('/settings-whatsapp')
    wrapper.unmount()

    useChatsStore().serverAccount = { ...WHATSAPP, relayOnline: false }
    wrapper = await page()
    expect(summary(wrapper, 'whatsapp')).toMatchObject({ pill: 'Needs attention', detail: 'Mac offline', action: 'Review' })
  })

  it('shows what is not connected yet as such, and no row for an app the server does not offer', async () => {
    apps = []
    tokens = [token('old', { revokedAt: '2026-11-02T08:00:00+00:00' })]
    preferences = { ...preferences, ownLink: null, apps: ['own'] }
    const wrapper = await page()
    expect(wrapper.findAll('[data-row]').map((found) => found.attributes('data-row'))).toEqual(['own', 'zoom', 'add', 'tokens'])
    expect(summary(wrapper, 'own')).toMatchObject({ pill: 'Not connected', detail: 'No link yet', action: 'Set up' })
    expect(summary(wrapper, 'tokens')).toMatchObject({ pill: 'Not connected', detail: '', action: 'Set up' })
  })

  it('says what could not be loaded and still shows the rest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/v1/personal-access-tokens') {
          return new Response(JSON.stringify({ detail: 'The server is busy. Try again in a moment.' }), { status: 503, headers: { 'Content-Type': 'application/problem+json' } })
        }
        const body: Record<string, unknown> = { '/api/v1/calendar/meeting-preferences': preferences, '/api/v1/mail-accounts': [WORK], '/api/v1/connected-apps': apps, '/api/v1/app-activity': activity }
        return new Response(JSON.stringify(body[path] ?? {}))
      }),
    )
    const wrapper = await page()
    expect(wrapper.get('[role="alert"]').text()).toBe('The server is busy. Try again in a moment.')
    expect(row(wrapper, 'teams').exists()).toBe(true)
  })
})
