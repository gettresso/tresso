<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  editScopes,
  formatDate,
  isoWeek,
  longDate,
  MONTH_NAMES,
  occurrenceWhen,
  parseWall,
  shortDate,
  toInstant,
  toWall,
  wallParts,
  type EditScope,
  type Occurrence,
  type TodoBlock,
} from '@tresso/core'
import { errorMessage } from '@/api/errors'
import AppIcon from '@/components/AppIcon.vue'
import AgendaList from '@/components/calendar/AgendaList.vue'
import CalendarRail from '@/components/calendar/CalendarRail.vue'
import EventDetail from '@/components/calendar/EventDetail.vue'
import EventEditor, { type EditorTarget } from '@/components/calendar/EventEditor.vue'
import MonthGrid from '@/components/calendar/MonthGrid.vue'
import ResponseButtons from '@/components/calendar/ResponseButtons.vue'
import ScopeDialog from '@/components/calendar/ScopeDialog.vue'
import TimeGrid from '@/components/calendar/TimeGrid.vue'
import TodoBlockDetail from '@/components/calendar/TodoBlockDetail.vue'
import { useCalendarStore, type CalendarViewKind, type Response } from '@/stores/calendar'
import { useMailStore } from '@/stores/mail'
import { useTodosStore } from '@/stores/todos'

const calendar = useCalendarStore()
const mail = useMailStore()
const todos = useTodosStore()
const route = useRoute()
const router = useRouter()

const VIEWS: { kind: CalendarViewKind; label: string; key: string }[] = [
  { kind: 'day', label: 'Day', key: '1' },
  { kind: 'week', label: 'Week', key: '2' },
  { kind: 'month', label: 'Month', key: '3' },
  { kind: 'agenda', label: 'Agenda', key: '4' },
]

// The route says which view and day are on screen, so the back button and links work.
watch(
  () => [route.params.view, route.params.date] as const,
  ([view, date]) => {
    const kind = typeof view === 'string' && VIEWS.some((entry) => entry.kind === view) ? (view as CalendarViewKind) : calendar.view
    const day = typeof date === 'string' ? parseWall(date) : null
    calendar.show(kind, day ?? undefined)
  },
  { immediate: true },
)

function go(kind: CalendarViewKind, day: number = calendar.anchor): void {
  void router.replace({ name: 'calendar', params: { view: kind, date: formatDate(day) } })
}
function step(direction: 1 | -1): void {
  calendar.step(direction)
  go(calendar.view, calendar.anchor)
}
function today(): void {
  calendar.goToday()
  go(calendar.view, calendar.anchor)
}

const title = computed(() => {
  const days = calendar.days
  if (days.length === 0) return ''
  const first = days[0]!.wall
  const last = days[days.length - 1]!.wall
  switch (calendar.view) {
    case 'day':
      return longDate(first, calendar.today)
    case 'month':
      return `${MONTH_NAMES[wallParts(calendar.anchor).month - 1]} ${wallParts(calendar.anchor).year}`
    case 'week': {
      const a = wallParts(first)
      const b = wallParts(last)
      return a.month === b.month ? `${a.day} to ${b.day} ${MONTH_NAMES[b.month - 1]}` : `${shortDate(first).slice(4)} to ${shortDate(last).slice(4)}`
    }
    case 'agenda':
      return `From ${longDate(first, calendar.today)}`
  }
  return ''
})
const subtitle = computed(() => (calendar.view === 'week' ? `Week ${isoWeek(calendar.days[0]?.wall ?? calendar.anchor)}` : ''))
const shownRange = computed(() => ({ first: calendar.days[0]?.wall ?? 0, last: calendar.days[calendar.days.length - 1]?.wall ?? 0 }))

// The minute ticks on, for the now line and what has ended.
let ticking: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  ticking = setInterval(() => (calendar.now = Date.now()), 30_000)
  window.addEventListener('keydown', onShortcut)
})
onBeforeUnmount(() => {
  if (ticking !== null) clearInterval(ticking)
  window.removeEventListener('keydown', onShortcut)
})

// Selection and detail
const selectedKey = ref<string | null>(null)
const listed = computed(() => calendar.occurrences.find((occurrence) => occurrence.key === selectedKey.value) ?? null)
/** An occurrence the server read for an old range comes without its full event; the detail fetches it. */
const completed = ref<Occurrence | null>(null)
const selected = computed(() => (completed.value !== null && completed.value.key === listed.value?.key ? completed.value : listed.value))
watch(listed, (occurrence) => {
  completed.value = null
  if (occurrence?.fromServer) {
    calendar
      .complete(occurrence)
      .then((full) => {
        if (selectedKey.value === full.key) completed.value = full
      })
      .catch((error: unknown) => (actionError.value = errorMessage(error)))
  }
})
const busy = ref(false)
const actionError = ref<string | null>(null)
const status = ref('')

function open(occurrence: Occurrence | TodoBlock): void {
  selectedKey.value = occurrence.key
  actionError.value = null
}

// The time planned for a todo: plan it again, give it back, or check the todo off.
const selectedTodo = computed(() => calendar.todoBlocks.find((block) => block.key === selectedKey.value) ?? null)
async function onTodo(action: 'plan' | 'unplan' | 'done'): Promise<void> {
  const block = selectedTodo.value
  if (block === null) return
  busy.value = true
  actionError.value = null
  try {
    if (action === 'plan') {
      await todos.plan(block.todo.id)
      status.value = 'Planned again.'
    } else if (action === 'unplan') {
      await todos.unplan(block.todo.id)
      status.value = 'Removed from the calendar.'
      selectedKey.value = null
    } else {
      await todos.setDone(block.todo.id, true)
      status.value = 'Todo done.'
      selectedKey.value = null
    }
  } catch (e) {
    actionError.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
function closeDetail(): void {
  const key = selectedKey.value
  selectedKey.value = null
  // Focus goes back to the block the detail was about.
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-key="${CSS.escape(key ?? '')}"]`)?.focus())
}

// Editor
const editor = ref<EditorTarget | null>(null)
function newEvent(start?: number, allDay = false): void {
  if (calendar.newEventCalendar === null) {
    status.value = 'There is no calendar to add events to.'
    return
  }
  // Without a time: the next full hour of the day on screen.
  const nowWall = toWall(Date.now(), calendar.zone)
  const day = calendar.view === 'day' || calendar.view === 'week' ? calendar.anchor : calendar.today
  const hour = Math.min(23, wallParts(nowWall).hour + 1)
  editor.value = { kind: 'new', start: start ?? toInstant(day + hour * 3_600_000, calendar.zone), allDay }
}
async function edit(): Promise<void> {
  const occurrence = selected.value
  if (occurrence === null) return
  try {
    editor.value = { kind: 'edit', occurrence: await calendar.complete(occurrence) }
  } catch (error) {
    actionError.value = errorMessage(error)
  }
}
function saved(): void {
  status.value = 'Event saved.'
  editor.value = null
}

// Deleting
async function deleteSelected(): Promise<void> {
  const occurrence = selected.value
  if (occurrence === null) return
  try {
    deleting.value = await calendar.complete(occurrence)
  } catch (error) {
    actionError.value = errorMessage(error)
  }
}
const deleting = ref<Occurrence | null>(null)
const deleteScopes = computed<EditScope[]>(() => (deleting.value === null ? [] : editScopes(deleting.value)))
async function confirmDelete(scope: EditScope, notify: boolean): Promise<void> {
  const occurrence = deleting.value
  if (occurrence === null) return
  busy.value = true
  actionError.value = null
  try {
    await calendar.remove(occurrence, occurrence.recurring ? scope : 'all', notify)
    status.value = 'Event deleted.'
    deleting.value = null
    selectedKey.value = null
  } catch (e) {
    actionError.value = errorMessage(e)
    deleting.value = null
  } finally {
    busy.value = false
  }
}

async function respond(occurrence: Occurrence, response: Response, onlyThis: boolean): Promise<void> {
  busy.value = true
  actionError.value = null
  try {
    await calendar.respond(occurrence, response, onlyThis)
    status.value = response === 'accepted' ? 'Accepted.' : response === 'tentative' ? 'Answered maybe.' : 'Declined.'
  } catch (e) {
    actionError.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function toggle(calendarId: string, visible: boolean): Promise<void> {
  try {
    await calendar.setVisible(calendarId, visible)
  } catch (e) {
    status.value = errorMessage(e)
  }
}

/** T, J, K, 1 to 4, N, E and Esc, unless the user is typing or a dialog is open. */
function onShortcut(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey || editor.value !== null || deleting.value !== null) return
  const target = event.target as HTMLElement | null
  if (target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
  const key = event.key.toLowerCase()
  const view = VIEWS.find((entry) => entry.key === event.key)
  if (view !== undefined) {
    go(view.kind)
  } else if (key === 't') {
    today()
  } else if (key === 'j') {
    if (event.shiftKey) {
      const url = selected.value?.event.conference?.url
      if (url) window.open(url, '_blank', 'noopener')
    } else {
      step(1)
    }
  } else if (key === 'k') {
    step(-1)
  } else if (key === 'n') {
    newEvent()
  } else if (key === 'e' && selected.value !== null) {
    void edit()
  } else if (key === 'escape' && (selected.value !== null || selectedTodo.value !== null)) {
    closeDetail()
  } else {
    return
  }
  event.preventDefault()
}

function showDay(day: number): void {
  go('day', day)
}
function pickDay(day: number): void {
  go(calendar.view, day)
}
</script>

<template>
  <div class="calendar-shell" :class="{ detail: selected !== null || selectedTodo !== null }">
    <CalendarRail
      class="rail"
      :anchor="calendar.anchor"
      :today="calendar.today"
      :shown="shownRange"
      :calendars="calendar.calendars"
      :accounts="mail.accounts"
      :zone="calendar.zone"
      :now="calendar.now"
      @pick="pickDay"
      @month="(month) => go(calendar.view, month)"
      @toggle="toggle"
    />

    <main class="main" aria-labelledby="calendar-title">
      <header class="toolbar">
        <button type="button" class="button button-quiet" @click="today">Today <kbd>T</kbd></button>
        <button type="button" class="button button-quiet icon" aria-label="Previous" @click="step(-1)"><AppIcon name="back" :size="16" /></button>
        <button type="button" class="button button-quiet icon" aria-label="Next" @click="step(1)"><AppIcon name="next" :size="16" /></button>
        <h1 id="calendar-title">{{ title }} <span v-if="subtitle" class="subtitle">{{ subtitle }}</span></h1>
        <span class="spacer" />
        <div class="segments" role="group" aria-label="View">
          <button v-for="entry in VIEWS" :key="entry.kind" type="button" class="segment" :aria-pressed="calendar.view === entry.kind ? 'true' : 'false'" @click="go(entry.kind)">
            {{ entry.label }}
          </button>
        </div>
        <button type="button" class="button button-primary" @click="newEvent()"><AppIcon name="plus" :size="16" /> New event <kbd>N</kbd></button>
      </header>

      <p v-if="calendar.notice" class="empty" role="status">{{ calendar.notice }}</p>
      <p v-if="mail.ready && calendar.calendars.length === 0" class="empty">No calendars yet. They appear here once your accounts have synced.</p>

      <TimeGrid
        v-if="calendar.view === 'day' || calendar.view === 'week'"
        :key="calendar.view"
        class="view"
        :days="calendar.days"
        :occurrences="calendar.occurrences"
        :todo-blocks="calendar.todoBlocks"
        :zone="calendar.zone"
        :now="calendar.now"
        :today="calendar.today"
        :calendars="calendar.calendar"
        :selected-key="selectedKey"
        @open="open"
        @open-todo="open"
        @create="newEvent"
      />
      <MonthGrid
        v-else-if="calendar.view === 'month'"
        class="view"
        :days="calendar.days"
        :month="calendar.anchor"
        :occurrences="calendar.occurrences"
        :todo-blocks="calendar.todoBlocks"
        :zone="calendar.zone"
        :now="calendar.now"
        :today="calendar.today"
        :calendars="calendar.calendar"
        :selected-key="selectedKey"
        @open="open"
        @open-todo="open"
        @show-day="showDay"
        @create="newEvent"
      />
      <div v-else class="view agenda-view">
        <AgendaList
          :days="calendar.days"
          :occurrences="calendar.occurrences"
          :todo-blocks="calendar.todoBlocks"
          :zone="calendar.zone"
          :now="calendar.now"
          :today="calendar.today"
          :calendars="calendar.calendar"
          :selected-key="selectedKey"
          @open="open"
          @open-todo="open"
        />
        <aside v-if="calendar.unanswered.length > 0" class="pending" aria-labelledby="pending-title">
          <h2 id="pending-title">Needs your response <span class="count">{{ calendar.unanswered.length }}</span></h2>
          <ul>
            <li v-for="occurrence in calendar.unanswered" :key="occurrence.key" class="invite">
              <button type="button" class="invite-title" @click="open(occurrence)">{{ occurrence.event.summary || 'Untitled event' }}</button>
              <span class="when">{{ occurrenceWhen(occurrence, calendar.zone, calendar.today) }}</span>
              <span v-if="occurrence.event.organizer" class="from">From {{ occurrence.event.organizer.name || occurrence.event.organizer.address }}</span>
              <ResponseButtons :current="occurrence.event.selfResponse" :busy="busy" :label="`Answer ${occurrence.event.summary}`" @respond="(r) => respond(occurrence, r, false)" />
            </li>
          </ul>
          <p class="hint">Answering sends your response to the organizer.</p>
        </aside>
      </div>
      <p class="visually-hidden" role="status" aria-live="polite">{{ status }}</p>
    </main>

    <EventDetail
      v-if="selected"
      class="detail-panel"
      :occurrence="selected"
      :calendar="calendar.calendar(selected.event.calendarId)"
      :zone="calendar.zone"
      :now="calendar.now"
      :busy="busy"
      :error="actionError"
      @close="closeDetail"
      @edit="edit"
      @delete="deleteSelected"
      @respond="(response, onlyThis) => respond(selected!, response, onlyThis)"
    />

    <TodoBlockDetail
      v-else-if="selectedTodo"
      class="detail-panel"
      :block="selectedTodo"
      :zone="calendar.zone"
      :now="calendar.now"
      :busy="busy"
      :error="actionError"
      @close="closeDetail"
      @plan="onTodo('plan')"
      @unplan="onTodo('unplan')"
      @done="onTodo('done')"
    />

    <EventEditor v-if="editor" :target="editor" @close="editor = null" @saved="saved" />
    <ScopeDialog
      v-if="deleting"
      :scopes="deleteScopes"
      :title="`Delete ${deleting.event.summary || 'this event'}?`"
      :busy="busy"
      :notify-count="deleting.event.attendees.length"
      @confirm="confirmDelete"
      @cancel="deleting = null"
    />
  </div>
</template>

<style scoped>
.calendar-shell {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.calendar-shell.detail {
  grid-template-columns: 248px minmax(0, 1fr) 340px;
}
.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.toolbar h1 {
  margin: 0 0 0 8px;
  font: 700 20px/26px var(--font-display);
}
.subtitle {
  margin-left: 6px;
  font: 500 13px var(--font-ui);
  color: var(--ink-3);
}
.spacer {
  flex: 1;
}
.icon {
  width: 36px;
  padding: 0;
}
.segments {
  display: flex;
  padding: 2px;
  border-radius: var(--radius-control);
  background: var(--ground);
}
.segment {
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  font: 600 13px var(--font-ui);
  cursor: pointer;
}
.segment[aria-pressed='true'] {
  background: var(--surface);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}
.view {
  flex: 1;
  min-height: 0;
}
.empty {
  margin: 0;
  padding: 12px 16px;
  color: var(--ink-2);
}
.agenda-view {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
}
.pending {
  width: 320px;
  padding: 16px;
  border-left: 1px solid var(--line);
  background: var(--surface);
  overflow-y: auto;
}
.pending h2 {
  margin: 0 0 12px;
  font: 700 15px var(--font-display);
}
.count {
  margin-left: 4px;
  color: var(--ink-3);
}
.pending ul {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.invite {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.invite-title {
  padding: 0;
  border: 0;
  background: none;
  font: 600 14px var(--font-ui);
  text-align: left;
  cursor: pointer;
}
.when,
.from,
.hint {
  font-size: 12px;
  color: var(--ink-2);
}
kbd {
  font: 500 11px var(--font-mono);
  opacity: 0.7;
}

@media (max-width: 1100px) {
  .calendar-shell,
  .calendar-shell.detail {
    grid-template-columns: minmax(0, 1fr);
  }
  .rail {
    display: none;
  }
  .detail-panel {
    position: fixed;
    inset: 0 0 0 auto;
    z-index: 40;
  }
  .pending {
    display: none;
  }
}
</style>
