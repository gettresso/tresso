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
const relativeNames = Object.keys(RELATIVE).sort((a, b) => b.length - a.length).join('|')

const DAY_PATTERN = new RegExp(
  [
    `\\b(?<relative>${relativeNames})\\b`,
    `\\b(?:next\\s+|volgende\\s+)?(?<weekday>${weekdayNames})\\b\\.?`,
    `\\b(?<dateDay>\\d{1,2})(?:st|nd|rd|th|e)?\\s+(?:of\\s+)?(?<dateMonth>${monthNames})\\b\\.?`,
    `\\b(?<monthFirst>${monthNames})\\.?\\s+(?<monthFirstDay>\\d{1,2})(?:st|nd|rd|th)?\\b`,
  ].join('|'),
  'i',
)

// "at 12:30", "om 15.00", "12:30", "3pm", "3 p.m.", "15u", "15 uur"; a bare number is a time only with at/om before it.
const TIME_PATTERN =
  /\b(?:(?<clockHour>\d{1,2})[:.](?<clockMinute>[0-5]\d)\s*(?<clockSuffix>a\.?m\.?|p\.?m\.?)?|(?<suffixHour>\d{1,2})\s*(?<suffix>a\.?m\.?|p\.?m\.?|u\b|uur\b)|(?:at|om)\s+(?<bareHour>\d{1,2})\b(?![:.]\d))/i

function minutesOf(groups: Record<string, string | undefined>): number | null {
  const suffix = (groups.clockSuffix ?? groups.suffix ?? '').toLowerCase().replace(/\./g, '')
  const hourText = groups.clockHour ?? groups.suffixHour ?? groups.bareHour
  if (hourText === undefined) {
    return null
  }
  let hour = Number(hourText)
  const minute = Number(groups.clockMinute ?? 0)
  if (suffix === 'pm' && hour < 12) {
    hour += 12
  } else if (suffix === 'am' && hour === 12) {
    hour = 0
  }
  if (hour > 23 || minute > 59) {
    return null
  }

  return hour * 60 + minute
}

/**
 * The first day (and time) an email proposes, read from its subject and text in English or Dutch, for "Add to
 * calendar". A weekday means the next one after today; a date without a year the next time it comes; a time without a
 * day today when still ahead, otherwise tomorrow. Null when the mail names neither a day nor a time.
 */
export function proposedTime(text: string, now: number, zone: string): ProposedTime | null {
  const today = startOfWallDay(toWall(now, zone))
  const nowMinutes = Math.floor((toWall(now, zone) - today) / 60_000)
  const dayMatch = DAY_PATTERN.exec(text)
  const timeMatch = TIME_PATTERN.exec(text)
  const minutes = timeMatch?.groups === undefined ? null : minutesOf(timeMatch.groups)
  if (dayMatch?.groups === undefined) {
    if (minutes === null) {
      return null
    }
    return { day: minutes > nowMinutes ? today : addDays(today, 1), minutes }
  }

  const groups = dayMatch.groups
  let day: number
  if (groups.relative !== undefined) {
    day = addDays(today, RELATIVE[groups.relative.toLowerCase()] ?? 0)
  } else if (groups.weekday !== undefined) {
    const target = WEEKDAYS[groups.weekday.toLowerCase()] ?? 0
    const ahead = (target - weekdayOf(today) + 7) % 7
    day = addDays(today, ahead === 0 ? 7 : ahead)
  } else {
    const month = MONTHS[(groups.dateMonth ?? groups.monthFirst ?? '').toLowerCase()] ?? 1
    const date = Number(groups.dateDay ?? groups.monthFirstDay)
    const { year } = wallParts(today)
    day = wallOf({ year, month, day: date })
    if (day < today) {
      day = wallOf({ year: year + 1, month, day: date })
    }
    if (wallParts(day).day !== date) {
      return null
    }
  }

  return { day, minutes }
}
