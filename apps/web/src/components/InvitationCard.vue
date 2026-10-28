<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  attendeeSummary,
  describeRule,
  formatDate,
  instantOf,
  occurrenceTimes,
  occurrenceWhen,
  RESPONSE_WORDS,
  toWall,
  type Occurrence,
  type SyncedCalendarEvent,
} from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { joinLabel } from '@/calendar/look'
import AppIcon from '@/components/AppIcon.vue'
import ResponseButtons from '@/components/calendar/ResponseButtons.vue'
import { useCalendarStore, type InvitationConflict, type MessageInvitation, type Response } from '@/stores/calendar'

/** The calendar object a message carries: what it is about, the user's answer, and what else is planned then. */
const props = defineProps<{ messageId: string }>()

const calendar = useCalendarStore()
const invitation = ref<MessageInvitation | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)
const status = ref('')
/** The message carries calendar data the API keeps no invitation for (a counter proposal, say): nothing to show. */
const missing = ref(false)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    invitation.value = await calendar.invitation(props.messageId)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      missing.value = true
    } else {
      error.value = errorMessage(e)
    }
  } finally {
    loading.value = false
  }
}
onMounted(load)

/** The invitation as an occurrence, so it is written like events in the calendar. */
const shown = computed<Occurrence | null>(() => {
  const value = invitation.value
  if (value === null) return null
  const event = { allDay: value.allDay, start: value.start, end: value.end } as SyncedCalendarEvent
  const start = instantOf(value.start, calendar.zone)
  return {
    key: value.id,
    event,
    seriesId: value.eventId ?? value.id,
    series: null,
    recurrenceId: value.recurrenceId,
    recurring: value.recurrenceId !== null,
    first: false,
    allDay: value.allDay,
    start,
    end: Math.max(start, instantOf(value.end, calendar.zone)),
    startDate: 'date' in value.start ? value.start.date : null,
    endDate: 'date' in value.end ? value.end.date : null,
    timeZone: 'dateTime' in value.start ? value.start.timeZone : null,
    fromServer: false,
  }
})

const heading = computed(() => {
  switch (invitation.value?.kind) {
    case 'update':
      return 'Updated invitation'
    case 'cancelled':
      return 'Cancelled'
    case 'reply':
      return 'Answer to your invitation'
    case 'outdated':
      return 'Older version of an invitation'
    default:
      return 'Invitation'
  }
})

const repeats = computed(() => {
  const value = invitation.value
  if (value === null) return null
  if (value.recurrence !== null) return describeRule(value.recurrence)
  return value.recurrenceId !== null ? 'One event of a series.' : null
})

const people = computed(() => attendeeSummary(invitation.value?.attendees.map((person) => person.partstat) ?? []))
// An update the calendar has not taken yet is applied first: an answer refers to the version in the calendar.
const canAnswer = computed(() => invitation.value !== null && !invitation.value.canApply && invitation.value.canRespond && invitation.value.eventId !== null && invitation.value.kind !== 'cancelled' && invitation.value.kind !== 'reply')
const day = computed(() => (shown.value === null ? null : formatDate(toWall(shown.value.start, calendar.zone))))

/** Occurrences from the API carry UTC instants (2026-10-22T08:30:00+00:00) for timed events, dates otherwise. */
function occurrenceInstant(time: InvitationConflict['start']): number {
  return 'date' in time ? instantOf(time, calendar.zone) : Date.parse(time.dateTime)
}

function conflictTimes(conflict: InvitationConflict): string {
  const start = occurrenceInstant(conflict.start)
  const end = Math.max(start, occurrenceInstant(conflict.end))
  const occurrence = { allDay: conflict.allDay, start, end, startDate: 'date' in conflict.start ? conflict.start.date : null, endDate: 'date' in conflict.end ? conflict.end.date : null } as Occurrence
  return occurrenceTimes(occurrence, calendar.zone)
}

async function respond(response: Response): Promise<void> {
  const value = invitation.value
  if (value === null || value.eventId === null) return
  busy.value = true
  error.value = null
  try {
    await calendar.respondTo(value.eventId, response, value.recurrenceId)
    invitation.value = { ...value, selfResponse: response }
    status.value = `Answered: ${RESPONSE_WORDS[response]}.`
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function apply(): Promise<void> {
  busy.value = true
  error.value = null
  try {
    invitation.value = await calendar.applyInvitation(props.messageId)
    status.value = 'Added to your calendar.'
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

/** Y, M and N answer while the card has focus. */
function onKeydown(event: KeyboardEvent): void {
  if (!canAnswer.value || busy.value || event.metaKey || event.ctrlKey || event.altKey) return
  const target = event.target as HTMLElement
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  const response = ({ y: 'accepted', m: 'tentative', n: 'declined' } as const)[event.key.toLowerCase() as 'y' | 'm' | 'n']
  if (response !== undefined) {
    event.preventDefault()
    event.stopPropagation()
    void respond(response)
  }
}
</script>

<template>
  <section v-if="!missing" class="invitation" tabindex="0" aria-labelledby="invitation-title" @keydown="onKeydown">
    <p v-if="loading" class="state">Loading the invitation…</p>
    <p v-else-if="invitation === null" class="state error" role="alert">
      The invitation could not be loaded. <button type="button" class="link" @click="load">Try again</button>
    </p>
    <template v-else-if="shown">
      <p class="kind" :class="invitation.kind">
        <AppIcon name="calendar" :size="15" /> {{ heading }}
      </p>
      <h3 id="invitation-title" class="title" :class="{ cancelled: invitation.kind === 'cancelled' }">{{ invitation.summary || 'Untitled event' }}</h3>
      <p class="when">{{ occurrenceWhen(shown, calendar.zone, calendar.today) }}</p>
      <p v-if="repeats" class="line"><AppIcon name="repeat" :size="14" /> {{ repeats }}</p>
      <p v-if="invitation.organizer" class="line"><AppIcon name="people" :size="14" /> Organizer {{ invitation.organizer.name || invitation.organizer.address }}<template v-if="people">. {{ people }}</template></p>
      <p v-if="invitation.location" class="line"><AppIcon name="place" :size="14" /> {{ invitation.location }}</p>
      <a v-if="invitation.conference" class="button button-quiet join" :href="invitation.conference.url" target="_blank" rel="noopener noreferrer">
        <AppIcon name="video" :size="15" /> {{ joinLabel(invitation.conference.provider) }}
      </a>

      <div v-if="invitation.conflicts.length > 0" class="conflicts">
        <p class="label">Your {{ shown.allDay ? 'day' : 'time' }}</p>
        <p v-for="conflict in invitation.conflicts" :key="conflict.id" class="conflict">
          Overlaps {{ conflict.summary || 'an event' }}, {{ conflictTimes(conflict) }}<template v-if="conflict.selfResponse === 'tentative'"> (maybe)</template>
        </p>
      </div>

      <div v-if="invitation.canApply" class="answer">
        <p class="label">
          This {{ invitation.kind === 'cancelled' ? 'cancellation' : invitation.kind === 'reply' ? 'answer' : invitation.kind === 'update' ? 'update' : 'invitation' }} is not in your calendar yet.
          <template v-if="invitation.canRespond && invitation.kind !== 'cancelled' && invitation.kind !== 'reply'">Add it before you answer, so your answer is about this version.</template>
        </p>
        <button type="button" class="button button-primary" :disabled="busy" @click="apply">{{ invitation.kind === 'cancelled' ? 'Apply the cancellation' : invitation.kind === 'reply' ? 'Apply the answer' : invitation.kind === 'update' ? 'Apply the update' : 'Add to calendar' }}</button>
      </div>
      <div v-else-if="canAnswer" class="answer">
        <p class="label">
          {{ invitation.selfResponse === null || invitation.selfResponse === 'needs-action' ? 'Going?' : `You answered: ${RESPONSE_WORDS[invitation.selfResponse]}` }}
        </p>
        <ResponseButtons :current="invitation.selfResponse" :busy="busy" label="Answer the invitation" shortcuts @respond="respond" />
      </div>

      <RouterLink v-if="day && invitation.eventId" class="open" :to="{ name: 'calendar', params: { view: 'day', date: day } }">Open in calendar</RouterLink>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p class="visually-hidden" role="status" aria-live="polite">{{ status }}</p>
    </template>
  </section>
</template>

<style scoped>
.invitation {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 16px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: var(--glass-edge);
}
.invitation:focus-visible {
  outline: 2px solid var(--focus);
}
p {
  margin: 0;
}
.kind {
  display: flex;
  align-items: center;
  gap: 6px;
  font: 600 12px var(--font-ui);
  color: var(--ink-2);
}
.kind.cancelled {
  color: var(--danger);
}
.title {
  margin: 0;
  font: 700 17px/22px var(--font-display);
}
.title.cancelled {
  text-decoration: line-through;
}
.when {
  font-weight: 600;
}
.line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--ink-2);
}
.join {
  align-self: flex-start;
}
.conflicts {
  padding: 8px 10px;
  border-radius: var(--radius-control);
  background: var(--ground);
  font-size: 13px;
}
.label {
  font-weight: 600;
  font-size: 13px;
}
.answer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
.answer .button {
  align-self: flex-start;
}
.open {
  font-size: 13px;
  font-weight: 600;
}
.state {
  color: var(--ink-2);
}
.error {
  color: var(--danger);
  font-size: 13px;
}
.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--focus);
  cursor: pointer;
}
</style>
