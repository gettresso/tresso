<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import {
  addedByText,
  DEFAULT_REMINDER_CHANNELS,
  defaultMeetingApp,
  describeRule,
  editScopes,
  formatDate,
  formatDateTime,
  inputForScope,
  inputFromEvent,
  inputFromOccurrence,
  knownTimeZones,
  MEETING_PENDING_MS,
  meetingChoices,
  meetingRemovable,
  meetingRow,
  parseWall,
  presetLabel,
  SCOPE_LABELS,
  scopeHint,
  signInProvider,
  startingChoice,
  toWall,
  zoneLabel,
  type AttendeeInput,
  type EditScope,
  type EventInput,
  type MeetingApp,
  type MeetingPreferences,
  type NotificationChannel,
  type Occurrence,
  type RepeatPreset,
  type SyncedCalendarEvent,
} from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import FieldLabel from '@/forms/FieldLabel.vue'
import { provideRequiredFields } from '@/forms/required'
import { EVENT_LOCATION_MAX, EVENT_REMINDERS_MAX, EVENT_SUMMARY_MAX, eventSchema, inputFromValues, ruleOf, valuesFromInput, type EventValues } from '@/forms/calendarEvent'
import AppIcon from '@/components/AppIcon.vue'
import { backdropClose } from '@/components/backdropClose'
import { genie, reducedMotion } from '@/components/calendar/genie'
import MeetingLinkRow from '@/components/calendar/MeetingLinkRow.vue'
import { useAccountsStore } from '@/stores/accounts'
import { useAuthStore } from '@/stores/auth'
import { useCalendarStore, type KeptEditor } from '@/stores/calendar'
import { useMailStore } from '@/stores/mail'
import { useMeetingAppsStore } from '@/stores/meetingApps'
import KeyShortcut from '@/components/KeyShortcut.vue'

/** A new event can start filled in, say from an email that proposes a time. */
export interface EventPrefill {
  summary?: string
  description?: string
  attendees?: AttendeeInput[]
  /** Whether saving invites the guests; on unless the prefill says otherwise. */
  notify?: boolean
}

/** What the editor opens on: a new event at a time, or an occurrence to change. */
export type EditorTarget = { kind: 'new'; start: number; allDay: boolean; prefill?: EventPrefill } | { kind: 'edit'; occurrence: Occurrence }

const props = defineProps<{
  target: EditorTarget
  /** Where the saved event shows on screen, for the editor to land in (the calendar); null when it is not in view. */
  landing?: (event: SyncedCalendarEvent) => Promise<HTMLElement | null>
  /** An editor the user left for Settings, reopened with its values ("Back to the event"). */
  restore?: KeptEditor
}>()
/** Saved: `landed` when the editor already flew into the event, so it needs no closing animation of its own. */
const emit = defineEmits<{ close: []; saved: [landed: boolean] }>()

provideRequiredFields(eventSchema)

const calendar = useCalendarStore()
const mail = useMailStore()
const auth = useAuthStore()
const accounts = useAccountsStore()
const meetingApps = useMeetingAppsStore()
const router = useRouter()

const writable = computed(() => calendar.calendars.filter((entry) => entry.writable))
const zones = knownTimeZones()

/** The values the editor starts from. */
function initial(): EventInput {
  if (props.target.kind === 'edit') {
    return inputFromOccurrence(props.target.occurrence, calendar.zone)
  }
  const zone = calendar.zone
  const wall = toWall(props.target.start, zone)
  const calendarId = calendar.newEventCalendar?.id ?? writable.value[0]?.id ?? ''
  const input = props.target.allDay
    ? blank(calendarId, { date: formatDate(wall) }, { date: formatDate(wall + 86_400_000) })
    : blank(calendarId, { dateTime: formatDateTime(wall), timeZone: zone }, { dateTime: formatDateTime(wall + 3_600_000), timeZone: zone })
  const prefill = props.target.prefill ?? {}
  return { ...input, summary: prefill.summary ?? '', description: prefill.description ?? '', attendees: prefill.attendees ?? [] }
}

function blank(calendarId: string, start: EventInput['start'], end: EventInput['end']): EventInput {
  return {
    calendarId,
    summary: '',
    description: '',
    location: '',
    url: null,
    start,
    end,
    recurrence: null,
    status: 'confirmed',
    transparency: 'busy',
    visibility: 'public',
    attendees: [],
    useDefaultReminders: true,
    reminders: [],
    important: false,
    travelMinutes: null,
    conferenceUrl: null,
    organizerMailAccountId: null,
  }
}

const before = initial()
// The meeting link row owns the link: the form's own field stays empty, so it never validates or saves a link.
const { defineField, handleSubmit, errors, values, setErrors, setFieldValue, setValues, meta } = useForm<EventValues>({
  validationSchema: toTypedSchema(eventSchema),
  initialValues: { ...valuesFromInput(before, calendar.zone), conferenceUrl: '' },
})
// Back from Settings: the values the user had, as changes, so closing still asks before discarding them.
if (props.restore !== undefined) {
  setValues({ ...props.restore.values, conferenceUrl: '' })
}
const [summary] = defineField('summary')
const [calendarId] = defineField('calendarId')
const [allDay] = defineField('allDay')
const [startDate] = defineField('startDate')
const [startTime] = defineField('startTime')
const [endDate] = defineField('endDate')
const [endTime] = defineField('endTime')
const [timeZone] = defineField('timeZone')
const [repeat] = defineField('repeat')
const [repeatEnd] = defineField('repeatEnd')
const [repeatUntil] = defineField('repeatUntil')
const [repeatCount] = defineField('repeatCount')
const [location] = defineField('location')
const [description] = defineField('description')
const [transparency] = defineField('transparency')
const [visibility] = defineField('visibility')
const [organizerMailAccountId] = defineField('organizerMailAccountId')
const [useDefaultReminders] = defineField('useDefaultReminders')
const [important] = defineField('important')
const [travelMinutes] = defineField('travelMinutes')

const isNew = computed(() => props.target.kind === 'new')
const occurrence = computed(() => (props.target.kind === 'edit' ? props.target.occurrence : null))
const saving = ref(false)
/** Saved, and flying into its place in the calendar. */
const flying = ref(false)
const error = ref<string | null>(null)
const notify = ref(props.restore?.notify ?? (props.target.kind === 'new' ? (props.target.prefill?.notify ?? true) : true))

/** A start moved keeps the event as long as it was. */
watch(
  () => [values.startDate, values.startTime, values.allDay] as const,
  (now, previous) => {
    if (previous === undefined || now[2] !== previous[2]) {
      return
    }
    const from = parseWall(previous[2] ? previous[0] : `${previous[0]}T${previous[1]}`)
    const to = parseWall(now[2] ? now[0] : `${now[0]}T${now[1]}`)
    const end = parseWall(values.allDay ? values.endDate : `${values.endDate}T${values.endTime}`)
    if (from === null || to === null || end === null) {
      return
    }
    const moved = end + (to - from)
    setFieldValue('endDate', formatDate(moved))
    if (!values.allDay) {
      setFieldValue('endTime', formatDateTime(moved).slice(11, 16))
    }
  },
)

/** The zone the series' end is read in: the one ruleOf writes it in. */
const ruleZone = computed(() => (values.allDay || !values.timeZone ? null : values.timeZone))
const startWall = computed(() => parseWall(values.allDay ? values.startDate : `${values.startDate}T${values.startTime}`) ?? Date.now())
const presets = computed<{ value: RepeatPreset; label: string }[]>(() => {
  const options: RepeatPreset[] = ['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthlyByDay', 'monthlyByDate', 'yearly']
  const list = options.map((value) => ({ value, label: presetLabel(value, startWall.value) }))
  if (values.repeat === 'custom') {
    list.push({ value: 'custom', label: values.customRule === '' ? 'Custom' : describeRule(values.customRule, ruleZone.value) })
  }
  return list
})

const after = computed(() => inputFromValues(values as EventValues, { status: before.status, url: before.url }))
const scopes = computed<EditScope[]>(() => (occurrence.value === null ? [] : editScopes(occurrence.value, { before, after: after.value })))
const scope = ref<EditScope>('this')
watch(
  scopes,
  (available) => {
    if (!available.includes(scope.value)) scope.value = available[0] ?? 'all'
  },
  { immediate: true },
)

const selectedCalendar = computed(() => calendar.calendar(values.calendarId ?? ''))
const guests = computed(() => values.attendees ?? [])
const needsOrganizer = computed(() => selectedCalendar.value?.mailAccountId === null && guests.value.length > 0)
const zoneHint = computed(() => (values.allDay || values.timeZone === '' ? 'Same clock time in every zone.' : zoneLabel(values.timeZone ?? calendar.zone, Date.now())))
const saveLabel = computed(() => (guests.value.length > 0 && notify.value ? `Save and notify ${guests.value.length} ${guests.value.length === 1 ? 'person' : 'people'}` : 'Save'))

// Meeting link (build plan 5.2): the row's state comes from core's meetingRow; this keeps what the user did with it.
const EMPTY_PREFERENCES: MeetingPreferences = { ownLink: null, addWithGuests: false, defaults: {}, defaultOther: null, disabled: [], apps: [] }
const preferences = computed(() => meetingApps.preferences ?? EMPTY_PREFERENCES)
const preferencesReady = computed(() => meetingApps.preferences !== null)
const meetingError = ref<string | null>(null)
const meetingBusy = ref(false)
const meetingNotice = ref<string | null>(null)

/**
 * The saved event as the row shows it: its own link, and the request of its series (an override carries none). The
 * answers of Retry and Leave without a link replace the request.
 */
const saved = ref<SyncedCalendarEvent | null>(
  props.target.kind === 'edit' ? { ...props.target.occurrence.event, conferenceRequest: (props.target.occurrence.series ?? props.target.occurrence.event).conferenceRequest ?? null } : null,
)
const hadLink = computed(() => saved.value !== null && saved.value.conference !== null)
/**
 * The link the editor knows of per row (the event, and its series): a save that would make a link compares the
 * server's link of the row it saves against this, so only a link the user has not seen stops it.
 */
const knownLinks = reactive(new Map<string, SyncedCalendarEvent['conference']>())
if (props.target.kind === 'edit') {
  const occurrence = props.target.occurrence
  knownLinks.set(occurrence.event.id, occurrence.event.conference)
  if (occurrence.series !== null) knownLinks.set(occurrence.series.id, occurrence.series.conference)
}
/** Only the organizer changes the link; an invited event shows who added it and nothing to change. */
const organizes = computed(() => saved.value === null || saved.value.selfResponse === null)

const linkOn = ref(props.restore?.link.on ?? hadLink.value)
/** The app the user picked in this editor, or null to follow the calendar's default. */
const explicitApp = ref<MeetingApp | null>(props.restore?.link.app ?? null)
/** The user used the switch: a first guest no longer switches it on. */
const touched = ref(props.restore?.link.touched ?? false)
/** "Remove meeting link" on a saved event with a link, not saved yet. */
const removed = ref(props.restore?.link.removed ?? false)

const meetingAccount = computed(() => mail.accounts.find((account) => account.id === selectedCalendar.value?.mailAccountId) ?? null)
const choices = computed(() => meetingChoices(selectedCalendar.value, meetingAccount.value, preferences.value))
const defaultApp = computed(() => defaultMeetingApp(selectedCalendar.value, meetingAccount.value, preferences.value))
const starting = computed(() => startingChoice(choices.value, defaultApp.value))
/** The app of the link the event has: the own link, or Meet, Teams or Zoom by its provider; null for any other. */
function appOf(conference: SyncedCalendarEvent['conference']): MeetingApp | null {
  if (conference === null) return null
  const own = preferences.value.ownLink
  if (own !== null && own !== '' && conference.url === own) return 'own'
  return conference.provider === 'meet' || conference.provider === 'teams' || conference.provider === 'zoom' ? conference.provider : null
}
const linkApp = computed<MeetingApp | null>(() => appOf(saved.value?.conference ?? null))
/**
 * The menu's apps for this event. While the event keeps a link whose host is Meet's or Teams' but that reads as
 * another app here (the own link is a Teams room), that provider's item is not offered: the server keeps a meeting of
 * the same app on a save, so the pick would promise a new link and change nothing.
 */
const rowChoices = computed(() => {
  const conference = saved.value?.conference ?? null
  if (conference === null || removed.value) return choices.value
  const provider = conference.provider
  if ((provider !== 'meet' && provider !== 'teams') || linkApp.value === provider) return choices.value
  const name = provider === 'teams' ? 'Teams' : 'Google Meet'
  return choices.value.map((choice) =>
    choice.app === provider ? { ...choice, ok: false, problem: 'unsupported' as const, via: `The current link is already a ${name} link. Remove it first to get a new one.` } : choice,
  )
})
/** Keeps the link it has: the app button names that link's app, not the calendar's default. */
const keepsLink = computed(() => hadLink.value && !removed.value && explicitApp.value === null)
const chosen = computed(() => {
  const app = explicitApp.value ?? (keepsLink.value ? linkApp.value : null)
  if (app === null) return keepsLink.value ? null : starting.value.choice
  return rowChoices.value.find((choice) => choice.app === app) ?? null
})
/** A Teams meeting Microsoft keeps on its event: the server's word, or core's rule for rows from before it. */
const locked = computed(() => {
  const conference = saved.value?.conference ?? null
  return conference !== null && !meetingRemovable(calendar.calendar(saved.value?.calendarId ?? '')?.source, conference)
})

// The server's clock for a link being made, read again when it turns two minutes old.
const meetingNow = ref(auth.serverNow())
let meetingTimer: ReturnType<typeof setTimeout> | null = null
function watchRequestAge(): void {
  if (meetingTimer !== null) clearTimeout(meetingTimer)
  meetingTimer = null
  meetingNow.value = auth.serverNow()
  const request = saved.value?.conferenceRequest ?? null
  if (request === null || request.status !== 'pending' || saved.value?.conference !== null) return
  const left = Date.parse(request.requestedAt) + MEETING_PENDING_MS - meetingNow.value
  if (Number.isFinite(left) && left >= 0) {
    meetingTimer = setTimeout(watchRequestAge, Math.min(left, MEETING_PENDING_MS) + 250)
  }
}
watch(() => saved.value?.conferenceRequest, watchRequestAge, { immediate: true })
onBeforeUnmount(() => {
  if (meetingTimer !== null) clearTimeout(meetingTimer)
})

const meeting = computed(() =>
  meetingRow({
    on: linkOn.value,
    removed: removed.value,
    chosen: chosen.value,
    fellBack: explicitApp.value === null ? starting.value.fellBack : null,
    explicit: explicitApp.value !== null,
    choices: choices.value,
    calendar: selectedCalendar.value,
    account: meetingAccount.value,
    preferences: preferences.value,
    guests: guests.value.length,
    event: saved.value,
    now: meetingNow.value,
  }),
)
/** The link the row shows: the event's while it keeps it, else the own link when that is the choice. */
const shownLink = computed(() => {
  if (meeting.value.kind === 'own') {
    const link = preferences.value.ownLink
    return link === null ? null : { provider: 'other' as const, url: link }
  }
  return meeting.value.kind === 'created' ? (saved.value?.conference ?? null) : null
})
const addedBy = computed(() => {
  const conference = saved.value?.conference ?? null
  const organizer = saved.value?.organizer ?? null
  return conference === null || organizer === null ? null : addedByText(conference, preferences.value.ownLink, organizer.name?.trim() || organizer.address)
})

/** The server drops a request without touching a link: only then is "Leave without a link" offered. */
const canLeave = ref(false)

onMounted(() => {
  meetingApps.ensureLoaded().catch((e: unknown) => (meetingError.value = `The meeting apps could not be loaded: ${errorMessage(e)}`))
  if (props.target.kind === 'edit') {
    calendar
      .capabilities()
      .then((capabilities) => (canLeave.value = capabilities.meetingRequestDrop === true))
      // Unknown: the button stays away, as on a server without the request-only drop.
      .catch(() => (canLeave.value = false))
  }
})

/**
 * Takes the link and request the server has into the row: a link that arrived shows by itself (state 6), and the
 * switch follows it unless the user already changed the row.
 */
function adopt(own: SyncedCalendarEvent, series: SyncedCalendarEvent | null): void {
  if (saved.value === null) return
  knownLinks.set(own.id, own.conference)
  if (series !== null) knownLinks.set(series.id, series.conference)
  const conference = own.conference
  const arrived = saved.value.conference === null && conference !== null
  const changed = saved.value.conference !== null && conference !== null && saved.value.conference.url !== conference.url
  const gone = saved.value.conference !== null && conference === null
  saved.value = { ...saved.value, conference, conferenceRequest: (series ?? own).conferenceRequest ?? null }
  if (arrived || changed) {
    // The link now on the event wins over anything chosen before it came: a pick after this replaces it knowingly.
    const acted = touched.value || explicitApp.value !== null || removed.value || !linkOn.value
    explicitApp.value = null
    removed.value = false
    linkOn.value = true
    if (acted || changed) meetingNotice.value = arrived ? 'A meeting link was added meanwhile. It is shown now.' : 'The meeting link was changed meanwhile. It is shown now.'
  } else if (gone && explicitApp.value === null) {
    // Taken off elsewhere: keeping it (untouched, switched back on, or Undo) no longer means a link; a save does not
    // make a new one. A pick of another app stays a pick.
    linkOn.value = false
    removed.value = false
  }
}

// While the editor is open, the copy on this device follows the server: a link made since shows up in the row.
watch(
  () => mail.calendarRevision,
  async () => {
    const database = mail.currentStore()
    if (database === null || props.target.kind !== 'edit') return
    const occurrence = props.target.occurrence
    const [own, series] = await Promise.all([database.calendarEvent(occurrence.event.id), database.calendarEvent(occurrence.seriesId)])
    if (own === null) return
    adopt(own, series)
  },
)

// The first guest switches the link on with the calendar's default, unless the user used the switch.
watch(
  () => guests.value.length,
  (count, previous) => {
    if (props.target.kind === 'new' && previous === 0 && count > 0 && !touched.value && !linkOn.value && !removed.value && !hadLink.value && (saved.value?.conferenceRequest ?? null) === null && preferences.value.addWithGuests && defaultApp.value !== null && defaultApp.value !== 'none') {
      linkOn.value = true
    }
  },
)

function toggleLink(): void {
  touched.value = true
  if (linkOn.value) {
    linkOn.value = false
    // Off on a saved link takes it off when saved (state 11, with Undo).
    removed.value = hadLink.value
    return
  }
  if (removed.value) {
    removed.value = false
    explicitApp.value = null
  }
  linkOn.value = true
}

function pickApp(app: MeetingApp): void {
  if (rowChoices.value.find((choice) => choice.app === app)?.ok === false) return
  // The app of the link the event has: picking it (again) keeps that link, it does not make a new one.
  if (hadLink.value && !removed.value && app === linkApp.value) {
    explicitApp.value = null
    linkOn.value = true
    return
  }
  explicitApp.value = app
  removed.value = false
  linkOn.value = true
  touched.value = true
}

function removeLink(): void {
  touched.value = true
  explicitApp.value = null
  linkOn.value = false
  removed.value = hadLink.value
}

function undoRemove(): void {
  removed.value = false
  explicitApp.value = null
  linkOn.value = true
}

/** The series the request belongs to: Retry and Leave act on it, as the API does. */
const seriesId = computed(() => (props.target.kind === 'edit' ? props.target.occurrence.seriesId : null))

async function retryLink(): Promise<void> {
  const request = saved.value?.conferenceRequest ?? null
  if (seriesId.value === null || request === null || (request.provider !== 'meet' && request.provider !== 'teams')) return
  meetingBusy.value = true
  meetingError.value = null
  try {
    const answer = await calendar.requestMeetingLink(seriesId.value, request.provider)
    saved.value = { ...saved.value!, conference: saved.value!.conference ?? answer.conference, conferenceRequest: answer.conferenceRequest ?? null }
  } catch (e) {
    meetingError.value = errorMessage(e)
  } finally {
    meetingBusy.value = false
  }
}

async function leaveWithoutLink(): Promise<void> {
  if (seriesId.value === null) return
  meetingBusy.value = true
  meetingError.value = null
  try {
    const answer = await calendar.dropMeetingRequest(seriesId.value)
    saved.value = { ...saved.value!, conferenceRequest: answer.conferenceRequest ?? null }
    linkOn.value = false
    explicitApp.value = null
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      // The link arrived meanwhile: nothing was dropped, and the row shows the link now.
      await refreshFromServer().catch((read: unknown) => (meetingError.value = errorMessage(read)))
      return
    }
    meetingError.value = errorMessage(e)
  } finally {
    meetingBusy.value = false
  }
}

/** What the editor holds now, to come back to from Settings. */
function keep(): void {
  calendar.keepEditor({
    target: props.target,
    values: { ...(values as EventValues) },
    link: { on: linkOn.value, app: explicitApp.value, touched: touched.value, removed: removed.value },
    notify: notify.value,
  })
}

/** Connect a meeting app: Settings, Meeting apps, with "Back to the event" there. */
async function toMeetingSettings(): Promise<void> {
  keep()
  emit('close')
  await router.push({ name: 'settings-meeting-apps' })
}

/** Reconnect: the account's sign-in again, with calendar access when it was never given. */
async function reconnect(): Promise<void> {
  const account = meetingAccount.value
  const provider = account === null ? null : signInProvider(account)
  if (account === null || provider === null) return
  meetingError.value = null
  meetingNotice.value = null
  keep()
  try {
    if ((await accounts.openProviderSignIn(provider, account.id, account.calendarStatus === 'not_granted' ? ['calendar'] : undefined)) === 'browser') {
      meetingNotice.value = 'Sign in in your browser, then come back here and save the event.'
    }
  } catch (e) {
    calendar.takeKeptEditor()
    meetingError.value = errorMessage(e)
  }
}

/** The row the save is about: one occurrence keeps its own link; the series (and what follows) the series' link. */
function linkRowId(target: { occurrence: Occurrence; scope: EditScope }): string {
  const occurrence = target.occurrence
  return occurrence.recurring && target.scope !== 'this' ? occurrence.seriesId : occurrence.event.id
}

/** Reads the event's link and the series' request from the server into the row. */
async function refreshFromServer(): Promise<void> {
  if (props.target.kind !== 'edit') return
  const occurrence = props.target.occurrence
  const own = await calendar.event(occurrence.event.id)
  const series = occurrence.seriesId === occurrence.event.id ? own : await calendar.event(occurrence.seriesId)
  adopt(own, series)
}

/** The save stops with a plain sentence: the server has something the editor did not know of. */
class Stale extends Error {}

/**
 * The link fields of the save, from what the user did with the row and what the server has at the save (read then, so
 * an older copy never removes a link made since):
 * - removed: both null;
 * - a new link switched on or an app picked: Meet or Teams as `conferenceProvider`, the own link as `conferenceUrl`;
 *   when the server already has a link the editor did not know of, nothing is sent and the row shows that link;
 * - anything else: the server's link back, and the request it has only for the series, while the user left the switch
 *   on and the calendar offers it (switching off drops only the request).
 */
async function meetingFields(target: { occurrence: Occurrence; scope: EditScope } | null): Promise<Pick<EventInput, 'conferenceUrl' | 'conferenceProvider'>> {
  const fresh = target === null ? null : await calendar.event(linkRowId(target))
  // Moved to another calendar elsewhere, while the user left the calendar as it was: the meeting choices were made
  // for the old one, and a save would move it back.
  if (fresh !== null && fresh.calendarId !== before.calendarId && values.calendarId === before.calendarId) {
    throw new Stale('This event was moved to another calendar meanwhile. Close it and open it again to change it.')
  }
  if (removed.value) {
    return { conferenceUrl: null, conferenceProvider: null }
  }
  const app = chosen.value
  if (linkOn.value && app !== null && app.ok && (explicitApp.value !== null || !hadLink.value)) {
    const known = knownLinks.get(fresh?.id ?? '') ?? null
    if (target !== null && fresh !== null && fresh.conference !== null && fresh.conference.url !== known?.url) {
      await refreshFromServer()
      if (fresh.id !== target.occurrence.event.id) {
        // The series' link, which the row of this occurrence does not show: say what changed, and that the row now
        // tells what a save does with it.
        throw new Stale(known === null ? 'The series got a meeting link meanwhile. Check the meeting link row, then save again.' : "The series' meeting link was changed meanwhile. Check the meeting link row, then save again.")
      }
      throw new Stale(known === null ? 'A meeting link was added meanwhile. It is shown now; save again to keep it.' : 'The meeting link was changed meanwhile. It is shown now; save again to keep it.')
    }
    // The series already has a link of this app: it keeps it, and the save asks for nothing.
    if (target !== null && fresh !== null && fresh.id !== target.occurrence.event.id && fresh.conference !== null && sameApp(fresh.conference, app.app)) {
      return { conferenceUrl: fresh.conference.url, conferenceProvider: null }
    }
    if (app.app === 'meet' || app.app === 'teams') {
      return { conferenceUrl: null, conferenceProvider: app.app }
    }
    if (app.app === 'own' && preferences.value.ownLink !== null) {
      return { conferenceUrl: preferences.value.ownLink, conferenceProvider: null }
    }
  }
  if (target === null || fresh === null) {
    return { conferenceUrl: null, conferenceProvider: null }
  }
  const kept = inputFromEvent(fresh)
  const provider = kept.conferenceProvider ?? null
  const oneOccurrence = target.occurrence.recurring && target.scope === 'this'
  const asks = provider !== null && !oneOccurrence && !(touched.value && !linkOn.value) && selectedCalendar.value?.conferenceProviders.includes(provider) === true
  return { conferenceUrl: kept.conferenceUrl, conferenceProvider: asks ? provider : null }
}

/**
 * A moved occurrence saved for all or following events: the save is about the series, so the series' link is the one
 * that counts, not the occurrence's (which may have none).
 */
const targetsSeries = computed(() => {
  if (props.target.kind !== 'edit') return false
  const occurrence = props.target.occurrence
  return occurrence.recurring && scope.value !== 'this' && occurrence.event.id !== occurrence.seriesId
})

/** Whether `app` is the app of a link: by how it reads here, or by its host (the server compares hosts). */
function sameApp(conference: NonNullable<SyncedCalendarEvent['conference']>, app: MeetingApp): boolean {
  return appOf(conference) === app || conference.provider === app
}

/**
 * The row would make a link of the app the series' link already is: the server keeps the series' link (a save asking
 * for the app of an existing meeting keeps it), so the row promises nothing new and the save asks for nothing.
 */
const seriesKeeps = computed(() => {
  if (!targetsSeries.value || props.target.kind !== 'edit' || removed.value || !linkOn.value) return false
  const series = knownLinks.get(props.target.occurrence.seriesId) ?? null
  const app = chosen.value
  return series !== null && app !== null && app.ok && (explicitApp.value !== null || !hadLink.value) && sameApp(series, app.app)
})

/** The row as core says it, with the truth for a series that keeps its link. */
const shownRow = computed(() => (seriesKeeps.value ? { ...meeting.value, hint: 'The series keeps its current link. Nothing new is made when you save.' } : meeting.value))

/** Another app picked on an event with a link: saving replaces that link. */
const replacing = computed(() => {
  if (removed.value || !linkOn.value || props.target.kind !== 'edit') return false
  const occurrence = props.target.occurrence
  // For all or following events of a series, the link replaced is the series' link.
  const target = occurrence.recurring && scope.value !== 'this' ? (knownLinks.get(occurrence.seriesId) ?? null) : (saved.value?.conference ?? null)
  if (target === null) return false
  const app = chosen.value
  const makes = app !== null && app.ok && (explicitApp.value !== null || !hadLink.value)
  return makes && !seriesKeeps.value && app.app !== appOf(target)
})

const meetingChanged = computed(() => touched.value || explicitApp.value !== null || removed.value)

// People
const newGuest = ref('')
function addGuest(): void {
  const address = newGuest.value.trim()
  if (address === '') return
  setFieldValue('attendees', [...guests.value, { address, name: null, role: 'required' }])
  newGuest.value = ''
}
function removeGuest(index: number): void {
  setFieldValue(
    'attendees',
    guests.value.filter((_, at) => at !== index),
  )
}
function toggleOptional(index: number): void {
  setFieldValue(
    'attendees',
    guests.value.map((person, at) => (at === index ? { ...person, role: person.role === 'optional' ? 'required' : 'optional' } : person)),
  )
}
function guestError(index: number): string | undefined {
  return (errors.value as Record<string, string | undefined>)[`attendees[${index}].address`] ?? (errors.value as Record<string, string | undefined>)[`attendees.${index}.address`]
}

// Reminders
const REMINDER_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080]
function reminderLabel(minutes: number): string {
  if (minutes === 0) return 'At the start'
  if (minutes % 10080 === 0) return minutes === 10080 ? '1 week before' : `${minutes / 10080} weeks before`
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 day before' : `${minutes / 1440} days before`
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour before' : `${minutes / 60} hours before`
  return `${minutes} minutes before`
}
const CHANNELS: { value: NotificationChannel; label: string }[] = [
  { value: 'phone', label: 'Phone' },
  { value: 'desktop', label: 'Desktop' },
  { value: 'email', label: 'Email' },
]
const reminders = computed(() => values.reminders ?? [])
function reminderOptions(current: number): number[] {
  return REMINDER_OPTIONS.includes(current) ? REMINDER_OPTIONS : [...REMINDER_OPTIONS, current].sort((a, b) => a - b)
}
function setReminder(index: number, minutesBefore: number): void {
  setFieldValue(
    'reminders',
    reminders.value.map((reminder, at) => (at === index ? { ...reminder, minutesBefore } : reminder)),
  )
}
function toggleChannel(index: number, channel: NotificationChannel): void {
  setFieldValue(
    'reminders',
    reminders.value.map((reminder, at) =>
      at === index ? { ...reminder, channels: reminder.channels.includes(channel) ? reminder.channels.filter((c) => c !== channel) : [...reminder.channels, channel] } : reminder,
    ),
  )
}
function addReminder(): void {
  const next = REMINDER_OPTIONS.find((option) => !reminders.value.some((reminder) => reminder.minutesBefore === option)) ?? 15
  setFieldValue('reminders', [...reminders.value, { minutesBefore: next, channels: [...DEFAULT_REMINDER_CHANNELS] }])
}
function removeReminder(index: number): void {
  setFieldValue(
    'reminders',
    reminders.value.filter((_, at) => at !== index),
  )
}
function reminderError(index: number): string | undefined {
  const all = errors.value as Record<string, string | undefined>
  return all[`reminders[${index}].channels`] ?? all[`reminders.${index}.channels`] ?? all[`reminders[${index}].minutesBefore`] ?? all[`reminders.${index}.minutesBefore`]
}

/** API field paths onto the form's. */
function formErrors(violations: Record<string, string>): Record<string, string> {
  const mapped: Record<string, string> = {}
  for (const [path, message] of Object.entries(violations)) {
    const field = path.startsWith('start') ? 'startDate' : path.startsWith('end') ? 'endDate' : path === 'recurrence' ? 'repeat' : path
    mapped[field] ??= message
  }
  return mapped
}

const save = handleSubmit(async (current) => {
  saving.value = true
  error.value = null
  meetingNotice.value = null
  try {
    const edited = inputFromValues(current, { status: before.status, url: before.url })
    const target = occurrence.value === null ? null : { occurrence: occurrence.value, scope: occurrence.value.recurring ? scope.value : 'all' }
    const scoped = target === null ? edited : inputForScope(target.occurrence, before, edited, target.scope)
    const input = { ...scoped, ...(await meetingFields(target)) }
    const done = await calendar.save(input, target, notify.value)
    // Only a new event flies into its place: an edited one is already on screen at its old time until the copy catches up.
    const landingAt = props.landing === undefined || props.target.kind !== 'new' || reducedMotion() ? null : await props.landing(done)
    if (landingAt !== null && dialog.value !== null) {
      flying.value = true
      await genie(dialog.value, landingAt)
    }
    // Saved: an editor kept for a sign-in that is still on its way does not come back.
    calendar.takeKeptEditor()
    emit('saved', landingAt !== null)
  } catch (e) {
    if (e instanceof Stale) {
      meetingNotice.value = e.message
      return
    }
    error.value = errorMessage(e)
    if (e instanceof ApiError) setErrors(formErrors(e.violations))
  } finally {
    saving.value = false
  }
})

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    if (!saving.value) void save()
  }
}

function close(): void {
  // While it flies into the saved event the editor is already on its way out: Escape or a click beside it waits.
  if (flying.value) {
    return
  }
  if ((meta.value.dirty || meetingChanged.value) && !window.confirm('Discard the changes to this event?')) {
    return
  }
  calendar.takeKeptEditor()
  emit('close')
}

const dialog = ref<HTMLDialogElement | null>(null)
// A click on the backdrop closes it like Cancel, asking first when there are changes.
const backdrop = backdropClose(close)
const titleInput = ref<HTMLInputElement | null>(null)
onMounted(() => {
  dialog.value?.showModal?.()
  titleInput.value?.focus()
})

const repeatSummary = computed(() => {
  const rule = ruleOf(values as EventValues)
  return rule === null ? null : describeRule(rule, ruleZone.value)
})
</script>

<template>
  <dialog ref="dialog" class="editor" aria-labelledby="editor-title" @cancel.prevent="close" @pointerdown="backdrop.onPointerdown" @click="backdrop.onClick">
    <form novalidate @submit.prevent="save" @keydown="onKeydown">
      <header class="header">
        <h2 id="editor-title">{{ isNew ? 'New event' : 'Edit event' }}</h2>
        <span class="spacer" />
        <button type="button" class="button button-quiet" @click="close">Cancel</button>
        <button type="submit" class="button button-primary" :disabled="saving">{{ saveLabel }} <KeyShortcut keys="Mod+Enter" /></button>
      </header>

      <div class="fields">
        <label class="field">
          <FieldLabel name="summary">Title</FieldLabel>
          <input ref="titleInput" v-model="summary" :maxlength="EVENT_SUMMARY_MAX" autocomplete="off" placeholder="Add a title" :aria-invalid="errors.summary ? 'true' : undefined" />
          <small v-if="errors.summary" class="error">{{ errors.summary }}</small>
        </label>

        <label class="field">
          <FieldLabel name="calendarId">Calendar</FieldLabel>
          <select v-model="calendarId" :aria-invalid="errors.calendarId ? 'true' : undefined">
            <option v-for="entry in writable" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
          </select>
          <small v-if="errors.calendarId" class="error">{{ errors.calendarId }}</small>
        </label>

        <fieldset class="when">
          <legend>When</legend>
          <div class="row">
            <label class="field compact">
              <span class="visually-hidden">Start date</span>
              <input v-model="startDate" type="date" :aria-invalid="errors.startDate ? 'true' : undefined" />
            </label>
            <label v-if="!allDay" class="field compact">
              <span class="visually-hidden">Start time</span>
              <input v-model="startTime" type="time" step="300" :aria-invalid="errors.startTime ? 'true' : undefined" />
            </label>
            <span class="to">to</span>
            <label class="field compact">
              <span class="visually-hidden">End date</span>
              <input v-model="endDate" type="date" :aria-invalid="errors.endDate ? 'true' : undefined" />
            </label>
            <label v-if="!allDay" class="field compact">
              <span class="visually-hidden">End time</span>
              <input v-model="endTime" type="time" step="300" :aria-invalid="errors.endTime ? 'true' : undefined" />
            </label>
            <label class="check"><input v-model="allDay" type="checkbox" /> All day</label>
          </div>
          <small v-for="field in ['startDate', 'startTime', 'endDate', 'endTime'] as const" :key="field" class="error">{{ errors[field] }}</small>
          <label v-if="!allDay" class="field">
            <span>Time zone</span>
            <select v-model="timeZone">
              <option value="">Same time everywhere</option>
              <option v-for="zone in zones" :key="zone" :value="zone">{{ zone.replace(/_/g, ' ') }}</option>
            </select>
          </label>
          <small class="hint">{{ zoneHint }}</small>
        </fieldset>

        <fieldset class="repeat">
          <legend>Repeat</legend>
          <select v-model="repeat" aria-label="Repeat">
            <option v-for="option in presets" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <template v-if="repeat !== 'none'">
            <div class="row">
              <label class="check"><input v-model="repeatEnd" type="radio" value="never" /> Never ends</label>
              <label class="check"><input v-model="repeatEnd" type="radio" value="until" /> On</label>
              <input v-if="repeatEnd === 'until'" v-model="repeatUntil" type="date" aria-label="Last date" :aria-invalid="errors.repeatUntil ? 'true' : undefined" />
              <label class="check"><input v-model="repeatEnd" type="radio" value="count" /> After</label>
              <input v-if="repeatEnd === 'count'" v-model.number="repeatCount" type="number" min="1" max="1000" class="count" aria-label="Number of times" />
            </div>
            <small v-if="repeatSummary" class="hint">{{ repeatSummary }}</small>
            <small v-if="errors.repeatUntil" class="error">{{ errors.repeatUntil }}</small>
            <small v-if="errors.repeatCount" class="error">{{ errors.repeatCount }}</small>
            <small v-if="errors.repeat" class="error">{{ errors.repeat }}</small>
          </template>
        </fieldset>

        <fieldset v-if="scopes.length > 0" class="scope">
          <legend>This event repeats. Save the changes to</legend>
          <div class="segments">
            <label v-for="option in scopes" :key="option" class="segment" :class="{ on: scope === option }">
              <input v-model="scope" type="radio" name="scope" :value="option" class="visually-hidden" />
              {{ SCOPE_LABELS[option] }}
            </label>
          </div>
          <small class="hint">{{ scopeHint(scope, false) }}</small>
        </fieldset>

        <fieldset class="people">
          <legend>People</legend>
          <ul v-if="guests.length > 0">
            <li v-for="(person, index) in guests" :key="index" class="guest">
              <span class="address">{{ person.name ? `${person.name} (${person.address})` : person.address }}</span>
              <label class="check"><input type="checkbox" :checked="person.role === 'optional'" @change="toggleOptional(index)" /> Optional</label>
              <button type="button" class="button button-quiet icon" :aria-label="`Remove ${person.address}`" @click="removeGuest(index)"><AppIcon name="close" :size="15" /></button>
              <small v-if="guestError(index)" class="error">{{ guestError(index) }}</small>
            </li>
          </ul>
          <div class="row">
            <input v-model="newGuest" type="email" placeholder="Add people by address" aria-label="Add a guest" autocomplete="off" @keydown.enter.prevent="addGuest" />
            <button type="button" class="button button-quiet" @click="addGuest"><AppIcon name="plus" :size="15" /> Add</button>
          </div>
          <small v-if="errors.attendees" class="error">{{ errors.attendees }}</small>
          <label v-if="needsOrganizer" class="field">
            <span>Send invitations from</span>
            <select v-model="organizerMailAccountId">
              <option value="">The default account</option>
              <option v-for="account in mail.accounts" :key="account.id" :value="account.id">{{ account.displayName }} ({{ account.emailAddress }})</option>
            </select>
          </label>
          <label v-if="guests.length > 0 || (occurrence?.event.attendees.length ?? 0) > 0" class="check">
            <input v-model="notify" type="checkbox" /> Send invitations and updates
          </label>
        </fieldset>

        <label class="field">
          <span>Where</span>
          <input v-model="location" :maxlength="EVENT_LOCATION_MAX" placeholder="Add a place" autocomplete="off" />
          <small v-if="errors.location" class="error">{{ errors.location }}</small>
        </label>
        <div class="field">
          <span>Meeting link</span>
          <MeetingLinkRow
            v-if="organizes"
            :row="shownRow"
            :choices="rowChoices"
            :chosen="chosen"
            :default-app="defaultApp"
            :calendar-name="selectedCalendar?.name ?? ''"
            :on="linkOn"
            :link="shownLink"
            :locked="locked"
            :removable="hadLink && !locked"
            :busy="meetingBusy || !preferencesReady"
            :error="meetingError"
            :can-leave="canLeave"
            @toggle="toggleLink"
            @pick="pickApp"
            @remove="removeLink"
            @undo="undoRemove"
            @retry="retryLink"
            @leave="leaveWithoutLink"
            @reconnect="reconnect"
            @settings="toMeetingSettings"
          />
          <p v-else-if="addedBy" class="hint">{{ addedBy }}</p>
          <p v-else class="hint">No meeting link. Only the organizer can add one.</p>
          <small v-if="replacing" class="hint">It replaces the current link.</small>
          <small v-if="meetingNotice" class="hint" role="status">{{ meetingNotice }}</small>
        </div>

        <fieldset class="reminders">
          <legend>Reminders</legend>
          <label class="check"><input v-model="useDefaultReminders" type="checkbox" /> Use my default reminders</label>
          <template v-if="!useDefaultReminders">
            <div v-for="(reminder, index) in reminders" :key="index" class="reminder">
              <div class="row">
                <select :value="reminder.minutesBefore" :aria-label="`Reminder ${index + 1}`" @change="setReminder(index, Number(($event.target as HTMLSelectElement).value))">
                  <option v-for="option in reminderOptions(reminder.minutesBefore)" :key="option" :value="option">{{ reminderLabel(option) }}</option>
                </select>
                <span class="channels" role="group" :aria-label="`Where reminder ${index + 1} reaches you`">
                  <label v-for="channel in CHANNELS" :key="channel.value" class="check">
                    <input type="checkbox" :checked="reminder.channels.includes(channel.value)" @change="toggleChannel(index, channel.value)" /> {{ channel.label }}
                  </label>
                </span>
                <button type="button" class="button button-quiet icon" :aria-label="`Remove reminder ${index + 1}`" @click="removeReminder(index)"><AppIcon name="close" :size="15" /></button>
              </div>
              <small v-if="reminderError(index)" class="error">{{ reminderError(index) }}</small>
            </div>
            <p v-if="reminders.length === 0" class="hint">No reminders for this event.</p>
            <button v-if="reminders.length < EVENT_REMINDERS_MAX" type="button" class="button button-quiet add" @click="addReminder"><AppIcon name="plus" :size="15" /> Add reminder</button>
          </template>
          <small v-if="errors.reminders" class="error">{{ errors.reminders }}</small>
          <label class="check"><input v-model="important" type="checkbox" /> Important: reminders also reach me in quiet hours</label>
          <label v-if="location" class="field compact">
            <span>Travel time in minutes</span>
            <input v-model="travelMinutes" inputmode="numeric" placeholder="Estimated by your phone" :aria-invalid="errors.travelMinutes ? 'true' : undefined" />
            <small v-if="errors.travelMinutes" class="error">{{ errors.travelMinutes }}</small>
          </label>
        </fieldset>

        <label class="field">
          <span>Description</span>
          <textarea v-model="description" rows="4" />
          <small v-if="errors.description" class="error">{{ errors.description }}</small>
        </label>

        <div class="row">
          <label class="field compact">
            <span>Show as</span>
            <select v-model="transparency">
              <option value="busy">Busy</option>
              <option value="free">Free</option>
            </select>
          </label>
          <label class="field compact">
            <span>Visibility</span>
            <select v-model="visibility">
              <option value="public">Default visibility</option>
              <option value="private">Private</option>
              <option value="confidential">Confidential</option>
            </select>
          </label>
        </div>

        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.editor {
  animation: pop-in var(--motion-base) var(--ease-out);
  width: min(680px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  color: var(--ink);
  box-shadow: var(--raised);
}
.header {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
  /* Solid: the form scrolls under this sticky header. */
  background: var(--paper);
  z-index: 1;
}
h2 {
  margin: 0;
  font: 700 20px/26px var(--font-display);
}
.spacer {
  flex: 1;
}
.fields {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 20px 20px;
}
fieldset {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}
legend {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.compact {
  flex: 0 1 auto;
}
.to {
  color: var(--ink-2);
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
select,
textarea,
.row > input {
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--ink);
  font: 400 14px var(--font-ui);
}
textarea {
  padding: 8px 12px;
  resize: vertical;
}
.count {
  width: 88px;
}
.hint {
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 400;
}
.error {
  color: var(--danger);
  font-size: 12px;
}
.error:empty {
  display: none;
}
.segments {
  display: flex;
  gap: 4px;
}
.segment {
  padding: 6px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  font: 600 13px var(--font-ui);
  cursor: pointer;
}
.segment.on {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--paper);
}
.segment:has(input:focus-visible) {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.people ul {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.guest {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.address {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.icon {
  width: 32px;
  height: 32px;
  padding: 0;
}
.add {
  align-self: flex-start;
}
.reminder {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.channels {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 10px;
}
</style>
