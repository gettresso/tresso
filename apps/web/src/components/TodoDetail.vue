<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import {
  canPlan,
  formatDate,
  plannedLabel,
  readerTimeZone,
  startOfWallDay,
  TODO_NOTES_MAX_LENGTH,
  TODO_TITLE_MAX_LENGTH,
  toWall,
  type SyncedMessage,
  type Todo,
  type TodoUpdate,
} from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import FieldLabel from '@/forms/FieldLabel.vue'
import { provideRequiredFields } from '@/forms/required'
import { todoSchema, type TodoValues } from '@/forms/todos'
import { senderName, shortTime } from '@/mail/format'
import { useTodosStore } from '@/stores/todos'
import AppIcon from '@/components/AppIcon.vue'

const props = defineProps<{ todo: Todo; message: SyncedMessage | null }>()

provideRequiredFields(todoSchema)

const store = useTodosStore()
const router = useRouter()
const saving = ref(false)
const error = ref<string | null>(null)
const confirmingRemoval = ref(false)

const SOURCE_LABELS: Record<Todo['source'], string> = { manual: 'Manual', suggested: 'Suggested', automatic: 'Automatic' }

const done = computed(() => props.todo.completedAt !== null)

// The time the todo holds in the calendar, on this device's clock.
const zone = readerTimeZone()
const planned = computed(() => plannedLabel(props.todo, zone, startOfWallDay(toWall(Date.now(), zone))))
const plannedDay = computed(() => (props.todo.plannedStart === null ? null : formatDate(startOfWallDay(toWall(Date.parse(props.todo.plannedStart), zone)))))

const { defineField, handleSubmit, errors, meta, resetForm, setErrors } = useForm<TodoValues>({
  validationSchema: toTypedSchema(todoSchema),
  initialValues: saved(),
})
const [title] = defineField('title')
const [notes] = defineField('notes')
const [dueDate] = defineField('dueDate')
const [dueTime] = defineField('dueTime')
const [durationMinutes] = defineField('durationMinutes')

// A cleared date takes its time with it, as on the server.
watch(dueDate, (next) => {
  if (next === '' && dueTime.value !== '') {
    dueTime.value = ''
  }
})

function saved(): TodoValues {
  return {
    title: props.todo.title,
    notes: props.todo.notes,
    dueDate: props.todo.dueDate ?? '',
    dueTime: props.todo.dueTime ?? '',
    durationMinutes: props.todo.durationMinutes === null ? '' : String(props.todo.durationMinutes),
  }
}

// Another todo resets the form; changes from other devices show while the form has none of its own.
watch(
  () => props.todo,
  (todo, previous) => {
    if (previous === undefined || previous.id !== todo.id || (!saving.value && !meta.value.dirty)) {
      resetForm({ values: saved() })
      confirmingRemoval.value = false
      error.value = null
    }
  },
)

function changes(current: TodoValues): TodoUpdate {
  const original = saved()
  const changed: TodoUpdate = {}
  if (current.title !== original.title) changed.title = current.title
  if (current.notes !== original.notes) changed.notes = current.notes
  const dueDate = current.dueDate === '' ? null : current.dueDate
  const dueTime = current.dueTime === '' ? null : current.dueTime
  if (dueDate !== props.todo.dueDate) changed.dueDate = dueDate
  if (dueTime !== props.todo.dueTime) changed.dueTime = dueTime
  if (current.durationMinutes !== original.durationMinutes) changed.durationMinutes = current.durationMinutes === '' ? null : Number(current.durationMinutes)

  return changed
}

async function run(action: () => Promise<void>): Promise<void> {
  saving.value = true
  error.value = null
  try {
    await action()
  } catch (e) {
    error.value = errorMessage(e)
    if (e instanceof ApiError) setErrors(e.violations)
  } finally {
    saving.value = false
  }
}

const save = handleSubmit((current) =>
  run(async () => {
    const changed = changes(current)
    if (Object.keys(changed).length > 0) {
      await store.update(props.todo.id, changed)
    }
    resetForm({ values: current })
  }),
)

function setDone(next: boolean): Promise<void> {
  return run(() => store.setDone(props.todo.id, next))
}

function completeAndArchive(): Promise<void> {
  return run(() => store.completeAndArchive(props.todo))
}

function plan(): Promise<void> {
  return run(async () => {
    await store.plan(props.todo.id)
  })
}

function unplan(): Promise<void> {
  return run(() => store.unplan(props.todo.id))
}

function remove(): Promise<void> {
  return run(async () => {
    await store.remove(props.todo.id)
    await router.push({ name: 'todos' })
  })
}
</script>

<template>
  <form class="detail" aria-labelledby="todo-detail-title" novalidate @submit.prevent="save">
    <header class="header">
      <h2 id="todo-detail-title" class="visually-hidden">Todo</h2>
      <span class="pill">{{ SOURCE_LABELS[todo.source] }}</span>
      <span v-if="done" class="pill">Done</span>
      <span class="spacer" />
      <RouterLink :to="{ name: 'todos' }" class="close" aria-label="Close the todo"><AppIcon name="close" /></RouterLink>
    </header>

    <label class="field">
      <FieldLabel name="title">Title</FieldLabel>
      <input v-model="title" class="title" :maxlength="TODO_TITLE_MAX_LENGTH" autocomplete="off" :aria-invalid="errors.title ? 'true' : undefined" />
      <small v-if="errors.title" class="error">{{ errors.title }}</small>
    </label>

    <div class="when">
      <label class="field">
        <FieldLabel name="dueDate">Due</FieldLabel>
        <input v-model="dueDate" type="date" :aria-invalid="errors.dueDate ? 'true' : undefined" />
        <small v-if="errors.dueDate" class="error">{{ errors.dueDate }}</small>
      </label>
      <label class="field">
        <FieldLabel name="dueTime">Time</FieldLabel>
        <input v-model="dueTime" type="time" :disabled="dueDate === ''" :aria-invalid="errors.dueTime ? 'true' : undefined" />
        <small v-if="errors.dueTime" class="error">{{ errors.dueTime }}</small>
      </label>
      <label class="field">
        <FieldLabel name="durationMinutes">Takes (minutes)</FieldLabel>
        <input v-model="durationMinutes" inputmode="numeric" autocomplete="off" placeholder="30" :aria-invalid="errors.durationMinutes ? 'true' : undefined" />
        <small v-if="errors.durationMinutes" class="error">{{ errors.durationMinutes }}</small>
      </label>
    </div>

    <section v-if="!done" class="plan" aria-label="In the calendar">
      <p class="plan-line" :class="{ conflict: todo.planState === 'conflict' }">
        <AppIcon name="calendar" :size="15" />
        <span v-if="planned">{{ planned }}</span>
        <span v-else-if="canPlan(todo)">Not in the calendar yet.</span>
        <span v-else>Give it a due date and say how long it takes to plan it in the calendar.</span>
      </p>
      <div v-if="canPlan(todo)" class="plan-actions">
        <button type="button" class="button button-quiet" :disabled="saving || meta.dirty" :title="meta.dirty ? 'Save your changes first' : undefined" @click="plan">
          {{ todo.plannedStart === null ? 'Plan automatically' : 'Plan again' }}
        </button>
        <button v-if="todo.plannedStart !== null" type="button" class="button button-quiet" :disabled="saving" @click="unplan">Remove from calendar</button>
        <RouterLink v-if="plannedDay" :to="{ name: 'calendar', params: { view: 'day', date: plannedDay } }" class="button button-quiet">Show in calendar</RouterLink>
      </div>
    </section>

    <label class="field">
      <FieldLabel name="notes">Notes</FieldLabel>
      <textarea v-model="notes" rows="4" :maxlength="TODO_NOTES_MAX_LENGTH" :aria-invalid="errors.notes ? 'true' : undefined" />
      <small v-if="errors.notes" class="error">{{ errors.notes }}</small>
    </label>

    <section v-if="todo.messageId !== null" class="email" aria-label="Linked email">
      <template v-if="message">
        <p class="email-from">
          <AppIcon name="mail" :size="15" />
          <strong>{{ senderName(message.from) }}</strong>
          <span class="muted">{{ shortTime(Date.parse(message.receivedAt)) }}</span>
        </p>
        <p class="email-subject">{{ message.subject || '(no subject)' }}</p>
        <p class="email-snippet">{{ message.snippet }}</p>
        <RouterLink :to="{ name: 'unified-thread', params: { threadId: message.threadId } }" class="button button-quiet">Open email</RouterLink>
      </template>
      <p v-else class="muted">The email this todo came from is not on this device any more.</p>
    </section>

    <p v-if="error" class="form-error" role="alert">{{ error }}</p>

    <div class="actions">
      <button type="submit" class="button button-quiet" :disabled="saving || !meta.dirty">Save changes</button>
      <span class="spacer" />
      <template v-if="!done">
        <button v-if="message" type="button" class="button button-primary" :disabled="saving" @click="completeAndArchive">Complete and archive email</button>
        <button type="button" class="button" :class="message ? 'button-quiet' : 'button-primary'" :disabled="saving" @click="setDone(true)">
          {{ message ? 'Complete only' : 'Complete' }}
        </button>
      </template>
      <button v-else type="button" class="button button-quiet" :disabled="saving" @click="setDone(false)">Reopen</button>
      <button type="button" class="button button-quiet" :disabled="saving" @click="confirmingRemoval = true">Delete</button>
    </div>

    <div v-if="confirmingRemoval" class="confirm" role="alertdialog" aria-labelledby="todo-delete-title">
      <p id="todo-delete-title"><strong>Delete this todo?</strong></p>
      <p>It goes on every device. The email stays where it is.</p>
      <div class="actions">
        <button type="button" class="button button-danger" :disabled="saving" @click="remove">Delete todo</button>
        <button type="button" class="button button-quiet" @click="confirmingRemoval = false">Keep it</button>
      </div>
    </div>
  </form>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: var(--glass-edge);
}
.header,
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.spacer {
  flex: 1;
}
.pill {
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
}
.close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-control);
  color: var(--ink-2);
}
.title {
  font: 600 18px/26px var(--font-ui);
}
.when {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
textarea {
  resize: vertical;
  padding: 10px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--ink);
  font: 400 14px/21px var(--font-ui);
}
textarea[aria-invalid='true'] {
  border-color: var(--danger);
}
.error {
  font-size: 12px;
}
.plan {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.plan-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  color: var(--ink-2);
  font-size: 13px;
}
.plan-line.conflict {
  color: var(--danger);
}
.plan-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.email {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--ground);
}
.email p {
  margin: 0;
}
.email-from {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.email-subject {
  font-weight: 600;
}
.email-snippet,
.muted {
  color: var(--ink-2);
  font-size: 13px;
}
.actions .button {
  text-decoration: none;
}
.confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
}
.confirm p {
  margin: 0;
}
</style>
