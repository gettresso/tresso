import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { AppActivityEntry, AppActivityPage } from '@tresso/core'
import SettingsAppActivityView from '../SettingsAppActivityView.vue'

const today = (h: number, m: number, s: number) => {
  const at = new Date()
  at.setHours(h, m, s, 0)
  return at.toISOString()
}

const REFUSED: AppActivityEntry = {
  id: 'e4',
  occurredAt: today(10, 21, 5),
  app: { key: 'client:chatgpt', type: 'client', name: 'ChatGPT', connectedAppId: 'consent-chatgpt', personalAccessTokenId: null },
  channel: 'mcp',
  action: { name: 'send_whatsapp_message', title: 'Send a WhatsApp message' },
  kind: 'send',
  result: 'refused',
  reason: { code: 'no_permission', label: 'No permission', sentence: 'ChatGPT does not have the permission Send WhatsApp messages as you. Nothing was sent.' },
  durationMs: 12,
  permissions: [{ scope: 'chat:send', label: 'Send WhatsApp messages as you', held: false }],
  object: { type: 'Chat', label: 'WhatsApp chat', list: false, id: 'chat_8f2k41', several: false },
  lastOccurredAt: today(10, 21, 5),
  count: 1,
}

const LISTED: AppActivityEntry = {
  id: 'e5',
  occurredAt: today(9, 41, 30),
  app: { key: 'token:pat-1', type: 'token', name: 'Invoice export script', connectedAppId: null, personalAccessTokenId: 'pat-1' },
  channel: 'api',
  action: { name: 'GET /api/v1/mail-accounts', title: 'List mail accounts' },
  kind: 'read',
  result: 'done',
  reason: null,
  durationMs: 140,
  permissions: [{ scope: 'settings:read', label: 'See settings', held: true }],
  object: { type: 'MailAccount', label: 'Mail accounts', list: true, id: null, several: false },
  lastOccurredAt: today(9, 43, 1),
  count: 3,
}

const FAILED: AppActivityEntry = {
  ...LISTED,
  id: 'e7',
  occurredAt: today(8, 52, 47),
  app: { key: 'client:bridge', type: 'client', name: 'Calendar bridge', connectedAppId: 'consent-bridge', personalAccessTokenId: null },
  action: { name: 'PATCH /api/v1/mail-accounts/{id}', title: 'Change a mail account' },
  kind: 'change',
  result: 'failed',
  reason: { code: 'server_error', label: 'Server error', sentence: 'Tresso could not finish this request.' },
  durationMs: 1200,
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('Settings, Apps, Activity log', () => {
  const queries: URLSearchParams[] = []
  let answer: (query: URLSearchParams) => AppActivityPage
  let hold: Promise<void> | null
  let failMore: boolean

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    queries.length = 0
    hold = null
    failMore = false
    const apps = [
      { key: 'client:chatgpt', type: 'client' as const, name: 'ChatGPT' },
      { key: 'token:pat-1', type: 'token' as const, name: 'Invoice export script' },
    ]
    answer = (query) =>
      query.get('cursor') === 'page-2'
        ? { items: [FAILED], nextCursor: null, apps, empty: false }
        : query.get('result') === 'failed'
          ? { items: [], nextCursor: null, apps, empty: false }
          : { items: [REFUSED, LISTED], nextCursor: 'page-2', apps, empty: false }
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input))
        queries.push(url.searchParams)
        if (hold !== null) await hold
        if (failMore && url.searchParams.has('cursor')) {
          return new Response(JSON.stringify({ detail: 'The server is busy. Try again in a moment.' }), { status: 503, headers: { 'Content-Type': 'application/problem+json' } })
        }
        if (url.searchParams.get('kind') === 'change') {
          return new Response(JSON.stringify({ detail: 'Could not read the log.' }), { status: 503, headers: { 'Content-Type': 'application/problem+json' } })
        }
        return new Response(JSON.stringify(answer(url.searchParams)))
      }),
    )
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
      routes: ['settings-apps-activity', 'settings-apps', 'settings-apps-assistants', 'settings-access-tokens', 'settings-connected-apps'].map((name) => ({ path: `/${name}`, name, component: stub })),
    })
    await router.push({ name: 'settings-apps-activity', query })
    const wrapper = mount(SettingsAppActivityView, { global: { plugins: [router] }, attachTo: document.body })
    await settle()
    return wrapper
  }

  it('shows the keep line, the filters and the entries of the last 24 hours, newest first', async () => {
    const wrapper = await page()
    expect(wrapper.get('h2').text()).toBe('Activity log')
    expect(wrapper.get('.lead').text()).toBe('Everything AI assistants and apps did with your Tresso, through MCP and the API.')
    expect(wrapper.get('.keeps span').text()).toBe('The log keeps the time, the app, the action, the result, and the kind and id of what was touched. It does not keep message text, file content or the addresses of other people. Entries are removed after 90 days.')
    expect(queries[0]!.toString()).toBe('period=24h')
    expect(wrapper.findAll('#log-app option').map((option) => option.text())).toEqual(['All apps', 'ChatGPT', 'Invoice export script'])
    expect(wrapper.findAll('#log-kind option').map((option) => option.text())).toEqual(['All kinds', 'Read', 'Change', 'Send'])
    expect(wrapper.findAll('#log-result option').map((option) => option.text())).toEqual(['All results', 'Done', 'Refused', 'Failed'])
    expect(wrapper.findAll('#log-period option').map((option) => option.text())).toEqual(['Last 24 hours', 'Last 7 days', 'Last 30 days', 'Last 90 days'])
    expect(wrapper.findAll('th').map((th) => th.text())).toEqual(['Time', 'App', 'Action', 'Kind', 'Result', 'Duration', 'Details'])

    const rows = wrapper.findAll('tbody tr')
    expect(rows.map((row) => row.findAll('td').map((td) => td.text()).slice(0, 6))).toEqual([
      ['10:21:05', 'ChatGPT', 'Send a WhatsApp messagesend_whatsapp_message', 'Send', 'RefusedNo permission', '12 ms'],
      ['09:41:30', 'Invoice export script', 'List mail accountsGET /api/v1/mail-accounts', 'Read', 'Done', '140 ms'],
    ])
    expect(wrapper.get('.count').text()).toBe('2 entries')
    expect(wrapper.get('button.older').text()).toBe('Show older entries')
  })

  it('opens a row with what was used and touched, how it came in, why, and where to change it', async () => {
    const wrapper = await page()
    const toggle = wrapper.findAll('button.toggle')[0]!
    expect(toggle.attributes('aria-label')).toBe('Details of Send a WhatsApp message by ChatGPT at 10:21:05')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')

    const detail = wrapper.get('.detail-row')
    expect(detail.findAll('.fact').map((fact) => fact.text())).toEqual([
      'Permission usedSend WhatsApp messages as you, off for ChatGPTchat:send',
      'What it touchedWhatsApp chatchat_8f2k41',
      'Came in throughMCP',
    ])
    expect(detail.get('.why').text()).toBe('Why it was refused. ChatGPT does not have the permission Send WhatsApp messages as you. Nothing was sent.')
    expect(detail.get('.detail-foot span').text()).toBe('Only the kind and the id are kept. The content of what was touched is not in the log.')
    expect(detail.get('.detail-foot a').text()).toBe('Change what ChatGPT may do')
    expect(detail.get('.detail-foot a').attributes('href')).toBe('/settings-apps-assistants?app=consent-chatgpt')

    await wrapper.findAll('button.toggle')[1]!.trigger('click')
    const second = wrapper.get('.detail-row')
    expect(second.findAll('.fact')[1]!.text()).toBe('What it touchedMail accountsNo id. A list has none.')
    expect(second.findAll('.fact')[3]!.text()).toBe('How often3 timesFirst at 09:41:30, last at 09:43:01')
    expect(second.find('.why').exists()).toBe(false)
    expect(second.get('.detail-foot a').text()).toBe('Open personal access tokens')
    expect(second.get('.detail-foot a').attributes('href')).toBe('/settings-access-tokens')
    expect(wrapper.findAll('.detail-row')).toHaveLength(1)
  })

  it('shows older entries after the newest, and the count of all shown', async () => {
    const wrapper = await page()
    await wrapper.get('button.older').trigger('click')
    await settle()
    expect(queries[queries.length - 1]!.toString()).toBe('period=24h&cursor=page-2')
    expect(wrapper.findAll('tbody tr').map((row) => row.findAll('td')[1]!.text())).toEqual(['ChatGPT', 'Invoice export script', 'Calendar bridge'])
    expect(wrapper.get('.count').text()).toBe('3 entries')
    expect(wrapper.find('button.older').exists()).toBe(false)

    await wrapper.findAll('button.toggle')[2]!.trigger('click')
    expect(wrapper.get('.why').text()).toBe('Why it failed. Tresso could not finish this request.')
    expect(wrapper.findAll('tbody tr')[2]!.findAll('td')[5]!.text()).toBe('1.2 s')
  })

  it('asks again for each filter, and says when nothing matches', async () => {
    const wrapper = await page()
    await wrapper.get('#log-app').setValue('client:chatgpt')
    await settle()
    expect(queries[queries.length - 1]!.toString()).toBe('period=24h&app=client%3Achatgpt')
    await wrapper.get('#log-kind').setValue('send')
    await wrapper.get('#log-period').setValue('90d')
    await settle()
    expect(queries[queries.length - 1]!.toString()).toBe('period=90d&app=client%3Achatgpt&kind=send')
    await wrapper.get('#log-result').setValue('failed')
    await settle()
    expect(queries[queries.length - 1]!.toString()).toBe('period=90d&app=client%3Achatgpt&kind=send&result=failed')
    expect(wrapper.get('.no-match').text()).toBe('No entries match these filtersChoose another app, kind or result, or a longer period.')
    expect(wrapper.get('.no-match').attributes('role')).toBe('status')
    expect(wrapper.find('.count').exists()).toBe(false)
  })

  it('keeps the entries when older ones fail to load, says why under the table and tries again', async () => {
    failMore = true
    const wrapper = await page()
    await wrapper.get('button.older').trigger('click')
    await settle()
    expect(wrapper.findAll('tbody tr')).toHaveLength(2)
    expect(wrapper.get('.more-error').text()).toContain('The server is busy. Try again in a moment.')
    expect(wrapper.find('.foot button.older').exists()).toBe(false)
    expect(wrapper.get('.more-error').attributes('role')).toBe('alert')

    failMore = false
    await wrapper.get('.more-error button').trigger('click')
    await settle()
    expect(wrapper.find('.more-error').exists()).toBe(false)
    expect(wrapper.findAll('tbody tr')).toHaveLength(3)
  })

  it('moves the focus to the first new entry when the last page arrives', async () => {
    const wrapper = await page()
    ;(wrapper.get('button.older').element as HTMLButtonElement).focus()
    await wrapper.get('button.older').trigger('click')
    await settle()
    expect(document.activeElement).toBe(wrapper.findAll('tbody tr')[2]!.element)
  })

  it('says why the log could not be read', async () => {
    const wrapper = await page()
    await wrapper.get('#log-kind').setValue('change')
    await settle()
    expect(wrapper.get('[role="alert"]').text()).toBe('Could not read the log.')
    expect(wrapper.find('table').exists()).toBe(false)
  })

  it('opens on the period the address names, as the full log of one assistant does', async () => {
    await page({ app: 'client:chatgpt', period: '90d' })
    expect(queries[0]!.toString()).toBe('period=90d&app=client%3Achatgpt')
  })

  it('says when repeats touched several objects', async () => {
    answer = () => ({ items: [{ ...LISTED, object: { type: 'SmartInbox', label: 'Smart inbox', list: false, id: null, several: true } }], nextCursor: null, apps: [], empty: false })
    const wrapper = await page()
    await wrapper.get('button.toggle').trigger('click')
    expect(wrapper.get('.detail-row').findAll('.fact')[1]!.text()).toBe('What it touchedSmart inboxSeveral, not kept one by one')
  })

  it('leaves out what was touched for an action that went through without an object', async () => {
    answer = () => ({ items: [{ ...LISTED, object: null }], nextCursor: null, apps: [], empty: false })
    const wrapper = await page()
    await wrapper.get('button.toggle').trigger('click')
    expect(wrapper.get('.detail-row').text()).not.toContain('What it touched')
  })

  it('opens filtered on the app the address names', async () => {
    await page({ app: 'client:chatgpt' })
    expect(queries[0]!.toString()).toBe('period=24h&app=client%3Achatgpt')
  })

  it('shows the loading state, then the empty log', async () => {
    let release = () => undefined as void
    hold = new Promise<void>((resolve) => (release = resolve))
    answer = () => ({ items: [], nextCursor: null, apps: [], empty: true })
    const stub = { template: '<div />' }
    const router = createRouter({ history: createMemoryHistory(), routes: ['settings-apps-activity', 'settings-apps', 'settings-apps-assistants'].map((name) => ({ path: `/${name}`, name, component: stub })) })
    const wrapper = mount(SettingsAppActivityView, { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    const loading = wrapper.get('[aria-label="Loading the log"]')
    expect(loading.attributes('role')).toBe('status')
    expect(loading.text()).toContain('Loading the log')
    expect(wrapper.findAll('.skeleton')).toHaveLength(6)

    release()
    await settle()
    expect(wrapper.find('.skeleton').exists()).toBe(false)
    expect(wrapper.get('.empty-title').text()).toBe('Nothing in the log yet')
    expect(wrapper.get('.empty-line').text()).toBe('When an AI assistant or an app uses your Tresso through MCP or the API, every action shows up here.')
    expect(wrapper.get('.empty-link').text()).toBe('Add an AI assistant')
    expect(wrapper.get('.empty-link').attributes('href')).toBe('/settings-apps-assistants')
    expect(wrapper.find('table').exists()).toBe(false)
  })
})
