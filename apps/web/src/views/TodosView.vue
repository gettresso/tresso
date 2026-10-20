<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { dueLabel, groupTodos, parseQuickAdd, todoSection, TODO_TITLE_MAX_LENGTH, type SyncedMessage, type Todo } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import FieldLabel from '@/forms/FieldLabel.vue'
import { provideRequiredFields } from '@/forms/required'
import { quickAddSchema, type QuickAddValues } from '@/forms/todos'
import { senderName } from '@/mail/format'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import { useTodosStore } from '@/stores/todos'
import AppIcon from '@/components/AppIcon.vue'
import TodoDetail from '@/components/TodoDetail.vue'

provideRequiredFields(quickAddSchema)

const route = useRoute()
const mail = useMailStore()
const store = useTodosStore()
const compose = useComposeStore()

const SOURCE_LABELS: Record<Todo['source'], string> = { manual: 'Manual', suggested: 'Suggested', automatic: 'Automatic' }

/** The clock the sections and due labels go by; it ticks every minute, so "Today 17:00" turns overdue on time. */
const now = ref(new Date())
let ticking: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  ticking = setInterval(() => (now.value = new Date()), 60_000)
})
onBeforeUnmount(() => {
  if (ticking !== null) clearInterval(ticking)
})

const groups = computed(() => groupTodos(store.todos, now.value))
const doneToday = computed(() => store.todos.filter((todo) => todo.completedAt !== null && dueLabel(todo, now.value) === 'Done today').length)
const selectedId = computed(() => (typeof route.params.todoId === 'string' ? route.params.todoId : null))
const selected = computed(() => store.todos.find((todo) => todo.id === selectedId.value) ?? null)

/** The emails todos link to, as far as this device has them. */
const emails = ref(new Map<string, SyncedMessage>())
watch(
  () => store.todos.map((todo) => todo.messageId).filter((id) => id !== null),
  async (ids) => {
    emails.value = new Map((await mail.messages(ids)).map((message) => [message.id, message]))
  },
  { immediate: true },
)

function emailOf(todo: Todo): SyncedMessage | null {
  return todo.messageId === null ? null : (emails.value.get(todo.messageId) ?? null)
}

const { defineField, handleSubmit, errors, values, resetForm, setErrors } = useForm<QuickAddValues>({
  validationSchema: toTypedSchema(quickAddSchema),
  initialValues: { text: '' },
})
const [text] = defineField('text', { validateOnModelUpdate: false })
const adding = ref(false)
const addError = ref<string | null>(null)

const preview = computed(() => {
  const typed = values.text ?? ''
  return typed.trim() === '' ? null : parseQuickAdd(typed, now.value)
})
const previewDue = computed(() => (preview.value === null || preview.value.dueDate === null ? null : dueLabel({ ...preview.value, completedAt: null }, now.value)))

const add = handleSubmit(async ({ text: typed }) => {
  adding.value = true
  addError.value = null
  try {
    const parsed = parseQuickAdd(typed, new Date())
    await store.create({ title: parsed.title, dueDate: parsed.dueDate, dueTime: parsed.dueTime })
    resetForm({ values: { text: '' } })
  } catch (e) {
    addError.value = errorMessage(e)
    if (e instanceof ApiError) setErrors({ text: e.violations.title ?? e.violations.dueDate ?? e.violations.dueTime })
  } finally {
    adding.value = false
  }
})

async function toggle(todo: Todo): Promise<void> {
  try {
    await store.setDone(todo.id, todo.completedAt === null)
  } catch (e) {
    compose.notify({ text: errorMessage(e), tone: 'error' })
  }
}
</script>

<template>
  <main class="todos" :class="{ 'with-detail': selected !== null }">
    <div class="list-column">
      <header class="header">
        <h1>Todos</h1>
        <p class="lead">
          {{ store.openCount }} open<template v-if="doneToday > 0">, {{ doneToday }} done today</template>, synced to all your devices
        </p>
      </header>

      <form class="quick-add" novalidate @submit.prevent="add">
        <FieldLabel name="text" tag="label" for="quick-add">Quick add</FieldLabel>
        <div class="quick-row">
          <input
            id="quick-add"
            v-model="text"
            :maxlength="TODO_TITLE_MAX_LENGTH"
            placeholder="Call Anna friday"
            autocomplete="off"
            aria-describedby="quick-add-hint"
            :aria-invalid="errors.text ? 'true' : undefined"
          />
          <span v-if="previewDue" class="due"><AppIcon name="clock" :size="14" /> {{ previewDue }}</span>
          <button type="submit" class="button button-primary" :disabled="adding">Add <kbd>Enter</kbd></button>
        </div>
        <small id="quick-add-hint" class="hint">
          <template v-if="preview && preview.dueDate === null">No date found, it goes to Later.</template>
          <template v-else>Type a day or date, like "friday", "tomorrow 9:00" or "27 oct".</template>
        </small>
        <small v-if="errors.text" class="error">{{ errors.text }}</small>
        <p v-if="addError && !errors.text" class="form-error" role="alert">{{ addError }}</p>
      </form>

      <p v-if="store.todos.length === 0" class="lead empty">Nothing to do. Add a todo above, or make one from an email.</p>

      <section v-for="group in groups" :key="group.section" class="group" :aria-labelledby="`todos-${group.section}`">
        <h2 :id="`todos-${group.section}`" class="group-title">{{ group.label }} <span class="group-count">{{ group.todos.length }}</span></h2>
        <ul class="rows">
          <li v-for="todo in group.todos" :key="todo.id" class="row" :class="{ done: todo.completedAt !== null, current: todo.id === selectedId }">
            <input
              type="checkbox"
              class="check"
              :checked="todo.completedAt !== null"
              :aria-label="`${todo.completedAt === null ? 'Complete' : 'Reopen'} ${todo.title}`"
              @change="toggle(todo)"
            />
            <RouterLink :to="{ name: 'todo', params: { todoId: todo.id } }" class="title">{{ todo.title }}</RouterLink>
            <span class="source">
              <RouterLink v-if="emailOf(todo)" :to="{ name: 'unified-thread', params: { threadId: emailOf(todo)!.threadId } }" class="email">
                <AppIcon name="mail" :size="14" /> {{ senderName(emailOf(todo)!.from) }}
              </RouterLink>
              <template v-else-if="todo.messageId !== null">From an email</template>
              <template v-else>Added by you</template>
            </span>
            <span class="pill">{{ SOURCE_LABELS[todo.source] }}</span>
            <span v-if="dueLabel(todo, now)" class="due" :class="{ overdue: todoSection(todo, now) === 'overdue' }">
              <AppIcon name="clock" :size="14" /> {{ dueLabel(todo, now) }}
            </span>
          </li>
        </ul>
      </section>
    </div>

    <div v-if="selected" class="detail-column">
      <TodoDetail :todo="selected" :message="emailOf(selected)" />
    </div>
    <p v-else-if="selectedId !== null && mail.ready" class="lead missing">
      This todo no longer exists. <RouterLink :to="{ name: 'todos' }">Back to todos</RouterLink>
    </p>
  </main>
</template>

<style scoped>
.todos {
  display: grid;
  grid-template-columns: minmax(0, 860px);
  justify-content: center;
  gap: 24px;
  padding: 32px 24px;
}
.todos.with-detail {
  grid-template-columns: minmax(0, 1fr) minmax(320px, 440px);
  max-width: 1320px;
  margin: 0 auto;
}
.list-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.detail-column {
  position: sticky;
  top: 24px;
  align-self: start;
}
.header h1 {
  margin: 0 0 4px;
  font: 700 28px/34px var(--font-display);
}
.lead {
  margin: 0;
  color: var(--ink-2);
  font-size: 14px;
}
.quick-add {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--surface);
  font-size: 13px;
  font-weight: 600;
}
.quick-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.quick-row input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--ink);
  font: 400 14px var(--font-ui);
}
.quick-row input[aria-invalid='true'] {
  border-color: var(--danger);
}
.hint {
  font-weight: 400;
  color: var(--ink-2);
}
.error,
.form-error {
  margin: 0;
  font-weight: 500;
  color: var(--danger);
}
kbd {
  font: 500 11px var(--font-mono);
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--surface) 25%, transparent);
}
.group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.group-title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--ink-2);
}
.group-count {
  font-weight: 500;
  color: var(--ink-3);
}
.rows {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--surface);
  overflow: hidden;
}
.row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 8px 16px;
  border-top: 1px solid var(--line);
  font-size: 14px;
}
.row:first-child {
  border-top: 0;
}
.row.current {
  background: var(--selected);
  box-shadow: inset 0 0 0 1.5px var(--do);
}
.check {
  width: 18px;
  height: 18px;
  margin: 0;
  accent-color: var(--do);
  cursor: pointer;
}
.title {
  overflow: hidden;
  color: var(--ink);
  text-decoration: none;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.row.done .title {
  color: var(--ink-3);
  text-decoration: line-through;
}
.source {
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
}
.email {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--do);
  text-decoration: none;
  font-weight: 600;
}
.pill {
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
}
.due {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.due.overdue {
  border: 1.5px solid var(--ink);
  color: var(--ink);
}
.missing {
  align-self: start;
}
@media (max-width: 900px) {
  .todos.with-detail {
    grid-template-columns: minmax(0, 1fr);
  }
  .detail-column {
    position: static;
    order: -1;
  }
}
@media (max-width: 640px) {
  .row {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .source,
  .pill {
    display: none;
  }
}
</style>
