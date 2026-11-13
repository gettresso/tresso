import type { CalendarCapabilities } from '@tresso/core'

/**
 * What this server offers for the calendar (GET /api/v1/calendar/capabilities), read once per signed-in user and
 * forgotten at sign-out or when another user signs in. The phone reads one field: `meetingRequestDrop`, whether the
 * server has DELETE /api/v1/calendar-events/{id}/meeting-link/request ("Leave without a link"). Without it the phone
 * offers no Leave: an older server has only the DELETE that also removes a link. A failed read offers nothing and is
 * not kept, so the next screen asks again.
 */
export class CalendarCapabilityCache {
  private userId: string | null = null
  private dropRead: Promise<boolean> | null = null

  constructor(private readonly read: () => Promise<unknown>) {}

  /** Whether "Leave without a link" may be offered to this user; false while signed out or when the read fails. */
  meetingRequestDrop(userId: string | null): Promise<boolean> {
    if (userId === null) {
      this.clear()
      return Promise.resolve(false)
    }
    if (userId !== this.userId) {
      this.clear()
      this.userId = userId
    }
    if (this.dropRead === null) {
      const reading: Promise<boolean> = this.read().then(
        (body) => typeof body === 'object' && body !== null && (body as Partial<CalendarCapabilities>).meetingRequestDrop === true,
        () => {
          if (this.dropRead === reading) {
            this.dropRead = null
          }
          return false
        },
      )
      this.dropRead = reading
    }
    return this.dropRead
  }

  /** Forgets what was read (sign-out). */
  clear(): void {
    this.userId = null
    this.dropRead = null
  }
}
