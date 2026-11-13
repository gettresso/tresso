import { describe, expect, it } from 'vitest'
import { meetingLine } from '@/calendar/meetingLine'

const invited = { selfResponse: 'accepted' as const }
const organizer = { selfResponse: null }

describe('the line under a meeting link', () => {
  it('names who the link is from and the place on an invitation', () => {
    expect(meetingLine(invited, 'Sanne Peters', 'Room 3.2, Herengracht office')).toBe('Link from Sanne Peters. Or Room 3.2, Herengracht office')
  })

  it('names only who the link is from on an invitation without a place', () => {
    expect(meetingLine(invited, 'Sanne Peters', '')).toBe('Link from Sanne Peters.')
  })

  it('names only the place when the user organizes', () => {
    expect(meetingLine(organizer, 'Kim Visser', 'Room 3.2')).toBe('Or Room 3.2')
  })

  it('says nothing when the user organizes and there is no place', () => {
    expect(meetingLine(organizer, 'Kim Visser', '')).toBeNull()
  })

  it('names nobody on an invitation without a known organizer', () => {
    expect(meetingLine({ selfResponse: 'needs-action' }, null, 'Room 3.2')).toBe('Or Room 3.2')
    expect(meetingLine({ selfResponse: 'needs-action' }, '  ', '')).toBeNull()
  })

  it('takes a place of only spaces as no place', () => {
    expect(meetingLine(invited, 'Sanne Peters', '   ')).toBe('Link from Sanne Peters.')
  })
})
