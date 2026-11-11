import { describe, expect, it } from 'vitest'
import { attendeeSummary, isoWeek, occurrenceTimes, relativeDay } from './format'
import { calendarEvent } from '../store/contract'
import { expandOccurrences } from './occurrences'
import { describeRule, endOf, presetLabel, presetOf, presetRule, sameRule, withEnd } from './rules'

// Thursday 22 October 2026, the fourth Thursday of the month.
const thursday = Date.UTC(2026, 9, 22, 10)

describe('repeat presets', () => {
  it('writes and recognizes each preset for its start', () => {
    for (const preset of ['daily', 'weekdays', 'weekly', 'biweekly', 'monthlyByDay', 'monthlyByDate', 'yearly'] as const) {
      expect(presetOf(presetRule(preset, thursday), thursday)).toBe(preset)
    }
    expect(presetRule('monthlyByDay', thursday)).toBe('FREQ=MONTHLY;BYDAY=4TH')
    expect(presetRule('monthlyByDay', Date.UTC(2026, 9, 29))).toBe('FREQ=MONTHLY;BYDAY=-1TH')
    expect(presetOf('FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231T225959Z', thursday)).toBe('weekly')
    expect(presetOf('FREQ=WEEKLY;BYDAY=MO,TH', thursday)).toBe('custom')
    expect(presetOf(null, thursday)).toBe('none')
  })

  it('names presets the way the Repeat menu does', () => {
    expect(presetLabel('monthlyByDay', thursday)).toBe('Monthly on the fourth Thursday')
    expect(presetLabel('biweekly', thursday)).toBe('Every other week on Thursday')
  })

  it('ends a timed series at the end of its last day in its zone, in UTC', () => {
    expect(withEnd('FREQ=WEEKLY;BYDAY=TH', { kind: 'until', date: '2026-12-31' }, false, 'Europe/Amsterdam')).toBe('FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231T225959Z')
    expect(withEnd('FREQ=DAILY', { kind: 'until', date: '2026-12-31' }, true, null)).toBe('FREQ=DAILY;UNTIL=20261231')
    expect(withEnd('FREQ=DAILY', { kind: 'until', date: '2026-12-31' }, false, null)).toBe('FREQ=DAILY;UNTIL=20261231T235959')
    expect(withEnd('FREQ=DAILY;UNTIL=20261231', { kind: 'count', count: 4 }, true, null)).toBe('FREQ=DAILY;COUNT=4')
    expect(endOf('FREQ=DAILY;UNTIL=20261231T225959Z')).toEqual({ kind: 'until', date: '2026-12-31' })
  })

  it("reads the end of a timed series back on the date it falls on in the series' zone", () => {
    for (const zone of ['America/New_York', 'Asia/Tokyo', 'Europe/Amsterdam']) {
      const rule = withEnd('FREQ=DAILY', { kind: 'until', date: '2026-12-31' }, false, zone)
      expect(endOf(rule, zone)).toEqual({ kind: 'until', date: '2026-12-31' })
    }
    expect(withEnd('FREQ=DAILY', { kind: 'until', date: '2026-12-31' }, false, 'America/New_York')).toBe('FREQ=DAILY;UNTIL=20270101T045959Z')
    // Another app's UNTIL: the start of the last occurrence, 08:00 in Tokyo on 31 December.
    expect(endOf('FREQ=DAILY;UNTIL=20261230T230000Z', 'Asia/Tokyo')).toEqual({ kind: 'until', date: '2026-12-31' })
    expect(describeRule('FREQ=DAILY;UNTIL=20270101T045959Z', 'America/New_York')).toBe('Every day, until 31 December 2026')
    // Dates, floating times and an unknown zone are read as written.
    expect(endOf('FREQ=DAILY;UNTIL=20261231', 'Asia/Tokyo')).toEqual({ kind: 'until', date: '2026-12-31' })
    expect(endOf('FREQ=DAILY;UNTIL=20261231T235959', 'Asia/Tokyo')).toEqual({ kind: 'until', date: '2026-12-31' })
    expect(endOf('FREQ=DAILY;UNTIL=20261231T225959Z', 'Nowhere/Invalid')).toEqual({ kind: 'until', date: '2026-12-31' })
  })

  it('compares rules the way the server does', () => {
    expect(sameRule('FREQ=WEEKLY;BYDAY=MO;INTERVAL=2', ' freq=weekly;interval=2;byday=MO ')).toBe(true)
    // The server tells these apart, so the editor does too.
    expect(sameRule('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=MO')).toBe(false)
    expect(sameRule('FREQ=WEEKLY;BYDAY=TH,MO', 'FREQ=WEEKLY;BYDAY=MO,TH')).toBe(false)
    expect(sameRule('FREQ=WEEKLY;UNTIL=20261231T080000Z', 'FREQ=WEEKLY;UNTIL=20261231T225959Z')).toBe(false)
    expect(sameRule(null, null)).toBe(true)
    expect(sameRule(null, '')).toBe(true)
    expect(sameRule(null, 'FREQ=DAILY')).toBe(false)
  })

  it('describes any rule in a sentence', () => {
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T225959Z')).toBe('Every week on Monday and Wednesday, until 31 December 2026')
    expect(describeRule('FREQ=MONTHLY;BYDAY=-1FR;COUNT=3')).toBe('Every month on the last Friday, 3 times')
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Every weekday')
  })
})

describe('display', () => {
  it('writes times as "10:00 to 11:00" in the reader zone', () => {
    const [meeting] = expandOccurrences([calendarEvent('m', 'cal')], Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1), 'Europe/Amsterdam')
    expect(occurrenceTimes(meeting!, 'Europe/Amsterdam')).toBe('10:00 to 11:00')
    expect(occurrenceTimes(meeting!, 'Europe/London')).toBe('09:00 to 10:00')
    const [trip] = expandOccurrences([calendarEvent('t', 'cal', { allDay: true, start: { date: '2026-10-21' }, end: { date: '2026-10-24' } })], Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1), 'Europe/Amsterdam')
    expect(occurrenceTimes(trip!, 'Europe/Amsterdam')).toBe('Wed 21 Oct to Fri 23 Oct')
  })

  it('names days relative to today and counts ISO weeks', () => {
    const today = Date.UTC(2026, 9, 20, 10, 24)
    expect(relativeDay(Date.UTC(2026, 9, 21, 9), today)).toBe('Tomorrow')
    expect(relativeDay(Date.UTC(2026, 9, 23), today)).toBe('Friday 23 October')
    expect(relativeDay(Date.UTC(2027, 0, 1), today)).toBe('Friday 1 January 2027')
    expect(isoWeek(today)).toBe(43)
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe(53)
  })

  it('sums up who is coming', () => {
    expect(attendeeSummary(['accepted', 'accepted', 'tentative', 'needs-action', 'needs-action'])).toBe('5 people: 2 going, 1 maybe, 2 no reply')
  })
})
