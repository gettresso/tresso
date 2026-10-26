<script setup lang="ts">
import { computed } from 'vue'
import {
  isTodoBlock,
  occurrenceTimes,
  relativeDay,
  RESPONSE_WORDS,
  shortDate,
  todoBlockTimes,
  type CalendarDay,
  type Occurrence,
  type SyncedCalendar,
  type TodoBlock,
} from '@tresso/core'
import { calendarColor, joinLabel, occurrenceLabel, TODO_COLOR, todoBlockLabel } from '@/calendar/look'
import AppIcon from '@/components/AppIcon.vue'

const props = withDefaults(
  defineProps<{
    days: CalendarDay[]
    occurrences: Occurrence[]
    /** Time planned for todos, listed among the events. */
    todoBlocks?: TodoBlock[]
    zone: string
    now: number
    today: number
    calendars: (id: string) => SyncedCalendar | undefined
    selectedKey: string | null
  }>(),
  { todoBlocks: () => [] },
)
const emit = defineEmits<{ open: [occurrence: Occurrence]; openTodo: [block: TodoBlock] }>()

/**
 * Days with something planned, each with what touches it; a multi-day event is listed on each of its days. A todo's
 * planned time goes among the events by its start.
 */
const groups = computed(() =>
  props.days
    .map((day) => ({
      day,
      items: [
        ...props.occurrences.filter((occurrence) => (occurrence.end === occurrence.start ? occurrence.start >= day.start && occurrence.start < day.end : occurrence.start < day.end && occurrence.end > day.start)),
        ...props.todoBlocks.filter((block) => block.start < day.end && block.end > day.start),
      ].sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || a.start - b.start),
    }))
    .filter((group) => group.items.length > 0),
)

function chip(occurrence: Occurrence): string | null {
  const response = occurrence.event.selfResponse
  if (response === null) {
    return occurrence.event.attendees.length > 0 ? 'Organizer' : null
  }
  return RESPONSE_WORDS[response]
}

function sub(day: CalendarDay): string {
  const label = relativeDay(day.wall, props.today)
  return label === 'Today' || label === 'Tomorrow' || label === 'Yesterday' ? shortDate(day.wall) : ''
}
</script>

<template>
  <div class="agenda">
    <p v-if="groups.length === 0" class="empty">Nothing planned in these {{ days.length }} days.</p>
    <section v-for="group in groups" :key="group.day.wall" class="day" :aria-labelledby="`agenda-${group.day.wall}`">
      <h3 :id="`agenda-${group.day.wall}`" class="day-title" :class="{ today: group.day.wall === today }">
        {{ relativeDay(group.day.wall, today) }} <span class="sub">{{ sub(group.day) }}</span>
      </h3>
      <ul class="rows">
        <template v-for="occurrence in group.items" :key="occurrence.key">
          <li v-if="isTodoBlock(occurrence)" class="row todo" :class="{ past: occurrence.end <= now }" :style="TODO_COLOR">
            <button type="button" class="open" :class="{ selected: occurrence.key === selectedKey }" :aria-label="todoBlockLabel(occurrence, zone, now)" @click="emit('openTodo', occurrence)">
              <span class="bar" aria-hidden="true"></span>
              <span class="time">{{ todoBlockTimes(occurrence, zone) }}</span>
              <span class="text">
                <span class="title">{{ occurrence.todo.title }}</span>
                <span class="meta">Todo<template v-if="occurrence.conflict">, that time is taken</template></span>
              </span>
              <span class="chip" :class="{ pending: occurrence.conflict }">{{ occurrence.conflict ? 'Conflict' : 'Planned' }}</span>
            </button>
          </li>
          <li v-else class="row" :class="{ past: occurrence.end <= now }" :style="calendarColor(calendars(occurrence.event.calendarId))" :data-key="occurrence.key">
            <button
              type="button"
              class="open"
              :class="{ selected: occurrence.key === selectedKey }"
              :aria-label="occurrenceLabel(occurrence, zone, calendars(occurrence.event.calendarId), now)"
              @click="emit('open', occurrence)"
            >
              <span class="bar" aria-hidden="true"></span>
              <span class="time">{{ occurrenceTimes(occurrence, zone) }}</span>
              <span class="text">
                <span class="title">{{ occurrence.event.summary || 'Untitled event' }}</span>
                <span class="meta">
                  <template v-if="occurrence.event.location">{{ occurrence.event.location }}, </template>{{ calendars(occurrence.event.calendarId)?.name ?? '' }}
                </span>
              </span>
              <span v-if="chip(occurrence)" class="chip" :class="{ pending: occurrence.event.selfResponse === 'needs-action' }">{{ chip(occurrence) }}</span>
            </button>
            <a v-if="occurrence.event.conference" class="button button-quiet join" :href="occurrence.event.conference.url" target="_blank" rel="noopener noreferrer">
              <AppIcon name="video" :size="15" /> {{ joinLabel(occurrence.event.conference.provider) }}
            </a>
          </li>
        </template>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.agenda {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 24px 24px;
  background: var(--surface);
}
.empty {
  color: var(--ink-3);
}
.day-title {
  margin: 16px 0 6px;
  font: 700 15px/20px var(--font-display);
}
.day-title .sub {
  margin-left: 6px;
  font: 500 12px var(--font-ui);
  color: var(--ink-3);
}
.rows {
  margin: 0;
  padding: 0;
  list-style: none;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--line);
}
.row.past {
  opacity: 0.55;
}
.open {
  flex: 1;
  display: grid;
  grid-template-columns: 3px 120px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 8px 4px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.open:hover,
.open.selected {
  background: var(--selected);
}
.bar {
  align-self: stretch;
  border-radius: 2px;
  background: var(--cal);
}
.time {
  font: 500 13px var(--font-ui);
  color: var(--ink-2);
}
.text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 12px;
  color: var(--ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip {
  padding: 0 8px;
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-2);
  font: 600 11px/20px var(--font-ui);
}
.chip.pending {
  background: var(--surface);
  border: 1px dashed var(--cal);
}
.join {
  height: 30px;
}
</style>
