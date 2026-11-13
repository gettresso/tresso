/**
 * Wire format of the calendar assistant interfaces: /api/v1/calendar/capabilities,
 * /api/v1/calendar/scheduling-preferences, /api/v1/calendar/meeting-times, /api/v1/calendar/event-drafts
 * and /api/v1/messages/{id}/event-suggestions, and helpers. The brief (/api/v1/calendar-events/{id}/brief) is in
 * notifications.
 */

import type { AttendeeRole, EventTime } from './types'

/** Which assistant features the server offers; clients show only these. */
export interface CalendarCapabilities {
  eventDrafts: boolean
  meetingTimes: boolean
  attendeeAvailability: boolean
  eventSuggestions: boolean
  textSuggestions: boolean
  meetingBriefs: boolean
  briefSummaries: boolean
  /**
   * The server drops a requested meeting link without touching a link (DELETE .../meeting-link/request). Servers from
   * before it lack the field: no "Leave without a link" then.
   */
  meetingRequestDrop?: boolean
}

/**
 * What the meeting time finder keeps free besides the working hours and zone of the notification settings: a buffer
 * on both sides of busy time, travel time to busy time at a place that names none, and the notice the user needs.
 */
export interface SchedulingPreferences {
  bufferMinutes: number
  travelMinutes: number
  minimumNoticeMinutes: number
  /** Open todos with a due date and a duration get free time before it on their own. */
  planTodos: boolean
}

/** JSON merge patch: omitted fields stay as they are. */
export type SchedulingPreferencesUpdate = Partial<SchedulingPreferences>

export interface MeetingTimesRequest {
  /** RFC 3339; the window is at most 92 days. */
  from: string
  to: string
  durationMinutes: number
  attendees?: Array<{ address: string; optional?: boolean }>
  stepMinutes?: 5 | 10 | 15 | 20 | 30 | 60
  limit?: number
  perDay?: number | null
  inPerson?: boolean
  workingHoursOnly?: boolean
  /** null or omitted: the visible calendars. */
  calendarIds?: string[] | null
  /** Event ids, or occurrence ids (`eventId:recurrenceId`), to treat as free: the meeting being moved. */
  ignore?: string[]
  /** The zone of working hours and all-day events; the one in the notification settings when omitted. */
  timeZone?: string | null
}

export type SlotEdgeReason =
  | 'window'
  | 'notice'
  | 'working_hours'
  | 'focus'
  | 'busy'
  | 'buffer'
  | 'travel'
  | 'attendee'

/** One side of a slot's free time and what closes it there. */
export interface SlotEdge {
  at: string
  reason: SlotEdgeReason
  /** The busy time's or focus block's title, or the attendee's address; '' when there is nothing to name. */
  label: string
}

export interface ProposedSlot {
  start: string
  end: string
  freeFrom: SlotEdge
  freeUntil: SlotEdge
  /** Optional attendees who are busy then. */
  optionalConflicts: string[]
}

export type NoSlotReason = 'window_passed' | 'no_working_hours' | 'no_free_time'

export interface MeetingTimes {
  /** Best first. */
  slots: ProposedSlot[]
  noSlotReason: NoSlotReason | null
  timeZone: string
  attendees: Array<{ address: string; availability: 'known' | 'unknown' }>
}

/** An unsaved event in the editor's shape. */
export interface EventDraft {
  summary: string
  description: string
  location: string
  start: EventTime
  end: EventTime
  recurrence: string | null
  attendees: Array<{ address: string; name: string | null; role: AttendeeRole }>
  conferenceUrl: string | null
}

export interface EventSuggestions {
  id: string
  events: Array<{
    draft: EventDraft
    source: 'calendar_part' | 'text'
    uid: string | null
    /** The event in the user's calendar: offer to open it rather than add it. */
    eventId: string | null
  }>
  deadlines: Array<{ title: string; dueAt: string }>
}

/**
 * Why a slot's free time begins or ends where it does, in a few words: "after Standup", "before the buffer of
 * Lunch", "working hours end". `side` is `from` for `freeFrom`, `until` for `freeUntil`.
 */
export function describeSlotEdge(edge: SlotEdge, side: 'from' | 'until'): string {
  const of = (what: string) => (edge.label === '' ? what : `${what} of ${edge.label}`)
  const relative = (what: string) => `${side === 'from' ? 'after' : 'before'} ${what}`
  switch (edge.reason) {
    case 'window':
      return side === 'from' ? 'start of the search' : 'end of the search'
    case 'notice':
      return 'your minimum notice'
    case 'working_hours':
      return side === 'from' ? 'working hours start' : 'working hours end'
    case 'focus':
      return relative(edge.label === '' ? 'focus time' : edge.label)
    case 'busy':
      return relative(edge.label === '' ? 'busy time' : edge.label)
    case 'buffer':
      return relative(of('the buffer'))
    case 'travel':
      return relative(of('travel time'))
    case 'attendee':
      return `${edge.label} is busy`
  }
}
