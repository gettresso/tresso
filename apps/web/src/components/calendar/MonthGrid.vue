<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  addDays,
  cellOverflow,
  inAllDayRow,
  isoWeek,
  isTodoBlock,
  layoutSpans,
  longDate,
  MONTH_NAMES,
  timeIn,
  wallParts,
  WEEKDAYS_SHORT,
  weekdayOf,
  type CalendarDay,
  type Occurrence,
  type SyncedCalendar,
  type TodoBlock,
} from '@tresso/core'
import { blockState, calendarColor, occurrenceLabel, TODO_COLOR, todoBlockLabel } from '@/calendar/look'

const props = withDefaults(
  defineProps<{
    days: CalendarDay[]
    /** Any day of the month on screen. */
    month: number
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
const emit = defineEmits<{ open: [occurrence: Occurrence]; openTodo: [block: TodoBlock]; showDay: [day: number]; create: [start: number, allDay: boolean] }>()

/** Three items per cell, then "+N more". */
const VISIBLE = 3

const weeks = computed(() => {
  const rows: CalendarDay[][] = []
  for (let index = 0; index < props.days.length; index += 7) {
    rows.push(props.days.slice(index, index + 7))
  }
  return rows.map((days) => {
    const items = layoutSpans<Occurrence | TodoBlock>([...props.occurrences, ...props.todoBlocks], days)
    return {
      days,
      cells: days.map((day, index) => ({ day, ...cellOverflow(items, index, VISIBLE) })),
    }
  })
})

const monthNumber = computed(() => wallParts(props.month).month)
const monthLabel = computed(() => `${MONTH_NAMES[monthNumber.value - 1]} ${wallParts(props.month).year}`)
const inMonth = (day: CalendarDay): boolean => wallParts(day.wall).month === monthNumber.value
const headings = computed(() => props.days.slice(0, 7).map((day) => WEEKDAYS_SHORT[weekdayOf(day.wall)]))

// The grid pattern: one cell is in the tab order, the arrow keys move between days.
const focused = ref(props.today)
watch(
  () => props.days,
  (days) => {
    if (!days.some((day) => day.wall === focused.value)) {
      focused.value = days.find((day) => day.wall === props.today)?.wall ?? days.find(inMonth)?.wall ?? days[0]?.wall ?? props.today
    }
  },
  { immediate: true },
)
const root = ref<HTMLElement | null>(null)

/** The events and "+N more" of the cell an element is in, in order. */
function cellItems(element: Element): HTMLElement[] {
  const cell = element.closest<HTMLElement>('[data-day]')
  return cell === null ? [] : [...cell.querySelectorAll<HTMLElement>('[data-cell-item]')]
}

/**
 * The grid pattern: the arrow keys move between days; Enter moves into a day's events (or opens a day without any),
 * where the up and down arrows move between them and "+N more", and Escape goes back to the day.
 */
function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement
  if (target.closest('[data-cell-item]') !== null) {
    const items = cellItems(target)
    const at = items.indexOf(target)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      items[Math.min(items.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      target.closest<HTMLElement>('[data-day]')?.focus()
    }
    return
  }
  const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
  let next: number | null = null
  if (event.key in moves) {
    next = addDays(focused.value, moves[event.key]!)
  } else if (event.key === 'Home') {
    next = addDays(focused.value, -((weekdayOf(focused.value) + 6) % 7))
  } else if (event.key === 'End') {
    next = addDays(focused.value, 6 - ((weekdayOf(focused.value) + 6) % 7))
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const first = cellItems(target)[0]
    if (first !== undefined) {
      first.focus()
    } else {
      emit('showDay', focused.value)
    }
    return
  }
  if (next === null || !props.days.some((day) => day.wall === next)) {
    return
  }
  event.preventDefault()
  focused.value = next
  void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-day="${next}"]`)?.focus())
}

function itemTime(item: Occurrence | TodoBlock): string {
  return inAllDayRow(item) ? '' : timeIn(item.start, props.zone)
}

/** How an item of a day looks: an event in its calendar's color, or a todo's planned time in the Do colors. */
function itemLook(item: Occurrence | TodoBlock): { state: Record<string, boolean>; color: Record<string, string>; label: string; title: string } {
  if (isTodoBlock(item)) {
    return { state: { todo: true, conflict: item.conflict, past: item.end <= props.now }, color: TODO_COLOR, label: todoBlockLabel(item, props.zone, props.now), title: item.todo.title }
  }
  const calendar = props.calendars(item.event.calendarId)
  return { state: blockState(item, props.now), color: calendarColor(calendar), label: occurrenceLabel(item, props.zone, calendar, props.now), title: item.event.summary || 'Untitled event' }
}

function openItem(item: Occurrence | TodoBlock): void {
  if (isTodoBlock(item)) {
    emit('openTodo', item)
  } else {
    emit('open', item)
  }
}
</script>

<template>
  <div ref="root" class="month" role="grid" aria-readonly="true" :aria-label="monthLabel" aria-description="Arrow keys move between days. Enter moves to the events of a day, Escape back to the day." @keydown="onKeydown">
    <div class="row head" role="row">
      <span class="week-number" role="columnheader"><span class="visually-hidden">Week</span></span>
      <span v-for="name in headings" :key="name" role="columnheader" class="heading">{{ name }}</span>
    </div>
    <div v-for="week in weeks" :key="week.days[0]!.wall" class="row week" role="row">
      <span class="week-number" role="rowheader">{{ isoWeek(week.days[0]!.wall) }}</span>
      <div
        v-for="cell in week.cells"
        :key="cell.day.wall"
        class="cell"
        role="gridcell"
        :class="{ outside: !inMonth(cell.day), today: cell.day.wall === today }"
        :data-day="cell.day.wall"
        :tabindex="focused === cell.day.wall ? 0 : -1"
        :aria-label="`${longDate(cell.day.wall)}${cell.shown.length + cell.more === 0 ? ', nothing planned' : `, ${cell.shown.length + cell.more} ${cell.shown.length + cell.more === 1 ? 'item' : 'items'}`}`"
        :aria-current="cell.day.wall === today ? 'date' : undefined"
        @focus="focused = cell.day.wall"
        @dblclick.self="emit('create', cell.day.start, true)"
      >
        <button type="button" class="date" tabindex="-1" :aria-label="`Show ${longDate(cell.day.wall)}`" @click="emit('showDay', cell.day.wall)">{{ wallParts(cell.day.wall).day }}</button>
        <ul class="items">
          <li v-for="item in cell.shown" :key="item.occurrence.key">
            <button
              type="button"
              class="item"
              :class="{ ...itemLook(item.occurrence).state, filled: inAllDayRow(item.occurrence), selected: item.occurrence.key === selectedKey }"
              :style="itemLook(item.occurrence).color"
              data-occurrence=""
              :data-key="item.occurrence.key"
              data-cell-item=""
              tabindex="-1"
              :aria-label="itemLook(item.occurrence).label"
              @click="openItem(item.occurrence)"
            >
              <span v-if="!inAllDayRow(item.occurrence)" class="dot" aria-hidden="true"></span>
              <span v-if="itemTime(item.occurrence)" class="time">{{ itemTime(item.occurrence) }}</span>
              <span class="title">{{ itemLook(item.occurrence).title }}</span>
            </button>
          </li>
          <li v-if="cell.more > 0">
            <button type="button" class="more" tabindex="-1" data-cell-item="" @click="emit('showDay', cell.day.wall)">+{{ cell.more }} more</button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.month {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: var(--glass-edge);
}
.row {
  display: grid;
  grid-template-columns: 32px repeat(7, minmax(0, 1fr));
}
.head {
  border-bottom: 1px solid var(--line);
}
.heading {
  padding: 8px;
  font: 600 12px var(--font-ui);
  color: var(--ink-2);
}
.week {
  flex: 1 0 150px;
  border-bottom: 1px solid var(--line);
}
.week-number {
  padding: 8px 4px;
  font: 500 11px var(--font-ui);
  color: var(--ink-3);
  text-align: center;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 4px;
  border-left: 1px solid var(--line);
}
.cell.outside {
  background: var(--ground);
}
.cell.outside .date {
  color: var(--ink-3);
}
.date {
  align-self: flex-start;
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  font: 600 12px var(--font-ui);
  cursor: pointer;
}
.cell.today .date {
  background: var(--ink);
  color: var(--paper);
}
.items {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.item {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 1px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ink);
  font: 400 12px/18px var(--font-ui);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  cursor: pointer;
}
.item.filled {
  background: color-mix(in srgb, var(--cal) 16%, var(--paper));
  color: color-mix(in srgb, var(--cal) 65%, var(--ink));
  font-weight: 600;
}
.item.pending.filled {
  background: var(--paper);
  border: 1px dashed var(--cal);
}
.item.past {
  opacity: 0.55;
}
.item.selected {
  box-shadow: 0 0 0 2px var(--focus);
}
.dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cal);
}
.item.pending .dot,
.item.conflict .dot {
  background: transparent;
  border: 1px solid var(--cal);
}
.item.todo .title {
  color: color-mix(in srgb, var(--cal) 65%, var(--ink));
}
.time {
  color: var(--ink-2);
}
.title {
  overflow: hidden;
  text-overflow: ellipsis;
}
.more {
  padding: 0 6px;
  border: 0;
  background: transparent;
  color: var(--ink-2);
  font: 600 12px var(--font-ui);
  cursor: pointer;
}
</style>
