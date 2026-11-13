/** Wire format of calendars and events: in the delta, and from /api/v1/calendars and /api/v1/calendar-events. */

import type { NotificationChannel } from '../notifications'
import type { Address } from '../sync/types'

export type CalendarSource = 'local' | 'caldav' | 'google' | 'microsoft'

/** Online meetings a calendar's provider makes for its events. */
export type ConferenceProvider = 'meet' | 'teams'

/** A calendar of the user: at the provider of a mail account, or local to Tresso (`mailAccountId` null). */
export interface SyncedCalendar {
  id: string
  mailAccountId: string | null
  source: CalendarSource
  name: string
  /** The user's color when they chose one, else the provider's. */
  color: string
  timeZone: string | null
  writable: boolean
  isDefault: boolean
  visible: boolean
  /** A work calendar: its notifications keep to the user's working hours. */
  work: boolean
  /** The provider sends invitations and replies itself. */
  providerSchedules: boolean
  /** Online meetings events of this calendar can get; ask for one with `conferenceProvider` when saving an event. */
  conferenceProviders: ConferenceProvider[]
  position: number
}

/** A date for all-day events; a wall-clock time with its IANA zone otherwise (null zone: floating). */
export type EventTime = { date: string } | { dateTime: string; timeZone: string | null }

export type EventStatus = 'confirmed' | 'tentative' | 'cancelled'
export type ParticipationStatus = 'needs-action' | 'accepted' | 'declined' | 'tentative' | 'delegated'
export type AttendeeRole = 'required' | 'optional' | 'chair' | 'non-participant'

export interface Attendee {
  address: string
  name: string | null
  role: AttendeeRole
  partstat: ParticipationStatus
  rsvp: boolean
  kind: 'individual' | 'group' | 'resource' | 'room' | 'unknown'
}

export interface Reminder {
  action: string
  /** An iCalendar duration relative to `relatedTo` (-PT15M), or null for an absolute reminder. */
  trigger: string | null
  relatedTo: 'start' | 'end'
  /** The absolute time (YYYYMMDDTHHMMSSZ), or null. */
  at: string | null
  channels: NotificationChannel[]
}

export interface Conference {
  provider: 'teams' | 'meet' | 'zoom' | 'webex' | 'other'
  url: string
  id: string | null
  dialIn: string | null
  /**
   * Whether the API takes this link off the event: false for a Teams meeting Microsoft made on a Microsoft 365 event.
   * Rows stored before the server sent it lack it; `meetingRemovable` (meeting.ts) falls back to core's own rule then.
   */
  removable?: boolean
}

/** A meeting link that was asked for and is not on the event (yet). Master rows only. */
export interface ConferenceRequest {
  provider: 'meet' | 'teams' | 'zoom'
  /** `pending`: the write is on its way or the provider is still making the meeting. */
  status: 'pending' | 'failed'
  /** Only with `failed`; a code, never the provider's words. */
  reason: 'refused' | 'not_supported' | 'unreachable' | null
  requestedAt: string
}

/**
 * An event as stored: a single event, the master of a series (`recurrence`, `rdates`, `exdates`), or the override of
 * one occurrence (`recurrenceId`). Recurrence ids are YYYYMMDD for all-day series, YYYYMMDDTHHMMSSZ otherwise.
 */
export interface SyncedCalendarEvent {
  id: string
  calendarId: string
  uid: string
  recurrenceId: string | null
  sequence: number
  status: EventStatus
  summary: string
  description: string
  location: string
  url: string | null
  transparency: 'busy' | 'free'
  visibility: 'public' | 'private' | 'confidential'
  allDay: boolean
  start: EventTime
  /** Exclusive for all-day events. */
  end: EventTime
  recurrence: string | null
  rdates: string[]
  exdates: string[]
  organizer: Address | null
  attendees: Attendee[]
  /** The user's own response when invited; null when they organize or nobody is invited. */
  selfResponse: ParticipationStatus | null
  reminders: Reminder[]
  conference: Conference | null
  /** A link asked for and not made yet, on the series' master only. Missing on rows stored before it existed. */
  conferenceRequest?: ConferenceRequest | null
  /** The invitation this event came from. */
  messageId: string | null
  /** Why the last change did not reach the provider. */
  syncError: string | null
  /** Minutes to travel there, set by the user. */
  travelMinutes: number | null
  /** No reminders of its own: the user's default rules apply. */
  defaultReminders: boolean
  /** Its reminders reach the user also in quiet and outside working hours. */
  important: boolean
  /**
   * An override with RANGE=THISANDFUTURE (RFC 5545 3.8.4.4): it changes every later occurrence too, moved as far as
   * it moves its own. Always false on series and single events.
   */
  thisAndFuture: boolean
}
