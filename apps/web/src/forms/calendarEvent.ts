import { z } from 'zod'
import {
  DEFAULT_REMINDER_CHANNELS,
  endOf,
  parseWall,
  presetOf,
  presetRule,
  withEnd,
  type EventInput,
  type EventTime,
  type RepeatPreset,
} from '@tresso/core'

/** Mirrors the API's limits (App\ApiResource\Input\Calendar\EventInput). */
export const EVENT_SUMMARY_MAX = 1000
export const EVENT_LOCATION_MAX = 1000
export const EVENT_DESCRIPTION_MAX = 100000
export const EVENT_ATTENDEES_MAX = 500
export const EVENT_REMINDERS_MAX = 10
/** Four weeks, in minutes. */
export const EVENT_REMINDER_MAX_MINUTES = 40320

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

const attendee = z.object({
  address: z.string().trim().min(1, 'Enter an address.').email('Enter a valid address.').max(320, 'Use at most 320 characters.'),
  name: z.string().max(200).nullable(),
  role: z.enum(['required', 'optional', 'chair', 'non-participant']),
})

export const eventSchema = z
  .object({
    summary: z.string().max(EVENT_SUMMARY_MAX, `Use at most ${EVENT_SUMMARY_MAX} characters.`),
    calendarId: z.string().min(1, 'Choose a calendar.'),
    allDay: z.boolean(),
    startDate: z.string().regex(DATE, 'Choose a start date.'),
    startTime: z.string(),
    endDate: z.string().regex(DATE, 'Choose an end date.'),
    endTime: z.string(),
    /** An IANA zone, or '' for the same clock time everywhere (floating). */
    timeZone: z.string(),
    repeat: z.enum(['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthlyByDay', 'monthlyByDate', 'yearly', 'custom']),
    /** The stored rule, kept as it is while "Custom" is chosen. */
    customRule: z.string(),
    repeatEnd: z.enum(['never', 'until', 'count']),
    repeatUntil: z.string(),
    repeatCount: z.number().int(),
    /** The rule as stored, and the repeat fields it showed as: saved unchanged while those fields are. */
    originalRule: z.string(),
    originalRepeat: z.string(),
    location: z.string().max(EVENT_LOCATION_MAX, `Use at most ${EVENT_LOCATION_MAX} characters.`),
    conferenceUrl: z.string().trim().max(2048, 'Use at most 2048 characters.'),
    attendees: z.array(attendee).max(EVENT_ATTENDEES_MAX, `Invite at most ${EVENT_ATTENDEES_MAX} people.`),
    /** The user's default reminder rules apply instead of {@link reminders}. */
    useDefaultReminders: z.boolean(),
    reminders: z
      .array(
        z.object({
          minutesBefore: z.number().int().min(0, 'A reminder comes before the start.').max(EVENT_REMINDER_MAX_MINUTES, 'A reminder comes at most four weeks before.'),
          channels: z.array(z.enum(['phone', 'desktop', 'email'])).min(1, 'Choose where the reminder reaches you.'),
        }),
      )
      .max(EVENT_REMINDERS_MAX, `Use at most ${EVENT_REMINDERS_MAX} reminders.`),
    important: z.boolean(),
    /** Minutes to travel there; '' leaves the estimate to the phone. */
    travelMinutes: z.string().regex(/^\d{0,4}$/, 'Enter the travel time in minutes.'),
    description: z.string().max(EVENT_DESCRIPTION_MAX, `Use at most ${EVENT_DESCRIPTION_MAX} characters.`),
    transparency: z.enum(['busy', 'free']),
    visibility: z.enum(['public', 'private', 'confidential']),
    organizerMailAccountId: z.string(),
  })
  .superRefine((values, context) => {
    if (!values.allDay) {
      if (!TIME.test(values.startTime)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['startTime'], message: 'Enter a time like 09:30.' })
      }
      if (!TIME.test(values.endTime)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['endTime'], message: 'Enter a time like 10:30.' })
      }
    }
    const start = parseWall(values.allDay ? values.startDate : `${values.startDate}T${values.startTime}`)
    const end = parseWall(values.allDay ? values.endDate : `${values.endDate}T${values.endTime}`)
    if (start !== null && end !== null && (values.allDay ? end < start : end <= start)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'The event ends before it starts.' })
    }
    if (values.conferenceUrl !== '' && !/^https:\/\/[^\s/]+\.[^\s/]+/.test(values.conferenceUrl)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['conferenceUrl'], message: 'Use a meeting link that starts with https://.' })
    }
    if (values.repeat !== 'none' && values.repeatEnd === 'until') {
      if (!DATE.test(values.repeatUntil)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['repeatUntil'], message: 'Choose the last date.' })
      } else if (values.repeatUntil < values.startDate) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['repeatUntil'], message: 'The last date comes after the start.' })
      }
    }
    if (values.repeat !== 'none' && values.repeatEnd === 'count' && (values.repeatCount < 1 || values.repeatCount > 1000)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['repeatCount'], message: 'Repeat between 1 and 1000 times.' })
    }
    if (values.travelMinutes !== '' && Number(values.travelMinutes) > 1440) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['travelMinutes'], message: 'Travel takes at most 1440 minutes (a day).' })
    }
    const seen = new Set<string>()
    values.attendees.forEach((person, index) => {
      const key = person.address.trim().toLowerCase()
      if (seen.has(key)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['attendees', index, 'address'], message: `${person.address} is already invited.` })
      }
      seen.add(key)
    })
  })

export type EventValues = z.infer<typeof eventSchema>

function split(time: EventTime): { date: string; time: string; zone: string } {
  if ('date' in time) {
    return { date: time.date, time: '', zone: '' }
  }
  return { date: time.dateTime.slice(0, 10), time: time.dateTime.slice(11, 16), zone: time.timeZone ?? '' }
}

/** The form's values for an event the editor opens. All-day ends are shown inclusive: a one-day event ends that day. */
export function valuesFromInput(input: EventInput, fallbackZone: string): EventValues {
  const start = split(input.start)
  const end = split(input.end)
  const allDay = 'date' in input.start
  const startWall = parseWall(allDay ? start.date : `${start.date}T${start.time}`) ?? Date.now()
  const shownEnd = allDay ? lastDay(end.date) : end.date
  const repeatEnd = endOf(input.recurrence, 'dateTime' in input.start ? input.start.timeZone : null)
  const repeat = presetOf(input.recurrence, startWall)
  const repeatFields = {
    repeat,
    customRule: repeat === 'custom' ? (input.recurrence ?? '') : '',
    repeatEnd: repeatEnd.kind,
    repeatUntil: repeatEnd.kind === 'until' ? repeatEnd.date : '',
    repeatCount: repeatEnd.kind === 'count' ? repeatEnd.count : 10,
  }
  return {
    summary: input.summary,
    calendarId: input.calendarId,
    allDay,
    startDate: start.date,
    startTime: allDay ? '09:00' : start.time,
    endDate: shownEnd,
    endTime: allDay ? '10:00' : end.time,
    timeZone: allDay ? fallbackZone : start.zone,
    ...repeatFields,
    originalRule: input.recurrence ?? '',
    originalRepeat: repeatKey(repeatFields),
    location: input.location,
    conferenceUrl: input.conferenceUrl ?? '',
    attendees: input.attendees.map((person) => ({ ...person })),
    useDefaultReminders: input.useDefaultReminders,
    reminders: input.reminders.map((reminder) => ({ minutesBefore: reminder.minutesBefore, channels: [...reminder.channels] })),
    important: input.important,
    travelMinutes: input.travelMinutes === null ? '' : String(input.travelMinutes),
    description: input.description,
    transparency: input.transparency,
    visibility: input.visibility,
    organizerMailAccountId: input.organizerMailAccountId ?? '',
  }
}

function lastDay(exclusiveEnd: string): string {
  const wall = parseWall(exclusiveEnd)
  if (wall === null) {
    return exclusiveEnd
  }
  return new Date(wall - 86_400_000).toISOString().slice(0, 10)
}

function dayAfter(date: string): string {
  const wall = parseWall(date)
  return wall === null ? date : new Date(wall + 86_400_000).toISOString().slice(0, 10)
}

type RepeatFields = Pick<EventValues, 'repeat' | 'customRule' | 'repeatEnd' | 'repeatUntil' | 'repeatCount'>

function repeatKey(fields: RepeatFields): string {
  return JSON.stringify([fields.repeat, fields.customRule, fields.repeatEnd, fields.repeatUntil, fields.repeatCount])
}

/**
 * The rule the form's repeat choice stands for, with its end; null when it does not repeat. While the user left the
 * repeat fields as they were, it is the stored rule exactly as stored: moving one occurrence to another day keeps
 * BYDAY=MO, and a rule from another app (an Outlook UNTIL, an Apple WKST, a bare FREQ=WEEKLY) is not rewritten, so
 * saving "All events" never looks like a new rule to the server, which would drop every exception.
 */
export function ruleOf(values: EventValues): string | null {
  if (values.originalRepeat !== '' && repeatKey(values) === values.originalRepeat) {
    return values.originalRule === '' ? null : values.originalRule
  }
  if (values.repeat === 'none') {
    return null
  }
  const start = parseWall(values.allDay ? values.startDate : `${values.startDate}T${values.startTime}`) ?? Date.now()
  const rule = values.repeat === 'custom' ? values.customRule : presetRule(values.repeat as Exclude<RepeatPreset, 'none' | 'custom'>, start)
  if (rule === '') {
    return null
  }
  const end = values.repeatEnd === 'until' ? { kind: 'until' as const, date: values.repeatUntil } : values.repeatEnd === 'count' ? { kind: 'count' as const, count: values.repeatCount } : { kind: 'never' as const }
  return withEnd(rule, end, values.allDay, values.allDay || values.timeZone === '' ? null : values.timeZone)
}

/** What the editor saves; the status and link it does not show come from the event it edits. */
export function inputFromValues(values: EventValues, kept: Pick<EventInput, 'status' | 'url'> = { status: 'confirmed', url: null }): EventInput {
  const zone = values.timeZone === '' ? null : values.timeZone
  return {
    calendarId: values.calendarId,
    summary: values.summary.trim(),
    description: values.description,
    location: values.location.trim(),
    url: kept.url,
    start: values.allDay ? { date: values.startDate } : { dateTime: `${values.startDate}T${values.startTime}:00`, timeZone: zone },
    end: values.allDay ? { date: dayAfter(values.endDate) } : { dateTime: `${values.endDate}T${values.endTime}:00`, timeZone: zone },
    recurrence: ruleOf(values),
    status: kept.status,
    transparency: values.transparency,
    visibility: values.visibility,
    attendees: values.attendees.map((person) => ({ address: person.address.trim().toLowerCase(), name: person.name?.trim() || null, role: person.role })),
    useDefaultReminders: values.useDefaultReminders,
    reminders: values.useDefaultReminders ? [] : remindersOf(values.reminders),
    important: values.important,
    travelMinutes: values.travelMinutes === '' ? null : Number(values.travelMinutes),
    conferenceUrl: values.conferenceUrl.trim() === '' ? null : values.conferenceUrl.trim(),
    organizerMailAccountId: values.organizerMailAccountId === '' ? null : values.organizerMailAccountId,
  }
}

/** One reminder per time, earliest first; channels as chosen, else the phone and the desktop. */
function remindersOf(reminders: EventValues['reminders']): EventInput['reminders'] {
  const byTime = new Map<number, EventInput['reminders'][number]>()
  for (const reminder of reminders) {
    if (!byTime.has(reminder.minutesBefore)) {
      byTime.set(reminder.minutesBefore, { minutesBefore: reminder.minutesBefore, channels: reminder.channels.length > 0 ? [...new Set(reminder.channels)] : [...DEFAULT_REMINDER_CHANNELS] })
    }
  }
  return [...byTime.values()].sort((a, b) => a.minutesBefore - b.minutesBefore)
}
