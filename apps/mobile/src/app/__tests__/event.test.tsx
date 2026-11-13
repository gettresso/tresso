import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AccessibilityInfo, Linking } from 'react-native'
import type { Conference, ConferenceRequest, Occurrence, SyncedCalendar, SyncedCalendarEvent } from '@tresso/core'
import EventScreen from '@/app/calendar/event'
import { LINK_MAX, LTR_MARK, NOT_OPENED } from '@/calendar/MeetingLink'

const START = Date.parse('2026-10-23T08:00:00Z')

const { state, clipboard, mail } = vi.hoisted(() => ({
  state: { occurrences: [] as unknown[], calendars: new Map(), now: 0 },
  clipboard: { setStringAsync: vi.fn() },
  mail: { respond: () => Promise.resolve(), serverNow: (): number => 0, requestMeetingLink: vi.fn() },
}))
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => ({ key: 'e1', start: String(START) }) }))
vi.mock('expo-clipboard', () => clipboard)
vi.mock('@/components/Icon', () => ({ Icon: () => null }))
vi.mock('@/calendar/useOccurrences', () => ({
  useReaderZone: () => 'Europe/Amsterdam',
  useOccurrences: () => ({ occurrences: state.occurrences, calendars: state.calendars, todoBlocks: [], loaded: true }),
}))
vi.mock('@/mail/MailProvider', () => ({ useMail: () => mail }))

const calendar: SyncedCalendar = {
  id: 'cal',
  mailAccountId: 'acc',
  source: 'microsoft',
  name: 'Work',
  color: '#6E56CF',
  timeZone: 'Europe/Amsterdam',
  writable: true,
  isDefault: true,
  visible: true,
  work: true,
  providerSchedules: true,
  conferenceProviders: ['teams'],
  position: 0,
}

function event(overrides: Partial<SyncedCalendarEvent> = {}): SyncedCalendarEvent {
  return {
    id: 'e1',
    calendarId: 'cal',
    uid: 'e1@example.com',
    recurrenceId: null,
    sequence: 0,
    status: 'confirmed',
    summary: 'Product review',
    description: '',
    location: '',
    url: null,
    transparency: 'busy',
    visibility: 'public',
    allDay: false,
    start: { dateTime: '2026-10-23T10:00:00', timeZone: 'Europe/Amsterdam' },
    end: { dateTime: '2026-10-23T11:00:00', timeZone: 'Europe/Amsterdam' },
    recurrence: null,
    rdates: [],
    exdates: [],
    organizer: null,
    attendees: [],
    selfResponse: null,
    reminders: [],
    conference: null,
    conferenceRequest: null,
    messageId: null,
    syncError: null,
    travelMinutes: null,
    defaultReminders: true,
    important: false,
    thisAndFuture: false,
    ...overrides,
  }
}

function show(row: SyncedCalendarEvent, series: SyncedCalendarEvent | null = null, extra: Partial<Occurrence> = {}) {
  const occurrence: Occurrence = {
    key: 'e1',
    event: row,
    seriesId: series?.id ?? row.id,
    series,
    recurrenceId: series === null ? null : '20261023T080000Z',
    recurring: series !== null,
    first: series === null,
    allDay: false,
    start: START,
    end: START + 3_600_000,
    startDate: null,
    endDate: null,
    timeZone: 'Europe/Amsterdam',
    fromServer: false,
    ...extra,
  }
  state.occurrences = [occurrence]
  return render(<EventScreen />)
}

const teams: Conference = { provider: 'teams', url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d', id: null, dialIn: null }
const sanne = { address: 'sanne@company.example', name: 'Sanne Peters' }

function request(overrides: Partial<ConferenceRequest> = {}): ConferenceRequest {
  return { provider: 'teams', status: 'pending', reason: null, requestedAt: new Date(state.now - 10_000).toISOString(), ...overrides }
}

describe('the meeting link on the event screen', () => {
  let openURL: ReturnType<typeof vi.spyOn>
  let announce: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    state.calendars = new Map([['cal', calendar]])
    state.now = Date.parse('2026-10-23T07:00:00Z')
    clipboard.setStringAsync.mockReset()
    mail.serverNow = () => state.now
    mail.requestMeetingLink.mockReset().mockResolvedValue(undefined)
    openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
    announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('joins a made link with the app named, shows the link cut short, and copies the whole link', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    clipboard.setStringAsync.mockResolvedValue(true)
    show(event({ conference: teams }))

    fireEvent.click(screen.getByLabelText('Join with Microsoft Teams'))
    expect(openURL).toHaveBeenCalledExactlyOnceWith(teams.url)
    expect(screen.queryByText(NOT_OPENED)).toBeNull()

    expect(screen.getByText(LTR_MARK + 'teams.microsoft.com/l/meetup-jo\u20263a%22x%22%7d')).toBeTruthy()
    expect(clipboard.setStringAsync).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    })
    expect(clipboard.setStringAsync).toHaveBeenCalledExactlyOnceWith(teams.url)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
    expect(announce).toHaveBeenCalledWith('Meeting link copied')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText('Copy link')).toBeTruthy()
  })

  it('names the providers on the Join button', () => {
    const labels: [Conference['provider'], string][] = [
      ['meet', 'Join with Google Meet'],
      ['zoom', 'Join with Zoom'],
      ['webex', 'Join with Webex'],
      ['other', 'Join the meeting'],
    ]
    for (const [provider, label] of labels) {
      const view = show(event({ conference: { provider, url: 'https://meet.example.com/room', id: null, dialIn: null } }))
      expect(screen.getByLabelText(label)).toBeTruthy()
      view.unmount()
    }
  })

  it('offers no Join for a link that is not a plain https web address, but shows it with Copy', async () => {
    clipboard.setStringAsync.mockResolvedValue(true)
    const hostile = [
      'javascript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'msteams://teams.microsoft.com/l/meetup-join/1',
      'http://teams.microsoft.com/l/meetup-join/1',
      'https://user:pass@teams.microsoft.com/x',
      'https://localhost/room',
      'https://t\u0435ams.microsoft.com/l/meetup-join/1',
    ]
    for (const url of hostile) {
      const view = show(event({ conference: { provider: 'teams', url, id: null, dialIn: null } }))
      expect(screen.queryByLabelText('Join with Microsoft Teams'), url).toBeNull()
      expect(screen.queryByRole('link'), url).toBeNull()
      expect(screen.getByText('Microsoft Teams')).toBeTruthy()
      expect(screen.getByText(NOT_OPENED)).toBeTruthy()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
      })
      expect(clipboard.setStringAsync).toHaveBeenLastCalledWith(url)
      view.unmount()
    }
    expect(openURL).not.toHaveBeenCalled()
  })

  it('names who the link is from and the place once, on an invitation', () => {
    show(event({ conference: teams, selfResponse: 'accepted', organizer: sanne, location: 'Room 3.2, Herengracht office' }))

    expect(screen.getByText('Link from Sanne Peters. Or Room 3.2, Herengracht office')).toBeTruthy()
    expect(screen.queryByText('Room 3.2, Herengracht office')).toBeNull()
  })

  it('keeps the place on its own line when there is no link', () => {
    show(event({ location: 'Room 3.2' }))

    expect(screen.getByText('Room 3.2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
  })

  it('says when copying failed and shows the whole link to copy by hand', async () => {
    clipboard.setStringAsync.mockRejectedValue(new Error('no clipboard'))
    show(event({ conference: teams }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    })

    expect(screen.getByText('Could not copy the link. Press and hold it here to copy it.')).toBeTruthy()
    expect(screen.getByText(teams.url)).toBeTruthy()
    expect(screen.queryByText('Copied')).toBeNull()
    expect(announce).toHaveBeenCalledWith('Could not copy the meeting link.')
  })

  it('shows a link that cannot be joined, after a failed copy, with its hidden characters made visible', async () => {
    clipboard.setStringAsync.mockResolvedValue(false)
    const url = 'https://evil.example/\u202emoc.smaet'
    show(event({ conference: { provider: 'teams', url, id: null, dialIn: null } }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    })

    expect(screen.getByText('Could not copy the link. Press and hold it here to copy it.')).toBeTruthy()
    expect(screen.getByText('https://evil.example/\ufffdmoc.smaet')).toBeTruthy()
    expect(screen.queryByText(url)).toBeNull()
  })

  it('shows the whole host of a lookalike link', () => {
    // The server names the app by the link's host alone, so this one is "other": an ASCII host that canJoin passes.
    const longer = 'https://teams.microsoft.com.evil.example/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x'
    const view = show(event({ conference: { provider: 'other', url: longer, id: null, dialIn: null } }))
    expect(screen.getByText(/^\u200eteams\.microsoft\.com\.evil\.example\//)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Join the meeting'))
    expect(openURL).toHaveBeenCalledExactlyOnceWith(longer)
    view.unmount()

    show(event({ conference: { provider: 'teams', url: 'https://teams.microsoft.com@evil.example/l/meetup-join/1', id: null, dialIn: null } }))
    expect(screen.getByText(LTR_MARK + 'evil.example/l/meetup-join/1')).toBeTruthy()
    expect(screen.queryByText(/teams\.microsoft\.com/)).toBeNull()
    expect(screen.queryByLabelText('Join with Microsoft Teams')).toBeNull()
    expect(screen.getByText(NOT_OPENED)).toBeTruthy()
  })

  it('says when the meeting could not be opened, without the link', async () => {
    openURL.mockRejectedValue(new Error('no app'))
    show(event({ conference: teams }))

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Join with Microsoft Teams'))
    })

    expect(screen.getByText('The meeting could not be opened on this phone. Copy the link instead.')).toBeTruthy()
    expect(announce).toHaveBeenCalledExactlyOnceWith('The meeting could not be opened on this phone. Copy the link instead.')
  })

  it('shows a link that is being made, and reads it as failed once it waited too long', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    show(event({ conferenceRequest: request() }))

    expect(screen.getByText('Making the Teams link')).toBeTruthy()
    expect(screen.getByText('The event is saved. This usually takes a few seconds.')).toBeTruthy()

    state.now += 120_000
    act(() => {
      vi.advanceTimersByTime(120_000)
    })

    expect(screen.getByText('Could not make the Teams link')).toBeTruthy()
    expect(screen.getByText('The event is saved without a link. Microsoft did not answer in time.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('shows why a link could not be made, with core texts and Retry, and no removal', () => {
    const cases: [ConferenceRequest, string, string][] = [
      [request({ status: 'failed', reason: 'refused' }), 'Could not make the Teams link', 'The event is saved without a link. Microsoft refused to make it.'],
      [request({ provider: 'meet', status: 'failed', reason: 'not_supported' }), 'Could not make the Google Meet link', 'The event is saved without a link. Google Meet is not available for this calendar.'],
      [request({ status: 'failed', reason: 'unreachable' }), 'Could not make the Teams link', 'The event is saved without a link. Microsoft did not answer in time.'],
    ]
    for (const [failed, title, hint] of cases) {
      const view = show(event({ conferenceRequest: failed }))
      expect(screen.getByText(title)).toBeTruthy()
      expect(screen.getByText(hint)).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
      expect(screen.queryByText('Leave without a link')).toBeNull()
      view.unmount()
    }
  })

  it('does not tell a guest that the organizer could not make a link', () => {
    show(event({ selfResponse: 'needs-action', organizer: sanne, conferenceRequest: request({ status: 'failed', reason: 'refused' }) }))

    expect(screen.queryByText('Could not make the Teams link')).toBeNull()
  })

  it('reads the request from the series for one occurrence of it', () => {
    const series = event({ id: 's1', recurrence: 'FREQ=WEEKLY;BYDAY=TH', conferenceRequest: request() })
    show(event({ id: 'o1', recurrenceId: '20261023T080000Z', conferenceRequest: undefined }), series)

    expect(screen.getByText('Making the Teams link')).toBeTruthy()
  })

  it('shows nothing about a link when there is none and none was asked for', () => {
    show(event())

    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
    expect(screen.queryByText(/link/i)).toBeNull()
  })

  it('arms the wait again when the clock still reads under the limit, until the link reads as failed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    show(event({ conferenceRequest: request() }))

    // The timer fires after the 110 s left, but the server's clock moved only 50 s.
    state.now += 50_000
    act(() => {
      vi.advanceTimersByTime(110_250)
    })
    expect(screen.getByText('Making the Teams link')).toBeTruthy()

    state.now += 70_000
    act(() => {
      vi.advanceTimersByTime(60_250)
    })
    expect(screen.getByText('Could not make the Teams link')).toBeTruthy()
  })

  it('caps the wait for a request time far in the future', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    show(event({ conferenceRequest: request({ requestedAt: new Date(state.now + 365 * 86_400_000).toISOString() }) }))

    act(() => {
      vi.advanceTimersByTime(1000)
    })

    const waits = timeout.mock.calls.map((call) => call[1] ?? 0).filter((ms) => ms > 1000)
    expect(waits).toEqual([120_250])
    expect(screen.getByText('Making the Teams link')).toBeTruthy()
  })

  it('says once, also to screen readers, when a link that was being made could not be made', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    show(event({ conferenceRequest: request() }))
    expect(announce).not.toHaveBeenCalled()

    state.now += 120_000
    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    act(() => {
      vi.advanceTimersByTime(300_000)
    })

    expect(announce).toHaveBeenCalledExactlyOnceWith('Could not make the Teams link. The event is saved without a link. Microsoft did not answer in time.')
  })

  it('says nothing to screen readers about a link that had already failed when the screen opened', () => {
    show(event({ conferenceRequest: request({ status: 'failed', reason: 'refused' }) }))

    expect(screen.getByText('Could not make the Teams link')).toBeTruthy()
    expect(announce).not.toHaveBeenCalled()
  })

  it('uses neutral words for an app this phone does not know', () => {
    show(event({ conferenceRequest: request({ provider: 'webex' as unknown as ConferenceRequest['provider'] }) }))

    expect(screen.getByText('Making the meeting link')).toBeTruthy()
  })

  it('clears its timers when the screen closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    clipboard.setStringAsync.mockResolvedValue(true)
    const made = show(event({ conference: teams }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    })
    expect(vi.getTimerCount()).toBe(1)
    made.unmount()
    expect(vi.getTimerCount()).toBe(0)

    const making = show(event({ conferenceRequest: request() }))
    expect(vi.getTimerCount()).toBe(1)
    making.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a link whose host is in Hebrew or Arabic letters left to right on screen, and copies it without the mark', async () => {
    clipboard.setStringAsync.mockResolvedValue(true)
    for (const url of ['https://\u05e9\u05dc\u05d5\u05dd.example/room', 'https://\u0645\u062b\u0627\u0644.example/room']) {
      const view = show(event({ conference: { provider: 'other', url, id: null, dialIn: null } }))
      expect(screen.queryByRole('link'), url).toBeNull()
      expect(screen.getByText(LTR_MARK + url.slice('https://'.length))).toBeTruthy()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
      })
      expect(clipboard.setStringAsync).toHaveBeenLastCalledWith(url)
      view.unmount()
    }
  })

  it('sets nothing when the clipboard answers after the screen closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let answer: (done: boolean) => void = () => {}
    clipboard.setStringAsync.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)))
    const view = show(event({ conference: teams }))

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    view.unmount()
    await act(async () => {
      answer(true)
    })

    expect(vi.getTimerCount()).toBe(0)
    expect(announce).not.toHaveBeenCalled()
  })

  it('opens the link once for a fast double tap on Join', async () => {
    let opened: () => void = () => {}
    openURL.mockReturnValue(new Promise<void>((resolve) => (opened = resolve)))
    show(event({ conference: teams }))

    fireEvent.click(screen.getByLabelText('Join with Microsoft Teams'))
    fireEvent.click(screen.getByLabelText('Join with Microsoft Teams'))
    await act(async () => {
      opened()
    })

    expect(openURL).toHaveBeenCalledExactlyOnceWith(teams.url)
  })

  it('asks for the link again with Retry, once for a double tap, on the series, and says so', async () => {
    let done: () => void = () => {}
    mail.requestMeetingLink.mockReturnValue(new Promise<void>((resolve) => (done = resolve)))
    const series = event({ id: 's1', recurrence: 'FREQ=WEEKLY;BYDAY=TH', conferenceRequest: request({ status: 'failed', reason: 'refused' }) })
    show(event({ id: 'o1', recurrenceId: '20261023T080000Z', conferenceRequest: undefined }), series)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retrying' }))
    expect(mail.requestMeetingLink).toHaveBeenCalledExactlyOnceWith('s1', 'teams')

    await act(async () => {
      done()
    })
    expect(announce).toHaveBeenCalledExactlyOnceWith('Asked for the link again.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('shows that it asked again until the request changes, also when the sync after it failed', async () => {
    const failed = request({ status: 'failed', reason: 'refused' })
    const view = show(event({ conferenceRequest: failed }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    // The sync did not bring the new request: the copy still holds the failed one.
    expect(screen.getByText('Asked for the link again.')).toBeTruthy()
    expect(screen.getByText('Could not make the Teams link')).toBeTruthy()

    // A later sync brings the server's answer, failed again with a new time: the line goes.
    const [shown] = state.occurrences as Occurrence[]
    state.occurrences = [{ ...shown!, event: event({ conferenceRequest: request({ status: 'failed', reason: 'refused', requestedAt: new Date(state.now - 1000).toISOString() }) }) }]
    view.rerender(<EventScreen />)
    expect(screen.getByText('Could not make the Teams link')).toBeTruthy()
    expect(screen.queryByText('Asked for the link again.')).toBeNull()
  })

  it('says in plain words why Retry did not go through', async () => {
    const refusal = Object.assign(new Error('Microsoft keeps a Teams meeting on its event.'), { name: 'ApiError', status: 422 })
    const cases: [unknown, string][] = [
      [new TypeError('Network request failed'), 'No connection. Try again when you are online.'],
      [refusal, 'Microsoft keeps a Teams meeting on its event.'],
      [Object.assign(new Error('Internal'), { status: 500 }), 'The server could not do this now. Try again later.'],
      [Object.assign(new Error('Expired'), { status: 401 }), 'Your sign-in ended. Sign in again and try again.'],
      [Object.assign(new Error('Forbidden'), { status: 403 }), 'This sign-in is not allowed to make this change. Sign in again and allow the access Tresso asks for.'],
    ]
    for (const [error, text] of cases) {
      mail.requestMeetingLink.mockRejectedValueOnce(error)
      const view = show(event({ conferenceRequest: request({ status: 'failed', reason: 'refused' }) }))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      })
      expect(screen.getByText(text)).toBeTruthy()
      expect(announce).toHaveBeenLastCalledWith(text)
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
      view.unmount()
    }
  })

  it('offers Retry only for an app the provider makes, and nothing on a calendar the user cannot write', () => {
    const zoom = show(event({ conferenceRequest: request({ provider: 'zoom', status: 'failed', reason: 'refused' }) }))
    expect(screen.getByText('Could not make the Zoom link')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    zoom.unmount()

    state.calendars = new Map([['cal', { ...calendar, writable: false }]])
    show(event({ conferenceRequest: request({ status: 'failed', reason: 'refused' }) }))
    expect(screen.getByText('Could not make the Teams link')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('offers no Retry for an occurrence read from the server, whose series is not on the phone', () => {
    show(event({ conferenceRequest: request({ status: 'failed', reason: 'refused' }) }), null, { fromServer: true })

    expect(screen.getByText('Could not make the Teams link')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('shows the link of an occurrence that has its own, not the series request', () => {
    const series = event({ id: 's1', recurrence: 'FREQ=WEEKLY;BYDAY=TH', conferenceRequest: request() })
    show(event({ id: 'o1', recurrenceId: '20261023T080000Z', conference: teams, conferenceRequest: undefined }), series)

    expect(screen.getByLabelText('Join with Microsoft Teams')).toBeTruthy()
    expect(screen.queryByText('Making the Teams link')).toBeNull()
  })

  it('shows a guest that the link is being made', () => {
    show(event({ selfResponse: 'needs-action', organizer: sanne, conferenceRequest: request() }))

    expect(screen.getByText('Making the Teams link')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('shows a very long joinable link whole to copy by hand', async () => {
    clipboard.setStringAsync.mockResolvedValue(false)
    const url = `https://teams.microsoft.com/l/meetup-join/${'a'.repeat(1500)}`
    show(event({ conference: { provider: 'teams', url, id: null, dialIn: null } }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    })

    expect(screen.getByText(url)).toBeTruthy()
  })
})

describe('the meeting link layout', () => {
  beforeEach(() => {
    state.calendars = new Map([['cal', calendar]])
    state.now = Date.parse('2026-10-23T07:00:00Z')
    mail.serverNow = () => state.now
  })

  it('never cuts the link text on screen, so a large text size wraps it instead of losing the host', () => {
    const url = 'https://teams.microsoft.com.evil.example/room'
    show(event({ conference: { provider: 'other', url, id: null, dialIn: null } }))

    const text = screen.getByText(LTR_MARK + 'teams.microsoft.com.evil.example/room')
    // React Native for Web draws numberOfLines as a line clamp or an ellipsis.
    expect(text.className).not.toMatch(/LineClamp|textOverflow|whiteSpace/)
    expect(LINK_MAX).toBe(44)
  })
})
