import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { daysFrom, expandOccurrences, todoBlocks, type SyncedCalendarEvent } from '@tresso/core'
import { calendar as calendarRow, calendarEvent, todo } from '@tresso/core/testing'
import { useCalendarStore } from '@/stores/calendar'
import { useMailStore } from '@/stores/mail'
import AgendaList from '../calendar/AgendaList.vue'
import EventEditor from '../calendar/EventEditor.vue'
import MiniAgenda from '../calendar/MiniAgenda.vue'
import MonthGrid from '../calendar/MonthGrid.vue'
import TimeGrid from '../calendar/TimeGrid.vue'
import TodoBlockDetail from '../calendar/TodoBlockDetail.vue'
import InvitationCard from '../InvitationCard.vue'

const AMS = 'Europe/Amsterdam'
const now = Date.UTC(2026, 9, 20, 8, 24)
const work = calendarRow('work', 'work', { name: 'Work', isDefault: true })

function timed(id: string, start: string, end: string, extra: Partial<SyncedCalendarEvent> = {}): SyncedCalendarEvent {
  return calendarEvent(id, 'work', { summary: id, start: { dateTime: start, timeZone: AMS }, end: { dateTime: end, timeZone: AMS }, ...extra })
}

function router() {
  return createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/calendar/:view?/:date?', name: 'calendar', component: { template: '<div />' } }, { path: '/todos/:todoId', name: 'todo', component: { template: '<div />' } }] })
}

describe('time grid', () => {
  const days = daysFrom(Date.UTC(2026, 9, 19), 7, AMS)
  const events = [
    timed('Standup', '2026-10-19T09:00:00', '2026-10-19T09:15:00'),
    timed('Review', '2026-10-19T10:00:00', '2026-10-19T11:00:00', { selfResponse: 'needs-action' }),
    timed('Lunch', '2026-10-21T12:30:00', '2026-10-21T13:30:00', { location: 'Café Loos' }),
    calendarEvent('Offsite', 'work', { summary: 'Offsite', allDay: true, start: { date: '2026-10-22' }, end: { date: '2026-10-24' } }),
  ]
  const occurrences = expandOccurrences(events, days[0]!.start, days[6]!.end, AMS)

  function grid() {
    return mount(TimeGrid, { props: { days, occurrences, zone: AMS, now, today: Date.UTC(2026, 9, 20), calendars: () => work, selectedKey: null }, attachTo: document.body })
  }

  it('puts timed events on the grid and all-day ones in the all-day row, each with a full label', () => {
    const wrapper = grid()
    const blocks = wrapper.findAll('.block')
    expect(blocks.map((block) => block.find('.title').text())).toEqual(['Standup', 'Review', 'Lunch'])
    expect(blocks[0]!.attributes('style')).toContain('top: 540px')
    expect(blocks[1]!.classes()).toContain('pending')
    expect(blocks[2]!.attributes('aria-label')).toBe('Lunch, Wednesday 21 October, 12:30 to 13:30, Work, Café Loos')
    const span = wrapper.get('.span')
    expect(span.text()).toBe('Offsite')
    expect(span.attributes('style')).toContain('grid-column: 4 / 6')
    wrapper.unmount()
  })

  it('has one block in the tab order and moves with the arrow keys', async () => {
    const wrapper = grid()
    const tabbable = wrapper.findAll('[data-occurrence]').filter((item) => item.attributes('tabindex') === '0')
    expect(tabbable).toHaveLength(1)
    const standup = wrapper.findAll('.block')[0]!
    ;(standup.element as HTMLElement).focus()
    await standup.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toContain('Review')
    await wrapper.findAll('.block')[1]!.trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement?.textContent).toContain('Lunch')
    wrapper.unmount()
  })

  it('marks an event with a meeting link with a small camera after its title', () => {
    const linked = expandOccurrences(
      [timed('Call', '2026-10-20T09:00:00', '2026-10-20T10:00:00', { conference: { provider: 'meet', url: 'https://meet.google.com/kfp-wzqn-rtx', id: null, dialIn: null } }), timed('Desk', '2026-10-20T11:00:00', '2026-10-20T12:00:00')],
      days[0]!.start,
      days[6]!.end,
      AMS,
    )
    const wrapper = mount(TimeGrid, { props: { days, occurrences: linked, zone: AMS, now, today: Date.UTC(2026, 9, 20), calendars: () => work, selectedKey: null } })
    const [call, desk] = wrapper.findAll('.block')
    expect(call!.find('.title').text()).toBe('Call')
    expect(call!.get('.has-link').attributes('aria-hidden')).toBe('true')
    expect(desk!.find('.has-link').exists()).toBe(false)
    wrapper.unmount()
  })

  it('gives an event crossing midnight one tab stop', () => {
    const night = expandOccurrences([timed('Night', '2026-10-20T22:00:00', '2026-10-21T02:00:00')], days[0]!.start, days[6]!.end, AMS)
    const wrapper = mount(TimeGrid, { props: { days, occurrences: night, zone: AMS, now, today: Date.UTC(2026, 9, 20), calendars: () => work, selectedKey: null } })
    const pieces = wrapper.findAll('.block')
    expect(pieces).toHaveLength(2)
    expect(pieces.map((piece) => piece.attributes('tabindex'))).toEqual(['0', '-1'])
    wrapper.unmount()
  })

  it('opens an event and starts a new one where the user clicks', async () => {
    const wrapper = grid()
    await wrapper.findAll('.block')[2]!.trigger('click')
    expect(wrapper.emitted('open')?.[0]?.[0]).toMatchObject({ event: { id: 'Lunch' } })
    wrapper.unmount()
  })
})

describe('todos in the calendar', () => {
  const days = daysFrom(Date.UTC(2026, 9, 19), 7, AMS)
  const planned = { dueDate: '2026-10-23', durationMinutes: 60, plannedStart: '2026-10-20T12:00:00+00:00', plannedEnd: '2026-10-20T13:00:00+00:00', planState: 'planned' as const }
  const occurrences = expandOccurrences([timed('Review', '2026-10-20T14:30:00', '2026-10-20T15:30:00')], days[0]!.start, days[6]!.end, AMS)
  const blocks = todoBlocks([todo('report', { ...planned, title: 'Write the report' }), todo('slides', { ...planned, title: 'Send the slides', plannedStart: '2026-10-21T08:00:00+00:00', plannedEnd: '2026-10-21T08:30:00+00:00', planState: 'conflict' })], days[0]!.start, days[6]!.end)

  it('places planned todos on the time grid among the events, in the Do colors', async () => {
    const wrapper = mount(TimeGrid, { props: { days, occurrences, todoBlocks: blocks, zone: AMS, now, today: Date.UTC(2026, 9, 20), calendars: () => work, selectedKey: null } })
    const todos = wrapper.findAll('.block.todo')
    expect(todos.map((block) => block.find('.title').text())).toEqual(['Write the report', 'Send the slides'])
    expect(todos[0]!.attributes('style')).toContain('top: 840px')
    expect(todos[0]!.attributes('style')).toContain('--cal: var(--do)')
    expect(todos[0]!.attributes('aria-label')).toBe('Todo: Write the report, Tuesday 20 October, 14:00 to 15:00')
    expect(todos[1]!.classes()).toContain('conflict')
    expect(todos[1]!.find('.meta').text()).toBe('Time taken, 10:00 to 10:30')
    // The todo and the review overlap, so they share the width.
    expect(wrapper.findAll('.block').find((block) => block.text().includes('Review'))!.attributes('style')).toContain('left: calc(35% + 2px)')

    await todos[0]!.trigger('click')
    expect(wrapper.emitted('openTodo')?.[0]?.[0]).toMatchObject({ key: 'todo:report' })
    expect(wrapper.emitted('open')).toBeUndefined()
  })

  it('lists planned todos in the month and the agenda', async () => {
    const month = mount(MonthGrid, { props: { days: daysFrom(Date.UTC(2026, 8, 28), 35, AMS), month: Date.UTC(2026, 9, 1), occurrences, todoBlocks: blocks, zone: AMS, now, today: Date.UTC(2026, 9, 20), calendars: () => work, selectedKey: null } })
    const tuesday = month.get(`[data-day="${Date.UTC(2026, 9, 20)}"]`)
    expect(tuesday.findAll('.item').map((item) => item.text())).toEqual(['14:00Write the report', '14:30Review'])
    await tuesday.findAll('.item')[0]!.trigger('click')
    expect(month.emitted('openTodo')?.[0]?.[0]).toMatchObject({ key: 'todo:report' })

    const agenda = mount(AgendaList, { props: { days, occurrences, todoBlocks: blocks, zone: AMS, now, today: Date.UTC(2026, 9, 20), calendars: () => work, selectedKey: null } })
    expect(agenda.findAll('.row').map((row) => [row.find('.time').text(), row.find('.title').text(), row.find('.chip').exists() ? row.find('.chip').text() : ''])).toEqual([
      ['14:00 to 15:00', 'Write the report', 'Planned'],
      ['14:30 to 15:30', 'Review', ''],
      ['10:00 to 10:30', 'Send the slides', 'Conflict'],
    ])
    await agenda.findAll('.row .open')[2]!.trigger('click')
    expect(agenda.emitted('openTodo')?.[0]?.[0]).toMatchObject({ key: 'todo:slides' })
  })

  it('offers to plan again, remove the time or check the todo off', async () => {
    const detail = mount(TodoBlockDetail, { props: { block: blocks[1]!, zone: AMS, now, busy: false, error: null }, global: { plugins: [router()] } })
    expect(detail.get('h2').text()).toBe('Send the slides')
    expect(detail.get('.when').text()).toBe('Wednesday 21 October, 10:00 to 10:30')
    expect(detail.get('.conflict').text()).toContain('This time is taken now')
    const buttons = detail.findAll('.actions button')
    expect(buttons.map((button) => button.text())).toEqual(['Done', 'Plan again', 'Remove from calendar'])
    await buttons[1]!.trigger('click')
    await buttons[2]!.trigger('click')
    await buttons[0]!.trigger('click')
    expect(Object.keys(detail.emitted())).toEqual(expect.arrayContaining(['plan', 'unplan', 'done']))
  })
})

describe('month grid', () => {
  it('moves between days with the arrow keys and opens the day with Enter', async () => {
    const days = daysFrom(Date.UTC(2026, 8, 28), 35, AMS)
    const wrapper = mount(MonthGrid, {
      props: { days, month: Date.UTC(2026, 9, 1), occurrences: [], zone: AMS, now, today: Date.UTC(2026, 9, 20), calendars: () => work, selectedKey: null },
      attachTo: document.body,
    })
    const today = wrapper.get(`[data-day="${Date.UTC(2026, 9, 20)}"]`)
    expect(today.attributes('tabindex')).toBe('0')
    expect(today.attributes('aria-current')).toBe('date')
    ;(today.element as HTMLElement).focus()
    await today.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect((document.activeElement as HTMLElement).dataset.day).toBe(String(Date.UTC(2026, 9, 27)))
    await wrapper.get(`[data-day="${Date.UTC(2026, 9, 27)}"]`).trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('showDay')?.[0]).toEqual([Date.UTC(2026, 9, 27)])
    wrapper.unmount()
  })

  it('moves into the events and "+N more" of a day with Enter, and back with Escape', async () => {
    const days = daysFrom(Date.UTC(2026, 8, 28), 35, AMS)
    const busy = expandOccurrences(
      [1, 2, 3, 4].map((n) => timed(`Item ${n}`, `2026-10-20T0${n}:00:00`, `2026-10-20T0${n}:30:00`)),
      days[0]!.start,
      days[34]!.end,
      AMS,
    )
    const wrapper = mount(MonthGrid, {
      props: { days, month: Date.UTC(2026, 9, 1), occurrences: busy, zone: AMS, now, today: Date.UTC(2026, 9, 20), calendars: () => work, selectedKey: null },
      attachTo: document.body,
    })
    const cell = wrapper.get(`[data-day="${Date.UTC(2026, 9, 20)}"]`)
    ;(cell.element as HTMLElement).focus()
    await cell.trigger('keydown', { key: 'Enter' })
    const items = cell.findAll('[data-cell-item]').map((item) => item.element)
    // The day cell itself also holds the text, so focus is checked on the element, not by its text.
    expect(document.activeElement).toBe(items[0])
    expect(document.activeElement?.hasAttribute('data-cell-item')).toBe(true)
    ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(items[1])
    ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(items[2])
    expect(document.activeElement?.textContent).toContain('+2 more')
    ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.activeElement).toBe(cell.element)
    wrapper.unmount()
  })
})

describe('editor and invitation card', () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  let answer: (method: string, path: string) => unknown

  beforeEach(() => {
    vi.useFakeTimers({ now, toFake: ['Date'] })
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    answer = () => ({})
    const mail = useMailStore()
    mail.calendars = [work]
    vi.spyOn(mail, 'syncNow').mockResolvedValue()
    useCalendarStore().zone = AMS
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        // What the editor reads besides the save: the meeting preferences, and the event as the server has it.
        if (method === 'GET' && url.pathname === '/api/v1/calendar/capabilities') {
          return new Response(JSON.stringify({ eventDrafts: false, meetingTimes: false, attendeeAvailability: false, eventSuggestions: false, textSuggestions: false, meetingBriefs: false, briefSummaries: false, meetingRequestDrop: true }))
        }
        if (method === 'GET' && url.pathname === '/api/v1/calendar/meeting-preferences') {
          return new Response(JSON.stringify({ ownLink: null, addWithGuests: false, defaults: {}, defaultOther: null, disabled: [], apps: ['meet', 'teams', 'own'] }))
        }
        const event = /^\/api\/v1\/calendar-events\/([^/]+)$/.exec(url.pathname)
        if (method === 'GET' && event !== null) {
          return new Response(JSON.stringify(calendarEvent(decodeURIComponent(event[1]!), 'work')))
        }
        requests.push({ method, path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        return new Response(JSON.stringify(answer(method, url.pathname)), { status: 200 })
      }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('creates an event from the form', async () => {
    const wrapper = mount(EventEditor, { props: { target: { kind: 'new', start: Date.UTC(2026, 9, 22, 8), allDay: false } }, global: { plugins: [router()] } })
    await wrapper.get('input[placeholder="Add a title"]').setValue('Budget walkthrough')
    await wrapper.get('input[placeholder="Add a place"]').setValue('Room 3.2')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.emitted('saved')).toHaveLength(1))
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/calendar-events',
      body: { calendarId: 'work', summary: 'Budget walkthrough', location: 'Room 3.2', start: { dateTime: '2026-10-22T10:00:00', timeZone: AMS }, end: { dateTime: '2026-10-22T11:00:00', timeZone: AMS }, recurrence: null },
    })
    wrapper.unmount()
  })

  it('asks which events of a series a change is for, and sends that scope', async () => {
    const series = timed('Weekly', '2026-10-05T09:00:00', '2026-10-05T09:30:00', { recurrence: 'FREQ=WEEKLY;BYDAY=TH' })
    const thursday = expandOccurrences([series], Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 26), AMS)[0]!
    const wrapper = mount(EventEditor, { props: { target: { kind: 'edit', occurrence: thursday } }, global: { plugins: [router()] } })
    const scopes = wrapper.findAll('.scope input[type="radio"]')
    expect(scopes.map((input) => (input.element as HTMLInputElement).value)).toEqual(['this', 'following', 'all'])
    await scopes[1]!.setValue(true)
    expect(wrapper.get('.scope .hint').text()).toContain('every later one change')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.emitted('saved')).toHaveLength(1))
    expect(requests[0]?.path).toBe('/api/v1/calendar-events/Weekly?scope=following&recurrenceId=20261022T070000Z')
    expect(requests[0]?.body).toMatchObject({ start: { dateTime: '2026-10-22T09:00:00', timeZone: AMS }, recurrence: 'FREQ=WEEKLY;BYDAY=TH' })
    wrapper.unmount()
  })

  it.each([
    ['weekly', 'FREQ=WEEKLY;BYDAY=MO', '2026-10-05', '20261019T070000Z'],
    ['monthly', 'FREQ=MONTHLY;BYDAY=3MO', '2026-09-21', '20261019T070000Z'],
  ])('moves one occurrence of a %s series to another weekday with "This event"', async (_kind, rule, first, key) => {
    const series = timed('Series', `${first}T09:00:00`, `${first}T09:30:00`, { recurrence: rule })
    const monday = expandOccurrences([series], Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 20), AMS)[0]!
    expect(monday.recurrenceId).toBe(key)
    const wrapper = mount(EventEditor, { props: { target: { kind: 'edit', occurrence: monday } }, global: { plugins: [router()] } })
    await wrapper.findAll('input[type="date"]')[0]!.setValue('2026-10-20')
    await flushPromises()
    const scopes = wrapper.findAll('.scope input[type="radio"]').map((input) => (input.element as HTMLInputElement).value)
    expect(scopes).toContain('this')
    await wrapper.get('.scope input[value="this"]').setValue(true)
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.emitted('saved')).toHaveLength(1))
    expect(requests[0]?.path).toBe(`/api/v1/calendar-events/Series?scope=this&recurrenceId=${key}`)
    expect(requests[0]?.body).toMatchObject({ recurrence: rule, start: { dateTime: '2026-10-20T09:00:00', timeZone: AMS } })
    wrapper.unmount()
  })

  it('shows what is wrong before saving', async () => {
    const wrapper = mount(EventEditor, { props: { target: { kind: 'new', start: Date.UTC(2026, 9, 22, 8), allDay: false } }, global: { plugins: [router()] } })
    const times = wrapper.findAll('input[type="time"]')
    await times[1]!.setValue('09:00')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.text()).toContain('The event ends before it starts.'))
    expect(requests).toHaveLength(0)
    wrapper.unmount()
  })

  it('shows an invitation with its conflicts and answers it with a key', async () => {
    const invitation = {
      id: 'm1',
      method: 'REQUEST',
      kind: 'update',
      uid: 'review@company.example',
      recurrenceId: '20261023T080000Z',
      sequence: 2,
      summary: 'Product review',
      description: '',
      location: 'Room 3.2',
      allDay: false,
      start: { dateTime: '2026-10-22T10:00:00', timeZone: AMS },
      end: { dateTime: '2026-10-22T11:00:00', timeZone: AMS },
      recurrence: null,
      organizer: { address: 'sanne@company.example', name: 'Sanne Peters' },
      attendees: [
        { address: 'kim@company.example', name: 'Kim', role: 'required', partstat: 'needs-action', rsvp: true, kind: 'individual' },
        { address: 'mark@company.example', name: 'Mark', role: 'required', partstat: 'accepted', rsvp: true, kind: 'individual' },
      ],
      conference: { provider: 'teams', url: 'https://teams.example.com/join', id: null, dialIn: null },
      eventId: 'event-1',
      selfResponse: 'needs-action',
      canRespond: true,
      conflicts: [{ id: 'c1', eventId: 'e2', summary: 'Vendor call', allDay: false, start: { dateTime: '2026-10-22T08:30:00+00:00' }, end: { dateTime: '2026-10-22T09:00:00+00:00' }, selfResponse: 'tentative' }],
      canApply: false,
    }
    answer = (method) => (method === 'GET' ? invitation : {})
    const wrapper = mount(InvitationCard, { props: { messageId: 'm1' }, global: { plugins: [router()] } })
    await flushPromises()
    expect(wrapper.text()).toContain('Updated invitation')
    expect(wrapper.text()).toContain('Thursday 22 October, 10:00 to 11:00')
    expect(wrapper.text()).toContain('Overlaps Vendor call, 10:30 to 11:00 (maybe)')
    expect(wrapper.text()).toContain('Join with Microsoft Teams')
    expect(wrapper.text()).toContain('2 people: 1 going, 1 no reply')
    await wrapper.get('.invitation').trigger('keydown', { key: 'y' })
    await flushPromises()
    expect(requests[1]).toEqual({ method: 'POST', path: '/api/v1/calendar-events/event-1/response', body: { response: 'accepted', recurrenceId: '20261023T080000Z', comment: null, notify: true } })
    expect(wrapper.text()).toContain('You answered: Going')
  })

  it('asks to apply an update before answering it', async () => {
    const update = { id: 'm3', method: 'REQUEST', kind: 'update', uid: 'x', recurrenceId: null, sequence: 3, summary: 'Moved review', description: '', location: '', allDay: true, start: { date: '2026-10-22' }, end: { date: '2026-10-23' }, recurrence: null, organizer: null, attendees: [], conference: null, eventId: 'event-1', selfResponse: 'needs-action', canRespond: true, conflicts: [], canApply: true }
    answer = () => update
    const wrapper = mount(InvitationCard, { props: { messageId: 'm3' }, global: { plugins: [router()] } })
    await flushPromises()
    expect(wrapper.text()).toContain('Apply the update')
    expect(wrapper.find('.responses').exists()).toBe(false)
    await wrapper.get('.invitation').trigger('keydown', { key: 'y' })
    await flushPromises()
    expect(requests).toHaveLength(1)
  })

  it('offers to apply calendar mail the calendar did not take', async () => {
    const pending = { id: 'm2', method: 'REQUEST', kind: 'new', uid: 'x', recurrenceId: null, sequence: 0, summary: 'Old invite', description: '', location: '', allDay: true, start: { date: '2026-10-22' }, end: { date: '2026-10-23' }, recurrence: null, organizer: null, attendees: [], conference: null, eventId: null, selfResponse: null, canRespond: false, conflicts: [], canApply: true }
    answer = (method) => (method === 'GET' ? pending : { ...pending, canApply: false, eventId: 'new-event', canRespond: true, selfResponse: 'needs-action' })
    const wrapper = mount(InvitationCard, { props: { messageId: 'm2' }, global: { plugins: [router()] } })
    await flushPromises()
    await wrapper.get('button.button-primary').trigger('click')
    await flushPromises()
    expect(requests[1]).toMatchObject({ method: 'POST', path: '/api/v1/messages/m2/invitation/apply' })
    expect(wrapper.text()).toContain('Going?')
  })

  it.each([
    ['javascript:alert(document.cookie)'],
    ['http://teams.microsoft.com/l/meetup-join/1'],
    ['https://te\u0430ms.microsoft.com/l/meetup-join/1'],
  ])('offers no Join on an invitation with the link %s, only Copy link', async (url) => {
    const hostile = { id: 'm4', method: 'REQUEST', kind: 'new', uid: 'x', recurrenceId: null, sequence: 0, summary: 'Call', description: '', location: '', allDay: true, start: { date: '2026-10-22' }, end: { date: '2026-10-23' }, recurrence: null, organizer: null, attendees: [], conference: { provider: 'teams', url, id: null, dialIn: null }, eventId: 'event-4', selfResponse: 'needs-action', canRespond: true, conflicts: [], canApply: false }
    answer = () => hostile
    const wrapper = mount(InvitationCard, { props: { messageId: 'm4' }, global: { plugins: [router()] } })
    await flushPromises()
    expect(wrapper.find('a[target="_blank"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Join with')
    expect(wrapper.get('.copy-link').text()).toBe('Copy link')
  })

  it('offers no Join in the mini agenda for a link it cannot open, and Join for one it can', async () => {
    const calendar = useCalendarStore()
    const at = (id: string, url: string) =>
      expandOccurrences([timed(id, '2026-10-20T10:00:00', '2026-10-20T11:00:00', { conference: { provider: 'other', url, id: null, dialIn: null } })], Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 21), AMS)
    const upcoming = vi.spyOn(calendar, 'upcoming').mockResolvedValue(at('Call', 'javascript:alert(1)'))
    const hostile = mount(MiniAgenda, { global: { plugins: [router()] } })
    await flushPromises()
    expect(hostile.text()).toContain('Call')
    expect(hostile.find('a[target="_blank"]').exists()).toBe(false)
    expect(hostile.get('.copy-link').text()).toBe('Copy link')
    hostile.unmount()
    upcoming.mockResolvedValue(at('Call', 'https://video.example.org/room/7'))
    const fine = mount(MiniAgenda, { global: { plugins: [router()] } })
    await flushPromises()
    expect(fine.get('a[target="_blank"]').text()).toBe('Join the meeting')
    fine.unmount()
  })
})
