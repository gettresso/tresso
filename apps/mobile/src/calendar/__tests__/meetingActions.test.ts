import { describe, expect, it, vi } from 'vitest'
import { RequestTimeoutError, SessionEndedDuringRequestError } from '@tresso/core'
import { askForMeetingLink, canRetry, meetingActionError, meetingLinkCall, REFUSAL_MAX } from '@/calendar/meetingActions'

function status(code: number, message = 'x'): Error {
  return Object.assign(new Error(message), { name: 'ApiError', status: code })
}

describe('the meeting link actions', () => {
  it('ask again with POST and the app, on the series', () => {
    expect(meetingLinkCall('s/1', 'teams')).toEqual({ path: '/api/v1/calendar-events/s%2F1/meeting-link', method: 'POST', body: { provider: 'teams' } })
  })

  it('retry only the apps the calendar provider makes', () => {
    expect(['meet', 'teams', 'zoom', 'other'].filter(canRetry)).toEqual(['meet', 'teams'])
  })

  it('explain a failure in plain words', () => {
    expect(meetingActionError(new RequestTimeoutError())).toBe('The server did not answer in time. Try again.')
    expect(meetingActionError(new SessionEndedDuringRequestError())).toBe('You were signed out. Sign in and try again.')
    expect(meetingActionError(new TypeError('Network request failed'))).toBe('No connection. Try again when you are online.')
    expect(meetingActionError(status(401, 'Your session expired.'))).toBe('Your sign-in ended. Sign in again and try again.')
    expect(meetingActionError(status(403, 'Access Denied.'))).toBe('This sign-in may not change your calendar. Sign in again and allow calendar access.')
    expect(meetingActionError(status(404))).toBe('This event is no longer in your calendar.')
    expect(meetingActionError(status(502))).toBe('The server could not do this now. Try again later.')
    expect(meetingActionError('odd')).toBe('That did not work. Try again.')
  })

  it('give a 409 the general sentence, as the API has no 409 for this request', () => {
    expect(meetingActionError(status(409, 'Conflict'))).toBe('That did not work. Try again.')
  })

  it("show the server's own refusal as one line of plain text, cut at its limit", () => {
    expect(meetingActionError(status(422, 'Only the organizer can change the meeting link.'))).toBe('Only the organizer can change the meeting link.')
    expect(meetingActionError(status(422, '  This calendar\nis‮ read-only.​ '))).toBe('This calendar is read-only.')
    expect(meetingActionError(status(422, ' \n '))).toBe('That did not work. Try again.')
    const long = meetingActionError(status(422, 'a'.repeat(500)))
    expect(Array.from(long)).toHaveLength(REFUSAL_MAX)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe("the phone's Retry request (MailProvider.requestMeetingLink)", () => {
  it('sends the request, then syncs', async () => {
    const steps: string[] = []
    const api = vi.fn(async (path: string, init: RequestInit) => {
      steps.push(`${init.method} ${path} ${String(init.body)}`)
    })
    const sync = vi.fn(async () => {
      steps.push('sync')
    })

    await askForMeetingLink(api, sync, 's1', 'meet')

    expect(steps).toEqual(['POST /api/v1/calendar-events/s1/meeting-link {"provider":"meet"}', 'sync'])
    expect(api.mock.calls[0]?.[1].headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('fails without a sync when the request fails', async () => {
    const sync = vi.fn(async () => {})
    await expect(askForMeetingLink(() => Promise.reject(status(422, 'This calendar is read-only.')), sync, 's1', 'teams')).rejects.toThrow('This calendar is read-only.')
    expect(sync).not.toHaveBeenCalled()
  })

  it('succeeds when the server took the request and only the sync after it failed', async () => {
    const api = vi.fn(async () => ({}))
    const sync = vi.fn(() => Promise.reject(new Error('offline')))

    await expect(askForMeetingLink(api, sync, 's1', 'teams')).resolves.toBeUndefined()
    expect(sync).toHaveBeenCalledOnce()
  })
})
