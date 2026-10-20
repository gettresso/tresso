<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  attendeeSummary,
  canEdit,
  canWrite,
  describeRule,
  occurrenceTimes,
  occurrenceWhen,
  RESPONSE_WORDS,
  toWall,
  zoneLabel,
  type Occurrence,
  type SyncedCalendar,
} from '@tresso/core'
import { calendarColor, joinLabel } from '@/calendar/look'
import AppIcon from '@/components/AppIcon.vue'
import ResponseButtons from '@/components/calendar/ResponseButtons.vue'
import type { Response } from '@/stores/calendar'

const props = defineProps<{
  occurrence: Occurrence
  calendar: SyncedCalendar | undefined
  zone: string
  now: number
  busy: boolean
  error: string | null
}>()
const emit = defineEmits<{ close: []; edit: []; delete: []; respond: [response: Response, onlyThis: boolean] }>()

const event = computed(() => props.occurrence.event)
const editable = computed(() => canEdit(event.value, props.calendar))
const answerable = computed(() => event.value.selfResponse !== null && canWrite(props.calendar))
const rule = computed(() => props.occurrence.series?.recurrence ?? null)
const onlyThis = ref(false)

/** The event's own zone as a plain sentence, when it is not the one on screen. */
const ownZone = computed(() => {
  const zone = props.occurrence.timeZone
  if (zone === null || zone === props.zone || props.occurrence.allDay) {
    return null
  }
  return `${occurrenceTimes(props.occurrence, zone)} in ${zoneLabel(zone, props.occurrence.start)}.`
})

const people = computed(() => event.value.attendees)
const summary = computed(() => attendeeSummary(people.value.map((person) => person.partstat)))
const organizer = computed(() => event.value.organizer)

function initials(name: string | null, address: string): string {
  const source = name?.trim() || address
  return source
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
}
</script>

<template>
  <aside class="detail" role="dialog" aria-modal="false" aria-labelledby="detail-title" :style="calendarColor(calendar)" @keydown.esc.stop="emit('close')">
    <header class="header">
      <span class="swatch" aria-hidden="true"></span>
      <h2 id="detail-title">{{ event.summary || 'Untitled event' }}</h2>
      <button type="button" class="button button-quiet icon" aria-label="Close" @click="emit('close')"><AppIcon name="close" /></button>
    </header>

    <p class="when">{{ occurrenceWhen(occurrence, zone, toWall(now, zone)) }}</p>
    <p v-if="ownZone" class="hint">{{ ownZone }}</p>
    <p v-if="rule" class="line"><AppIcon name="repeat" :size="15" /> {{ describeRule(rule) }}</p>
    <p v-if="event.status === 'cancelled'" class="cancelled" role="status">This event was cancelled.</p>
    <p v-if="event.syncError" class="error" role="alert">Not saved at the provider: {{ event.syncError }}</p>

    <a v-if="event.conference" class="button button-primary join" :href="event.conference.url" target="_blank" rel="noopener noreferrer">
      <AppIcon name="video" :size="16" /> {{ joinLabel(event.conference.provider) }}
    </a>
    <p v-if="event.conference?.dialIn" class="hint">Dial in: {{ event.conference.dialIn }}</p>
    <p v-if="event.location" class="line"><AppIcon name="place" :size="15" /> {{ event.location }}</p>
    <p v-if="calendar" class="line"><AppIcon name="calendar" :size="15" /> {{ calendar.name }}</p>

    <section v-if="people.length > 0" class="people" aria-labelledby="people-title">
      <h3 id="people-title"><AppIcon name="people" :size="15" /> {{ summary }}</h3>
      <ul>
        <li v-if="organizer" class="person">
          <span class="initials" aria-hidden="true">{{ initials(organizer.name, organizer.address) }}</span>
          <span class="name">{{ organizer.name || organizer.address }}</span>
          <span class="status">Organizer</span>
        </li>
        <li v-for="person in people" :key="person.address" class="person">
          <span class="initials" aria-hidden="true">{{ initials(person.name, person.address) }}</span>
          <span class="name">{{ person.name || person.address }}<template v-if="person.role === 'optional'">, optional</template></span>
          <span class="status">{{ RESPONSE_WORDS[person.partstat] }}</span>
        </li>
      </ul>
    </section>

    <p v-if="event.description" class="description">{{ event.description }}</p>

    <section v-if="answerable" class="answer" aria-label="Your answer">
      <p class="label">Going? <span class="current">{{ RESPONSE_WORDS[event.selfResponse!] }}</span></p>
      <label v-if="occurrence.recurring" class="only-this">
        <input v-model="onlyThis" type="checkbox" /> Only this event
      </label>
      <ResponseButtons :current="event.selfResponse" :busy="busy" label="Answer the invitation" @respond="(r) => emit('respond', r, onlyThis)" />
    </section>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <footer v-if="editable" class="actions">
      <button type="button" class="button button-primary" :disabled="busy" @click="emit('edit')">Edit <kbd>E</kbd></button>
      <button type="button" class="button button-quiet" :disabled="busy" @click="emit('delete')"><AppIcon name="trash" :size="15" /> Delete</button>
    </footer>
  </aside>
</template>

<style scoped>
.detail {
  animation: fade-in var(--motion-base) ease-out;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 340px;
  max-width: 100%;
  padding: 16px;
  border-left: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--raised);
  overflow-y: auto;
}
.header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.swatch {
  flex: none;
  width: 12px;
  height: 12px;
  margin-top: 6px;
  border-radius: 3px;
  background: var(--cal);
}
h2 {
  flex: 1;
  margin: 0;
  font: 700 18px/24px var(--font-display);
  overflow-wrap: anywhere;
}
.icon {
  width: 32px;
  height: 32px;
  padding: 0;
}
p {
  margin: 0;
}
.when {
  font-weight: 600;
}
.hint,
.line {
  color: var(--ink-2);
  font-size: 13px;
}
.line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.join {
  align-self: flex-start;
}
.cancelled,
.error {
  color: var(--danger);
  font-size: 13px;
}
.people h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
  font: 600 13px var(--font-ui);
}
.people ul {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.person {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.initials {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--ground);
  font: 600 11px var(--font-ui);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status {
  color: var(--ink-3);
  font-size: 12px;
}
.description {
  white-space: pre-wrap;
  font-size: 13px;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.answer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.label {
  font-weight: 600;
}
.current {
  margin-left: 6px;
  font-weight: 500;
  color: var(--ink-3);
}
.only-this {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.actions {
  display: flex;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
</style>
