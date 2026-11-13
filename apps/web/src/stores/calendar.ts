import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  addDays,
  addMonths,
  daysFrom,
  defaultCalendar,
  deleteRequest,
  readerTimeZone,
  copyStart,
  expandOccurrences,
  expandRange,
  occurrenceFromServer,
  saveRequest,
  startOfMonth,
  startOfWallDay,
  startOfWeek,
  todoBlocks as plannedTodoBlocks,
  toWall,
  type CalendarCapabilities,
  type CalendarDay,
  type ConferenceProvider,
  type EditScope,
  type EventInput,
  type MeetingApp,
  type Occurrence,
  type ServerOccurrence,
  type SyncedCalendar,
  type SyncedCalendarEvent,
} from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { useAuthStore } from '@/stores/auth'
import { useMailStore } from '@/stores/mail'
import type { EditorTarget } from '@/components/calendar/EventEditor.vue'
import type { EventValues } from '@/forms/calendarEvent'

export type CalendarViewKind = 'day' | 'week' | 'month' | 'agenda'

/**
 * An event being written that the user left for Settings (to connect a meeting app): what the editor opened on, its
 * values and the meeting link row's choice, to reopen it with "Back to the event". Kept in memory only.
 */
export interface KeptEditor {
  target: EditorTarget
  values: EventValues
  link: { on: boolean; app: MeetingApp | null; touched: boolean; removed: boolean }
  notify: boolean
}

/** How many days the agenda lists from its first day. */
export const AGENDA_DAYS = 30

/** The invitation a message carries, as GET /api/v1/messages/{id}/invitation answers. */
export interface MessageInvitation {
  id: string
  method: string
  kind: 'new' | 'update' | 'cancelled' | 'reply' | 'outdated'
  uid: string
  recurrenceId: string | null
  sequence: number
  summary: string
  description: string
  location: string
  allDay: boolean
  start: SyncedCalendarEvent['start']
  end: SyncedCalendarEvent['end']
  recurrence: string | null
  organizer: SyncedCalendarEvent['organizer']
  attendees: SyncedCalendarEvent['attendees']
  conference: SyncedCalendarEvent['conference']
  eventId: string | null
  selfResponse: SyncedCalendarEvent['selfResponse']
  canRespond: boolean
  conflicts: InvitationConflict[]
  canApply: boolean
  /** It would change the event, but the provider did not confirm it comes from its sender, so it waits for the user. */
  senderUnconfirmed?: boolean
}

/** An occurrence that overlaps an invitation, as the API lists it. */
export interface InvitationConflict {
  id: string
  eventId: string
  summary: string
  allDay: boolean
  start: { date: string } | { dateTime: string }
  end: { date: string } | { dateTime: string }
  selfResponse: SyncedCalendarEvent['selfResponse']
}

export type Response = 'accepted' | 'tentative' | 'declined'

/** An instant as the occurrences endpoint takes it (2026-10-01T00:00:00+00:00). */
function atom(instant: number): string {
  return `${new Date(instant).toISOString().slice(0, 19)}+00:00`
}

/**
 * The calendar views' state: which days are shown, in which zone, and the occurrences in them, expanded on the device
 * from the synced copy so moving between weeks needs no request. Changes go through the API; the delta brings them
 * back into the copy.
 */
export const useCalendarStore = defineStore('calendar', () => {
  const auth = useAuthStore()
  const mail = useMailStore()

  const zone = ref(readerTimeZone())
  const view = ref<CalendarViewKind>('week')
  /** The day the view is about, as a wall date in {@link zone}. */
  const anchor = ref(startOfWallDay(toWall(Date.now(), zone.value)))
  /** The instant the views treat as now; the views move it on every minute. */
  const now = ref(Date.now())
  const loaded = shallowRef<Occurrence[]>([])
  /** Rows of the range on screen, for finding a series and its overrides. */
  const rows = shallowRef<SyncedCalendarEvent[]>([])
  const loading = ref(false)

  const calendars = computed(() => mail.calendars)
  const calendarsById = computed(() => new Map(calendars.value.map((calendar) => [calendar.id, calendar])))
  const visibleCalendarIds = computed(() => new Set(calendars.value.filter((calendar) => calendar.visible).map((calendar) => calendar.id)))
  const today = computed(() => startOfWallDay(toWall(now.value, zone.value)))

  /** The days the current view covers. */
  const days = computed<CalendarDay[]>(() => {
    switch (view.value) {
      case 'day':
        return daysFrom(anchor.value, 1, zone.value)
      case 'week':
        return daysFrom(startOfWeek(anchor.value), 7, zone.value)
      case 'month': {
        // Whole weeks around the month: 5 or 6 rows.
        const first = startOfWeek(startOfMonth(anchor.value))
        const last = startOfWeek(addMonths(startOfMonth(anchor.value), 1) - 1) + 7 * 86_400_000
        return daysFrom(first, Math.round((last - first) / 86_400_000), zone.value)
      }
      case 'agenda':
        return daysFrom(anchor.value, AGENDA_DAYS, zone.value)
    }
    return []
  })

  /** Occurrences on visible calendars; cancelled ones and ones the user declined are left out. */
  const occurrences = computed(() =>
    loaded.value.filter((occurrence) => visibleCalendarIds.value.has(occurrence.event.calendarId) && occurrence.event.status !== 'cancelled' && occurrence.event.selfResponse !== 'declined'),
  )

  /** Time planned for open todos on the days on screen; Tresso keeps it, in no calendar. */
  const todoBlocks = computed(() => {
    const range = days.value
    return range.length === 0 ? [] : plannedTodoBlocks(mail.todos, range[0]!.start, range[range.length - 1]!.end)
  })

  /** Invitations still waiting for the user's answer, from now on. */
  const unanswered = computed(() => occurrences.value.filter((occurrence) => occurrence.event.selfResponse === 'needs-action' && occurrence.end > now.value))

  /** Series too long to walk through here, and history the server could not give; shown above the view. */
  const notice = ref<string | null>(null)

  let reading = 0
  async function load(): Promise<void> {
    const database = mail.currentStore()
    const range = days.value
    if (database === null || range.length === 0) {
      loaded.value = []
      return
    }
    const mine = ++reading
    loading.value = true
    try {
      const from = range[0]!.start
      const to = range[range.length - 1]!.end
      const events = await database.calendarEvents(from, to)
      const expanded = expandRange(events, from, to, zone.value)
      let occurrences = expanded.occurrences
      const notes: string[] = []
      if (expanded.truncated.length > 0) {
        notes.push('Some repeating events have too many occurrences to show them all here.')
      }
      // Older than the copy on this device: the server reads that part.
      const older = copyStart(Date.now())
      if (from < older) {
        try {
          const history = await serverOccurrences(from, Math.min(to, older))
          const shown = new Set(occurrences.map(sameOccurrence))
          occurrences = [...occurrences, ...history.filter((occurrence) => !shown.has(sameOccurrence(occurrence)))].sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))
        } catch (error) {
          notes.push(`Events from before ${new Date(older).getUTCFullYear()} could not be loaded: ${errorMessage(error)}`)
        }
      }
      if (mine !== reading) {
        return
      }
      rows.value = events
      loaded.value = occurrences
      notice.value = notes.length === 0 ? null : notes.join(' ')
    } finally {
      if (mine === reading) {
        loading.value = false
      }
    }
  }

  /** The same occurrence whether the device or the server read it. */
  function sameOccurrence(occurrence: Occurrence): string {
    return `${occurrence.event.calendarId}:${occurrence.recurrenceId ?? occurrence.event.id}:${occurrence.start}`
  }

  /** Occurrences the server reads for a range, in steps the endpoint takes (at most 400 days). */
  async function serverOccurrences(from: number, to: number): Promise<Occurrence[]> {
    const step = 365 * 86_400_000
    const occurrences: Occurrence[] = []
    for (let start = from; start < to; start += step) {
      const query = new URLSearchParams({ from: atom(start), to: atom(Math.min(to, start + step)), timeZone: zone.value })
      const answer = await auth.api<ServerOccurrence[]>(`/api/v1/calendar-occurrences?${query.toString()}`)
      occurrences.push(...answer.map((occurrence) => occurrenceFromServer(occurrence, zone.value)))
    }
    return occurrences
  }

  /**
   * The occurrence with its full event, for the detail and the editor: an occurrence the server read has only what
   * the range endpoint gives. Its series is used when the event is one; an override read alone is edited by itself.
   */
  async function complete(occurrence: Occurrence): Promise<Occurrence> {
    if (!occurrence.fromServer) {
      return occurrence
    }
    const event = await auth.api<SyncedCalendarEvent>(`/api/v1/calendar-events/${encodeURIComponent(occurrence.event.id)}`)
    const series = occurrence.recurring && event.recurrenceId === null ? event : null
    return { ...occurrence, event, series, seriesId: event.id }
  }

  watch([days, () => mail.calendarRevision, () => mail.ready], () => void load(), { immediate: true })

  function show(kind: CalendarViewKind, day?: number): void {
    view.value = kind
    if (day !== undefined) {
      anchor.value = startOfWallDay(day)
    }
  }

  function goToday(): void {
    now.value = Date.now()
    anchor.value = today.value
  }

  /** The next (1) or previous (-1) day, week, month or agenda page. */
  function step(direction: 1 | -1): void {
    switch (view.value) {
      case 'day':
        anchor.value = addDays(anchor.value, direction)
        break
      case 'week':
        anchor.value = addDays(anchor.value, 7 * direction)
        break
      case 'month':
        anchor.value = addMonths(startOfMonth(anchor.value), direction)
        break
      case 'agenda':
        anchor.value = addDays(anchor.value, AGENDA_DAYS * direction)
        break
    }
  }

  function calendar(id: string): SyncedCalendar | undefined {
    return calendarsById.value.get(id)
  }

  /** Where new events go. */
  const newEventCalendar = computed(() => defaultCalendar(calendars.value))

  async function save(input: EventInput, target: { occurrence: Occurrence; scope: EditScope } | null, notify: boolean): Promise<SyncedCalendarEvent> {
    const request = saveRequest(input, target, notify)
    const saved = await auth.send<SyncedCalendarEvent>(request.method, request.path, request.body)
    await mail.syncNow()
    return saved
  }

  async function remove(occurrence: Occurrence, scope: EditScope, notify: boolean): Promise<void> {
    const request = deleteRequest(occurrence, scope, notify)
    await auth.send<void>(request.method, request.path)
    await mail.syncNow()
  }

  /** Answers an invitation, for the whole series or only this occurrence. */
  async function respond(occurrence: Pick<Occurrence, 'seriesId' | 'recurrenceId' | 'recurring'>, response: Response, onlyThis: boolean, comment: string | null = null, notify = true): Promise<void> {
    await respondTo(occurrence.seriesId, response, onlyThis && occurrence.recurring ? occurrence.recurrenceId : null, comment, notify)
  }

  async function respondTo(eventId: string, response: Response, recurrenceId: string | null, comment: string | null = null, notify = true): Promise<void> {
    await auth.send<SyncedCalendarEvent>('POST', `/api/v1/calendar-events/${encodeURIComponent(eventId)}/response`, { response, recurrenceId, comment, notify })
    await mail.syncNow()
  }

  async function setVisible(calendarId: string, visible: boolean): Promise<void> {
    await auth.send<SyncedCalendar>('PATCH', `/api/v1/calendars/${encodeURIComponent(calendarId)}`, { visible })
    await mail.syncNow()
  }

  function invitation(messageId: string): Promise<MessageInvitation> {
    return auth.api<MessageInvitation>(`/api/v1/messages/${encodeURIComponent(messageId)}/invitation`)
  }

  async function applyInvitation(messageId: string): Promise<MessageInvitation> {
    const applied = await auth.send<MessageInvitation>('POST', `/api/v1/messages/${encodeURIComponent(messageId)}/invitation/apply`)
    await mail.syncNow()
    return applied
  }

  /** The occurrences of the next days from now, for the mini agenda next to mail. */
  async function upcoming(daysAhead: number): Promise<Occurrence[]> {
    const database = mail.currentStore()
    if (database === null) {
      return []
    }
    const from = Date.now()
    const to = from + daysAhead * 86_400_000
    const events = await database.calendarEvents(from, to)
    return expandOccurrences(events, from, to, zone.value).filter(
      (occurrence) => visibleCalendarIds.value.has(occurrence.event.calendarId) && occurrence.event.status !== 'cancelled' && occurrence.event.selfResponse !== 'declined',
    )
  }

  /** One event as the server has it now, for the editor's save (the copy on this device may predate a new link). */
  function event(id: string): Promise<SyncedCalendarEvent> {
    return auth.api<SyncedCalendarEvent>(`/api/v1/calendar-events/${encodeURIComponent(id)}`)
  }

  /** Asks the calendar's provider again for the series' meeting link (Retry). */
  async function requestMeetingLink(eventId: string, provider: ConferenceProvider): Promise<SyncedCalendarEvent> {
    const saved = await auth.send<SyncedCalendarEvent>('POST', `/api/v1/calendar-events/${encodeURIComponent(eventId)}/meeting-link`, { provider })
    await mail.syncNow()
    return saved
  }

  /**
   * Drops a link that was asked for and leaves any link alone (Leave without a link): the API answers 409, and
   * changes nothing, when the link arrived meanwhile. Guests are never mailed.
   */
  async function dropMeetingRequest(eventId: string): Promise<SyncedCalendarEvent> {
    const saved = await auth.send<SyncedCalendarEvent>('DELETE', `/api/v1/calendar-events/${encodeURIComponent(eventId)}/meeting-link/request`)
    await mail.syncNow()
    return saved
  }

  /** What the server's calendar offers: the assistant features, and whether it drops a meeting request alone. */
  function capabilities(): Promise<CalendarCapabilities> {
    return auth.api<CalendarCapabilities>('/api/v1/calendar/capabilities')
  }

  const keptEditor = shallowRef<KeptEditor | undefined>(undefined)

  function keepEditor(kept: KeptEditor): void {
    keptEditor.value = kept
  }

  /** The kept editor, once: reopening it takes it out. */
  function takeKeptEditor(): KeptEditor | undefined {
    const kept = keptEditor.value
    keptEditor.value = undefined
    return kept
  }

  // Another user signed in (desktop): an event the previous one was writing does not come back.
  watch(
    () => auth.generation,
    () => {
      keptEditor.value = undefined
    },
  )

  return {
    zone,
    view,
    anchor,
    now,
    today,
    days,
    loading,
    notice,
    rows,
    occurrences,
    todoBlocks,
    unanswered,
    calendars,
    newEventCalendar,
    show,
    goToday,
    step,
    load,
    calendar,
    save,
    remove,
    respond,
    respondTo,
    setVisible,
    invitation,
    applyInvitation,
    upcoming,
    complete,
    event,
    requestMeetingLink,
    dropMeetingRequest,
    capabilities,
    keptEditor,
    keepEditor,
    takeKeptEditor,
  }
})
