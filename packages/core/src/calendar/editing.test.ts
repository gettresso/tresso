import { describe, expect, it } from 'vitest'
import { calendarEvent } from '../store/contract'
import { deleteRequest, durationMinutes, editScopes, inputForScope, inputFromEvent, inputFromOccurrence, reminderInputs, saveRequest, withLength } from './editing'
import { expandOccurrences } from './occurrences'

const AMS = 'Europe/Amsterdam'
const series = calendarEvent('series', 'cal', {
  uid: 'series@tresso.test',
  start: { dateTime: '2026-10-05T09:00:00', timeZone: AMS },
  end: { dateTime: '2026-10-05T10:00:00', timeZone: AMS },
  recurrence: 'FREQ=WEEKLY;BYDAY=MO',
  defaultReminders: false,
  reminders: [
    { action: 'DISPLAY', trigger: '-PT15M', relatedTo: 'start', at: null, channels: ['phone'] },
    { action: 'DISPLAY', trigger: 'PT0S', relatedTo: 'start', at: null, channels: [] },
    { action: 'DISPLAY', trigger: '-PT5M', relatedTo: 'end', at: null, channels: ['email'] },
    { action: 'DISPLAY', trigger: null, relatedTo: 'start', at: '20261001T080000Z', channels: ['email'] },
  ],
})
const moved = calendarEvent('moved', 'cal', {
  uid: 'series@tresso.test',
  recurrenceId: '20261012T070000Z',
  start: { dateTime: '2026-10-13T14:00:00', timeZone: AMS },
  end: { dateTime: '2026-10-13T15:00:00', timeZone: AMS },
})
const [first, override, third] = expandOccurrences([series, moved], Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 21), AMS)

describe('edit scopes', () => {
  it('offers nothing for an event that does not repeat', () => {
    const [single] = expandOccurrences([calendarEvent('single', 'cal')], Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1), AMS)
    expect(editScopes(single!)).toEqual([])
  })

  it('offers only "this event" for an occurrence read from the server without its series', () => {
    const lone = { ...third!, series: null, fromServer: true }
    expect(editScopes(lone)).toEqual(['this'])
  })

  it('offers "this and following" only after the first occurrence', () => {
    expect(editScopes(first!)).toEqual(['this', 'all'])
    expect(editScopes(third!)).toEqual(['this', 'following', 'all'])
  })

  it('leaves out "this event" when the rule changes, and allows only the series to move calendars', () => {
    const before = inputFromOccurrence(third!, AMS)
    expect(editScopes(third!, { before, after: { ...before, recurrence: 'FREQ=DAILY' } })).toEqual(['following', 'all'])
    expect(editScopes(third!, { before, after: { ...before, calendarId: 'other' } })).toEqual(['all'])
  })
})

describe('editor values', () => {
  it("opens an event whose zone the platform does not know in the reader's zone, saving the time the user saw", () => {
    const unknown = calendarEvent('unknown', 'cal', {
      start: { dateTime: '2026-10-05T09:00:00', timeZone: 'Nowhere/Invalid' },
      end: { dateTime: '2026-10-05T10:00:00', timeZone: 'Nowhere/Invalid' },
    })
    const [occurrence] = expandOccurrences([unknown], Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 21), AMS)

    expect(inputFromOccurrence(occurrence!, AMS)).toMatchObject({
      start: { dateTime: '2026-10-05T09:00:00', timeZone: AMS },
      end: { dateTime: '2026-10-05T10:00:00', timeZone: AMS },
    })
  })

  it('starts from the occurrence the user opened, in the event zone', () => {
    expect(inputFromOccurrence(third!, 'Asia/Tokyo')).toMatchObject({
      start: { dateTime: '2026-10-19T09:00:00', timeZone: AMS },
      end: { dateTime: '2026-10-19T10:00:00', timeZone: AMS },
      recurrence: 'FREQ=WEEKLY;BYDAY=MO',
    })
    expect(inputFromOccurrence(override!, AMS)).toMatchObject({ start: { dateTime: '2026-10-13T14:00:00', timeZone: AMS }, recurrence: 'FREQ=WEEKLY;BYDAY=MO' })
    // A rule written another way is the same rule: "This event" stays on offer.
    const before = inputFromOccurrence(override!, AMS)
    expect(editScopes(override!, { before, after: { ...before, recurrence: ' freq=weekly;byday=MO ' } })).toEqual(['this', 'following', 'all'])
    expect(editScopes(override!, { before, after: { ...before, recurrence: 'FREQ=WEEKLY;BYDAY=TU' } })).toEqual(['following', 'all'])
  })

  it('reads reminders before the start with their channels, and leaves default reminders to the rules', () => {
    expect(reminderInputs(series)).toEqual([
      { minutesBefore: 0, channels: ['phone', 'desktop'] },
      { minutesBefore: 15, channels: ['phone'] },
    ])
    expect(inputFromEvent(series)).toMatchObject({ useDefaultReminders: false, important: false, travelMinutes: null })
    expect(inputFromEvent(calendarEvent('plain', 'cal'))).toMatchObject({ useDefaultReminders: true, reminders: [] })
    expect(durationMinutes('-P1DT2H')).toBe(-1560)
    expect(durationMinutes('-P1W')).toBe(-10080)
    expect(durationMinutes('P')).toBeNull()
  })

  it('keeps asking for a meeting link that is being made or failed, so a save does not drop it', () => {
    const at = '2026-11-13T09:00:00+00:00'
    const pending = calendarEvent('p', 'cal', { conferenceRequest: { provider: 'meet', status: 'pending', reason: null, requestedAt: at } })
    expect(inputFromEvent(pending)).toMatchObject({ conferenceUrl: null, conferenceProvider: 'meet' })
    const failed = calendarEvent('f', 'cal', { conferenceRequest: { provider: 'teams', status: 'failed', reason: 'refused', requestedAt: at } })
    expect(inputFromEvent(failed)).toMatchObject({ conferenceUrl: null, conferenceProvider: 'teams' })
    const zoom = calendarEvent('z', 'cal', { conferenceRequest: { provider: 'zoom', status: 'pending', reason: null, requestedAt: at } })
    expect(inputFromEvent(zoom)).toMatchObject({ conferenceUrl: null, conferenceProvider: null })
    const made = calendarEvent('m', 'cal', {
      conference: { provider: 'meet', url: 'https://meet.google.com/abc-defg-hij', id: null, dialIn: null },
      conferenceRequest: { provider: 'meet', status: 'pending', reason: null, requestedAt: at },
    })
    expect(inputFromEvent(made)).toMatchObject({ conferenceUrl: 'https://meet.google.com/abc-defg-hij', conferenceProvider: null })
    expect(inputFromEvent(calendarEvent('none', 'cal'))).toMatchObject({ conferenceUrl: null, conferenceProvider: null })
    const old = calendarEvent('old', 'cal')
    delete old.conferenceRequest
    expect(inputFromEvent(old).conferenceProvider).toBeNull()
    // Through an occurrence and a scope save as well.
    const [occurrence] = expandOccurrences([pending], Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1), AMS)
    const before = inputFromOccurrence(occurrence!, AMS)
    expect(saveRequest(inputForScope(occurrence!, before, { ...before, summary: 'Renamed' }, 'all'), { occurrence: occurrence!, scope: 'all' }, true).body).toMatchObject({
      summary: 'Renamed',
      conferenceProvider: 'meet',
    })
  })

  it('keeps the length when the start moves', () => {
    expect(withLength({ dateTime: '2026-10-20T14:00:00', timeZone: AMS }, series.start, series.end)).toEqual({ dateTime: '2026-10-20T15:00:00', timeZone: AMS })
    expect(withLength({ date: '2026-10-22' }, { date: '2026-10-20' }, { date: '2026-10-23' })).toEqual({ date: '2026-10-25' })
  })
})

describe('saving a scope from a moved occurrence', () => {
  const before = inputFromOccurrence(override!, AMS)

  it('changes the series by what the user changed, not by the moved occurrence', () => {
    const body = inputForScope(override!, before, { ...before, location: 'Room 4' }, 'all')
    expect(body).toMatchObject({ summary: series.summary, location: 'Room 4', reminders: inputFromEvent(series).reminders })
    // The times stay where the occurrence is, with the series' own hour, so the series does not move.
    expect(body.start).toEqual({ dateTime: '2026-10-13T14:00:00', timeZone: AMS })
    expect(body.end).toEqual({ dateTime: '2026-10-13T15:00:00', timeZone: AMS })
  })

  it('takes new times the user gave', () => {
    const moved = { ...before, start: { dateTime: '2026-10-13T16:00:00', timeZone: AMS }, end: { dateTime: '2026-10-13T16:30:00', timeZone: AMS } }
    expect(inputForScope(override!, before, moved, 'following')).toMatchObject({ start: moved.start, end: moved.end, summary: series.summary })
  })

  it('saves exactly what the editor shows for this event, and for a series row', () => {
    const after = { ...before, location: 'Room 4' }
    expect(inputForScope(override!, before, after, 'this')).toBe(after)
    const fromSeries = inputFromOccurrence(third!, AMS)
    expect(inputForScope(third!, fromSeries, { ...fromSeries, summary: 'New' }, 'all')).toMatchObject({ summary: 'New' })
  })
})

describe('requests', () => {
  it('creates new events, with notify only when it is off', () => {
    const body = inputFromOccurrence(first!, AMS)
    expect(saveRequest(body, null, true)).toMatchObject({ method: 'POST', path: '/api/v1/calendar-events' })
    expect(saveRequest(body, null, false).path).toBe('/api/v1/calendar-events?notify=false')
  })

  it('changes occurrences through their series with the scope and the occurrence', () => {
    const body = inputFromOccurrence(override!, AMS)
    expect(saveRequest(body, { occurrence: override!, scope: 'following' }, true).path).toBe('/api/v1/calendar-events/series?scope=following&recurrenceId=20261012T070000Z')
    expect(deleteRequest(third!, 'this', false).path).toBe('/api/v1/calendar-events/series?notify=false&scope=this&recurrenceId=20261019T070000Z')
  })

  it('changes a single event by its own id', () => {
    const [single] = expandOccurrences([calendarEvent('single', 'cal')], Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1), AMS)
    expect(deleteRequest(single!, 'all', true).path).toBe('/api/v1/calendar-events/single')
  })
})
