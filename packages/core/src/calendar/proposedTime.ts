import { addDays, startOfWallDay, toWall, wallOf, wallParts, weekdayOf } from './zones'

/** A time an email proposes, in the reader's wall clock: a day, and a clock time when the mail names one. */
export interface ProposedTime {
  /** Midnight of the proposed day (wall time). */
  day: number
  /** Minutes after midnight; null when only a day is named, which makes an all-day suggestion. */
  minutes: number | null
}

// Full names only (and two unambiguous short forms): "sat" or "sun" alone are too often ordinary words.
const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  zondag: 0,
  monday: 1,
  maandag: 1,
  tuesday: 2,
  tues: 2,
  dinsdag: 2,
  wednesday: 3,
  woensdag: 3,
  thursday: 4,
  thurs: 4,
  donderdag: 4,
  friday: 5,
  vrijdag: 5,
  saturday: 6,
  zaterdag: 6,
}

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  januari: 1,
  february: 2,
  feb: 2,
  februari: 2,
  march: 3,
  mar: 3,
  maart: 3,
  mrt: 3,
  april: 4,
  apr: 4,
  may: 5,
  mei: 5,
  june: 6,
  jun: 6,
  juni: 6,
  july: 7,
  jul: 7,
  juli: 7,
  august: 8,
  aug: 8,
  augustus: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  oktober: 10,
  okt: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
}

const RELATIVE: Record<string, number> = { today: 0, vandaag: 0, tonight: 0, vanavond: 0, tomorrow: 1, morgen: 1, overmorgen: 2 }

const weekdayNames = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|')
const monthNames = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')

// Within one line only (a signature's "Jan" above a phone number is no date), and a day number that is not part of a
// longer number (06-1234, 12.50).
const GAP = '[ \\t]+'
const DAY_NUMBER = '(\\d{1,2})(?:st|nd|rd|th|e)?(?![\\d\\-./]\\d|\\d)'
const YEAR = `(?:,?${GAP}(\\d{4}))?`

/** Day patterns, most specific first: a date wins over a weekday, a weekday over today or tomorrow. */
const DATE_DAY_FIRST = new RegExp(`\\b${DAY_NUMBER}${GAP}(?:of${GAP})?(${monthNames})\\b\\.?${YEAR}`, 'i')
const DATE_MONTH_FIRST = new RegExp(`\\b(${monthNames})\\.?${GAP}${DAY_NUMBER}${YEAR}`, 'i')
const WEEKDAY = new RegExp(`\\b(?:next${GAP}|volgende${GAP})?(${weekdayNames})\\b`, 'i')
// "Goede morgen" is a greeting, not tomorrow.
const RELATIVE_DAY = /(?<!goede[ \t])\b(today|vandaag|tonight|vanavond|tomorrow|overmorgen|morgen)\b/i

/** Time patterns: a clock time, an hour with am/pm or "uur", or a bare hour right after at/om that ends the phrase. */
const TIMES: { pattern: RegExp; hour: number; minute?: number; suffix?: number; bare?: boolean }[] = [
  // 12:30, 4:30 pm; not inside 10:00:00 or a longer number.
  { pattern: /(?<![\d.:])(\d{1,2}):([0-5]\d)(?![\d:])(?:[ \t]*(a\.?m\.?|p\.?m\.?)(?![a-z]))?/i, hour: 1, minute: 2, suffix: 3 },
  // 15.00 only where it is plainly a time: after at/om/around, or before uur/u (12.50 euro, version 2.10 are no times).
  { pattern: /\b(?:at|om|around|rond|vanaf|from)[ \t]+(\d{1,2})\.([0-5]\d)(?![\d.])/i, hour: 1, minute: 2 },
  { pattern: /(?<![\d.])(\d{1,2})\.([0-5]\d)[ \t]*(?:uur|u)\b/i, hour: 1, minute: 2 },
  // 3pm, 3 p.m. (not "3 Amsterdam offices"), 15u, 15 uur.
  { pattern: /(?<![\d.:])(\d{1,2})[ \t]*(a\.?m\.?|p\.?m\.?)(?![a-z])/i, hour: 1, suffix: 2 },
  { pattern: /(?<![\d.:])(\d{1,2})[ \t]*(?:uur|u)\b/i, hour: 1 },
  // "at 3", "om 3 uur" end the phrase; "at 3 options", "om 3 redenen" do not.
  { pattern: /\b(?:at|om)[ \t]+(\d{1,2})(?=[ \t]*(?:[.,!?;)]|$|o'?clock\b))/im, hour: 1, bare: true },
]

/** Where the quoted part of a reply starts: "On ... wrote:", "Op ... schreef", "> ", a forwarded header. */
const QUOTE = /\b(?:On|Op)\b[^\n]{0,160}?\b(?:wrote|schreef)\b|(?:^|\n)[ \t]*>|-{2,}[ \t]*(?:Original|Oorspronkelijk)|(?:^|\n)[ \t]*(?:From|Van|Sent|Verzonden):[ \t]/i

function ownText(text: string): string {
  const quote = QUOTE.exec(text)
  return quote === null ? text : text.slice(0, quote.index)
}

function timeIn(text: string): number | null {
  let best: { index: number; minutes: number } | null = null
  for (const time of TIMES) {
    const match = time.pattern.exec(text)
    if (match === null || (best !== null && match.index >= best.index)) {
      continue
    }
    let hour = Number(match[time.hour])
    const minute = time.minute === undefined ? 0 : Number(match[time.minute])
    const suffix = time.suffix === undefined ? '' : (match[time.suffix] ?? '').toLowerCase().replace(/\./g, '')
    if (suffix === 'pm' && hour < 12) {
      hour += 12
    } else if (suffix === 'am' && hour === 12) {
      hour = 0
    } else if (time.bare === true && hour >= 1 && hour <= 7) {
      // "Meet at 3" is in the afternoon.
      hour += 12
    }
    if (hour > 23 || minute > 59) {
      continue
    }
    best = { index: match.index, minutes: hour * 60 + minute }
  }

  return best?.minutes ?? null
}

/** The next time a day of a month comes (a leap day may be years away), or that day in the year given. */
function dateDay(today: number, month: number, date: number, year: string | undefined): number | null {
  if (month < 1 || date < 1 || date > 31) {
    return null
  }
  if (year !== undefined) {
    const day = wallOf({ year: Number(year), month, day: date })
    // A date in the past (a quoted header, a deadline that was) proposes nothing.
    return wallParts(day).day === date && day >= today ? day : null
  }
  const first = wallParts(today).year
  for (let candidate = first; candidate <= first + 8; candidate++) {
    const day = wallOf({ year: candidate, month, day: date })
    if (wallParts(day).day === date && day >= today) {
      return day
    }
  }

  return null
}

function dayIn(text: string, today: number): number | null | undefined {
  const dayFirst = DATE_DAY_FIRST.exec(text)
  const monthFirst = DATE_MONTH_FIRST.exec(text)
  const date = [dayFirst === null ? null : { index: dayFirst.index, day: Number(dayFirst[1]), month: dayFirst[2]!, year: dayFirst[3] }, monthFirst === null ? null : { index: monthFirst.index, day: Number(monthFirst[2]), month: monthFirst[1]!, year: monthFirst[3] }]
    .filter((found) => found !== null)
    .sort((a, b) => a.index - b.index)[0]
  if (date !== undefined) {
    return dateDay(today, MONTHS[date.month.toLowerCase()] ?? 0, date.day, date.year)
  }
  const weekday = WEEKDAY.exec(text)
  if (weekday !== null) {
    const ahead = ((WEEKDAYS[weekday[1]!.toLowerCase()] ?? 0) - weekdayOf(today) + 7) % 7
    return addDays(today, ahead === 0 ? 7 : ahead)
  }
  const relative = RELATIVE_DAY.exec(text)
  if (relative !== null) {
    return addDays(today, RELATIVE[relative[1]!.toLowerCase()] ?? 0)
  }

  // Undefined: the mail names no day at all (null: it names one that proposes nothing, like a date gone by).
  return undefined
}

/**
 * The day (and time) an email proposes, read from its subject and its own text (not the quoted reply below it), in
 * English or Dutch, for "Add to calendar". A date wins over a weekday, a weekday over today or tomorrow. A weekday
 * means the next one after today; a date without a year the next time it comes, a date in the past nothing; a time
 * without a day today when still ahead, otherwise tomorrow. Null when the mail proposes neither a day nor a time.
 */
export function proposedTime(text: string, now: number, zone: string): ProposedTime | null {
  const own = ownText(text)
  const today = startOfWallDay(toWall(now, zone))
  const nowMinutes = Math.floor((toWall(now, zone) - today) / 60_000)
  const minutes = timeIn(own)
  const day = dayIn(own, today)
  if (day === null) {
    return null
  }
  if (day === undefined) {
    return minutes === null ? null : { day: minutes > nowMinutes ? today : addDays(today, 1), minutes }
  }

  return { day, minutes }
}
