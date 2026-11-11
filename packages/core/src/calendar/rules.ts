import { DAY, formatDate, isTimeZone, parseRecurrenceKey, recurrenceKey, toInstant, toWall, wallParts, weekdayOf, utc } from './zones'

/** The ways an event can repeat that the editor offers; anything else is shown as it is and kept unless changed. */
export type RepeatPreset = 'none' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthlyByDay' | 'monthlyByDate' | 'yearly' | 'custom'

/** How a series ends. */
export type RepeatEnd = { kind: 'never' } | { kind: 'until'; date: string } | { kind: 'count'; count: number }

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'] as const
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const

/** Which week of its month a day is in (1 to 5), counted the way "the fourth Thursday" does. */
function weekOfMonth(wall: number): number {
  return Math.floor((wallParts(wall).day - 1) / 7) + 1
}

/** The rule of a preset for a series starting at `start` (a wall time), without its end. */
export function presetRule(preset: Exclude<RepeatPreset, 'none' | 'custom'>, start: number): string {
  const day = WEEKDAY_CODES[weekdayOf(start)]!
  switch (preset) {
    case 'daily':
      return 'FREQ=DAILY'
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${day}`
    case 'biweekly':
      return `FREQ=WEEKLY;INTERVAL=2;BYDAY=${day}`
    case 'monthlyByDay':
      // The fifth week does not come every month, so a fifth Thursday repeats as the last one.
      return `FREQ=MONTHLY;BYDAY=${weekOfMonth(start) === 5 ? -1 : weekOfMonth(start)}${day}`
    case 'monthlyByDate':
      return `FREQ=MONTHLY;BYMONTHDAY=${wallParts(start).day}`
    case 'yearly':
      return 'FREQ=YEARLY'
  }
}

/** The rule without its end (COUNT, UNTIL), so it compares with a preset. */
export function ruleWithoutEnd(rule: string): string {
  return rule
    .split(';')
    .filter((part) => !part.startsWith('COUNT=') && !part.startsWith('UNTIL=') && part !== 'WKST=MO')
    .join(';')
}

/** Which preset a stored rule is for a series starting at `start`; custom when it is none of them. */
export function presetOf(rule: string | null, start: number): RepeatPreset {
  if (rule === null) {
    return 'none'
  }
  const bare = normalize(ruleWithoutEnd(rule))
  for (const preset of ['daily', 'weekdays', 'weekly', 'biweekly', 'monthlyByDay', 'monthlyByDate', 'yearly'] as const) {
    if (normalize(presetRule(preset, start)) === bare) {
      return preset
    }
  }
  // A weekly rule on the start's own day, written without BYDAY, is the same as the preset.
  if (bare === 'FREQ=WEEKLY') return 'weekly'
  if (bare === 'FREQ=WEEKLY;INTERVAL=2') return 'biweekly'
  if (bare === 'FREQ=MONTHLY') return 'monthlyByDate'
  return 'custom'
}

function normalize(rule: string): string {
  return rule
    .split(';')
    .filter((part) => part !== 'INTERVAL=1')
    .sort((a, b) => (a.startsWith('FREQ=') ? -1 : b.startsWith('FREQ=') ? 1 : a.localeCompare(b)))
    .join(';')
}

/**
 * The end of a stored rule. An UNTIL in UTC (a timed series in a zone) is read as the date it falls on in `zone`, the
 * series' own zone, so it reads back what {@link withEnd} wrote; a date, a floating time, or a series without a known
 * zone is read as written.
 */
export function endOf(rule: string | null, zone: string | null = null): RepeatEnd {
  if (rule === null) {
    return { kind: 'never' }
  }
  const count = /(?:^|;)COUNT=(\d+)/.exec(rule)?.[1]
  if (count !== undefined) {
    return { kind: 'count', count: Number(count) }
  }
  const until = /(?:^|;)UNTIL=((\d{4})(\d{2})(\d{2})(T\d{6}Z?)?)/.exec(rule)
  if (until === null) {
    return { kind: 'never' }
  }
  const instant = until[5]?.endsWith('Z') && zone !== null && isTimeZone(zone) ? parseRecurrenceKey(until[1]!) : null
  if (instant !== null) {
    return { kind: 'until', date: formatDate(toWall(instant, zone!)) }
  }
  return { kind: 'until', date: `${until[2]}-${until[3]}-${until[4]}` }
}

/**
 * A rule with an end. UNTIL is inclusive: the last day's occurrence still happens. For timed series it is the end of
 * that day in the series' zone as a UTC instant (RFC 5545 asks for UTC with a zoned start), the plain clock reading
 * for floating ones, and the date for all-day ones.
 */
export function withEnd(rule: string, end: RepeatEnd, allDay: boolean, zone: string | null): string {
  const bare = ruleWithoutEnd(rule)
  switch (end.kind) {
    case 'never':
      return bare
    case 'count':
      return `${bare};COUNT=${Math.max(1, Math.floor(end.count))}`
    case 'until': {
      const [year, month, day] = end.date.split('-').map(Number) as [number, number, number]
      const lastDay = utc(year, month - 1, day)
      if (allDay) {
        return `${bare};UNTIL=${recurrenceKey(lastDay, true)}`
      }
      const endOfDay = lastDay + DAY - 1000
      const until = zone === null ? recurrenceKey(endOfDay, false).slice(0, -1) : recurrenceKey(toInstant(endOfDay, zone), false)
      return `${bare};UNTIL=${until}`
    }
  }
}

/** The preset's name for a series starting at `start`, as the Repeat menu lists it. */
export function presetLabel(preset: RepeatPreset, start: number): string {
  const weekday = WEEKDAY_NAMES[weekdayOf(start)]!
  switch (preset) {
    case 'none':
      return 'Does not repeat'
    case 'daily':
      return 'Every day'
    case 'weekdays':
      return 'Every weekday'
    case 'weekly':
      return `Weekly on ${weekday}`
    case 'biweekly':
      return `Every other week on ${weekday}`
    case 'monthlyByDay': {
      const week = weekOfMonth(start)
      return `Monthly on the ${week === 5 ? 'last' : ORDINALS[week - 1]} ${weekday}`
    }
    case 'monthlyByDate':
      return `Monthly on day ${wallParts(start).day}`
    case 'yearly': {
      const parts = wallParts(start)
      return `Every year on ${parts.day} ${MONTHS[parts.month - 1]}`
    }
    case 'custom':
      return 'Custom'
  }
}

const FREQ_WORDS: Record<string, [string, string]> = {
  HOURLY: ['hour', 'hours'],
  DAILY: ['day', 'days'],
  WEEKLY: ['week', 'weeks'],
  MONTHLY: ['month', 'months'],
  YEARLY: ['year', 'years'],
}

function list(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/**
 * A plain sentence for any rule ("Weekly on Monday and Wednesday, until 31 December 2026"). `zone` is the series' own
 * zone, which its end date is read in (see {@link endOf}).
 */
export function describeRule(rule: string, zone: string | null = null): string {
  const parts = new Map(rule.split(';').map((part) => part.split('=') as [string, string]))
  const freq = parts.get('FREQ') ?? ''
  const interval = Number(parts.get('INTERVAL') ?? 1)
  const words = FREQ_WORDS[freq]
  if (words === undefined) {
    return 'Repeats'
  }
  let sentence = interval === 1 ? `Every ${words[0]}` : interval === 2 ? `Every other ${words[0]}` : `Every ${interval} ${words[1]}`
  const byDay = parts.get('BYDAY')
  if (byDay !== undefined) {
    const days = byDay.split(',').map((code) => {
      const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(code)
      if (match === null) return code
      const name = WEEKDAY_NAMES[WEEKDAY_CODES.indexOf(match[2] as (typeof WEEKDAY_CODES)[number])]!
      if (match[1] === undefined) return name
      const ordinal = Number(match[1])
      return `the ${ordinal === -1 ? 'last' : (ORDINALS[ordinal - 1] ?? `${ordinal}th`)} ${name}`
    })
    if (byDay === 'MO,TU,WE,TH,FR' && freq === 'WEEKLY' && interval === 1) {
      sentence = 'Every weekday'
    } else {
      sentence += ` on ${list(days)}`
    }
  }
  const byMonthDay = parts.get('BYMONTHDAY')
  if (byMonthDay !== undefined) {
    sentence += ` on day ${list(byMonthDay.split(','))}`
  }
  const end = endOf(rule, zone)
  if (end.kind === 'count') {
    sentence += `, ${end.count} ${end.count === 1 ? 'time' : 'times'}`
  } else if (end.kind === 'until') {
    const [year, month, day] = end.date.split('-').map(Number) as [number, number, number]
    sentence += `, until ${day} ${MONTHS[month - 1]} ${year}`
  }
  return sentence
}

/**
 * Whether two rules are the same rule, compared the way the server compares them (EventEditor::normalizeRule):
 * letter case, spaces around it and the order of parts make no difference. The server starts a series fresh, without
 * its exceptions, when they differ, so the editor offers "This event" exactly when the server would keep them.
 */
export function sameRule(a: string | null, b: string | null): boolean {
  return normalizeRule(a) === normalizeRule(b)
}

function normalizeRule(rule: string | null): string | null {
  if (rule === null || rule.trim() === '') {
    return null
  }
  return rule
    .trim()
    .toUpperCase()
    .split(';')
    .filter((part) => part !== '')
    .sort()
    .join(';')
}
