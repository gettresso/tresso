import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import type { SyncedMessage, Todo } from '@tresso/core'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import TodosView from '../TodosView.vue'

function todo(id: string, extra: Partial<Todo> = {}): Todo {
  return {
    id,
    title: `Todo ${id}`,
    notes: '',
    dueDate: null,
    dueTime: null,
    durationMinutes: null,
    completedAt: null,
    position: 0,
    source: 'manual',
    messageId: null,
    threadId: null,
    plannedStart: null,
    plannedEnd: null,
    planState: null,
    createdAt: '2026-10-19T08:00:00Z',
    updatedAt: '2026-10-19T08:00:00Z',
    ...extra,
  }
}

const email: SyncedMessage = {
  id: 'm1',
  mailAccountId: 'work',
  threadId: 't1',
  folderIds: ['inbox'],
  subject: 'Budget review',
  from: { address: 'anna@partner.example', name: 'Anna de Vries' },
  recipients: { to: [], cc: [], bcc: [], replyTo: [] },
  snippet: 'Can you look at the numbers?',
  sentAt: null,
  receivedAt: '2026-10-19T08:00:00Z',
  flags: { seen: true, flagged: false, answered: false, draft: false },
  hasAttachments: false,
  smartInboxId: null,
  verdict: 'do',
  summary: null,
  calendarMethod: null,
  attachmentScan: null,
}

/** Form validation runs asynchronously; let it and the requests it starts finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('TodosView', () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  let mail: ReturnType<typeof useMailStore>
  let router: Router
  /** What the next pull brings into the synced copy. */
  let afterSync: () => void
  /** While set, PATCH requests wait for it before the server answers. */
  let holdPatch: Promise<void> | null
  let refusePatch: boolean
  let refusePlan: boolean

  beforeEach(() => {
    // Tuesday 20 October 2026, 10:00 on this device; only the clock is fake, so promises and timers run as usual.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 20, 10, 0) })
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    afterSync = () => {}
    holdPatch = null
    refusePatch = false
    refusePlan = false
    mail = useMailStore()
    mail.ready = true
    mail.todos = [
      todo('overdue', { dueDate: '2026-10-19', position: 3 }),
      todo('budget', { title: 'Review the budget', dueDate: '2026-10-20', dueTime: '17:00', messageId: 'm1', threadId: 't1', source: 'automatic', position: 1 }),
      todo('later', { title: 'Renew the passport', position: 2 }),
      todo('done', { completedAt: new Date(2026, 9, 20, 9, 0).toISOString() }),
    ]
    vi.spyOn(mail, 'syncNow').mockImplementation(async () => afterSync())
    vi.spyOn(mail, 'messages').mockImplementation(async (ids) => (ids.includes('m1') ? [email] : []))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
        requests.push({ method, path: url.pathname, body })
        if (method === 'PATCH' && holdPatch !== null) {
          await holdPatch
        }
        if (method === 'PATCH' && refusePatch) {
          return new Response(JSON.stringify({ detail: 'Not now.' }), { status: 503 })
        }
        if (method === 'POST' && url.pathname.endsWith('/plan') && refusePlan) {
          return new Response(JSON.stringify({ detail: 'There is no free time that long before the due date.' }), { status: 422 })
        }
        if (method === 'DELETE') {
          return new Response(null, { status: 204 })
        }
        return new Response(JSON.stringify(todo('saved', body)), { status: method === 'POST' ? 201 : 200 })
      }),
    )
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'unified', component: { template: '<div />' } },
        { path: '/inbox/:threadId', name: 'unified-thread', component: { template: '<div />' } },
        { path: '/todos', name: 'todos', component: TodosView },
        { path: '/todos/:todoId', name: 'todo', component: TodosView },
        { path: '/calendar/:view?/:date?', name: 'calendar', component: { template: '<div />' } },
      ],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  async function mountAt(path: string) {
    await router.push(path)
    await router.isReady()
    const wrapper = mount(TodosView, { global: { plugins: [router] }, attachTo: document.body })
    await settle()
    return wrapper
  }

  function sections(wrapper: Awaited<ReturnType<typeof mountAt>>): [string, string[]][] {
    return wrapper.findAll('section').map((section) => [section.get('h2').text().replace(/\s*\d+$/, ''), section.findAll('.title').map((title) => title.text())])
  }

  it('lists todos by section, with the email they came from and when they are due', async () => {
    const wrapper = await mountAt('/todos')

    expect(sections(wrapper)).toEqual([
      ['Overdue', ['Todo overdue']],
      ['Today', ['Review the budget']],
      ['Later', ['Renew the passport']],
      ['Done', ['Todo done']],
    ])
    expect(wrapper.text()).toContain('3 open, 1 done today')
    const budget = wrapper.findAll('.row')[1]!
    expect(budget.get('.email').text()).toBe('Anna de Vries')
    expect(budget.get('.email').attributes('href')).toBe('/inbox/t1')
    // A long name is cut short on screen; the full name stays at hand.
    expect(budget.get('.email .sender').attributes('title')).toBe('Anna de Vries')
    expect(budget.get('.pill').text()).toBe('Automatic')
    expect(budget.get('.due').text()).toBe('Today 17:00')
    expect(wrapper.findAll('.row')[0]!.get('.due').classes()).toContain('overdue')
    expect(wrapper.findAll('.row')[2]!.get('.source').text()).toBe('Added by you')
  })

  it('adds a todo with the day and time found in what was typed', async () => {
    const wrapper = await mountAt('/todos')

    await wrapper.get('#quick-add').setValue('Call Anna friday 9:00')
    await settle()
    expect(wrapper.get('.quick-row .due').text()).toBe('Fri 23 Oct 09:00')
    await wrapper.get('form.quick-add').trigger('submit')
    await settle()

    expect(requests).toEqual([{ method: 'POST', path: '/api/v1/todos', body: { title: 'Call Anna', dueDate: '2026-10-23', dueTime: '09:00' } }])
    expect((wrapper.get('#quick-add').element as HTMLInputElement).value).toBe('')
  })

  it('refuses a quick add without anything to do before asking the server', async () => {
    const wrapper = await mountAt('/todos')

    await wrapper.get('#quick-add').setValue('tomorrow')
    await wrapper.get('form.quick-add').trigger('submit')
    await settle()

    expect(requests).toEqual([])
    expect(wrapper.text()).toContain('Say what to do, not only when.')
  })

  it('checks a todo off at once and puts it back when the server refuses', async () => {
    let release!: () => void
    holdPatch = new Promise((resolve) => (release = resolve))
    refusePatch = true
    const wrapper = await mountAt('/todos')

    await wrapper.get('input[aria-label="Complete Renew the passport"]').setValue(true)
    await settle()
    expect(sections(wrapper).find(([label]) => label === 'Done')?.[1]).toContain('Renew the passport')

    release()
    await settle()
    expect(requests).toEqual([{ method: 'PATCH', path: '/api/v1/todos/later', body: { done: true } }])
    expect(sections(wrapper).find(([label]) => label === 'Later')?.[1]).toEqual(['Renew the passport'])
    expect(useComposeStore().notices.map((notice) => notice.tone)).toEqual(['error'])
  })

  it('edits a todo in the detail panel and sends only what changed', async () => {
    const wrapper = await mountAt('/todos/budget')

    expect((wrapper.get('.detail input[type="date"]').element as HTMLInputElement).value).toBe('2026-10-20')
    await wrapper.get('.detail input[type="date"]').setValue('')
    await wrapper.get('.detail input[inputmode="numeric"]').setValue('45')
    await wrapper.get('form.detail').trigger('submit')
    await settle()

    expect(requests).toEqual([{ method: 'PATCH', path: '/api/v1/todos/budget', body: { dueDate: null, dueTime: null, durationMinutes: 45 } }])
  })

  it('completes a todo and archives its email', async () => {
    vi.spyOn(mail, 'messageIdsOf').mockResolvedValue(['m1', 'm0'])
    const act = vi.spyOn(mail, 'act').mockResolvedValue({ before: [], after: [] })
    const wrapper = await mountAt('/todos/budget')

    expect(wrapper.get('.detail .email').text()).toContain('Budget review')
    await wrapper.findAll('.detail button').find((button) => button.text() === 'Complete and archive email')!.trigger('click')
    await settle()

    expect(requests).toEqual([{ method: 'PATCH', path: '/api/v1/todos/budget', body: { done: true } }])
    expect(act).toHaveBeenCalledWith(['m1', 'm0'], 'archive')
  })

  it('deletes a todo after asking', async () => {
    const wrapper = await mountAt('/todos/later')

    await wrapper.findAll('.detail button').find((button) => button.text() === 'Delete')!.trigger('click')
    await wrapper.findAll('.detail button').find((button) => button.text() === 'Delete todo')!.trigger('click')
    await settle()

    expect(requests).toEqual([{ method: 'DELETE', path: '/api/v1/todos/later', body: undefined }])
    expect(router.currentRoute.value.name).toBe('todos')
  })

  it('plans a todo in the calendar and shows where it went', async () => {
    mail.todos = [todo('report', { title: 'Write the report', dueDate: '2026-10-23', durationMinutes: 60 })]
    afterSync = () => {
      mail.todos = [todo('report', { title: 'Write the report', dueDate: '2026-10-23', durationMinutes: 60, plannedStart: '2026-10-21T08:00:00Z', plannedEnd: '2026-10-21T09:00:00Z', planState: 'planned' })]
    }
    const wrapper = await mountAt('/todos/report')
    expect(wrapper.get('.plan-line').text()).toBe('Not in the calendar yet.')

    await wrapper.findAll('.detail button').find((button) => button.text() === 'Plan automatically')!.trigger('click')
    await settle()

    expect(requests).toEqual([{ method: 'POST', path: '/api/v1/todos/report/plan', body: undefined }])
    expect(wrapper.get('.plan-line').text()).toMatch(/^Planned Wednesday 21 October, \d\d:00 to \d\d:00$/)
    expect(wrapper.findAll('.plan-actions button').map((button) => button.text())).toEqual(['Plan again', 'Remove from calendar'])
    expect(wrapper.get('.plan-actions a').attributes('href')).toBe('/calendar/day/2026-10-21')
  })

  it('shows why a todo could not be planned', async () => {
    refusePlan = true
    mail.todos = [todo('report', { dueDate: '2026-10-20', durationMinutes: 600 })]
    const wrapper = await mountAt('/todos/report')

    await wrapper.findAll('.detail button').find((button) => button.text() === 'Plan automatically')!.trigger('click')
    await settle()

    expect(wrapper.get('.form-error').text()).toBe('There is no free time that long before the due date.')
  })

  it('removes the planned time and flags a conflict', async () => {
    mail.todos = [todo('report', { dueDate: '2026-10-23', durationMinutes: 60, plannedStart: '2026-10-21T08:00:00Z', plannedEnd: '2026-10-21T09:00:00Z', planState: 'conflict' })]
    const wrapper = await mountAt('/todos/report')
    expect(wrapper.get('.plan-line').classes()).toContain('conflict')
    expect(wrapper.get('.plan-line').text()).toContain('but that time is taken and nothing else is free before the due date')

    await wrapper.findAll('.detail button').find((button) => button.text() === 'Remove from calendar')!.trigger('click')
    await settle()

    expect(requests).toEqual([{ method: 'DELETE', path: '/api/v1/todos/report/plan', body: undefined }])
  })

  it('asks for a due date and a duration before planning', async () => {
    const wrapper = await mountAt('/todos/later')

    expect(wrapper.get('.plan-line').text()).toBe('Give it a due date and say how long it takes to plan it in the calendar.')
    expect(wrapper.findAll('.detail button').some((button) => button.text() === 'Plan automatically')).toBe(false)
  })
})
