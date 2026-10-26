<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { VERDICTS, verdictLabel, type SmartInboxUpdate, type SyncedSmartInbox, type Verdict } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import FieldLabel from '@/forms/FieldLabel.vue'
import { provideRequiredFields } from '@/forms/required'
import { SMART_INBOX_INSTRUCTIONS_MAX, SMART_INBOX_NAME_MAX, smartInboxSchema, type SmartInboxValues } from '@/forms/smartInboxes'
import { useMailStore } from '@/stores/mail'
import { useBatchesStore } from '@/stores/batches'
import { useSmartInboxesStore } from '@/stores/smartInboxes'
import AppIcon from '@/components/AppIcon.vue'
import SenderListField from '@/components/SenderListField.vue'
import KeyShortcut from '@/components/KeyShortcut.vue'

provideRequiredFields(smartInboxSchema)

const route = useRoute()
const router = useRouter()
const store = useSmartInboxesStore()
const mail = useMailStore()
const batches = useBatchesStore()

const id = computed(() => (typeof route.params.smartInboxId === 'string' ? route.params.smartInboxId : 'new'))
const isNew = computed(() => id.value === 'new')
const existing = computed<SyncedSmartInbox | null>(() => store.smartInboxes.find((s) => s.id === id.value) ?? null)

const saving = ref(false)
const error = ref<string | null>(null)
const confirmingRemoval = ref(false)

const VERDICT_HELP: Record<Verdict, string> = {
  do: 'Matching mail is something for you to do.',
  delegate: 'Matching mail is meant for someone else to handle.',
  know: 'Matching mail is good to know and stays out of the way.',
  none: 'Only grouped here, no verdict is set.',
}

const { defineField, handleSubmit, errors, values, meta, resetForm, setErrors } = useForm<SmartInboxValues>({
  validationSchema: toTypedSchema(smartInboxSchema),
  initialValues: { name: '', instructions: '', includeSenders: [], excludeSenders: [], verdict: 'do', autoCreateTodo: false, batchDelivery: false },
})
const [name] = defineField('name')
const [instructions] = defineField('instructions')
const [includeSenders] = defineField('includeSenders')
const [excludeSenders] = defineField('excludeSenders')
const [verdict] = defineField('verdict')
const [autoCreateTodo] = defineField('autoCreateTodo')

// Todos come from mail to do: another verdict switches the setting off.
watch(verdict, (next) => {
  if (next !== 'do' && autoCreateTodo.value) {
    autoCreateTodo.value = false
  }
})
const [batchDelivery] = defineField('batchDelivery')

onMounted(() => void batches.load())

function listError(path: 'includeSenders' | 'excludeSenders'): string | null {
  return Object.entries(errors.value).find(([field]) => field === path || field.startsWith(`${path}[`))?.[1] ?? null
}

function saved(): SmartInboxValues {
  const smartInbox = existing.value
  if (smartInbox === null) {
    return { name: '', instructions: '', includeSenders: [], excludeSenders: [], verdict: 'do', autoCreateTodo: false, batchDelivery: false }
  }

  return {
    name: smartInbox.name,
    instructions: smartInbox.instructions,
    includeSenders: [...smartInbox.includeSenders],
    excludeSenders: [...smartInbox.excludeSenders],
    verdict: smartInbox.verdict,
    autoCreateTodo: smartInbox.autoCreateTodo,
    batchDelivery: smartInbox.batchDelivery ?? false,
  }
}

function reset(): void {
  resetForm({ values: saved() })
  confirmingRemoval.value = false
}

// Fills the form once the synced copy has the smart inbox, and follows changes from other devices while the form has
// no changes of its own. A smart inbox deleted elsewhere closes.
watch(
  () => [id.value, existing.value, mail.ready] as const,
  ([, smartInbox, ready], previous) => {
    if (!isNew.value && ready && smartInbox === null) {
      void router.replace({ name: 'settings-smart-inboxes' })
      return
    }
    const switched = previous === undefined || previous[0] !== id.value || previous[1] === null
    if (switched || (!saving.value && !meta.value.dirty)) {
      reset()
    }
  },
  { immediate: true },
)

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

function changes(current: SmartInboxValues): SmartInboxUpdate {
  const original = saved()
  const changed: SmartInboxUpdate = {}
  if (current.name !== original.name) changed.name = current.name
  if (current.instructions !== original.instructions) changed.instructions = current.instructions
  if (!sameList(current.includeSenders, original.includeSenders)) changed.includeSenders = current.includeSenders
  if (!sameList(current.excludeSenders, original.excludeSenders)) changed.excludeSenders = current.excludeSenders
  if (current.verdict !== original.verdict) changed.verdict = current.verdict
  if (current.autoCreateTodo !== original.autoCreateTodo) changed.autoCreateTodo = current.autoCreateTodo
  if (current.batchDelivery !== original.batchDelivery) changed.batchDelivery = current.batchDelivery

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
    if (isNew.value) {
      await store.create(current)
    } else {
      const changed = changes(current)
      if (Object.keys(changed).length > 0) {
        await store.update(id.value, changed)
      }
    }
    await router.push({ name: 'settings-smart-inboxes' })
  }),
)

function remove(): Promise<void> {
  return run(async () => {
    await store.remove(id.value)
    await router.push({ name: 'settings-smart-inboxes' })
  })
}


function saveShortcut(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    if (!saving.value) {
      void save()
    }
  }
}
</script>

<template>
  <form class="edit" aria-labelledby="edit-title" novalidate @submit.prevent="save" @keydown="saveShortcut">
    <header class="header">
      <RouterLink :to="{ name: 'settings-smart-inboxes' }" class="back" aria-label="Back to smart inboxes"><AppIcon name="back" /></RouterLink>
      <span class="titles">
        <h2 id="edit-title">{{ isNew ? 'New smart inbox' : 'Edit smart inbox' }}</h2>
        <span class="subtitle">
          {{ existing?.builtin ? 'Built in' : 'Your own' }}, all accounts. Changes apply to new mail and the last 30 days.
        </span>
      </span>
    </header>

    <p v-if="!isNew && !mail.ready" class="state">Loading…</p>

    <template v-else>
      <label class="field">
        <FieldLabel name="name">Name</FieldLabel>
        <input v-model="name" :maxlength="SMART_INBOX_NAME_MAX" autocomplete="off" :aria-invalid="errors.name ? 'true' : undefined" />
        <small v-if="errors.name" class="error">{{ errors.name }}</small>
      </label>

      <label class="field">
        <span class="label-row">
          <FieldLabel name="instructions">Instructions</FieldLabel>
          <span class="hint">Describe what belongs here in plain words, for AI classification</span>
        </span>
        <textarea v-model="instructions" rows="3" :maxlength="SMART_INBOX_INSTRUCTIONS_MAX" :aria-invalid="errors.instructions ? 'true' : undefined" />
        <small v-if="errors.instructions" class="error">{{ errors.instructions }}</small>
      </label>

      <div class="lists">
        <div class="field">
          <FieldLabel name="includeSenders" tag="label" for="include-senders">Always include</FieldLabel>
          <SenderListField id="include-senders" v-model="includeSenders" described-by="include-help" :invalid="listError('includeSenders') !== null" />
          <small id="include-help" class="hint">Mail from these always lands here.</small>
          <small v-if="listError('includeSenders')" class="error">{{ listError('includeSenders') }}</small>
        </div>
        <div class="field">
          <FieldLabel name="excludeSenders" tag="label" for="exclude-senders">Never include</FieldLabel>
          <SenderListField id="exclude-senders" v-model="excludeSenders" described-by="exclude-help" :invalid="listError('excludeSenders') !== null" />
          <small id="exclude-help" class="hint">Wins over everything else, the include list too.</small>
          <small v-if="listError('excludeSenders')" class="error">{{ listError('excludeSenders') }}</small>
        </div>
      </div>

      <fieldset class="verdict">
        <FieldLabel name="verdict" tag="legend">Verdict for matching mail</FieldLabel>
        <div class="segments">
          <label v-for="option in VERDICTS" :key="option" class="segment" :class="[option, { on: verdict === option }]">
            <input v-model="verdict" type="radio" name="verdict" :value="option" class="visually-hidden" />
            <AppIcon :name="option" :size="15" /> {{ verdictLabel(option) }}
          </label>
        </div>
        <small class="hint">{{ VERDICT_HELP[values.verdict ?? 'do'] }}</small>
      </fieldset>

      <div class="switch-row">
        <span class="switch-text">
          <FieldLabel name="autoCreateTodo" tag="label" for="auto-create-todo">Auto-create todos</FieldLabel>
          <small id="auto-create-todo-help" class="hint">
            {{ verdict === 'do' ? 'New unread mail that lands here becomes a todo, linked to the email.' : 'Only available with the Do verdict.' }}
          </small>
          <small v-if="errors.autoCreateTodo" class="error">{{ errors.autoCreateTodo }}</small>
        </span>
        <input
          id="auto-create-todo"
          v-model="autoCreateTodo"
          type="checkbox"
          role="switch"
          class="switch"
          :disabled="verdict !== 'do'"
          aria-describedby="auto-create-todo-help"
        />
      </div>
      <div class="switch-row">
        <span class="switch-text">
          <FieldLabel name="batchDelivery" tag="label" for="batch-delivery">Deliver in batches</FieldLabel>
          <small id="batch-delivery-help" class="hint">
            Holds matches until {{ batches.timesLabel ?? 'your next batch time' }}.
            <RouterLink :to="{ name: 'settings-batches' }">Change batch times</RouterLink>
          </small>
        </span>
        <input id="batch-delivery" v-model="batchDelivery" type="checkbox" role="switch" class="switch" aria-describedby="batch-delivery-help" />
      </div>

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>

      <div class="actions">
        <button type="submit" class="button button-primary" :disabled="saving">
          Save <KeyShortcut keys="Mod+S" />
        </button>
        <RouterLink :to="{ name: 'settings-smart-inboxes' }" class="button button-quiet">Cancel</RouterLink>
        <span class="spacer" />
        <button v-if="!isNew && existing && !existing.builtin" type="button" class="button button-quiet" :disabled="saving" @click="confirmingRemoval = true">
          Delete smart inbox
        </button>
      </div>

      <div v-if="confirmingRemoval" class="confirm" role="alertdialog" aria-labelledby="delete-title">
        <p id="delete-title"><strong>Delete {{ existing?.name }}?</strong></p>
        <p>Its mail is sorted again into the other smart inboxes, on every device.</p>
        <div class="actions">
          <button type="button" class="button button-danger" :disabled="saving" @click="remove">Delete smart inbox</button>
          <button type="button" class="button button-quiet" @click="confirmingRemoval = false">Keep it</button>
        </div>
      </div>
    </template>
  </form>
</template>

<style scoped>
.edit {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 760px;
}
.header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-control);
  color: var(--ink-2);
}
.titles {
  display: flex;
  flex-direction: column;
}
h2 {
  margin: 0;
  font: 700 26px/32px var(--font-display);
}
.subtitle,
.state {
  margin: 0;
  font-size: 13px;
  color: var(--ink-2);
}
.label-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.hint {
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-2);
}
.error {
  font-size: 12px;
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
.lists {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}
.verdict {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: 0;
}
.verdict legend {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
}
.segments {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
  max-width: 560px;
  padding: 4px;
  border-radius: var(--radius-card);
  background: var(--ground);
}
.segment {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  border: 1.5px solid transparent;
  border-radius: var(--radius-control);
  color: var(--ink-2);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.segment:focus-within {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.segment.on.do {
  border-color: var(--do);
  background: var(--do-soft);
  color: var(--do);
}
.segment.on.delegate {
  border-color: var(--delegate);
  background: var(--delegate-soft);
  color: var(--delegate);
}
.segment.on.know {
  border-color: var(--know);
  background: var(--know-soft);
  color: var(--know);
}
.segment.on.none {
  border-color: var(--ink);
  background: var(--surface);
  color: var(--ink);
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  max-width: 560px;
}
.switch-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.switch {
  appearance: none;
  position: relative;
  flex: none;
  width: 40px;
  height: 24px;
  margin: 0;
  border-radius: 12px;
  background: var(--line-strong);
  cursor: pointer;
  transition: background-color 150ms ease;
}
.switch::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--surface);
  transition: transform 150ms ease;
}
.switch:checked {
  background: var(--do);
}
.switch:checked::after {
  transform: translateX(16px);
}
.switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.switch:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .switch,
  .switch::after {
    transition: none;
  }
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.actions .button {
  text-decoration: none;
}
.spacer {
  flex: 1;
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
@media (max-width: 560px) {
  .segments {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
