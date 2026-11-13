import type { SyncedCalendarEvent } from '@tresso/core'

/**
 * The line under an event's meeting link on the phone: who the link is from when someone else organizes the event,
 * and the place as the other way to meet. "Link from Sanne Peters. Or Room 3.2", "Link from Sanne Peters.",
 * "Or Room 3.2"; null when there is nothing to say (the user organizes and there is no place).
 *
 * The user organizes the event when `selfResponse` is null. An invitation without a known organizer names nobody.
 */
export function meetingLine(event: Pick<SyncedCalendarEvent, 'selfResponse'>, organizerName: string | null, location: string): string | null {
  const place = location.trim()
  const name = organizerName?.trim() ?? ''
  const from = event.selfResponse !== null && name !== '' ? `Link from ${name}.` : null
  if (from !== null && place !== '') {
    return `${from} Or ${place}`
  }
  if (from !== null) {
    return from
  }
  return place !== '' ? `Or ${place}` : null
}
