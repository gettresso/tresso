import type { NotificationChannel } from '../notifications'
import { sameRule } from './rules'
import { zoneOr, type Occurrence } from './occurrences'
import type { AttendeeRole, ConferenceProvider, EventStatus, EventTime, SyncedCalendar, SyncedCalendarEvent } from './types'
import { DAY, formatDate, formatDateTime, parseRecurrenceKey, parseWall, toWall } from './zones'

/** Which occurrences of a series a change or deletion applies to. */
export type EditScope = 'this' | 'following' | 'all'

/** An attendee as the editor saves it. */
export interface AttendeeInput {
  address: string
  name: string | null
  role: AttendeeRole
}

/** A reminder before the start, with the channels it reaches the user on. */
export interface ReminderInput {
  /** 0 is at the start. */
  minutesBefore: number
  channels: NotificationChannel[]
}

/** Where a reminder goes when the user does not say: the phone and the desktop. */
export const DEFAULT_REMINDER_CHANNELS: NotificationChannel[] = ['phone', 'desktop']

/** The event as the editor saves it: always complete (POST and PUT /api/v1/calendar-events). */
export interface EventInput {
  calendarId: string
  summary: string
  description: string
  location: string
  url: string | null
  start: EventTime
  /** Exclusive for all-day events. */
  end: EventTime
  recurrence: string | null
  status: EventStatus
  transparency: 'busy' | 'free'
  visibility: 'public' | 'private' | 'confidential'
  attendees: AttendeeInput[]
  /** The user's default reminder rules apply; when false, exactly {@link reminders} (possibly none). */
  useDefaultReminders: boolean
  reminders: ReminderInput[]
  /** Its reminders reach the user also in quiet and outside working hours. */
  important: boolean
  /** Minutes to travel there, for leave-now reminders; estimated by the phone when null. */
  travelMinutes: number | null
  conferenceUrl: string | null
  /**
   * Ask the calendar's provider to make this meeting with the save (with `conferenceUrl` null). Null with
   * `conferenceUrl` null removes the meeting link.
   */
  conferenceProvider?: ConferenceProvider | null
  organizerMailAccountId: string | null
}

/** What the user changes about an occurrence, compared with what it was. */
export interface EventChange {
  before: EventInput
  after: EventInput
}

/**
 * The scopes to offer when saving or deleting an occurrence, in the order the dialog lists them; empty when there is
 * nothing to choose (an event that does not repeat).
 *
 * - On the first occurrence "this and following" is the whole series, so it is not offered twice.
 * - A changed rule, or a move to another calendar, cannot apply to one occurrence; a move only to the whole series,
 *   as the API allows.
 */
export function editScopes(occurrence: Occurrence, change?: EventChange): EditScope[] {
  if (!occurrence.recurring) {
    return []
  }
  // An occurrence read from the server without its series (older than the copy on the device): only itself.
  if (occurrence.series === null) {
    return ['this']
  }
  const scopes: EditScope[] = occurrence.first ? ['this', 'all'] : ['this', 'following', 'all']
  if (change === undefined) {
    return scopes
  }
  if (change.after.calendarId !== change.before.calendarId) {
    return ['all']
  }
  if (!sameRule(change.after.recurrence, change.before.recurrence)) {
    return scopes.filter((scope) => scope !== 'this')
  }
  return scopes
}

/**
 * What to save for a scope. "This event" saves what the editor shows. "All events" and "This and following" from an
 * occurrence that has its own row (a moved one) save the series as it is with only what the user changed in the
 * editor, so the override's own title, place or times are not copied onto every occurrence. Times the user left
 * alone stay where the occurrence is, with the series' own length, so the series does not move.
 */
export function inputForScope(occurrence: Occurrence, before: EventInput, after: EventInput, scope: EditScope): EventInput {
  if (scope === 'this') {
    return after
  }
  const series = occurrence.series
  let result = after
  if (series !== null && occurrence.event.id !== series.id) {
    result = { ...inputFromEvent(series), organizerMailAccountId: after.organizerMailAccountId }
    const changed = <K extends keyof EventInput>(key: K): boolean => JSON.stringify(after[key]) !== JSON.stringify(before[key])
    for (const key of Object.keys(after) as (keyof EventInput)[]) {
      if (key !== 'start' && key !== 'end' && changed(key)) {
        ;(result as unknown as Record<string, unknown>)[key] = after[key]
      }
    }
    if (changed('start') || changed('end')) {
      result.start = after.start
      result.end = after.end
    } else {
      result.start = before.start
      result.end = withLength(before.start, series.start, series.end)
    }
  }
  // A move to another day keeps the rule as it is: the server moves its weekdays and days of the month along with
  // the series and its exceptions (EventEditor::shiftRule).
  return result
}

/** The words the scope dialog offers. */
export const SCOPE_LABELS: Record<EditScope, string> = {
  this: 'This event',
  following: 'This and following',
  all: 'All events',
}

/** One line per scope saying what it changes, as the editor shows below the choice. */
export function scopeHint(scope: EditScope, deleting: boolean): string {
  if (deleting) {
    switch (scope) {
      case 'this':
        return 'Only this event is deleted. The rest of the series stays.'
      case 'following':
        return 'This event and every later one are deleted. Earlier events stay.'
      case 'all':
        return 'Every event in the series is deleted.'
    }
  }
  switch (scope) {
    case 'this':
      return 'Only this event changes. The rest of the series stays as it is.'
    case 'following':
      return 'This event and every later one change. Earlier events stay as they are.'
    case 'all':
      return 'Every event in the series changes. A new time moves them all by the same amount, and changed single events keep their changes.'
  }
}

/**
 * The editor's starting values for an occurrence: the event's own fields with the occurrence's times, in the event's
 * zone, so a save from "this event" or "all events" carries the time the user saw (the API measures the shift of
 * the series from it).
 */
export function inputFromOccurrence(occurrence: Occurrence, readerZone: string): EventInput {
  const event = occurrence.event
  return {
    ...inputFromEvent(event),
    // An override has no rule of its own; the series' rule is what "all events" keeps.
    recurrence: occurrence.series?.recurrence ?? event.recurrence,
    start: timeAt(occurrence.start, occurrence.allDay, occurrence.startDate, event.start, readerZone),
    end: timeAt(occurrence.end, occurrence.allDay, occurrence.endDate, event.end, readerZone),
  }
}

function timeAt(instant: number, allDay: boolean, date: string | null, own: EventTime, readerZone: string): EventTime {
  if (allDay && date !== null) {
    return { date }
  }
  const zone = 'dateTime' in own ? own.timeZone : null
  if (zone === null) {
    // Floating: the same clock reading wherever it is read.
    return { dateTime: formatDateTime(toWall(instant, readerZone)), timeZone: null }
  }
  // A zone the platform does not know is shown in the reader's (as the views show it), and saved so: the time saved
  // is the one the user saw.
  const reading = zoneOr(zone, readerZone)
  return { dateTime: formatDateTime(toWall(instant, reading)), timeZone: reading }
}

/** The editor's starting values for a stored event (series, override or single event). */
export function inputFromEvent(event: SyncedCalendarEvent): EventInput {
  return {
    calendarId: event.calendarId,
    summary: event.summary,
    description: event.description,
    location: event.location,
    url: event.url,
    start: event.start,
    end: event.end,
    recurrence: event.recurrence,
    status: event.status,
    transparency: event.transparency,
    visibility: event.visibility,
    attendees: event.attendees.map((attendee) => ({ address: attendee.address, name: attendee.name, role: attendee.role })),
    useDefaultReminders: event.defaultReminders,
    reminders: event.defaultReminders ? [] : reminderInputs(event),
    important: event.important,
    travelMinutes: event.travelMinutes,
    conferenceUrl: event.conference?.url ?? null,
    conferenceProvider: null,
    organizerMailAccountId: null,
  }
}

/**
 * The event's reminders before the start, with their channels. Others (after the start, relative to the end, at an
 * absolute time) are not the editor's; the API keeps them as they are.
 */
export function reminderInputs(event: SyncedCalendarEvent): ReminderInput[] {
  const reminders = new Map<number, ReminderInput>()
  for (const reminder of event.reminders) {
    if (reminder.trigger === null || reminder.relatedTo !== 'start') {
      continue
    }
    const before = durationMinutes(reminder.trigger)
    // Math.abs, not negation: a reminder at the start is 0, never -0.
    const minutes = before === null ? null : Math.abs(before)
    if (before !== null && minutes !== null && before <= 0 && !reminders.has(minutes)) {
      reminders.set(minutes, { minutesBefore: minutes, channels: reminder.channels.length > 0 ? [...reminder.channels] : [...DEFAULT_REMINDER_CHANNELS] })
    }
  }
  return [...reminders.values()].sort((a, b) => a.minutesBefore - b.minutesBefore)
}

/** An iCalendar duration (-P1DT2H15M, PT0S, -P1W) in minutes, or null when it is not one. */
export function durationMinutes(duration: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration)
  if (match === null || duration.endsWith('P') || duration.endsWith('T')) {
    return null
  }
  const [, sign, weeks, days, hours, minutes, seconds] = match
  const total = Number(weeks ?? 0) * 7 * 24 * 60 + Number(days ?? 0) * 24 * 60 + Number(hours ?? 0) * 60 + Number(minutes ?? 0) + Math.floor(Number(seconds ?? 0) / 60)
  return sign === '-' ? -total : total
}

/**
 * The request that saves the editor's values: a new event, or a change of a stored one with the scope and the
 * occurrence the user edited.
 */
export function saveRequest(input: EventInput, target: { occurrence: Occurrence; scope: EditScope } | null, notify: boolean): { method: 'POST' | 'PUT'; path: string; body: EventInput } {
  const query = new URLSearchParams()
  if (!notify) {
    query.set('notify', 'false')
  }
  if (target === null) {
    const search = query.toString()
    return { method: 'POST', path: `/api/v1/calendar-events${search === '' ? '' : `?${search}`}`, body: input }
  }
  return { method: 'PUT', path: eventPath(target.occurrence, target.scope, query), body: input }
}

/** The request that deletes an occurrence, or the series, or what follows it. */
export function deleteRequest(occurrence: Occurrence, scope: EditScope, notify: boolean): { method: 'DELETE'; path: string } {
  const query = new URLSearchParams()
  if (!notify) {
    query.set('notify', 'false')
  }
  return { method: 'DELETE', path: eventPath(occurrence, scope, query) }
}

function eventPath(occurrence: Occurrence, scope: EditScope, query: URLSearchParams): string {
  if (occurrence.recurring) {
    // Overrides are edited through their series, which knows where "this and following" begins.
    query.set('scope', scope)
    if (occurrence.recurrenceId !== null) {
      query.set('recurrenceId', occurrence.recurrenceId)
    }
    return `/api/v1/calendar-events/${encodeURIComponent(occurrence.seriesId)}?${query.toString()}`
  }
  const search = query.toString()
  return `/api/v1/calendar-events/${encodeURIComponent(occurrence.event.id)}${search === '' ? '' : `?${search}`}`
}

/** Whether a calendar takes new events and changes: writable at its provider. */
export function canWrite(calendar: SyncedCalendar | undefined): boolean {
  return calendar !== undefined && calendar.writable
}

/**
 * Whether the user can change the event itself (time, title, guests): it is in a writable calendar and the user
 * organizes it or nobody is invited. An invitation is answered, not edited.
 */
export function canEdit(event: SyncedCalendarEvent, calendar: SyncedCalendar | undefined): boolean {
  return canWrite(calendar) && event.selfResponse === null
}

/** The start of the occurrence a recurrence id names, for showing which occurrence a dialog is about. */
export function recurrenceStart(recurrenceId: string): number | null {
  return parseRecurrenceKey(recurrenceId)
}

/**
 * Moves an event time to a new start, keeping its length: what dragging or the start field does. Both values are in
 * the same kind (date or date-time) as `start`.
 */
export function withLength(start: EventTime, previousStart: EventTime, previousEnd: EventTime): EventTime {
  const startWall = parseWall('date' in start ? start.date : start.dateTime)
  const fromWall = parseWall('date' in previousStart ? previousStart.date : previousStart.dateTime)
  const toWallEnd = parseWall('date' in previousEnd ? previousEnd.date : previousEnd.dateTime)
  if (startWall === null || fromWall === null || toWallEnd === null) {
    return previousEnd
  }
  const length = Math.max(0, toWallEnd - fromWall)
  if ('date' in start) {
    return { date: formatDate(startWall + Math.max(DAY, Math.round(length / DAY) * DAY)) }
  }
  return { dateTime: formatDateTime(startWall + length), timeZone: 'dateTime' in previousEnd ? previousEnd.timeZone : start.timeZone }
}
