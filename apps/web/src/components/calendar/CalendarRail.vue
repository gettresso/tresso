<script setup lang="ts">
import { computed } from 'vue'
import {
  addDays,
  addMonths,
  longDate,
  MONTH_NAMES,
  startOfMonth,
  startOfWeek,
  wallParts,
  WEEKDAYS_SHORT,
  zoneLabel,
  type SyncedCalendar,
  type SyncedMailAccount,
} from '@tresso/core'
import { calendarColor } from '@/calendar/look'
import AppIcon from '@/components/AppIcon.vue'

const props = defineProps<{
  anchor: number
  today: number
  /** The days the view on screen covers, marked in the mini month. */
  shown: { first: number; last: number }
  calendars: SyncedCalendar[]
  accounts: SyncedMailAccount[]
  zone: string
  now: number
}>()
const emit = defineEmits<{ pick: [day: number]; toggle: [calendarId: string, visible: boolean]; month: [month: number] }>()

const month = computed(() => startOfMonth(props.anchor))
const monthTitle = computed(() => `${MONTH_NAMES[wallParts(month.value).month - 1]} ${wallParts(month.value).year}`)
const weeks = computed(() => {
  const first = startOfWeek(month.value)
  return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (_, day) => addDays(first, week * 7 + day)))
})
const headings = computed(() => weeks.value[0]!.map((day) => WEEKDAYS_SHORT[new Date(day).getUTCDay()]!.slice(0, 2)))
const inMonth = (day: number): boolean => wallParts(day).month === wallParts(month.value).month

/** Calendars grouped by account, the Tresso calendar first. */
const groups = computed(() => {
  const byAccount = new Map<string | null, SyncedCalendar[]>()
  for (const calendar of props.calendars) {
    byAccount.set(calendar.mailAccountId, [...(byAccount.get(calendar.mailAccountId) ?? []), calendar])
  }
  return [...byAccount.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : 0))
    .map(([accountId, calendars]) => {
      const account = props.accounts.find((entry) => entry.id === accountId)
      return { key: accountId ?? 'tresso', name: accountId === null ? 'Tresso' : (account?.displayName ?? 'Account'), meta: account?.emailAddress ?? 'On this account only', calendars }
    })
})
</script>

<template>
  <nav class="rail" aria-label="Calendars">
    <section class="mini" aria-labelledby="mini-title">
      <header class="mini-head">
        <h2 id="mini-title">{{ monthTitle }}</h2>
        <button type="button" class="button button-quiet icon" aria-label="Previous month" @click="emit('month', addMonths(month, -1))"><AppIcon name="back" :size="15" /></button>
        <button type="button" class="button button-quiet icon" aria-label="Next month" @click="emit('month', addMonths(month, 1))"><AppIcon name="next" :size="15" /></button>
      </header>
      <table>
        <thead>
          <tr>
            <th v-for="(heading, index) in headings" :key="index" scope="col">{{ heading }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="week in weeks" :key="week[0]">
            <td v-for="day in week" :key="day">
              <button
                type="button"
                class="day"
                :class="{ outside: !inMonth(day), today: day === today, shown: day >= shown.first && day <= shown.last }"
                :aria-label="longDate(day)"
                :aria-current="day === today ? 'date' : undefined"
                @click="emit('pick', day)"
              >
                {{ wallParts(day).day }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-for="group in groups" :key="group.key" class="group" :aria-label="group.name">
      <h3 class="group-title">{{ group.name }} <span class="meta">{{ group.meta }}</span></h3>
      <label v-for="calendar in group.calendars" :key="calendar.id" class="calendar" :style="calendarColor(calendar)">
        <input type="checkbox" :checked="calendar.visible" @change="emit('toggle', calendar.id, ($event.target as HTMLInputElement).checked)" />
        <span class="box" aria-hidden="true"></span>
        <span class="name">{{ calendar.name }}</span>
        <span v-if="!calendar.writable" class="meta">Read only</span>
      </label>
    </section>

    <p class="zone"><AppIcon name="clock" :size="14" /> {{ zoneLabel(zone, now) }}</p>
    <dl class="keys">
      <div><dt>T</dt><dd>Today</dd></div>
      <div><dt>J K</dt><dd>Next, previous</dd></div>
      <div><dt>1 to 4</dt><dd>Views</dd></div>
      <div><dt>N</dt><dd>New event</dd></div>
    </dl>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  border-right: 1px solid var(--line);
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: var(--glass-edge);
  overflow-y: auto;
}
.mini-head {
  display: flex;
  align-items: center;
  gap: 2px;
}
.mini-head h2 {
  flex: 1;
  margin: 0;
  font: 700 14px var(--font-display);
}
.icon {
  width: 28px;
  height: 28px;
  padding: 0;
}
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
th {
  font: 500 11px var(--font-ui);
  color: var(--ink-3);
}
td {
  padding: 1px;
  text-align: center;
}
.day {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  font: 500 12px var(--font-ui);
  cursor: pointer;
}
.day.outside {
  color: var(--ink-3);
}
.day.shown {
  background: var(--selected);
}
.day.today {
  background: var(--ink);
  color: var(--paper);
}
.group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.group-title {
  display: flex;
  flex-direction: column;
  margin: 0 0 2px;
  font: 600 12px var(--font-ui);
}
.meta {
  font-weight: 400;
  font-size: 11px;
  color: var(--ink-3);
}
.calendar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border-radius: var(--radius-control);
  font-size: 13px;
  cursor: pointer;
}
.calendar input {
  position: absolute;
  opacity: 0;
}
.box {
  flex: none;
  width: 14px;
  height: 14px;
  border: 2px solid var(--cal);
  border-radius: 3px;
}
.calendar input:checked + .box {
  background: var(--cal);
}
.calendar input:focus-visible + .box {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zone {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  color: var(--ink-2);
}
.keys {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  font-size: 12px;
  color: var(--ink-3);
}
.keys div {
  display: flex;
  gap: 8px;
}
.keys dt {
  min-width: 44px;
  font: 500 11px var(--font-mono);
}
.keys dd {
  margin: 0;
}
</style>
