import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AccessibilityInfo, Linking } from 'react-native'
import type { Conference, ConferenceRequest, Occurrence, SyncedCalendar, SyncedCalendarEvent } from '@tresso/core'
import EventScreen from '@/app/calendar/event'

const START = Date.parse('2026-10-23T08:00:00Z')

const { state, clipboard } = vi.hoisted(() => ({
  state: { occurrences: [] as unknown[], calendars: new Map(), now: 0 },
  clipboard: { setStringAsync: vi.fn() },
}))
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => ({ key: 'e1', start: String(START) }) }))
vi.mock('expo-clipboard', () => clipboard)
vi.mock('@/components/Icon', () => ({ Icon: () => null }))
vi.mock('@/calendar/useOccurrences', () => ({
  useReaderZone: () => 'Europe/Amsterdam',
  useOccurrences: () => ({ occurrences: state.occurrences, calendars: state.calendars, todoBlocks: [], loaded: true }),
}))
vi.mock('@/mail/MailProvider', () => ({ useMail: () => ({ respond: vi.fn(), serverNow: () => state.now }) }))

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

function show(row: SyncedCalendarEvent, series: SyncedCalendarEvent | null = null) {
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

    expect(screen.getByText('teams.microsoft.com/l/…22Tid%22%3a%22x%22%7d')).toBeTruthy()
    expect(clipboard.setStringAsync).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Copy meeting link'))
    })
    expect(clipboard.setStringAsync).toHaveBeenCalledExactlyOnceWith(teams.url)
    expect(screen.getByText('Copied')).toBeTruthy()
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
      'https://tеams.microsoft.com/l/meetup-join/1',
    ]
    for (const url of hostile) {
      const view = show(event({ conference: { provider: 'teams', url, id: null, dialIn: null } }))
      expect(screen.queryByLabelText('Join with Microsoft Teams'), url).toBeNull()
      expect(screen.queryByRole('link'), url).toBeNull()
      expect(screen.getByText('Microsoft Teams')).toBeTruthy()
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Copy meeting link'))
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
    expect(screen.queryByLabelText('Copy meeting link')).toBeNull()
  })

  it('says when copying failed and shows the whole link to copy by hand', async () => {
    clipboard.setStringAsync.mockRejectedValue(new Error('no clipboard'))
    show(event({ conference: teams }))

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Copy meeting link'))
    })

    expect(screen.getByText('Could not copy the link. Press and hold it here to copy it.')).toBeTruthy()
    expect(screen.getByText(teams.url)).toBeTruthy()
    expect(screen.queryByText('Copied')).toBeNull()
    expect(announce).toHaveBeenCalledWith('Could not copy the meeting link.')
  })

  it('says when the meeting could not be opened, without the link', async () => {
    openURL.mockRejectedValue(new Error('no app'))
    show(event({ conference: teams }))

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Join with Microsoft Teams'))
    })

    expect(screen.getByText('The meeting could not be opened on this phone. Copy the link instead.')).toBeTruthy()
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
    expect(screen.queryByText('Retry')).toBeNull()
  })

  it('shows why a link could not be made, with core texts and no retry', () => {
    const cases: [ConferenceRequest, string, string][] = [
      [request({ status: 'failed', reason: 'refused' }), 'Could not make the Teams link', 'The event is saved without a link. Microsoft refused to make it.'],
      [request({ provider: 'meet', status: 'failed', reason: 'not_supported' }), 'Could not make the Google Meet link', 'The event is saved without a link. Google Meet is not available for this calendar.'],
      [request({ status: 'failed', reason: 'unreachable' }), 'Could not make the Teams link', 'The event is saved without a link. Microsoft did not answer in time.'],
    ]
    for (const [failed, title, hint] of cases) {
      const view = show(event({ conferenceRequest: failed }))
      expect(screen.getByText(title)).toBeTruthy()
      expect(screen.getByText(hint)).toBeTruthy()
      expect(screen.queryByText('Retry')).toBeNull()
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

    expect(screen.queryByLabelText('Copy meeting link')).toBeNull()
    expect(screen.queryByText(/link/i)).toBeNull()
  })
})
