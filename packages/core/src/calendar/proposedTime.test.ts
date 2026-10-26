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

  it('reads only the email itself, not the reply it quotes', () => {
    expect(read('Sounds good, see you then. On Fri, 23 Oct 2026 at 09:12, Piet wrote: lunch on Thursday at 12:30?')).toBeNull()
    expect(read('Prima! Op vr 23 okt. 2026 om 09:12 schreef Piet: zullen we donderdag?')).toBeNull()
    expect(read('Friday works.\n> Can we meet Thursday at 10:00?')).toEqual({ date: '2026-10-30', time: null })
  })

  it('takes a date with a year as given, and proposes nothing for one gone by', () => {
    expect(read('The deadline was 3 March 2025')).toBeNull()
    expect(read('Launch on 12 January 2027 at 9:00')).toEqual({ date: '2027-01-12', time: '09:00' })
  })

  it('reads no date from a signature name above a phone number', () => {
    expect(read('Met vriendelijke groet,\nJan\n06 12345678')).toBeNull()
    expect(read('Groet, June 06-1234')).toBeNull()
  })

  it('reads no time from prices, versions, addresses or counts', () => {
    for (const text of ['That is 12.50 euro', 'Update to version 2.10', 'IP 10.0.1.10', 'Tel. 020 12.34.56', 'Look at 3 options', 'Kijk om 3 redenen', 'We have 3 Amsterdam offices']) {
      expect(read(text), text).toBeNull()
    }
  })

  it('puts a bare hour after at in the afternoon', () => {
    expect(read('Meet at 4.')).toEqual({ date: '2026-10-26', time: '16:00' })
    expect(read('Bellen om 9 uur?')).toEqual({ date: '2026-10-27', time: '09:00' })
  })

  it('prefers a named day over tomorrow, and a greeting is no tomorrow', () => {
    expect(read('Goede morgen allemaal, kun je vrijdag?')).toEqual({ date: '2026-10-30', time: null })
    expect(read('Morgen lukt niet, wel donderdag om 14:00')).toEqual({ date: '2026-10-29', time: '14:00' })
  })

  it('finds the next leap day for 29 February', () => {
    expect(read('Lunch 29 feb')).toEqual({ date: '2028-02-29', time: null })
  })

  it('cuts a quote only at its header, not at a sentence that says someone wrote something', () => {
    expect(read('Can we meet on Friday at 14:00? Jan wrote the agenda already.')).toEqual({ date: '2026-10-30', time: '14:00' })
    expect(read('Zullen we op vrijdag om 14:00 afspreken? Piet schreef al een opzet.')).toEqual({ date: '2026-10-30', time: '14:00' })
  })

  it('reads Dutch hours the way business mail means them', () => {
    expect(read('Om 4 uur bij mij?')).toEqual({ date: '2026-10-26', time: '16:00' })
    expect(read('Morgen 15u?')).toEqual({ date: '2026-10-27', time: '15:00' })
    expect(read('Ik stuur 2 u toe')).toBeNull()
  })

  it('keeps a bare hour that a day follows, and a weekday gone by proposes nothing', () => {
    expect(read('Meet at 4 tomorrow')).toEqual({ date: '2026-10-27', time: '16:00' })
    expect(read('Kun je om 10 morgen?')).toEqual({ date: '2026-10-27', time: '10:00' })
    expect(read('As discussed last Monday')).toBeNull()
  })
})
