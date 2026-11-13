import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { daysFrom, displayLink, expandOccurrences, type Conference, type ConferenceRequest, type SyncedCalendarEvent } from '@tresso/core'
import { calendar as calendarRow, calendarEvent } from '@tresso/core/testing'
import { openMeeting } from '@/calendar/join'
import AgendaList from '../calendar/AgendaList.vue'
import EventDetail from '../calendar/EventDetail.vue'
import JoinLink from '../calendar/JoinLink.vue'
import MeetingLink from '../calendar/MeetingLink.vue'

const desktop = vi.hoisted(() => ({ isDesktop: false, opened: [] as string[], fail: false }))

vi.mock('@/platform/desktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/desktop')>()),
  get isDesktop() {
    return desktop.isDesktop
  },
  openInBrowser: async (url: string) => {
    if (desktop.fail) {
      // What a shell error may look like: it repeats the link, which must not reach the screen.
      throw new Error(`Failed to open ${url}`)
    }
    desktop.opened.push(url)
  },
}))

const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjY0ZTk0YjQtZDQ5Mi00YjQ5LWE1ZjMtNzE3ZmQ4MzM5YjQx%40thread.v2/0?context=%7b%22Tid%22%3a%22c2f1%22%7d'
const MEET = 'https://meet.google.com/kfp-wzqn-rtx'
const NOW = Date.parse('2026-11-13T09:01:00+00:00')

function conference(provider: Conference['provider'], url: string, dialIn: string | null = null): Conference {
  return { provider, url, id: null, dialIn }
}

function request(extra: Partial<ConferenceRequest> = {}): ConferenceRequest {
  return { provider: 'teams', status: 'pending', reason: null, requestedAt: '2026-11-13T09:00:00+00:00', ...extra }
}

function event(extra: Partial<SyncedCalendarEvent> = {}): SyncedCalendarEvent {
  return calendarEvent('review', 'work', { summary: 'Product review', ...extra })
}

let clockNow = NOW
const clock = () => clockNow

function popover(value: SyncedCalendarEvent, ownLink: string | null = null) {
  return mount(MeetingLink, { props: { event: value, request: value.conferenceRequest ?? null, ownLink, clock }, attachTo: document.body })
}

beforeEach(() => {
  desktop.isDesktop = false
  desktop.opened = []
  desktop.fail = false
  clockNow = NOW
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the meeting link in the popover', () => {
  it('shows the app, the link cut in the middle, Join and Copy link', () => {
    const wrapper = popover(event({ conference: conference('teams', TEAMS, '+31201234567') }))
    expect(wrapper.get('.app').text()).toBe('Microsoft Teams')
    const url = wrapper.get('.url')
    expect(url.text()).toBe('teams.microsoft.com/l/meetup-jo…22c2f1%22%7d')
    expect(url.attributes('title')).toBe(TEAMS)
    const join = wrapper.get('a.button-primary')
    expect(join.text()).toContain('Join')
    expect(join.attributes('aria-label')).toBe('Join with Microsoft Teams')
    expect(join.attributes('aria-keyshortcuts')).toBe('Shift+J')
    expect(join.attributes('href')).toBe(TEAMS)
    expect(join.attributes('target')).toBe('_blank')
    expect(join.attributes('rel')).toBe('noopener noreferrer')
    expect(join.attributes('referrerpolicy')).toBe('no-referrer')
    expect(wrapper.get('.copy-link').text()).toBe('Copy link')
    expect(wrapper.text()).toContain('Dial in: +31201234567')
    expect(wrapper.find('[role="status"].request').exists()).toBe(false)
  })

  it('names the app from the conference, the own link as such, and anything else neutrally', () => {
    expect(popover(event({ conference: conference('meet', MEET) })).get('a').attributes('aria-label')).toBe('Join with Google Meet')
    const own = popover(event({ conference: conference('other', 'https://meet.example.com/kim') }), 'https://meet.example.com/kim')
    expect(own.get('.app').text()).toBe('My own link')
    expect(own.get('a').attributes('aria-label')).toBe('Join the meeting')
    const other = popover(event({ conference: conference('other', 'https://video.example.org/room/7') }))
    expect(other.get('.app').text()).toBe('Meeting link')
    expect(other.get('.url').text()).toBe('video.example.org/room/7')
  })

  it('copies the whole link on a click only, says Copied for 2 seconds and announces it once', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const wrapper = popover(event({ conference: conference('teams', TEAMS) }))
    const status = () => wrapper.findAll('.visually-hidden[role="status"]').map((node) => node.text())
    expect(writeText).not.toHaveBeenCalled()
    expect(status()).toEqual([''])

    await wrapper.get('.copy-link').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(TEAMS)
    expect(wrapper.get('.copy-link').text()).toBe('Copied')
    expect(status()).toEqual(['Link copied'])

    // Another render (the event changes) does not announce it again.
    await wrapper.setProps({ event: event({ conference: conference('teams', TEAMS), summary: 'Renamed' }) })
    expect(status()).toEqual(['Link copied'])

    vi.advanceTimersByTime(2000)
    await flushPromises()
    expect(wrapper.get('.copy-link').text()).toBe('Copy link')
    expect(status()).toEqual([''])
  })

  it('shows the whole link to copy by hand when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn<(text: string) => Promise<void>>(async () => Promise.reject(new Error('denied'))) } })
    const wrapper = popover(event({ conference: conference('teams', TEAMS) }))
    await wrapper.get('.copy-link').trigger('click')
    await flushPromises()
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('The link could not be copied. Select it and copy it by hand.')
    expect(alert.get('.full-link').text()).toBe(TEAMS)
    expect(wrapper.get('.copy-link').text()).toBe('Copy link')
  })

  it('also when the browser has no clipboard at all', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const wrapper = popover(event({ conference: conference('meet', MEET) }))
    await wrapper.get('.copy-link').trigger('click')
    await flushPromises()
    expect(wrapper.get('.full-link').text()).toBe(MEET)
  })

  it('says who added the link on an event someone else organizes', () => {
    const invited = event({
      conference: conference('teams', TEAMS),
      selfResponse: 'accepted',
      organizer: { address: 'kim@company.example', name: 'Kim Visser' },
    })
    expect(popover(invited).text()).toContain('Microsoft Teams, added by Kim Visser. Only the organizer can change it.')
    const unnamed = { ...invited, organizer: { address: 'kim@company.example', name: null } }
    expect(popover(unnamed).text()).toContain('Microsoft Teams, added by kim@company.example. Only the organizer can change it.')
    // The organizer's own event has no such line.
    expect(popover(event({ conference: conference('teams', TEAMS) })).text()).not.toContain('added by')
  })

  it('shows a link being made, and that it failed once two minutes have passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const wrapper = popover(event({ conferenceRequest: request() }))
    const block = wrapper.get('.request')
    expect(block.attributes('role')).toBe('status')
    expect(block.text()).toContain('Making the Teams link')
    expect(block.text()).toContain('The event is saved. This usually takes a few seconds.')
    expect(wrapper.find('.spinner').exists()).toBe(true)
    expect(wrapper.find('a').exists()).toBe(false)

    // The server's clock passes the two minutes since the request: 09:02:00 plus a moment.
    clockNow = Date.parse('2026-11-13T09:02:01+00:00')
    vi.advanceTimersByTime(59_000)
    await flushPromises()
    expect(wrapper.get('.request').text()).toContain('Making the Teams link')
    vi.advanceTimersByTime(2_000)
    await flushPromises()
    expect(wrapper.get('.request').text()).toContain('Could not make the Teams link')
    expect(wrapper.get('.request').text()).toContain('The event is saved without a link. Microsoft did not answer in time.')
  })

  it('gives the reason of a failed link', () => {
    const failed = (reason: ConferenceRequest['reason'], provider: ConferenceRequest['provider'] = 'teams') =>
      popover(event({ conferenceRequest: request({ status: 'failed', reason, provider }) })).get('.failed').text()
    expect(failed('refused')).toBe('Could not make the Teams link The event is saved without a link. Microsoft refused to make it.')
    expect(failed('unreachable', 'meet')).toBe('Could not make the Google Meet link The event is saved without a link. Google did not answer in time.')
    expect(failed('not_supported')).toBe('Could not make the Teams link The event is saved without a link. Microsoft Teams is not available for this calendar.')
    // No retry or remove controls here: those belong to the editor's row.
    expect(popover(event({ conferenceRequest: request({ status: 'failed', reason: 'refused' }) })).findAll('button')).toHaveLength(0)
  })

  it('shows a failed link only to the organizer', () => {
    const wrapper = popover(event({ selfResponse: 'accepted', conferenceRequest: request({ status: 'failed', reason: 'refused' }) }))
    expect(wrapper.find('.failed').exists()).toBe(false)
  })

  it('renders nothing without a link or a request', () => {
    const wrapper = popover(event())
    expect(wrapper.text()).toBe('')
    expect(wrapper.find('.meeting').exists()).toBe(false)
  })

  it('shows the link once it is there, not the request', () => {
    const wrapper = popover(event({ conference: conference('teams', TEAMS), conferenceRequest: request() }))
    expect(wrapper.text()).not.toContain('Making')
    expect(wrapper.get('.app').text()).toBe('Microsoft Teams')
  })

  it.each([
    ['a script', 'javascript:alert(document.cookie)'],
    ['a data address', 'data:text/html,<script>alert(1)</script>'],
    ['plain http', 'http://teams.microsoft.com/l/meetup-join/1'],
    ['a custom scheme', 'zoommtg://zoom.us/join?confno=123'],
    ['an intranet host', 'https://meet/room'],
    ['a host that imitates another', 'https://teаms.microsoft.com/l/meetup-join/1'],
    ['a user name before the host', 'https://teams.microsoft.com@evil.example/x'],
    ['a user name and password', 'https://user:pass@teams.microsoft.com/l/meetup-join/1'],
    ['a file', 'file:///etc/passwd'],
    ['localhost', 'https://localhost/room'],
    ['a reversed text', 'https://evil.example/\u202emoc.tfosorcim.smaet'],
  ])('offers no Join for %s, but shows it with Copy link', async (_name, url) => {
    const wrapper = popover(event({ conference: conference('teams', url) }))
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.find(`[href]`).exists()).toBe(false)
    expect(wrapper.get('.url').attributes('title')).toBe(displayLink(url))
    expect(wrapper.get('.url').attributes('dir')).toBe('ltr')
    expect(wrapper.get('.url').text()).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/)
    expect(wrapper.get('.copy-link').text()).toBe('Copy link')
    expect(wrapper.text()).toContain('Tresso does not open this link. Check where it leads before you use it.')
    // Nor does the key or any other way to join open it.
    vi.stubGlobal('open', vi.fn<typeof window.open>())
    desktop.isDesktop = false
    await expect(openMeeting(url)).resolves.toBe(false)
    desktop.isDesktop = true
    await expect(openMeeting(url)).resolves.toBe(false)
    expect(window.open).not.toHaveBeenCalled()
    expect(desktop.opened).toEqual([])
  })
})

describe('the popover around the link', () => {
  const AMS = 'Europe/Amsterdam'
  const work = calendarRow('work', 'work', { name: 'Work' })

  function detail(occurrence: ReturnType<typeof expandOccurrences>[number]) {
    setActivePinia(createPinia())
    return mount(EventDetail, { props: { occurrence, calendar: work, zone: AMS, now: NOW, busy: false, error: null, clock }, attachTo: document.body })
  }

  it('names the saved own link "My own link"', () => {
    setActivePinia(createPinia())
    const own = 'https://meet.example.com/kim'
    const [occurrence] = expandOccurrences([calendarEvent('own', 'work', { conference: conference('other', own) })], Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 25), AMS)
    const wrapper = mount(EventDetail, { props: { occurrence: occurrence!, calendar: work, zone: AMS, now: NOW, busy: false, error: null, clock, ownLink: own } })
    expect(wrapper.get('.app').text()).toBe('My own link')
    expect(detail(occurrence!).get('.app').text()).toBe('Meeting link')
  })

  it('reads the request from the series for a moved occurrence', () => {
    const series = calendarEvent('series', 'work', { summary: 'Standup', recurrence: 'FREQ=DAILY;COUNT=3', conferenceRequest: request() })
    const moved = calendarEvent('moved', 'work', {
      summary: 'Standup',
      uid: series.uid,
      recurrenceId: '20261021T080000Z',
      start: { dateTime: '2026-10-21T11:00:00', timeZone: AMS },
      end: { dateTime: '2026-10-21T12:00:00', timeZone: AMS },
      conferenceRequest: null,
    })
    const occurrences = expandOccurrences([series, moved], Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 25), AMS)
    const override = occurrences.find((item) => item.event.id === 'moved')!
    expect(override.series?.id).toBe('series')
    expect(detail(override).text()).toContain('Making the Teams link')
    const failed = expandOccurrences([{ ...series, conferenceRequest: request({ status: 'failed', reason: 'refused' }) }, moved], Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 25), AMS)
    expect(detail(failed.find((item) => item.event.id === 'moved')!).text()).toContain('Could not make the Teams link')
  })

  it('starts over for another event: a failed copy does not follow', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn<(text: string) => Promise<void>>(async () => Promise.reject(new Error('denied'))) } })
    const [a] = expandOccurrences([calendarEvent('a', 'work', { conference: conference('teams', TEAMS) })], Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 25), AMS)
    const [b] = expandOccurrences([calendarEvent('b', 'work', { conference: conference('meet', MEET) })], Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 25), AMS)
    const wrapper = detail(a!)
    await wrapper.get('.copy-link').trigger('click')
    await flushPromises()
    expect(wrapper.find('.copy-failed').exists()).toBe(true)
    await wrapper.setProps({ occurrence: b! })
    expect(wrapper.find('.copy-failed').exists()).toBe(false)
    expect(wrapper.get('.app').text()).toBe('Google Meet')
  })
})

describe('timers', () => {
  it('waits at most two minutes for a request time far in the future, without a loop', async () => {
    vi.useFakeTimers()
    const delays: number[] = []
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, delay?: number) => {
      delays.push(delay ?? 0)
      return real(handler, delay)
    }) as typeof setTimeout)
    const wrapper = popover(event({ conferenceRequest: request({ requestedAt: '2027-11-13T09:00:00+00:00' }) }))
    expect(wrapper.text()).toContain('Making the Teams link')
    const armed = delays.length
    expect(Math.max(...delays)).toBeLessThanOrEqual(120_250)
    vi.advanceTimersByTime(1_000)
    await flushPromises()
    expect(delays.length).toBe(armed)
    wrapper.unmount()
  })

  it('clears the request timer and the copy timer on unmount', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn<(text: string) => Promise<void>>(async () => undefined) } })
    const making = popover(event({ conferenceRequest: request() }))
    expect(vi.getTimerCount()).toBe(1)
    making.unmount()
    expect(vi.getTimerCount()).toBe(0)
    const made = popover(event({ conference: conference('teams', TEAMS) }))
    await made.get('.copy-link').trigger('click')
    await flushPromises()
    expect(made.get('.copy-link').text()).toBe('Copied')
    expect(vi.getTimerCount()).toBe(1)
    made.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sets no timer when the clipboard answers after the button is gone', async () => {
    vi.useFakeTimers()
    let answer: () => void = () => undefined
    const writeText = vi.fn<(text: string) => Promise<void>>(() => new Promise<void>((resolve) => (answer = resolve)))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const wrapper = popover(event({ conference: conference('teams', TEAMS) }))
    await wrapper.get('.copy-link').trigger('click')
    expect(writeText).toHaveBeenCalled()
    wrapper.unmount()
    answer()
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a link shown as text', () => {
  it('shows a refused link with its hidden characters visible, capped, left to right', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const long = `https://evil.example/\u202e${'a'.repeat(5000)}`
    const wrapper = popover(event({ conference: conference('other', long) }))
    await wrapper.get('.copy-link').trigger('click')
    await flushPromises()
    const full = wrapper.get('.full-link')
    expect(full.attributes('dir')).toBe('ltr')
    expect(full.text()).toBe(displayLink(long))
    expect(Array.from(full.text())).toHaveLength(300)
    expect(full.text()).toContain('\ufffd')
  })

  it('shows a long link it can join whole to copy by hand', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const long = `https://teams.microsoft.com/l/meetup-join/${'a'.repeat(400 - 42)}`
    expect(long).toHaveLength(400)
    const wrapper = popover(event({ conference: conference('teams', long) }))
    await wrapper.get('.copy-link').trigger('click')
    await flushPromises()
    expect(wrapper.get('.full-link').text()).toBe(long)
    expect(wrapper.get('.url').attributes('title')).toBe(displayLink(long))
  })

  it('shows a refused link in a list the same way', () => {
    const url = 'https://evil.example/\u202emoc.smaet'
    const wrapper = mount(JoinLink, { props: { conference: conference('other', url) } })
    const text = wrapper.get('.link')
    expect(text.attributes('dir')).toBe('ltr')
    expect(text.attributes('title')).toBe(displayLink(url))
    expect(text.text()).toBe('evil.example/\ufffdmoc.smaet')
  })
})

describe('joining a meeting', () => {
  it('opens a new tab without opener or referrer in the browser', async () => {
    const open = vi.fn<typeof window.open>()
    vi.stubGlobal('open', open)
    await expect(openMeeting(MEET)).resolves.toBe(true)
    expect(open).toHaveBeenCalledWith(MEET, '_blank', 'noopener,noreferrer')
    expect(desktop.opened).toEqual([])
  })

  it('leaves a click in the browser to the anchor, which opens its own tab', async () => {
    const wrapper = mount(JoinLink, { props: { conference: conference('meet', MEET) } })
    const anchor = wrapper.get('a')
    expect(anchor.text()).toBe('Join with Google Meet')
    let leftToAnchor: boolean | null = null
    // Runs after the component's own handler: notes whether it let the anchor act, then stops jsdom navigating.
    anchor.element.addEventListener('click', (event) => {
      leftToAnchor = !event.defaultPrevented
      event.preventDefault()
    })
    anchor.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(leftToAnchor).toBe(true)
    expect(desktop.opened).toEqual([])
  })

  it('hands the link to the shell on the desktop, never to the app window', async () => {
    desktop.isDesktop = true
    const open = vi.fn<typeof window.open>()
    vi.stubGlobal('open', open)
    const wrapper = mount(JoinLink, { props: { conference: conference('teams', TEAMS) } })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    wrapper.get('a').element.dispatchEvent(click)
    await flushPromises()
    expect(click.defaultPrevented).toBe(true)
    expect(desktop.opened).toEqual([TEAMS])
    expect(open).not.toHaveBeenCalled()
    await expect(openMeeting(MEET)).resolves.toBe(true)
    expect(desktop.opened).toEqual([TEAMS, MEET])
  })

  it('says the meeting could not be opened, without the link', async () => {
    desktop.isDesktop = true
    desktop.fail = true
    const wrapper = mount(JoinLink, { props: { conference: conference('teams', TEAMS) } })
    await wrapper.get('a').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('The meeting could not be opened.')
    expect(wrapper.text()).not.toContain('teams.microsoft.com')
    await expect(openMeeting(TEAMS)).rejects.toThrow(/^The meeting could not be opened\.$/)
  })
})

describe('Join in the lists', () => {
  const AMS = 'Europe/Amsterdam'
  const work = calendarRow('work', 'work', { name: 'Work' })
  const days = daysFrom(Date.UTC(2026, 9, 20), 1, AMS)

  function agenda(conferences: (Conference | null)[]) {
    setActivePinia(createPinia())
    const events = conferences.map((item, index) =>
      calendarEvent(`e${index}`, 'work', { summary: `Event ${index}`, start: { dateTime: `2026-10-20T1${index}:00:00`, timeZone: AMS }, end: { dateTime: `2026-10-20T1${index}:30:00`, timeZone: AMS }, conference: item }),
    )
    const occurrences = expandOccurrences(events, days[0]!.start, days[0]!.end, AMS)
    return mount(AgendaList, { props: { days, occurrences, zone: AMS, now: Date.UTC(2026, 9, 20, 7), today: Date.UTC(2026, 9, 20), calendars: () => work, selectedKey: null } })
  }

  it('labels the button with the app and leaves a link it cannot join as text with Copy link', () => {
    const wrapper = agenda([conference('teams', TEAMS), conference('zoom', 'https://zoom.us/j/123'), conference('other', 'javascript:alert(1)'), null])
    const joins = wrapper.findAll('a.button')
    expect(joins.map((anchor) => anchor.text())).toEqual(['Join with Microsoft Teams', 'Join with Zoom'])
    expect(joins.every((anchor) => anchor.attributes('referrerpolicy') === 'no-referrer' && anchor.attributes('rel') === 'noopener noreferrer')).toBe(true)
    const rows = wrapper.findAll('.row')
    expect(rows[2]!.find('a').exists()).toBe(false)
    expect(rows[2]!.get('.link').text()).toBe('javascript:alert(1)')
    expect(rows[2]!.get('.copy-link').text()).toBe('Copy link')
    expect(rows[3]!.find('.join-link').exists()).toBe(false)
  })
})
