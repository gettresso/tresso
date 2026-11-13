import { RequestTimeoutError, SessionEndedDuringRequestError } from '@tresso/core'

/** The apps the API asks a calendar's provider for again (POST /api/v1/calendar-events/{id}/meeting-link). */
export type RetryProvider = 'meet' | 'teams'

/** Whether Retry can ask for this app again: only Meet and Teams are made by the calendar's provider in V1. */
export function canRetry(provider: string): provider is RetryProvider {
  return provider === 'meet' || provider === 'teams'
}

/**
 * Why Retry or "Leave without a link" did not go through, in plain words. Never the link: the server's answers to
 * these two requests carry none, and a refusal's own sentence (422) is shown as the API words it.
 */
export function meetingActionError(error: unknown): string {
  if (error instanceof RequestTimeoutError) {
    return 'The server did not answer in time. Try again.'
  }
  if (error instanceof SessionEndedDuringRequestError) {
    return 'You were signed out. Sign in and try again.'
  }
  // fetch rejects with a TypeError when there is no connection at all.
  if (error instanceof TypeError) {
    return 'No connection. Try again when you are online.'
  }
  const status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : null
  if (status === 404) {
    return 'This event is no longer in your calendar.'
  }
  if (status === 403) {
    return 'Only the organizer can change the meeting link.'
  }
  if (status === 422 && error instanceof Error && error.message.trim() !== '') {
    return error.message
  }
  if (status !== null && status >= 500) {
    return 'The server could not do this now. Try again later.'
  }
  return 'That did not work. Try again.'
}

/**
 * The API call behind Retry (a provider: POST with it) and "Leave without a link" (null: DELETE), on the series' id.
 * Both act on the whole series; the server keeps its own nonce for the request, so the client sends only the app.
 */
export function meetingLinkCall(seriesId: string, provider: RetryProvider | null): { path: string; method: 'POST' | 'DELETE'; body: { provider: RetryProvider } | undefined } {
  const path = `/api/v1/calendar-events/${encodeURIComponent(seriesId)}/meeting-link`
  return provider === null ? { path, method: 'DELETE', body: undefined } : { path, method: 'POST', body: { provider } }
}
