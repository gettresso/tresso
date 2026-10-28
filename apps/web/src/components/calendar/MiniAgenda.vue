<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { inAllDayRow, longDate, occurrenceTimes, occurrenceWhen, relativeDay, startOfWallDay, toWall, type Occurrence } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { calendarColor, joinLabel, occurrenceLabel } from '@/calendar/look'
import AppIcon from '@/components/AppIcon.vue'
import ResponseButtons from '@/components/calendar/ResponseButtons.vue'
import { useCalendarStore, type Response } from '@/stores/calendar'
import { useMailStore } from '@/stores/mail'

/** Today and tomorrow next to mail: what comes next, and the invitations still to answer. */
const calendar = useCalendarStore()
const mail = useMailStore()

const upcoming = ref<Occurrence[]>([])
const now = ref(Date.now())
const busy = ref(false)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  upcoming.value = await calendar.upcoming(14)
}
watch([() => mail.calendarRevision, () => mail.ready, () => mail.calendars], () => void load(), { immediate: true })

let ticking: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  ticking = setInterval(() => (now.value = Date.now()), 30_000)
})
onBeforeUnmount(() => {
  if (ticking !== null) clearInterval(ticking)
})

const today = computed(() => startOfWallDay(toWall(now.value, calendar.zone)))
const soon = computed(() => upcoming.value.filter((occurrence) => occurrence.end > now.value && startOfWallDay(toWall(occurrence.start, calendar.zone)) <= today.value + 86_400_000))
const next = computed(() => soon.value.find((occurrence) => !inAllDayRow(occurrence) && occurrence.event.selfResponse !== 'needs-action') ?? null)
const nextIn = computed(() => {
  if (next.value === null) return ''
  const minutes = Math.round((next.value.start - now.value) / 60_000)
  if (minutes <= 0) return 'Now'
  if (minutes < 60) return `Next, in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  return `Next, at ${occurrenceTimes(next.value, calendar.zone).split(' to ')[0]}`
})
const groups = computed(() => {
  const days = new Map<number, Occurrence[]>()
  for (const occurrence of soon.value) {
    if (occurrence.key === next.value?.key) continue
    const day = Math.max(today.value, startOfWallDay(toWall(occurrence.start, calendar.zone)))
    days.set(day, [...(days.get(day) ?? []), occurrence])
  }
  return [...days.entries()].map(([day, items]) => ({ day, items }))
})
const invitations = computed(() => upcoming.value.filter((occurrence) => occurrence.event.selfResponse === 'needs-action' && occurrence.end > now.value).slice(0, 3))

/** The month and day on the invitation's date tile, in the user's zone. */
function dateTile(occurrence: Occurrence): { month: string; day: number } {
  const wall = new Date(toWall(occurrence.start, calendar.zone))
  return { month: wall.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }), day: wall.getUTCDate() }
}

async function respond(occurrence: Occurrence, response: Response): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await calendar.respond(occurrence, response, false)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <aside class="mini-agenda" aria-labelledby="mini-agenda-title">
    <header class="head">
      <h2 id="mini-agenda-title">Today <span class="sub">{{ longDate(today) }}</span></h2>
      <RouterLink :to="{ name: 'calendar' }" class="button button-quiet"><AppIcon name="calendar" :size="15" /> Calendar</RouterLink>
    </header>

    <p v-if="calendar.calendars.length === 0" class="empty">No calendars yet.</p>

    <section v-if="next" class="next" :style="calendarColor(calendar.calendar(next.event.calendarId))" aria-label="Next event">
      <p class="label">{{ nextIn }}</p>
      <RouterLink class="next-title" :to="{ name: 'calendar', params: { view: 'day' } }" :aria-label="occurrenceLabel(next, calendar.zone, calendar.calendar(next.event.calendarId), now)">
        {{ next.event.summary || 'Untitled event' }}
      </RouterLink>
      <p class="meta">{{ occurrenceTimes(next, calendar.zone) }}<template v-if="next.event.location">, {{ next.event.location }}</template></p>
      <a v-if="next.event.conference" class="button button-primary join" :href="next.event.conference.url" target="_blank" rel="noopener noreferrer">
        <AppIcon name="video" :size="15" /> {{ joinLabel(next.event.conference.provider) }}
      </a>
    </section>

    <section v-for="group in groups" :key="group.day" class="day" :aria-label="relativeDay(group.day, today)">
      <h3 v-if="group.day !== today">{{ relativeDay(group.day, today) }}</h3>
      <ul>
        <li v-for="occurrence in group.items" :key="occurrence.key" class="item" :style="calendarColor(calendar.calendar(occurrence.event.calendarId))">
          <span class="bar" aria-hidden="true"></span>
          <span class="time">{{ occurrenceTimes(occurrence, calendar.zone) }}</span>
          <span class="title">{{ occurrence.event.summary || 'Untitled event' }}</span>
        </li>
      </ul>
    </section>
    <p v-if="calendar.calendars.length > 0 && next === null && groups.length === 0" class="empty">Nothing else planned today or tomorrow.</p>

    <section v-if="invitations.length > 0" class="invitations" aria-labelledby="mini-invitations-title">
      <h3 id="mini-invitations-title">Invitations to answer</h3>
      <article v-for="occurrence in invitations" :key="occurrence.key" class="invite" :style="calendarColor(calendar.calendar(occurrence.event.calendarId))">
        <span class="date" aria-hidden="true">
          <span class="month">{{ dateTile(occurrence).month }}</span>
          <span class="day-number">{{ dateTile(occurrence).day }}</span>
        </span>
        <div class="invite-body">
          <p class="invite-title">{{ occurrence.event.summary || 'Untitled event' }}</p>
          <p class="meta">{{ occurrenceWhen(occurrence, calendar.zone, today) }}</p>
          <p v-if="occurrence.event.organizer" class="meta">From {{ occurrence.event.organizer.name || occurrence.event.organizer.address }}</p>
          <ResponseButtons class="answer" :current="occurrence.event.selfResponse" :busy="busy" :label="`Answer ${occurrence.event.summary}`" @respond="(r) => respond(occurrence, r)" />
        </div>
      </article>
    </section>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </aside>
</template>

<style scoped>
.mini-agenda {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 520px;
  padding: 40px 32px;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
}
h2 {
  flex: 1;
  margin: 0;
  font: 700 18px var(--font-display);
}
.sub {
  margin-left: 4px;
  font: 500 13px var(--font-ui);
  color: var(--ink-3);
}
h3 {
  margin: 0 0 6px;
  font: 600 13px var(--font-ui);
  color: var(--ink-2);
}
p {
  margin: 0;
}
.next {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-left: 3px solid var(--cal);
  border-radius: var(--radius-card);
  background: color-mix(in srgb, var(--cal) 12%, var(--paper));
}
.label {
  font: 600 12px var(--font-ui);
  color: var(--ink-2);
}
.next-title {
  font: 700 16px var(--font-display);
  color: var(--ink);
  text-decoration: none;
}
.meta {
  font-size: 12px;
  color: var(--ink-2);
}
.join {
  align-self: flex-start;
  margin-top: 6px;
}
ul {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.item {
  display: grid;
  grid-template-columns: 3px 110px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  font-size: 13px;
}
.bar {
  height: 18px;
  border-radius: 2px;
  background: var(--cal);
}
.time {
  color: var(--ink-2);
}
.title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.invitations {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.invite {
  display: flex;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: 0 1px 2px rgb(22 24 29 / 4%);
}
.date {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  width: 48px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--surface);
  text-align: center;
}
.month {
  align-self: stretch;
  padding: 2px 0;
  background: var(--cal);
  color: #fff;
  font: 700 11px/16px var(--font-ui);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.day-number {
  padding: 2px 0 4px;
  font: 700 20px/26px var(--font-display);
}
.invite-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.invite-title {
  font: 700 15px/20px var(--font-display);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.answer {
  align-self: flex-start;
  margin-top: 10px;
}
.empty {
  color: var(--ink-3);
}
.error {
  color: var(--danger);
  font-size: 13px;
}
</style>
