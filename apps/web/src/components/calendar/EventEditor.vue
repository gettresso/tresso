<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import {
  DEFAULT_REMINDER_CHANNELS,
  describeRule,
  editScopes,
  formatDate,
  formatDateTime,
  inputForScope,
  inputFromOccurrence,
  knownTimeZones,
  parseWall,
  presetLabel,
  SCOPE_LABELS,
  scopeHint,
  toWall,
  zoneLabel,
  type AttendeeInput,
  type EditScope,
  type EventInput,
  type NotificationChannel,
  type Occurrence,
  type RepeatPreset,
} from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import FieldLabel from '@/forms/FieldLabel.vue'
import { provideRequiredFields } from '@/forms/required'
import { EVENT_LOCATION_MAX, EVENT_REMINDERS_MAX, EVENT_SUMMARY_MAX, eventSchema, inputFromValues, ruleOf, valuesFromInput, type EventValues } from '@/forms/calendarEvent'
import AppIcon from '@/components/AppIcon.vue'
import { useCalendarStore } from '@/stores/calendar'
import { useMailStore } from '@/stores/mail'
import KeyShortcut from '@/components/KeyShortcut.vue'

/** A new event can start filled in, say from an email that proposes a time. */
export interface EventPrefill {
  summary?: string
  description?: string
  attendees?: AttendeeInput[]
}

/** What the editor opens on: a new event at a time, or an occurrence to change. */
export type EditorTarget = { kind: 'new'; start: number; allDay: boolean; prefill?: EventPrefill } | { kind: 'edit'; occurrence: Occurrence }

const props = defineProps<{ target: EditorTarget }>()
const emit = defineEmits<{ close: []; saved: [] }>()

provideRequiredFields(eventSchema)

const calendar = useCalendarStore()
const mail = useMailStore()

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
const { defineField, handleSubmit, errors, values, setErrors, setFieldValue, meta } = useForm<EventValues>({
  validationSchema: toTypedSchema(eventSchema),
  initialValues: valuesFromInput(before, calendar.zone),
})
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
const [conferenceUrl] = defineField('conferenceUrl')
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
const error = ref<string | null>(null)
const notify = ref(true)

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

const startWall = computed(() => parseWall(values.allDay ? values.startDate : `${values.startDate}T${values.startTime}`) ?? Date.now())
const presets = computed<{ value: RepeatPreset; label: string }[]>(() => {
  const options: RepeatPreset[] = ['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthlyByDay', 'monthlyByDate', 'yearly']
  const list = options.map((value) => ({ value, label: presetLabel(value, startWall.value) }))
  if (values.repeat === 'custom') {
    list.push({ value: 'custom', label: values.customRule === '' ? 'Custom' : describeRule(values.customRule) })
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
  try {
    const edited = inputFromValues(current, { status: before.status, url: before.url })
    const target = occurrence.value === null ? null : { occurrence: occurrence.value, scope: occurrence.value.recurring ? scope.value : 'all' }
    const input = target === null ? edited : inputForScope(target.occurrence, before, edited, target.scope)
    await calendar.save(input, target, notify.value)
    emit('saved')
  } catch (e) {
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
  if (meta.value.dirty && !window.confirm('Discard the changes to this event?')) {
    return
  }
  emit('close')
}

const dialog = ref<HTMLDialogElement | null>(null)
const titleInput = ref<HTMLInputElement | null>(null)
onMounted(() => {
  dialog.value?.showModal?.()
  titleInput.value?.focus()
})

const repeatSummary = computed(() => {
  const rule = ruleOf(values as EventValues)
  return rule === null ? null : describeRule(rule)
})
</script>

<template>
  <dialog ref="dialog" class="editor" aria-labelledby="editor-title" @cancel.prevent="close">
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
        <label class="field">
          <span>Online meeting link</span>
          <input v-model="conferenceUrl" type="url" placeholder="https://" :aria-invalid="errors.conferenceUrl ? 'true' : undefined" />
          <small v-if="errors.conferenceUrl" class="error">{{ errors.conferenceUrl }}</small>
        </label>

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
  width: min(680px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--surface);
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
  background: var(--surface);
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
  color: var(--surface);
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
