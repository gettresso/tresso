import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { expandOccurrences, type ConferenceRequest, type MeetingPreferences, type SyncedCalendarEvent, type SyncedMailAccount } from '@tresso/core'
import { calendar, calendarEvent } from '@tresso/core/testing'
import { useCalendarStore } from '@/stores/calendar'
import { useMailStore } from '@/stores/mail'
import EventEditor from '../calendar/EventEditor.vue'

const AMS = 'Europe/Amsterdam'
const NOW = Date.UTC(2026, 9, 20, 8, 24)
const WORK = calendar('work', 'm365', { source: 'microsoft', name: 'Work', isDefault: true, conferenceProviders: ['teams'] })
const HOME = calendar('home', 'gmail', { source: 'google', name: 'Home', conferenceProviders: ['meet'] })
const TEAMS_URL = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0'
const OWN = 'https://meet.company.example/kim'

function account(id: string, provider: string, emailAddress: string): SyncedMailAccount {
  return { id, emailAddress, displayName: id, provider, status: 'active', statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'active', calendarStatusDetail: null }
}

function event(id: string, extra: Partial<SyncedCalendarEvent> = {}): SyncedCalendarEvent {
  return calendarEvent(id, 'work', { summary: id, start: { dateTime: '2026-10-22T10:00:00', timeZone: AMS }, end: { dateTime: '2026-10-22T11:00:00', timeZone: AMS }, ...extra })
}

function occurrenceOf(...events: SyncedCalendarEvent[]) {
  return expandOccurrences(events, Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 26), AMS)
}

describe('the meeting link in the event editor', () => {
  const requests: { method: string; path: string; body: Record<string, unknown> | undefined }[] = []
  let preferences: MeetingPreferences
  /** The events as the server has them now. */
  let server: Map<string, SyncedCalendarEvent>

  function router() {
    return createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/settings/meeting-apps', name: 'settings-meeting-apps', component: { template: '<div />' } },
      ],
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    preferences = { ownLink: OWN, addWithGuests: true, defaults: {}, defaultOther: null, disabled: [], apps: ['meet', 'teams', 'own'] }
    server = new Map()
    const mail = useMailStore()
    mail.calendars = [WORK, HOME]
    mail.accounts = [account('m365', 'microsoft', 'kim@company.example'), account('gmail', 'gmail', 'kim@gmail.example')]
    vi.spyOn(mail, 'syncNow').mockResolvedValue()
    useCalendarStore().zone = AMS
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        if (url.pathname === '/api/v1/calendar/meeting-preferences') {
          return new Response(JSON.stringify(preferences))
        }
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
        requests.push({ method, path: `${url.pathname}${url.search}`, body })
        const id = /^\/api\/v1\/calendar-events\/([^/]+)/.exec(url.pathname)?.[1]
        const stored = id === undefined ? undefined : server.get(decodeURIComponent(id))
        if (url.pathname.endsWith('/meeting-link')) {
          const request: ConferenceRequest | null = method === 'POST' ? { provider: body?.provider as 'teams', status: 'pending', reason: null, requestedAt: new Date(NOW).toISOString() } : null
          return new Response(JSON.stringify({ ...stored, conferenceRequest: request }))
        }
        return new Response(JSON.stringify(stored ?? event('saved')))
      }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  async function editor(target: InstanceType<typeof EventEditor>['$props']['target'], restore?: InstanceType<typeof EventEditor>['$props']['restore']) {
    const wrapper = mount(EventEditor, { props: { target, restore }, global: { plugins: [router()] }, attachTo: document.body })
    await flushPromises()
    return wrapper
  }
  const newEvent = () => editor({ kind: 'new', start: Date.UTC(2026, 9, 22, 8), allDay: false })
  const title = (wrapper: Awaited<ReturnType<typeof editor>>) => wrapper.get('.meeting-row .title').text()
  const hint = (wrapper: Awaited<ReturnType<typeof editor>>) => wrapper.get('.meeting-row .hint').text()
  const toggle = (wrapper: Awaited<ReturnType<typeof editor>>) => wrapper.get('.meeting-row [role="switch"]')
  async function addGuest(wrapper: Awaited<ReturnType<typeof editor>>, address: string) {
    await wrapper.get('input[aria-label="Add a guest"]').setValue(address)
    await wrapper.get('input[aria-label="Add a guest"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
  }
  async function save(wrapper: Awaited<ReturnType<typeof editor>>) {
    await wrapper.get('input[placeholder="Add a title"]').setValue('Product review')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.emitted('saved')).toHaveLength(1))
    return requests.find((request) => request.method === 'POST' || request.method === 'PUT')!.body!
  }

  it('starts a new event off, and the first guest switches it on with the calendar default', async () => {
    const wrapper = await newEvent()
    expect(toggle(wrapper).attributes('aria-checked')).toBe('false')
    expect(hint(wrapper)).toBe('No meeting link. Tresso switches this on when you add a guest.')
    await addGuest(wrapper, 'sam@company.example')
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')
    expect(hint(wrapper)).toBe('Tresso makes the Teams link when you save and adds it to the invitation for 1 guest.')
    expect(await save(wrapper)).toMatchObject({ conferenceProvider: 'teams', conferenceUrl: null })
  })

  it('stays off with the guests rule off, and the switch the user used wins', async () => {
    preferences = { ...preferences, addWithGuests: false }
    const off = await newEvent()
    await addGuest(off, 'sam@company.example')
    expect(toggle(off).attributes('aria-checked')).toBe('false')
    expect(await save(off)).toMatchObject({ conferenceProvider: null, conferenceUrl: null })
    off.unmount()

    preferences = { ...preferences, addWithGuests: true }
    requests.length = 0
    setActivePinia(createPinia())
    const mail = useMailStore()
    mail.calendars = [WORK, HOME]
    mail.accounts = [account('m365', 'microsoft', 'kim@company.example')]
    vi.spyOn(mail, 'syncNow').mockResolvedValue()
    const used = await newEvent()
    await toggle(used).trigger('click')
    await toggle(used).trigger('click')
    await addGuest(used, 'sam@company.example')
    expect(toggle(used).attributes('aria-checked')).toBe('false')
  })

  it('saves the own link when the user picks it', async () => {
    const wrapper = await newEvent()
    await toggle(wrapper).trigger('click')
    await wrapper.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
    const own = wrapper.findAll('[role="menuitemradio"]').find((item) => item.text().includes('My own link'))!
    await own.trigger('click')
    expect(hint(wrapper)).toBe('Your own link is added to the invitation when you save.')
    expect(wrapper.get('.meeting-row .link').text()).toBe('meet.company.example/kim')
    expect(await save(wrapper)).toMatchObject({ conferenceUrl: OWN, conferenceProvider: null })
  })

  it('says when a chosen app cannot make a link on the calendar the event moves to', async () => {
    const wrapper = await newEvent()
    await toggle(wrapper).trigger('click')
    await wrapper.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
    await wrapper.findAll('[role="menuitemradio"]').find((item) => item.text().includes('Microsoft Teams'))!.trigger('click')
    await wrapper.get('select').setValue('home')
    await flushPromises()
    expect(title(wrapper)).toBe('Microsoft Teams cannot make a link for this event')
    expect(hint(wrapper)).toBe('A Teams link is made through a Microsoft 365 calendar event, and Home is a Google calendar.')
    expect(wrapper.findAll('.meeting-row .actions button').map((button) => button.text())).toEqual(['Use Google Meet', 'Use my own link'])
    await wrapper.get('.meeting-row .actions .button-primary').trigger('click')
    expect(await save(wrapper)).toMatchObject({ conferenceProvider: 'meet', conferenceUrl: null })
  })

  it('keeps a Teams meeting Microsoft made: no switch, no removal, and the link as the server has it', async () => {
    const graph = event('graph', { conference: { provider: 'teams', url: TEAMS_URL, id: null, dialIn: null, removable: false } })
    server.set('graph', graph)
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(graph)[0]! })
    expect(toggle(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
    expect(wrapper.findAll('[role="menuitem"]')[0]!.attributes('aria-disabled')).toBe('true')
    expect(await save(wrapper)).toMatchObject({ conferenceUrl: TEAMS_URL })
  })

  it('never removes a link made since the editor opened', async () => {
    const before = event('fresh')
    server.set('fresh', { ...before, conference: { provider: 'teams', url: TEAMS_URL, id: null, dialIn: null, removable: false } })
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(before)[0]! })
    const body = await save(wrapper)
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/calendar-events/fresh' })
    expect(body).toMatchObject({ conferenceUrl: TEAMS_URL })
  })

  it('removes a link only when the user asked, and Undo keeps it', async () => {
    const own = event('own', { conference: { provider: 'other', url: OWN, id: null, dialIn: null, removable: true } })
    server.set('own', own)
    const kept = await editor({ kind: 'edit', occurrence: occurrenceOf(own)[0]! })
    await kept.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
    await kept.findAll('[role="menuitem"]')[0]!.trigger('click')
    expect(hint(kept)).toBe('Removed. The link goes when you save.')
    await kept.get('.meeting-row .actions button').trigger('click')
    expect(await save(kept)).toMatchObject({ conferenceUrl: OWN })
    kept.unmount()

    requests.length = 0
    const gone = await editor({ kind: 'edit', occurrence: occurrenceOf(own)[0]! })
    await toggle(gone).trigger('click')
    expect(hint(gone)).toBe('Removed. The link goes when you save.')
    expect(await save(gone)).toMatchObject({ conferenceUrl: null, conferenceProvider: null })
  })

  it('retries a link that failed, and leaves without one, on the series', async () => {
    const failed = event('failed', { conferenceRequest: { provider: 'teams', status: 'failed', reason: 'refused', requestedAt: new Date(NOW - 600_000).toISOString() } })
    server.set('failed', failed)
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(failed)[0]! })
    expect(title(wrapper)).toBe('Could not make the Teams link')
    expect(hint(wrapper)).toBe('The event is saved without a link. Microsoft refused to make it.')
    await wrapper.findAll('.meeting-row .actions button')[0]!.trigger('click')
    await flushPromises()
    expect(requests[requests.length - 1]).toMatchObject({ method: 'POST', path: '/api/v1/calendar-events/failed/meeting-link', body: { provider: 'teams' } })
    expect(title(wrapper)).toBe('Making the Teams link')
    expect(wrapper.emitted('close')).toBeUndefined()

    server.set('failed', { ...failed, conferenceRequest: { provider: 'teams', status: 'failed', reason: 'unreachable', requestedAt: new Date(NOW - 600_000).toISOString() } })
    const again = await editor({ kind: 'edit', occurrence: occurrenceOf(failed)[0]! })
    await again.findAll('.meeting-row .actions button')[2]!.trigger('click')
    await flushPromises()
    expect(requests[requests.length - 1]).toMatchObject({ method: 'DELETE', path: '/api/v1/calendar-events/failed/meeting-link' })
    expect(title(again)).toBe('Meeting link')
  })

  it('shows the series request on a moved occurrence, and drops a request the new calendar cannot serve', async () => {
    const series = event('series', { recurrence: 'FREQ=DAILY;COUNT=3', start: { dateTime: '2026-10-20T10:00:00', timeZone: AMS }, end: { dateTime: '2026-10-20T11:00:00', timeZone: AMS }, conferenceRequest: { provider: 'teams', status: 'pending', reason: null, requestedAt: new Date(NOW).toISOString() } })
    const moved = event('moved', { uid: series.uid, recurrenceId: '20261021T080000Z', start: { dateTime: '2026-10-21T12:00:00', timeZone: AMS }, end: { dateTime: '2026-10-21T13:00:00', timeZone: AMS } })
    server.set('series', series)
    server.set('moved', moved)
    const override = occurrenceOf(series, moved).find((item) => item.event.id === 'moved')!
    const wrapper = await editor({ kind: 'edit', occurrence: override })
    expect(title(wrapper)).toBe('Making the Teams link')
    expect(wrapper.find('.meeting-row [role="switch"]').exists()).toBe(false)

    const first = occurrenceOf(series)[0]!
    requests.length = 0
    const all = await editor({ kind: 'edit', occurrence: first })
    await all.get('select').setValue('home')
    await all.get('.scope input[value="all"]').setValue(true)
    const body = await save(all)
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/calendar-events/series' })
    expect(body).toMatchObject({ calendarId: 'home', conferenceProvider: null, conferenceUrl: null })
  })

  it('shows no controls on an event someone else organizes', async () => {
    const invited = event('invited', { selfResponse: 'accepted', organizer: { address: 'sam@company.example', name: 'Sam de Vries' }, conference: { provider: 'teams', url: TEAMS_URL, id: null, dialIn: null } })
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(invited)[0]! })
    expect(wrapper.find('.meeting-row').exists()).toBe(false)
    expect(wrapper.text()).toContain('Microsoft Teams, added by Sam de Vries. Only the organizer can change it.')
  })

  it('keeps the event being written for Settings, and opens it again as it was', async () => {
    preferences = { ...preferences, ownLink: null }
    useMailStore().calendars = [calendar('local', null, { name: 'Tresso', isDefault: true, conferenceProviders: [] })]
    const wrapper = await newEvent()
    await wrapper.get('input[placeholder="Add a title"]').setValue('Planning')
    await toggle(wrapper).trigger('click')
    expect(hint(wrapper)).toBe('No meeting app connected yet. Connect Google Meet, Microsoft Teams or your own link once.')
    await wrapper.get('.meeting-row .actions button').trigger('click')
    await flushPromises()
    const kept = useCalendarStore().keptEditor
    expect(kept?.values.summary).toBe('Planning')
    expect(kept?.link.on).toBe(true)
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()

    const back = await editor(kept!.target, kept)
    expect((back.get('input[placeholder="Add a title"]').element as HTMLInputElement).value).toBe('Planning')
    expect(toggle(back).attributes('aria-checked')).toBe('true')
  })
})
