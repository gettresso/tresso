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
  /** The request-only drop answers 409: the link arrived meanwhile. */
  let linkArrived: boolean
  /** Reading one event fails. */
  let readFails: boolean
  /** What /calendar/capabilities says about the request-only drop; undefined: a server without the field. */
  let canDrop: boolean | undefined | null

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
    linkArrived = false
    readFails = false
    canDrop = true
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
        if (url.pathname === '/api/v1/calendar/capabilities' && canDrop === null) {
          return new Response(JSON.stringify({ detail: 'The server is busy.' }), { status: 503, headers: { 'Content-Type': 'application/problem+json' } })
        }
        if (url.pathname === '/api/v1/calendar/capabilities') {
          const capabilities: Record<string, boolean> = { eventDrafts: false, meetingTimes: false, attendeeAvailability: false, eventSuggestions: false, textSuggestions: false, meetingBriefs: false, briefSummaries: false }
          if (canDrop !== undefined && canDrop !== null) capabilities.meetingRequestDrop = canDrop
          return new Response(JSON.stringify(capabilities))
        }
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
        requests.push({ method, path: `${url.pathname}${url.search}`, body })
        const id = /^\/api\/v1\/calendar-events\/([^/]+)/.exec(url.pathname)?.[1]
        const stored = id === undefined ? undefined : server.get(decodeURIComponent(id))
        if (method === 'GET' && readFails) {
          return new Response(JSON.stringify({ detail: 'The server is busy. Try again in a moment.' }), { status: 503, headers: { 'Content-Type': 'application/problem+json' } })
        }
        if (url.pathname.endsWith('/meeting-link/request') && linkArrived) {
          return new Response(JSON.stringify({ detail: 'The meeting link has arrived meanwhile. Nothing was changed.' }), { status: 409, headers: { 'Content-Type': 'application/problem+json' } })
        }
        if (url.pathname.endsWith('/meeting-link') || url.pathname.endsWith('/meeting-link/request')) {
          const request: ConferenceRequest | null = method === 'POST' ? { provider: body?.provider as 'teams', status: 'pending', reason: null, requestedAt: new Date(NOW).toISOString() } : null
          return new Response(JSON.stringify({ ...stored, conferenceRequest: request }))
        }
        return new Response(JSON.stringify(stored ?? event('saved')))
      }),
    )
  })

  /** Every editor a test opened: closed after it, so nothing it still does reaches the next test. */
  const opened: { unmount: () => void }[] = []

  afterEach(async () => {
    await flushPromises()
    for (const wrapper of opened.splice(0)) wrapper.unmount()
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  async function editor(target: InstanceType<typeof EventEditor>['$props']['target'], restore?: InstanceType<typeof EventEditor>['$props']['restore']) {
    const wrapper = mount(EventEditor, { props: { target, restore }, global: { plugins: [router()] }, attachTo: document.body })
    opened.push(wrapper)
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
    expect(requests[requests.length - 1]).toMatchObject({ method: 'DELETE', path: '/api/v1/calendar-events/failed/meeting-link/request' })
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
    // Still state 2, as it was left: the row asks to connect an app.
    expect(hint(back)).toBe('No meeting app connected yet. Connect Google Meet, Microsoft Teams or your own link once.')
  })

  it('shows a link that arrives while the editor is open', async () => {
    const failed = event('arrives', { conferenceRequest: { provider: 'teams', status: 'failed', reason: 'unreachable', requestedAt: new Date(NOW - 600_000).toISOString() } })
    const mail = useMailStore()
    // The copy on this device as far as the editor and the calendar's own reload read it.
    vi.spyOn(mail, 'currentStore').mockReturnValue({ calendarEvent: async (id: string) => server.get(id) ?? null, calendarEvents: async () => [...server.values()] } as unknown as ReturnType<typeof mail.currentStore>)
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(failed)[0]! })
    expect(title(wrapper)).toBe('Could not make the Teams link')
    server.set('arrives', { ...failed, conference: { provider: 'teams', url: TEAMS_URL, id: null, dialIn: null, removable: false }, conferenceRequest: null })
    mail.calendarRevision++
    await flushPromises()
    expect(title(wrapper)).toBe('Meeting link')
    expect(hint(wrapper)).toBe('Made with kim@company.example.')
    expect(wrapper.get('.meeting-row .link').attributes('title')).toBe(TEAMS_URL)
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')
  })

  it('leaves the link alone when it arrived just before Leave without a link', async () => {
    const failed = event('late', { conferenceRequest: { provider: 'teams', status: 'failed', reason: 'unreachable', requestedAt: new Date(NOW - 600_000).toISOString() } })
    server.set('late', { ...failed, conference: { provider: 'teams', url: TEAMS_URL, id: null, dialIn: null, removable: false }, conferenceRequest: null })
    linkArrived = true
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(failed)[0]! })
    await wrapper.findAll('.meeting-row .actions button')[2]!.trigger('click')
    await flushPromises()
    expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.path)).toEqual(['/api/v1/calendar-events/late/meeting-link/request'])
    expect(title(wrapper)).toBe('Meeting link')
    expect(wrapper.get('.meeting-row .link').attributes('title')).toBe(TEAMS_URL)
  })

  it('shows a link the server has before asking for another, and sends nothing', async () => {
    const before = event('stale')
    server.set('stale', { ...before, conference: { provider: 'teams', url: TEAMS_URL, id: null, dialIn: null, removable: false } })
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(before)[0]! })
    await toggle(wrapper).trigger('click')
    await wrapper.get('input[placeholder="Add a title"]').setValue('Product review')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.text()).toContain('A meeting link was added meanwhile. It is shown now; save again to keep it.'))
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
    expect(wrapper.get('.meeting-row .link').attributes('title')).toBe(TEAMS_URL)
    expect(wrapper.emitted('saved')).toBeUndefined()
  })

  it('names the app of the link the event has, and picking it again keeps that link', async () => {
    const own = event('own-kept', { conference: { provider: 'other', url: OWN, id: null, dialIn: null, removable: true } })
    server.set('own-kept', own)
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(own)[0]! })
    // The calendar's default is Teams, but the event keeps its own link.
    expect(wrapper.get('.meeting-row button[aria-haspopup="menu"]').text()).toBe('My own link')
    await wrapper.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
    const checked = wrapper.get('[role="menuitemradio"][aria-checked="true"]')
    expect(checked.text()).toContain('My own link')
    await checked.trigger('click')
    expect(await save(wrapper)).toMatchObject({ conferenceUrl: OWN, conferenceProvider: null })
  })

  it('names a Meet link Google Meet whatever the calendar default, and keeps it on a second pick', async () => {
    preferences = { ...preferences, defaults: { gmail: 'own' } }
    const MEET = 'https://meet.google.com/kfp-wzqn-rtx'
    const meet = calendarEvent('meet', 'home', { summary: 'meet', start: { dateTime: '2026-10-22T10:00:00', timeZone: AMS }, end: { dateTime: '2026-10-22T11:00:00', timeZone: AMS }, conference: { provider: 'meet', url: MEET, id: null, dialIn: null, removable: true } })
    server.set('meet', meet)
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(meet)[0]! })
    expect(wrapper.get('.meeting-row button[aria-haspopup="menu"]').text()).toBe('Google Meet')
    await wrapper.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
    await wrapper.findAll('[role="menuitemradio"]').find((item) => item.text().includes('Google Meet'))!.trigger('click')
    expect(await save(wrapper)).toMatchObject({ conferenceUrl: MEET, conferenceProvider: null })
  })

  it('drops only the request when the switch goes off after Use another app', async () => {
    const failed = event('off', { conferenceRequest: { provider: 'teams', status: 'failed', reason: 'refused', requestedAt: new Date(NOW - 600_000).toISOString() } })
    server.set('off', failed)
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(failed)[0]! })
    await wrapper.findAll('.meeting-row .actions button')[1]!.trigger('click')
    await wrapper.findAll('[role="menuitemradio"]').find((item) => item.text().includes('My own link'))!.trigger('click')
    await toggle(wrapper).trigger('click')
    expect(await save(wrapper)).toMatchObject({ conferenceUrl: null, conferenceProvider: null })
  })

  it('asks for the series meeting from the series only, never from one occurrence', async () => {
    const series = event('weekly', { recurrence: 'FREQ=DAILY;COUNT=3', start: { dateTime: '2026-10-20T10:00:00', timeZone: AMS }, end: { dateTime: '2026-10-20T11:00:00', timeZone: AMS }, conferenceRequest: { provider: 'teams', status: 'failed', reason: 'refused', requestedAt: new Date(NOW - 600_000).toISOString() } })
    server.set('weekly', series)
    const second = occurrenceOf(series)[1]!
    const one = await editor({ kind: 'edit', occurrence: second })
    await one.get('.scope input[value="this"]').setValue(true)
    expect(await save(one)).toMatchObject({ conferenceProvider: null, conferenceUrl: null })
    one.unmount()

    requests.length = 0
    const following = await editor({ kind: 'edit', occurrence: second })
    await following.get('.scope input[value="following"]').setValue(true)
    const body = await save(following)
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/calendar-events/weekly' })
    expect(body).toMatchObject({ conferenceProvider: 'teams' })
  })

  it('keeps the own link of one moved occurrence', async () => {
    const series = event('daily', { recurrence: 'FREQ=DAILY;COUNT=3', start: { dateTime: '2026-10-20T10:00:00', timeZone: AMS }, end: { dateTime: '2026-10-20T11:00:00', timeZone: AMS } })
    const moved = event('daily-2', { uid: series.uid, recurrenceId: '20261021T080000Z', start: { dateTime: '2026-10-21T12:00:00', timeZone: AMS }, end: { dateTime: '2026-10-21T13:00:00', timeZone: AMS }, conference: { provider: 'other', url: OWN, id: null, dialIn: null, removable: true } })
    server.set('daily', series)
    server.set('daily-2', moved)
    const override = occurrenceOf(series, moved).find((item) => item.event.id === 'daily-2')!
    const wrapper = await editor({ kind: 'edit', occurrence: override })
    expect(wrapper.get('.meeting-row button[aria-haspopup="menu"]').text()).toBe('My own link')
    await wrapper.get('.scope input[value="this"]').setValue(true)
    const body = await save(wrapper)
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/calendar-events/daily-2' })
    expect(body).toMatchObject({ conferenceUrl: OWN, conferenceProvider: null })
  })

  it('sends nothing when the server cannot be read at the save', async () => {
    const plain = event('unread')
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(plain)[0]! })
    readFails = true
    await wrapper.get('input[placeholder="Add a title"]').setValue('Changed')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.text()).toContain('The server is busy. Try again in a moment.'))
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
  })

  it('never blocks a save over a link the form does not show', async () => {
    const odd = event('odd', { conference: { provider: 'other', url: 'http://video.example.org/room', id: null, dialIn: null, removable: true } })
    server.set('odd', odd)
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(odd)[0]! })
    expect(await save(wrapper)).toMatchObject({ conferenceUrl: 'http://video.example.org/room' })
  })

  it('leaves the switch alone when a guest is added to a saved event', async () => {
    const plain = event('guests')
    server.set('guests', plain)
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(plain)[0]! })
    await addGuest(wrapper, 'sam@company.example')
    expect(toggle(wrapper).attributes('aria-checked')).toBe('false')
  })

  it('asks to sign in in the browser on Reconnect', async () => {
    preferences = { ...preferences, ownLink: null }
    useMailStore().accounts = [{ ...account('m365', 'microsoft', 'kim@company.example'), status: 'auth_failed' }]
    const { useAccountsStore } = await import('@/stores/accounts')
    vi.spyOn(useAccountsStore(), 'openProviderSignIn').mockResolvedValue('browser')
    const wrapper = await newEvent()
    await toggle(wrapper).trigger('click')
    expect(title(wrapper)).toBe('Reconnect Microsoft Teams to add a link')
    await wrapper.get('.meeting-row .actions .button-primary').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Sign in in your browser, then come back here and save the event.')
  })

  it('asks before discarding an event brought back from Settings', async () => {
    const wrapper = await newEvent()
    await wrapper.get('input[placeholder="Add a title"]').setValue('Planning')
    await toggle(wrapper).trigger('click')
    await wrapper.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
    await wrapper.findAll('[role="menuitem"]')[1]!.trigger('click')
    await flushPromises()
    const kept = useCalendarStore().keptEditor!
    wrapper.unmount()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const back = await editor(kept.target, kept)
    await back.findAll('button').find((button) => button.text() === 'Cancel')!.trigger('click')
    expect(confirm).toHaveBeenCalled()
    expect(back.emitted('close')).toBeUndefined()
  })

  it('closes only the menu on Escape, not the editor', async () => {
    const wrapper = await newEvent()
    await toggle(wrapper).trigger('click')
    await wrapper.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
    await wrapper.get('[role="menu"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.find('dialog').exists()).toBe(true)
  })

  it('forgets the event being written when the user signs out', async () => {
    const calendarStore = useCalendarStore()
    calendarStore.keepEditor({ target: { kind: 'new', start: 0, allDay: false }, values: {} as NonNullable<typeof calendarStore.keptEditor>['values'], link: { on: false, app: null, touched: false, removed: false }, notify: true })
    const { useAuthStore } = await import('@/stores/auth')
    useAuthStore().generation++
    await flushPromises()
    expect(calendarStore.keptEditor).toBeUndefined()
  })

  function followSync() {
    const mail = useMailStore()
    vi.spyOn(mail, 'currentStore').mockReturnValue({ calendarEvent: async (id: string) => server.get(id) ?? null, calendarEvents: async () => [...server.values()] } as unknown as ReturnType<typeof mail.currentStore>)
    return async () => {
      mail.calendarRevision++
      await flushPromises()
    }
  }
  const teamsLink = { provider: 'teams' as const, url: TEAMS_URL, id: null, dialIn: null, removable: false }

  it('does not make a link again when it was taken off elsewhere', async () => {
    const own = event('gone', { conference: { provider: 'other', url: OWN, id: null, dialIn: null, removable: true } })
    server.set('gone', own)
    const sync = followSync()
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(own)[0]! })
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')
    server.set('gone', { ...own, conference: null })
    await sync()
    expect(toggle(wrapper).attributes('aria-checked')).toBe('false')
    expect(await save(wrapper)).toMatchObject({ conferenceUrl: null, conferenceProvider: null })
  })

  it('shows a link that arrives after a pick, and saves that link', async () => {
    const failed = event('picked', { conferenceRequest: { provider: 'teams', status: 'failed', reason: 'unreachable', requestedAt: new Date(NOW - 600_000).toISOString() } })
    server.set('picked', failed)
    const sync = followSync()
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(failed)[0]! })
    await wrapper.findAll('.meeting-row .actions button')[1]!.trigger('click')
    await wrapper.findAll('[role="menuitemradio"]').find((item) => item.text().includes('My own link'))!.trigger('click')
    server.set('picked', { ...failed, conference: teamsLink, conferenceRequest: null })
    await sync()
    expect(wrapper.get('.meeting-row button[aria-haspopup="menu"]').text()).toBe('Microsoft Teams')
    expect(wrapper.get('.meeting-row .link').attributes('title')).toBe(TEAMS_URL)
    expect(wrapper.text()).toContain('A meeting link was added meanwhile. It is shown now.')
    expect(wrapper.text()).not.toContain('save again to keep it')
    expect(await save(wrapper)).toMatchObject({ conferenceUrl: TEAMS_URL, conferenceProvider: null })
  })

  it('shows a link that arrives after the switch went off', async () => {
    const plain = event('off-then-link')
    server.set('off-then-link', plain)
    const sync = followSync()
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(plain)[0]! })
    await toggle(wrapper).trigger('click')
    await toggle(wrapper).trigger('click')
    expect(toggle(wrapper).attributes('aria-checked')).toBe('false')
    server.set('off-then-link', { ...plain, conference: teamsLink })
    await sync()
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')
    expect(wrapper.get('.meeting-row .link').attributes('title')).toBe(TEAMS_URL)
  })

  it('keeps the title through a save stopped by a new link, and the next save sends that link', async () => {
    const before = event('second')
    server.set('second', { ...before, conference: teamsLink })
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(before)[0]! })
    await toggle(wrapper).trigger('click')
    await wrapper.get('input[placeholder="Add a title"]').setValue('Renamed review')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.text()).toContain('A meeting link was added meanwhile.'))
    expect((wrapper.get('input[placeholder="Add a title"]').element as HTMLInputElement).value).toBe('Renamed review')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.emitted('saved')).toHaveLength(1))
    expect(requests.find((request) => request.method === 'PUT')!.body).toMatchObject({ summary: 'Renamed review', conferenceUrl: TEAMS_URL, conferenceProvider: null })
    expect(wrapper.text()).not.toContain('A meeting link was added meanwhile.')
  })

  it('keeps the link when its own app is picked after another one, and says when a pick replaces it', async () => {
    const MEET = 'https://meet.google.com/kfp-wzqn-rtx'
    const meet = calendarEvent('meet2', 'home', { summary: 'meet', start: { dateTime: '2026-10-22T10:00:00', timeZone: AMS }, end: { dateTime: '2026-10-22T11:00:00', timeZone: AMS }, conference: { provider: 'meet', url: MEET, id: null, dialIn: null, removable: true } })
    server.set('meet2', meet)
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(meet)[0]! })
    const pick = async (name: string) => {
      await wrapper.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
      await wrapper.findAll('[role="menuitemradio"]').find((item) => item.text().includes(name))!.trigger('click')
    }
    await pick('My own link')
    expect(wrapper.text()).toContain('It replaces the current link.')
    await pick('Google Meet')
    expect(wrapper.text()).not.toContain('It replaces the current link.')
    expect(await save(wrapper)).toMatchObject({ conferenceUrl: MEET, conferenceProvider: null })
  })

  it('offers the app menu on a link of an app it does not know', async () => {
    const webex = event('webex', { conference: { provider: 'webex', url: 'https://company.webex.com/meet/kim', id: null, dialIn: null, removable: true } })
    server.set('webex', webex)
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(webex)[0]! })
    const app = wrapper.get('.meeting-row button[aria-haspopup="menu"]')
    expect(app.text()).toBe('Meeting link')
    await app.trigger('click')
    expect(wrapper.find('[role="menuitemradio"][aria-checked="true"]').exists()).toBe(false)
  })

  it('compares with the series link when a moved occurrence asks for all events', async () => {
    const series = event('linked', { recurrence: 'FREQ=DAILY;COUNT=3', start: { dateTime: '2026-10-20T10:00:00', timeZone: AMS }, end: { dateTime: '2026-10-20T11:00:00', timeZone: AMS }, conference: teamsLink })
    const moved = event('linked-2', { uid: series.uid, recurrenceId: '20261021T080000Z', start: { dateTime: '2026-10-21T12:00:00', timeZone: AMS }, end: { dateTime: '2026-10-21T13:00:00', timeZone: AMS } })
    server.set('linked', series)
    server.set('linked-2', moved)
    const override = occurrenceOf(series, moved).find((item) => item.event.id === 'linked-2')!
    const wrapper = await editor({ kind: 'edit', occurrence: override })
    await toggle(wrapper).trigger('click')
    await wrapper.get('.scope input[value="all"]').setValue(true)
    const body = await save(wrapper)
    expect(wrapper.text()).not.toContain('A meeting link was added meanwhile.')
    // The series already has a Teams link: it keeps it, and nothing new is asked for.
    expect(body).toMatchObject({ conferenceProvider: null, conferenceUrl: TEAMS_URL })
  })

  it('stops with a plain sentence when the event moved to another calendar meanwhile', async () => {
    const moved = event('elsewhere')
    server.set('elsewhere', { ...moved, calendarId: 'home' })
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(moved)[0]! })
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.text()).toContain('This event was moved to another calendar meanwhile. Close it and open it again to change it.'))
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
  })

  it('offers Leave without a link only when the server says it can drop the request alone', async () => {
    const failed = event('nodrop', { conferenceRequest: { provider: 'teams', status: 'failed', reason: 'refused', requestedAt: new Date(NOW - 600_000).toISOString() } })
    server.set('nodrop', failed)
    for (const answer of [false, undefined]) {
      canDrop = answer
      const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(failed)[0]! })
      expect(wrapper.findAll('.meeting-row .actions button').map((button) => button.text())).toEqual(['Retry', 'Use another app'])
      wrapper.unmount()
    }
  })

  it('shows a link that the provider still made after the request was dropped', async () => {
    const failed = event('after', { conferenceRequest: { provider: 'teams', status: 'failed', reason: 'unreachable', requestedAt: new Date(NOW - 600_000).toISOString() } })
    server.set('after', failed)
    const sync = followSync()
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(failed)[0]! })
    await wrapper.findAll('.meeting-row .actions button')[2]!.trigger('click')
    await flushPromises()
    expect(title(wrapper)).toBe('Meeting link')
    expect(wrapper.find('.meeting-row [role="alert"]').exists()).toBe(false)
    server.set('after', { ...failed, conference: { provider: 'teams', url: TEAMS_URL, id: null, dialIn: null, removable: false }, conferenceRequest: null })
    await sync()
    expect(wrapper.get('.meeting-row .link').attributes('title')).toBe(TEAMS_URL)
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')
    expect(wrapper.find('.meeting-row [role="alert"]').exists()).toBe(false)
  })

  it('offers no Leave without a link when the capabilities cannot be read', async () => {
    canDrop = null
    const failed = event('nocaps', { conferenceRequest: { provider: 'teams', status: 'failed', reason: 'refused', requestedAt: new Date(NOW - 600_000).toISOString() } })
    server.set('nocaps', failed)
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(failed)[0]! })
    expect(wrapper.findAll('.meeting-row .actions button').map((button) => button.text())).toEqual(['Retry', 'Use another app'])
  })

  it.each([
    ['Teams', 'work', 'teams' as const, 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_kim%40thread.v2/0', 'Microsoft Teams', 'The current link is already a Teams link. Remove it first to get a new one.'],
    ['Meet', 'home', 'meet' as const, 'https://meet.google.com/kim-room-abc', 'Google Meet', 'The current link is already a Google Meet link. Remove it first to get a new one.'],
  ])('does not offer %s for a new link while the own link is a room of that app', async (_name, calendarId, provider, url, label, via) => {
    preferences = { ...preferences, ownLink: url }
    const own = calendarEvent('own-room', calendarId, { summary: 'own', start: { dateTime: '2026-10-22T10:00:00', timeZone: AMS }, end: { dateTime: '2026-10-22T11:00:00', timeZone: AMS }, conference: { provider, url, id: null, dialIn: null, removable: true } })
    server.set('own-room', own)
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(own)[0]! })
    expect(wrapper.get('.meeting-row button[aria-haspopup="menu"]').text()).toBe('My own link')
    await wrapper.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
    const item = wrapper.findAll('[role="menuitemradio"]').find((entry) => entry.text().includes(label))!
    expect(item.attributes('aria-disabled')).toBe('true')
    expect(item.get('.via').text()).toBe(via)
    await item.trigger('click')
    expect(wrapper.text()).not.toContain('It replaces the current link.')
    expect(await save(wrapper)).toMatchObject({ conferenceUrl: url, conferenceProvider: null })
  })

  it.each([
    ['switched off and on again', async (wrapper: Awaited<ReturnType<typeof editor>>) => {
      await toggle(wrapper).trigger('click')
      await toggle(wrapper).trigger('click')
    }],
    ['removed and undone', async (wrapper: Awaited<ReturnType<typeof editor>>) => {
      await wrapper.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
      await wrapper.findAll('[role="menuitem"]')[0]!.trigger('click')
      await wrapper.get('.meeting-row .actions button').trigger('click')
    }],
  ])('makes no link when the kept link was taken off elsewhere after it was %s', async (_name, act) => {
    const own = event('kept-gone', { conference: { provider: 'other', url: OWN, id: null, dialIn: null, removable: true } })
    server.set('kept-gone', own)
    const sync = followSync()
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(own)[0]! })
    await act(wrapper)
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true')
    server.set('kept-gone', { ...own, conference: null })
    await sync()
    expect(toggle(wrapper).attributes('aria-checked')).toBe('false')
    expect(await save(wrapper)).toMatchObject({ conferenceUrl: null, conferenceProvider: null })
  })

  it('reads before a removal too, and stops when the event moved meanwhile', async () => {
    const own = event('moved-removal', { conference: { provider: 'other', url: OWN, id: null, dialIn: null, removable: true } })
    server.set('moved-removal', { ...own, calendarId: 'home' })
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(own)[0]! })
    await toggle(wrapper).trigger('click')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.text()).toContain('This event was moved to another calendar meanwhile. Close it and open it again to change it.'))
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
  })

  it('says a pick for all events replaces the series link of a moved occurrence', async () => {
    const series = event('series-own', { recurrence: 'FREQ=DAILY;COUNT=3', start: { dateTime: '2026-10-20T10:00:00', timeZone: AMS }, end: { dateTime: '2026-10-20T11:00:00', timeZone: AMS }, conference: { provider: 'other', url: OWN, id: null, dialIn: null, removable: true } })
    const moved = event('series-own-2', { uid: series.uid, recurrenceId: '20261021T080000Z', start: { dateTime: '2026-10-21T12:00:00', timeZone: AMS }, end: { dateTime: '2026-10-21T13:00:00', timeZone: AMS } })
    server.set('series-own', series)
    server.set('series-own-2', moved)
    const override = occurrenceOf(series, moved).find((item) => item.event.id === 'series-own-2')!
    const wrapper = await editor({ kind: 'edit', occurrence: override })
    await toggle(wrapper).trigger('click')
    await wrapper.get('.scope input[value="this"]').setValue(true)
    expect(wrapper.text()).not.toContain('It replaces the current link.')
    await wrapper.get('.scope input[value="all"]').setValue(true)
    expect(wrapper.text()).toContain('It replaces the current link.')
  })

  it('takes a link changed elsewhere over a pick, and says it changed', async () => {
    const own = event('changed', { conference: { provider: 'other', url: OWN, id: null, dialIn: null, removable: true } })
    const OTHER = 'https://video.example.org/room/9'
    server.set('changed', { ...own, conference: { provider: 'other', url: OTHER, id: null, dialIn: null, removable: true } })
    const wrapper = await editor({ kind: 'edit', occurrence: occurrenceOf(own)[0]! })
    await wrapper.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
    await wrapper.findAll('[role="menuitemradio"]').find((item) => item.text().includes('Microsoft Teams'))!.trigger('click')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.text()).toContain('The meeting link was changed meanwhile. It is shown now; save again to keep it.'))
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
    expect(wrapper.get('.meeting-row .link').attributes('title')).toBe(OTHER)
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.emitted('saved')).toHaveLength(1))
    expect(requests.find((request) => request.method === 'PUT')!.body).toMatchObject({ conferenceUrl: OTHER, conferenceProvider: null })
  })

  function seriesWithMovedOccurrence(seriesLink: SyncedCalendarEvent['conference']) {
    const series = event('team-sync', { recurrence: 'FREQ=DAILY;COUNT=3', start: { dateTime: '2026-10-20T10:00:00', timeZone: AMS }, end: { dateTime: '2026-10-20T11:00:00', timeZone: AMS }, conference: seriesLink })
    const moved = event('team-sync-2', { uid: series.uid, recurrenceId: '20261021T080000Z', start: { dateTime: '2026-10-21T12:00:00', timeZone: AMS }, end: { dateTime: '2026-10-21T13:00:00', timeZone: AMS } })
    return { series, moved }
  }

  it('promises nothing new for all events when the series already has a link of that app', async () => {
    const { series, moved } = seriesWithMovedOccurrence({ provider: 'teams', url: TEAMS_URL, id: null, dialIn: null, removable: false })
    server.set('team-sync', series)
    server.set('team-sync-2', moved)
    const override = occurrenceOf(series, moved).find((item) => item.event.id === 'team-sync-2')!
    const wrapper = await editor({ kind: 'edit', occurrence: override })
    await toggle(wrapper).trigger('click')
    await wrapper.get('.scope input[value="this"]').setValue(true)
    expect(hint(wrapper)).toBe('Tresso makes the Teams link when you save.')
    await wrapper.get('.scope input[value="all"]').setValue(true)
    expect(hint(wrapper)).toBe('The series keeps its current link. Nothing new is made when you save.')
    expect(wrapper.text()).not.toContain('It replaces the current link.')
    expect(await save(wrapper)).toMatchObject({ conferenceUrl: TEAMS_URL, conferenceProvider: null })
  })

  it('says the series got a link when a save for all events meets one the editor did not know', async () => {
    const { series, moved } = seriesWithMovedOccurrence(null)
    server.set('team-sync', { ...series, conference: { provider: 'teams', url: TEAMS_URL, id: null, dialIn: null, removable: false } })
    server.set('team-sync-2', moved)
    const override = occurrenceOf(series, moved).find((item) => item.event.id === 'team-sync-2')!
    const wrapper = await editor({ kind: 'edit', occurrence: override })
    await toggle(wrapper).trigger('click')
    await wrapper.get('.scope input[value="all"]').setValue(true)
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.text()).toContain('The series got a meeting link meanwhile. Check the meeting link row, then save again.'))
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
    expect(wrapper.text()).not.toContain('It is shown now')
    // The row now tells what saving does with the series' link, and the next save keeps it.
    expect(hint(wrapper)).toBe('The series keeps its current link. Nothing new is made when you save.')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.emitted('saved')).toHaveLength(1))
    expect(requests.find((request) => request.method === 'PUT')!.body).toMatchObject({ conferenceUrl: TEAMS_URL, conferenceProvider: null })
  })

  it('removes a link, and after reopening makes a new one of the same app', async () => {
    const MEET = 'https://meet.google.com/kfp-wzqn-rtx'
    const meet = calendarEvent('again', 'home', { summary: 'again', start: { dateTime: '2026-10-22T10:00:00', timeZone: AMS }, end: { dateTime: '2026-10-22T11:00:00', timeZone: AMS }, conference: { provider: 'meet', url: MEET, id: null, dialIn: null, removable: true } })
    server.set('again', meet)
    const first = await editor({ kind: 'edit', occurrence: occurrenceOf(meet)[0]! })
    await first.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
    await first.findAll('[role="menuitem"]')[0]!.trigger('click')
    expect(await save(first)).toMatchObject({ conferenceUrl: null, conferenceProvider: null })
    first.unmount()

    // The server took the link off; the event opens again without it.
    const without = { ...meet, conference: null }
    server.set('again', without)
    requests.length = 0
    const second = await editor({ kind: 'edit', occurrence: occurrenceOf(without)[0]! })
    expect(toggle(second).attributes('aria-checked')).toBe('false')
    await toggle(second).trigger('click')
    await second.get('.meeting-row button[aria-haspopup="menu"]').trigger('click')
    await second.findAll('[role="menuitemradio"]').find((item) => item.text().includes('Google Meet'))!.trigger('click')
    expect(hint(second)).toBe('Tresso makes the Google Meet link when you save.')
    expect(second.text()).not.toContain('It replaces the current link.')
    expect(await save(second)).toMatchObject({ conferenceUrl: null, conferenceProvider: 'meet' })
  })
})
