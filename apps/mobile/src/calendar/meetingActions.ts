import { RequestTimeoutError, SessionEndedDuringRequestError } from '@tresso/core'

/** The apps the API asks a calendar's provider for again (POST /api/v1/calendar-events/{id}/meeting-link). */
export type RetryProvider = 'meet' | 'teams'

/** Whether Retry can ask for this app again: only Meet and Teams are made by the calendar's provider in V1. */
export function canRetry(provider: string): provider is RetryProvider {
  return provider === 'meet' || provider === 'teams'
}

/** The longest refusal of the server shown as it is; a longer one is cut with an ellipsis. */
export const REFUSAL_MAX = 200

/**
 * The server's own sentence for a refusal (422: "This calendar is read-only.", "Only the organizer ..."), as one line of
 * plain text: line breaks and runs of spaces become one space, characters that show nothing are dropped, and it is cut
 * at {@link REFUSAL_MAX} characters.
 */
function refusal(message: string): string {
  const plain = Array.from(
    message
      .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  return plain.length <= REFUSAL_MAX ? plain.join('') : `${plain.slice(0, REFUSAL_MAX - 1).join('')}\u2026`
}

/**
 * Why Retry did not go through, in plain words. Never the link: the server's answers to this request carry none.
 * The API answers this request with 404 (not the user's event), 422 (refused, with its own sentence), 403 (the
 * sign-in lacks a permission the change needs: calendar write access, or sending mail for the invitations), 401 (the sign-in ended) or a server error; it has no 409 for it.
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
  if (status === 401) {
    return 'Your sign-in ended. Sign in again and try again.'
  }
  if (status === 403) {
    return 'This sign-in is not allowed to make this change. Sign in again and allow the access Tresso asks for.'
  }
  if (status === 404) {
    return 'This event is no longer in your calendar.'
  }
  if (status === 422 && error instanceof Error) {
    const text = refusal(error.message)
    if (text !== '') {
      return text
    }
  }
  if (status !== null && status >= 500) {
    return 'The server could not do this now. Try again later.'
  }
  return 'That did not work. Try again.'
}

/**
 * The API call behind Retry: POST with the app, on the series' id (it acts on the whole series). The server keeps its
 * own nonce for the request, so the client sends only the app.
 */
export function meetingLinkCall(seriesId: string, provider: RetryProvider): { path: string; method: 'POST'; body: { provider: RetryProvider } } {
  return { path: `/api/v1/calendar-events/${encodeURIComponent(seriesId)}/meeting-link`, method: 'POST', body: { provider } }
}

/**
 * Retry as the phone's mail provider runs it: the request, then a sync so the copy shows the new state ("Making the
 * ... link"). A failing request rejects (the screen says why). A sync that fails after the server took the request
 * does not: the request went through, and the session keeps and shows its own sync error (its syncNow records it).
 */
export async function askForMeetingLink(
  api: (path: string, init: RequestInit) => Promise<unknown>,
  syncNow: () => Promise<void>,
  seriesId: string,
  provider: RetryProvider,
): Promise<void> {
  const call = meetingLinkCall(seriesId, provider)
  await api(call.path, { method: call.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(call.body) })
  try {
    await syncNow()
  } catch {
    // The sync's failure is the session's to show (its sync state); the request itself was taken.
  }
}
