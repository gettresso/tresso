import { describe, expect, it } from 'vitest'
import { RequestTimeoutError, SessionEndedDuringRequestError } from '@tresso/core'
import { canRetry, meetingActionError, meetingLinkCall } from '@/calendar/meetingActions'

describe('the meeting link actions', () => {
  it('ask again with POST and the app, and leave without a link with DELETE, on the series', () => {
    expect(meetingLinkCall('s/1', 'teams')).toEqual({ path: '/api/v1/calendar-events/s%2F1/meeting-link', method: 'POST', body: { provider: 'teams' } })
    expect(meetingLinkCall('s1', null)).toEqual({ path: '/api/v1/calendar-events/s1/meeting-link', method: 'DELETE', body: undefined })
  })

  it('retry only the apps the calendar provider makes', () => {
    expect(['meet', 'teams', 'zoom', 'other'].filter(canRetry)).toEqual(['meet', 'teams'])
  })

  it('explain a failure in plain words', () => {
    expect(meetingActionError(new RequestTimeoutError())).toBe('The server did not answer in time. Try again.')
    expect(meetingActionError(new SessionEndedDuringRequestError())).toBe('You were signed out. Sign in and try again.')
    expect(meetingActionError(new TypeError('Network request failed'))).toBe('No connection. Try again when you are online.')
    expect(meetingActionError(Object.assign(new Error('gone'), { status: 404 }))).toBe('This event is no longer in your calendar.')
    expect(meetingActionError(Object.assign(new Error('no'), { status: 403 }))).toBe('Only the organizer can change the meeting link.')
    expect(meetingActionError(Object.assign(new Error('Not for this calendar.'), { status: 422 }))).toBe('Not for this calendar.')
    expect(meetingActionError(Object.assign(new Error(''), { status: 422 }))).toBe('That did not work. Try again.')
    expect(meetingActionError(Object.assign(new Error('boom'), { status: 502 }))).toBe('The server could not do this now. Try again later.')
    expect(meetingActionError('odd')).toBe('That did not work. Try again.')
  })
})
