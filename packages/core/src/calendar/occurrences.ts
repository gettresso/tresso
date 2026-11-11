import ICAL from 'ical.js'
import type { EventTime, SyncedCalendarEvent } from './types'
import { DAY, formatDateTime, isTimeZone, parseRecurrenceKey, parseWall, recurrenceKey, toInstant, toWall, wallOf, wallParts, utc } from './zones'

/**
 * One occurrence of an event, as the views show it: recurrence expanded, overrides applied and excluded dates left
 * out, the way GET /api/v1/calendar-occurrences answers (the reference this is tested against).
 */
export interface Occurrence {
  /** Unique among the occurrences: the event id and the recurrence id. */
  key: string
  /** The row the occurrence takes its fields from: the override of this occurrence, else the series or the event. */
  event: SyncedCalendarEvent
  /** The series it belongs to; the row edits and RSVPs go to, with {@link recurrenceId}. */
  seriesId: string
  /** The series row, for its rule; null for an event that does not repeat. */
  series: SyncedCalendarEvent | null
  /** The occurrence's original start (YYYYMMDD or YYYYMMDDTHHMMSSZ); null for an event that does not repeat. */
  recurrenceId: string | null
  recurring: boolean
  /** The first occurrence of its series: "this and following" is all of it. */
  first: boolean
  allDay: boolean
  /** Instants (ms). All-day occurrences start and end at midnight in the reader's zone. */
  start: number
  end: number
  /** For all-day occurrences: the first day and the day after the last (YYYY-MM-DD); null otherwise. */
  startDate: string | null
  endDate: string | null
  /** The zone the event's own times are in; null for floating and all-day events. */
  timeZone: string | null
  /**
   * Read from the server (GET /api/v1/calendar-occurrences) for a range older than the copy on the device: its event
   * has only the fields the range endpoint gives, and its series is not on the device.
   */
  fromServer: boolean
}

/** An occurrence as GET /api/v1/calendar-occurrences gives it: instants (UTC) for timed ones, dates for all-day ones. */
export interface ServerOccurrence {
  id: string
  eventId: string
  calendarId: string
  recurrenceId: string | null
  recurring: boolean
  allDay: boolean
  start: { date: string } | { dateTime: string }
  end: { date: string } | { dateTime: string }
  timeZone: string | null
  status: SyncedCalendarEvent['status']
  summary: string
  location: string
  transparency: SyncedCalendarEvent['transparency']
  visibility: SyncedCalendarEvent['visibility']
  organizer: SyncedCalendarEvent['organizer']
  attendeeCount: number
  selfResponse: SyncedCalendarEvent['selfResponse']
  conference: SyncedCalendarEvent['conference']
}

/** How far back the delta keeps series in the copy on the device (SyncChangesProvider::eventWindow). */
export const COPY_YEARS = 2

/** The instant before which the copy on the device may lack occurrences, with a day to spare. */
export function copyStart(now: number): number {
  const date = new Date(now)
  return utc(date.getUTCFullYear() - COPY_YEARS, date.getUTCMonth(), date.getUTCDate()) + DAY
}

/** An occurrence the server read, as the views show it; times in the reader's zone. */
export function occurrenceFromServer(occurrence: ServerOccurrence, readerZone: string): Occurrence {
  const time = (value: ServerOccurrence['start']): EventTime =>
    'date' in value ? { date: value.date } : { dateTime: formatDateTime(Date.parse(value.dateTime)), timeZone: 'UTC' }
  const event: SyncedCalendarEvent = {
    id: occurrence.eventId,
    calendarId: occurrence.calendarId,
    uid: '',
    recurrenceId: occurrence.recurrenceId,
    sequence: 0,
    status: occurrence.status,
    summary: occurrence.summary,
    description: '',
    location: occurrence.location,
    url: null,
    transparency: occurrence.transparency,
    visibility: occurrence.visibility,
    allDay: occurrence.allDay,
    start: time(occurrence.start),
    end: time(occurrence.end),
    recurrence: null,
    rdates: [],
    exdates: [],
    organizer: occurrence.organizer,
    attendees: [],
    selfResponse: occurrence.selfResponse,
    reminders: [],
    conference: occurrence.conference,
    messageId: null,
    syncError: null,
    travelMinutes: null,
    defaultReminders: true,
    important: false,
    thisAndFuture: false,
  }
  const start = instantOf(event.start, readerZone)
  return {
    key: `${occurrence.eventId}:${occurrence.recurrenceId ?? ''}`,
    event,
    seriesId: occurrence.eventId,
    series: null,
    recurrenceId: occurrence.recurrenceId,
    recurring: occurrence.recurring,
    first: false,
    allDay: occurrence.allDay,
    start,
    end: Math.max(start, instantOf(event.end, readerZone)),
    startDate: 'date' in occurrence.start ? occurrence.start.date : null,
    endDate: 'date' in occurrence.end ? occurrence.end.date : null,
    timeZone: occurrence.timeZone,
    fromServer: true,
  }
}

/** How far one series is walked before it stops, as on the server: an old dense series costs no more than a new one. */
export const MAX_STEPS = 100_000

/** The occurrences of a range, and the series that had more to walk than {@link MAX_STEPS} (shown cut short). */
export interface ExpandedRange {
  occurrences: Occurrence[]
  /** Ids of series whose walk stopped at the step limit; the server refuses such a range with a 422. */
  truncated: string[]
}

/** A zone the platform knows: the event's own, else the reader's. */
export function zoneOr(zone: string | null, readerZone: string): string {
  return zone !== null && isTimeZone(zone) ? zone : readerZone
}

function wallOfTime(time: EventTime): number {
  const wall = parseWall('date' in time ? time.date : time.dateTime)
  if (wall === null) {
    throw new Error(`Not a calendar time: ${JSON.stringify(time)}`)
  }
  return wall
}

/** The instant an event time stands for; dates and floating times are read in the reader's zone. */
export function instantOf(time: EventTime, readerZone: string): number {
  const wall = wallOfTime(time)
  return 'date' in time ? toInstant(wall, readerZone) : toInstant(wall, zoneOr(time.timeZone, readerZone))
}

function seriesKey(event: SyncedCalendarEvent): string {
  return `${event.calendarId}\u0000${event.uid}`
}

function isSeries(event: SyncedCalendarEvent): boolean {
  return event.recurrence !== null || event.rdates.length > 0
}

function icalTime(wall: number, date: boolean): ICAL.Time {
  const parts = wallParts(wall)
  return date ? ICAL.Time.fromData({ year: parts.year, month: parts.month, day: parts.day, isDate: true }) : ICAL.Time.fromData({ ...parts, isDate: false })
}

function wallOfIcal(time: ICAL.Time): number {
  return wallOf({ year: time.year, month: time.month, day: time.day, hour: time.isDate ? 0 : time.hour, minute: time.isDate ? 0 : time.minute, second: time.isDate ? 0 : time.second })
}

/** The parts of a rule by name, upper-cased. */
export function ruleParts(rule: string): Map<string, string> {
  const parts = new Map<string, string>()
  for (const part of rule.toUpperCase().split(';')) {
    const at = part.indexOf('=')
    if (at > 0) parts.set(part.slice(0, at), part.slice(at + 1))
  }
  return parts
}

const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function numbers(value: string | undefined): number[] {
  return value === undefined ? [] : value.split(',').map(Number).filter((n) => Number.isInteger(n) && n !== 0)
}

/**
 * Whether a rule can never give an occurrence: a day of the month no month of BYMONTH has (BYMONTH=2;BYMONTHDAY=30),
 * a day of the month or year beyond any. ical.js loops forever looking for one with DAILY and gives normalized
 * dates (2 March) with YEARLY, so such a rule is only its start, as RFC 5545 counts DTSTART.
 */
export function neverMatches(parts: Map<string, string>): boolean {
  const monthDays = numbers(parts.get('BYMONTHDAY'))
  if (monthDays.some((day) => Math.abs(day) > 31)) return monthDays.every((day) => Math.abs(day) > 31)
  if (numbers(parts.get('BYYEARDAY')).length > 0 && numbers(parts.get('BYYEARDAY')).every((day) => Math.abs(day) > 366)) return true
  const months = numbers(parts.get('BYMONTH'))
  if (months.length === 0 || monthDays.length === 0) return false
  return !months.some((month) => monthDays.some((day) => Math.abs(day) <= (MONTH_LENGTHS[month - 1] ?? 0)))
}

/** Whether a produced day keeps to BYMONTH and BYMONTHDAY; ical.js may give a normalized day that does not. */
function keepsTo(parts: Map<string, string>, wall: number): boolean {
  const day = wallParts(wall)
  const months = numbers(parts.get('BYMONTH'))
  if (months.length > 0 && !months.includes(day.month)) return false
  const monthDays = numbers(parts.get('BYMONTHDAY'))
  if (monthDays.length === 0) return true
  const length = new Date(utc(day.year, day.month, 0)).getUTCDate()
  return monthDays.some((wanted) => (wanted > 0 ? wanted === day.day : length + 1 + wanted === day.day))
}

/** The fixed periods the server jumps over (Occurrences::jump), on the clock. */
const PERIODS: Record<string, number> = { HOURLY: 3_600_000, DAILY: DAY, WEEKLY: 7 * DAY }

interface RuleWalk {
  /** Clock readings of the starts, in the zone the series is read in. */
  starts: number[]
  truncated: boolean
}

/**
 * The starts of a rule (clock readings in `readingZone`), from the series start on, while they are at most `until`;
 * `from` is a clock reading too. Like sabre on the server:
 * - the rule steps on the clock (an hourly series too: 00:00, 01:00, 02:00, 03:00 on the night clocks go back);
 * - the series start always counts as the first occurrence, also when the rule would not give it, or its UNTIL is
 *   before it (RFC 5545 counts DTSTART, and COUNT includes it);
 * - an UNTIL date on a timed series is midnight of that date; a UTC UNTIL is compared as an instant, also for a
 *   floating series, which is read in the reader's zone;
 * - a rule of a fixed period without COUNT is jumped on the clock to two periods before `from`, so old series cost
 *   no more.
 */
function walkRule(rule: string, start: number, date: boolean, readingZone: string, from: number, until: number): RuleWalk {
  const parts = ruleParts(rule)
  const result: number[] = [start]
  if (neverMatches(parts)) {
    return { starts: result, truncated: false }
  }

  const recur = ICAL.Recur.fromString(rule)
  if (recur.until !== null && recur.until !== undefined) {
    const end = recur.until
    let limit: number
    if (end.isDate) {
      // A date: the day itself for all-day series, its midnight for timed ones (as sabre reads it).
      limit = wallOfIcal(end)
    } else if (end.zone?.tzid === 'UTC') {
      limit = toWall(utc(end.year, end.month - 1, end.day, end.hour, end.minute, end.second), readingZone)
    } else {
      limit = wallOfIcal(end)
    }
    if (date) limit = Math.floor(limit / DAY) * DAY
    // An UNTIL before the start leaves only the start: the walk below keeps nothing at or before it.
    recur.until = icalTime(limit, date)
  }
  const count = recur.count ?? null
  // Counted here: ical.js would count days it gives in error (a 30 February as 2 March) and not the start.
  recur.count = null
  if (count !== null && count <= 1) {
    return { starts: result, truncated: false }
  }
  let origin = start
  const freq = parts.get('FREQ') ?? ''
  const period = PERIODS[freq]
  if (period !== undefined && count === null) {
    const interval = Math.max(1, Number(parts.get('INTERVAL') ?? 1))
    // On the clock, as the server's modify('+N hours') and modify('+N days') do: an hourly series every 2 hours
    // from summer is still on the even hours in winter.
    const periods = Math.floor((from - start) / (period * interval)) - 2
    if (periods > 0) origin = start + periods * interval * period
  }
  const iterator = recur.iterator(icalTime(origin, date))
  let produced = 1
  for (let step = 0; ; step++) {
    if (step >= MAX_STEPS) {
      return { starts: result, truncated: true }
    }
    const next = iterator.next()
    if (next === null || next === undefined) {
      return { starts: result, truncated: false }
    }
    const wall = wallOfIcal(next)
    if (wall > until) {
      return { starts: result, truncated: false }
    }
    if (wall <= start || !keepsTo(parts, wall)) {
      continue
    }
    result.push(wall)
    produced += 1
    if (count !== null && produced >= count) {
      return { starts: result, truncated: false }
    }
  }
}

/** The occurrence of one row at its own times. */
function single(event: SyncedCalendarEvent, series: SyncedCalendarEvent | null, recurrenceId: string | null, recurring: boolean, first: boolean, readerZone: string): Occurrence {
  const start = instantOf(event.start, readerZone)
  const end = Math.max(start, instantOf(event.end, readerZone))
  return {
    key: `${event.id}:${recurrenceId ?? ''}`,
    event,
    seriesId: series?.id ?? event.id,
    series,
    recurrenceId,
    recurring,
    first,
    allDay: event.allDay,
    start,
    end,
    startDate: 'date' in event.start ? event.start.date : null,
    endDate: 'date' in event.end ? event.end.date : null,
    timeZone: 'dateTime' in event.start ? event.start.timeZone : null,
    fromServer: false,
  }
}

function overlaps(occurrence: Occurrence, from: number, to: number): boolean {
  if (occurrence.end === occurrence.start) {
    return occurrence.start >= from && occurrence.start < to
  }
  return occurrence.start < to && occurrence.end > from
}

function dateOf(wall: number): string {
  const parts = wallParts(wall)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

/** How long a row lasts: whole days for all-day rows, elapsed time otherwise. */
function lengthOf(event: SyncedCalendarEvent, readerZone: string): number {
  if ('date' in event.start) {
    return Math.max(0, Math.round((wallOfTime(event.end) - wallOfTime(event.start)) / DAY)) * DAY
  }
  return Math.max(0, instantOf(event.end, readerZone) - instantOf(event.start, readerZone))
}

/** The occurrences of a series in a range, overrides applied. */
function seriesOccurrences(master: SyncedCalendarEvent, overrides: Map<string, SyncedCalendarEvent>, from: number, to: number, readerZone: string, truncated: string[]): Occurrence[] {
  const date = 'date' in master.start
  const zone = 'dateTime' in master.start ? master.start.timeZone : null
  const readingZone = zoneOr(zone, readerZone)
  const startWall = wallOfTime(master.start)
  const length = lengthOf(master, readerZone)

  const keyOf = (wall: number): string => (date ? recurrenceKey(wall, true) : zone === null ? recurrenceKey(wall, false) : recurrenceKey(toInstant(wall, readingZone), false))
  // The clock reading of a key in the series' zone.
  const wallOfKey = (key: string): number | null => {
    const value = parseRecurrenceKey(key)
    return value === null ? null : date || zone === null ? value : toWall(value, readingZone)
  }
  // A THISANDFUTURE override changes every later occurrence, moved as far as it moves its own (RFC 5545 3.8.4.4).
  const ranges = [...overrides.entries()].filter(([, override]) => override.thisAndFuture).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const shiftOf = (key: string, override: SyncedCalendarEvent): number => (wallOfTime(override.start) - (wallOfKey(key) ?? wallOfTime(override.start)))
  const reach = Math.max(length, ...ranges.map(([key, override]) => Math.abs(shiftOf(key, override)) + lengthOf(override, readerZone)))
  // Walk in the series' wall time, with a day to spare for zones, long events and moved ones.
  const until = toWall(to, readingZone) + DAY + reach + 14 * 3_600_000
  const earliest = toWall(from, readingZone) - DAY - reach - 14 * 3_600_000

  const firstKey = keyOf(startWall)
  const exdates = new Set(master.exdates)
  const starts = new Map<string, number>()
  if (master.recurrence !== null) {
    const walk = walkRule(master.recurrence, startWall, date, readingZone, earliest, until)
    if (walk.truncated) truncated.push(master.id)
    for (const wall of walk.starts) {
      if (wall >= earliest) starts.set(keyOf(wall), wall)
    }
  } else {
    starts.set(firstKey, startWall)
  }
  for (const rdate of master.rdates) {
    const wall = wallOfKey(rdate)
    if (wall !== null && wall >= earliest && wall < until) {
      starts.set(keyOf(wall), wall)
    }
  }

  const occurrences: Occurrence[] = []
  const seen = new Set<string>()
  for (const [key, wall] of [...starts.entries()].sort((a, b) => a[1] - b[1])) {
    if (exdates.has(key)) {
      continue
    }
    seen.add(key)
    const override = overrides.get(key)
    if (override !== undefined) {
      occurrences.push(single(override, master, key, true, key === firstKey, readerZone))
      continue
    }
    let range: [string, SyncedCalendarEvent] | undefined
    for (const candidate of ranges) {
      if (candidate[0] >= key) break
      range = candidate
    }
    const source = range === undefined ? master : range[1]
    const shown = range === undefined ? wall : wall + shiftOf(range[0], range[1])
    const span = lengthOf(source, readerZone)
    const start = date ? toInstant(shown, readerZone) : toInstant(shown, readingZone)
    const end = date ? toInstant(shown + span, readerZone) : start + span
    occurrences.push({
      key: `${master.id}:${key}`,
      event: source,
      seriesId: master.id,
      series: master,
      recurrenceId: key,
      recurring: true,
      first: key === firstKey,
      allDay: master.allDay,
      start,
      end,
      startDate: date ? dateOf(shown) : null,
      endDate: date ? dateOf(shown + span) : null,
      timeZone: zone,
      fromServer: false,
    })
  }
  // Overrides moved here from an occurrence outside the walk, ones whose occurrence the series no longer has, and
  // ones whose occurrence an EXDATE removed: the server shows them all, as their own event.
  for (const [key, override] of overrides) {
    if (!seen.has(key)) {
      occurrences.push(single(override, master, key, true, key === firstKey, readerZone))
    }
  }
  return occurrences.filter((occurrence) => overlaps(occurrence, from, to))
}

/**
 * The occurrences of events in a range [from, to) of instants, sorted by start and then by length (longest first),
 * with the series whose walk was cut short. Floating and all-day events are read in `readerZone`.
 */
export function expandRange(events: Iterable<SyncedCalendarEvent>, from: number, to: number, readerZone: string): ExpandedRange {
  const masters = new Map<string, SyncedCalendarEvent>()
  const overrides = new Map<string, Map<string, SyncedCalendarEvent>>()
  for (const event of events) {
    const key = seriesKey(event)
    if (event.recurrenceId === null) {
      masters.set(key, event)
      continue
    }
    let forSeries = overrides.get(key)
    if (forSeries === undefined) {
      forSeries = new Map()
      overrides.set(key, forSeries)
    }
    forSeries.set(event.recurrenceId, event)
  }

  const truncated: string[] = []
  const occurrences: Occurrence[] = []
  for (const [key, master] of masters) {
    const own = overrides.get(key) ?? new Map<string, SyncedCalendarEvent>()
    overrides.delete(key)
    if (isSeries(master)) {
      occurrences.push(...seriesOccurrences(master, own, from, to, readerZone, truncated))
      continue
    }
    const occurrence = single(master, null, null, false, true, readerZone)
    if (overlaps(occurrence, from, to)) {
      occurrences.push(occurrence)
    }
  }
  // Occurrences the user was invited to without their series: each is an event of its own, edited as "this event".
  for (const forSeries of overrides.values()) {
    for (const [recurrenceId, override] of forSeries) {
      const occurrence = single(override, null, recurrenceId, false, true, readerZone)
      if (overlaps(occurrence, from, to)) {
        occurrences.push(occurrence)
      }
    }
  }
  occurrences.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.key.localeCompare(b.key))
  return { occurrences, truncated }
}

/** {@link expandRange} without the series that were cut short. */
export function expandOccurrences(events: Iterable<SyncedCalendarEvent>, from: number, to: number, readerZone: string): Occurrence[] {
  return expandRange(events, from, to, readerZone).occurrences
}

/**
 * The instants a stored row can touch, for finding the rows a range needs: from its first start to the end of its
 * last occurrence, null when the series has no end (or one only expanding it can tell, a COUNT).
 */
export function eventSpan(event: SyncedCalendarEvent): { startsAt: number; endsAt: number | null } {
  // Read in UTC and widened by 14 hours on each side, like the server's range columns: all-day and floating events
  // fall on another instant in every zone.
  const widen = 14 * 3_600_000
  const floating = 'date' in event.start || event.start.timeZone === null
  const startsAt = instantOf(event.start, 'UTC') - (floating ? widen : 0)
  const firstEnd = Math.max(instantOf(event.end, 'UTC'), instantOf(event.start, 'UTC')) + (floating ? widen : 0)
  if (!isSeries(event)) {
    return { startsAt, endsAt: firstEnd }
  }
  const length = firstEnd - startsAt
  let endsAt = firstEnd
  for (const rdate of event.rdates) {
    const value = parseRecurrenceKey(rdate)
    if (value !== null) {
      endsAt = Math.max(endsAt, value + length + DAY)
    }
  }
  if (event.recurrence === null) {
    return { startsAt, endsAt }
  }
  const until = /(?:^|;)UNTIL=(\d{8}(?:T\d{6}Z?)?)/.exec(event.recurrence)?.[1]
  if (/(?:^|;)COUNT=/.test(event.recurrence) || until === undefined) {
    return { startsAt, endsAt: null }
  }
  const untilAt = parseRecurrenceKey(until.endsWith('Z') || until.length === 8 ? until : `${until}Z`)
  return { startsAt, endsAt: untilAt === null ? null : Math.max(endsAt, untilAt + length + DAY) }
}
