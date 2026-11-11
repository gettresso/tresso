import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { SearchHit, SearchResults } from '@tresso/core'
import { useMailStore } from '@/stores/mail'
import SearchView from '../SearchView.vue'

function hit(id: string, subject: [string, string, string], override: Partial<SearchHit> = {}): SearchHit {
  return {
    id,
    threadId: `thread-${id}`,
    accountId: 'work',
    folderIds: [],
    fromAddress: 'anna@finance.example',
    fromName: 'Anna de Vries',
    receivedAt: '2026-10-19T09:12:00+00:00',
    seen: true,
    flagged: false,
    hasAttachments: false,
    subject: [
      { text: subject[0], match: false },
      { text: subject[1], match: true },
      { text: subject[2], match: false },
    ].filter((segment) => segment.text !== ''),
    from: [{ text: 'Anna de Vries', match: false }],
    preview: [{ text: 'I updated the numbers.', match: false }],
    attachments: [],
    ...override,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('SearchView', () => {
  const requests: URL[] = []
  let pages: Record<string, SearchResults>
  let failure: { status: number; body: unknown } | null

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    failure = null
    pages = {
      '1': {
        query: 'budget',
        page: 1,
        perPage: 20,
        totalHits: 2,
        totalPages: 2,
        messages: [
          hit('m1', ['Q4 ', 'budget', ', revised'], {
            seen: false,
            hasAttachments: true,
            attachments: [
              { id: 'a1', filename: [{ text: 'budget', match: true }, { text: '-q4.xlsx', match: false }], contentType: 'application/vnd.ms-excel', size: 48000, matched: true, scanStatus: 'clean' },
              { id: 'a2', filename: [{ text: 'budget', match: true }, { text: '.exe', match: false }], contentType: 'application/octet-stream', size: 900, matched: true, scanStatus: 'infected' },
            ],
          }),
        ],
      },
      '2': { query: 'budget', page: 2, perPage: 20, totalHits: 2, totalPages: 2, messages: [hit('m2', ['Team day ', 'budget', ''])] },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        requests.push(url)
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
        if (url.pathname === '/api/v1/search') {
          return failure ? json(failure.body, failure.status) : json(pages[url.searchParams.get('page') ?? '1'])
        }
        return json({ detail: 'Unexpected request' }, 500)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  async function mountView(q: string) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'unified', component: { template: '<div />' } },
        { path: '/inbox/:threadId', name: 'unified-thread', component: { template: '<div />' } },
        { path: '/search', name: 'search', component: SearchView },
        { path: '/outbox', name: 'outbox', component: { template: '<div />' } },
        { path: '/drafts', name: 'drafts', component: { template: '<div />' } },
        { path: '/todos', name: 'todos', component: { template: '<div />' } },
        { path: '/cleanup', name: 'cleanup', component: { template: '<div />' } },
        { path: '/waiting', name: 'waiting', component: { template: '<div />' } },
        { path: '/brief', name: 'brief', component: { template: '<div />' } },
        { path: '/calendar', name: 'calendar', component: { template: '<div />' } },
        { path: '/triage', name: 'triage', component: { template: '<div />' } },
        { path: '/accounts/:accountId', name: 'account', component: { template: '<div />' } },
        { path: '/settings/accounts', name: 'settings-accounts', component: { template: '<div />' } },
        { path: '/settings/accounts/new', name: 'settings-accounts-new', component: { template: '<div />' } },
      ],
    })
    await router.push({ name: 'search', query: { q } })
    await router.isReady()
    useMailStore().accounts = [
      { id: 'work', emailAddress: 'kim@company.example', displayName: 'Work', provider: 'imap', status: 'active', statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null },
    ]
    const wrapper = mount(SearchView, { global: { plugins: [router] } })
    await settle()

    return { wrapper, router }
  }

  it('asks the API with the query and the local time zone', async () => {
    await mountView('budget')

    const search = requests.find((url) => url.pathname === '/api/v1/search')
    expect(search?.searchParams.get('q')).toBe('budget')
    expect(search?.searchParams.get('page')).toBe('1')
    expect(search?.searchParams.get('perPage')).toBe('20')
    expect(search?.searchParams.get('timeZone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it('shows emails with their matches marked as text', async () => {
    pages['1']!.messages[0]!.subject = [{ text: '<b>Q4</b> ', match: false }, { text: 'budget', match: true }]
    const { wrapper } = await mountView('budget')

    const row = wrapper.get('section[aria-label="Emails"] li')
    expect(row.get('.subject').html()).toContain('&lt;b&gt;Q4&lt;/b&gt;')
    expect(row.get('mark').text()).toBe('budget')
    expect(row.classes()).not.toContain('unread')
    expect(row.get('.row').classes()).toContain('unread')
    // Unread is heard as part of the link, not only seen in the dot.
    expect(row.get('.row').text()).toContain('Unread.')
    expect(row.text()).toContain('Work')
    expect(wrapper.text()).toContain('2 emails, 2 attachments')
  })

  it('lists matching attachments apart', async () => {
    const { wrapper } = await mountView('budget')

    const attachments = wrapper.get('section[aria-label="Matching attachments"]')
    expect(attachments.text()).toContain('budget-q4.xlsx')
    expect(attachments.text()).toContain('XLSX')
    expect(attachments.get('mark').text()).toBe('budget')
  })

  it('marks attachments that were blocked', async () => {
    const { wrapper } = await mountView('budget')

    const [clean, blocked] = wrapper.get('section[aria-label="Matching attachments"]').findAll('a')
    expect(clean!.classes()).not.toContain('blocked')
    expect(clean!.text()).not.toContain('malware')
    expect(blocked!.classes()).toContain('blocked')
    expect(blocked!.text()).toContain('blocked: contains malware')
    expect(blocked!.find('[aria-label="Blocked: contains malware"]').exists()).toBe(true)
  })

  it('opens the thread of a result', async () => {
    const { wrapper, router } = await mountView('budget')

    await wrapper.get('section[aria-label="Emails"] a').trigger('click')
    await settle()

    expect(router.currentRoute.value.name).toBe('unified-thread')
    expect(router.currentRoute.value.params.threadId).toBe('thread-m1')
  })

  it('loads more results below the ones shown', async () => {
    const { wrapper } = await mountView('budget')

    await wrapper.get('button.more').trigger('click')
    await settle()

    expect(requests.filter((url) => url.pathname === '/api/v1/search').map((url) => url.searchParams.get('page'))).toEqual(['1', '2'])
    expect(wrapper.findAll('section[aria-label="Emails"] li')).toHaveLength(2)
    expect(wrapper.find('button.more').exists()).toBe(false)
  })

  it('narrows the search with the filter chips', async () => {
    const { wrapper, router } = await mountView('budget')

    await wrapper.get('button[aria-pressed="false"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query.q).toBe('budget has:attachment')

    expect(wrapper.findAll('label.chip')[0]!.classes()).not.toContain('on')
    await wrapper.findAll('select')[0]!.setValue('kim@company.example')
    await settle()
    expect(router.currentRoute.value.query.q).toBe('budget has:attachment in:kim@company.example')
    expect(wrapper.findAll('label.chip')[0]!.classes()).toContain('on')
    expect(wrapper.get('button[aria-pressed="true"]').text()).toContain('Has attachment')
    expect((wrapper.findAll('select')[0]!.element as HTMLSelectElement).value).toBe('kim@company.example')
  })

  it('explains a query the API cannot run', async () => {
    failure = { status: 422, body: { detail: 'q: invalid', violations: [{ propertyPath: 'q', message: '"before:soon" needs a date like before:2026-10-01.' }] } }
    const { wrapper } = await mountView('before:soon')

    expect(wrapper.get('[role="alert"]').text()).toBe('"before:soon" needs a date like before:2026-10-01.')
  })

  it('says when nothing matches', async () => {
    pages['1'] = { query: 'nothing', page: 1, perPage: 20, totalHits: 0, totalPages: 0, messages: [] }
    const { wrapper } = await mountView('nothing')

    expect(wrapper.text()).toContain('No mail matches this search.')
    expect(wrapper.text()).toContain('0 emails')
  })
})
