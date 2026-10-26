import { describe, expect, it } from 'vitest'
import { proposedTime } from './proposedTime'
import { formatDate, toInstant, utc } from './zones'

const ZONE = 'Europe/Amsterdam'
// Monday 26 October 2026, 15:04 in Amsterdam.
const NOW = toInstant(utc(2026, 9, 26, 15, 4), ZONE)

function read(text: string): { date: string; time: string | null } | null {
  const found = proposedTime(text, NOW, ZONE)
  if (found === null) {
    return null
  }
  const time = found.minutes === null ? null : `${String(Math.floor(found.minutes / 60)).padStart(2, '0')}:${String(found.minutes % 60).padStart(2, '0')}`
  return { date: formatDate(found.day), time }
}

describe('proposedTime', () => {
  it('reads a weekday and a clock time, as the next such weekday', () => {
    expect(read('Lunch on Thursday? Hey Kim, lunch on Thursday at 12:30? The usual place.')).toEqual({ date: '2026-10-29', time: '12:30' })
  })

  it('takes the weekday of today as next week, not today', () => {
    expect(read('Catch up Monday at 10am')).toEqual({ date: '2026-11-02', time: '10:00' })
  })

  it('reads Dutch', () => {
    expect(read('Kunnen we morgen om 15.00 bellen?')).toEqual({ date: '2026-10-27', time: '15:00' })
    expect(read('Overleg volgende vrijdag 9u')).toEqual({ date: '2026-10-30', time: '09:00' })
    expect(read('Borrel op 3 november')).toEqual({ date: '2026-11-03', time: null })
  })

  it('reads dates either way round, in the coming year when the date has passed', () => {
    expect(read('Kick-off on March 4th at 2pm')).toEqual({ date: '2027-03-04', time: '14:00' })
    expect(read('Review 30 October, 4:30 pm')).toEqual({ date: '2026-10-30', time: '16:30' })
  })

  it('puts a time without a day today while it is ahead, otherwise tomorrow', () => {
    expect(read('Call at 17:00?')).toEqual({ date: '2026-10-26', time: '17:00' })
    expect(read('Call at 9:15?')).toEqual({ date: '2026-10-27', time: '09:15' })
  })

  it('finds nothing in mail that names no time, and ignores ordinary words and impossible dates', () => {
    expect(read('Could you review the attached budget?')).toBeNull()
    expect(read('We sat down and talked; you may join')).toBeNull()
    expect(read('Meet on 31 November')).toBeNull()
    expect(read('Room 4 at 25:00')).toBeNull()
  })
})
