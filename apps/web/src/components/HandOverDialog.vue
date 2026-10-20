<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { dueChoices, firstName, MAX_NOTE, UnscannedFilesError, type DueChoice, type SyncedMessage } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import FieldLabel from '@/forms/FieldLabel.vue'
import { dayValue, handOverSchema, pickedDue, type HandOverValues } from '@/forms/handOver'
import { provideRequiredFields } from '@/forms/required'
import { dueLabel, senderName } from '@/mail/format'
import { useHandOversStore } from '@/stores/handOvers'
import RecipientField from '@/components/RecipientField.vue'

/** Hands a conversation over: forwarded to one person with a note, and waited on until the due date. */
const props = defineProps<{ message: SyncedMessage }>()

const handOvers = useHandOversStore()
const schema = handOverSchema()
provideRequiredFields(schema)

// The choices are fixed while the dialog is open, so a choice does not change under the user's hand.
const choices = dueChoices()
const choiceText: Record<DueChoice, string> = { today: 'Today', tomorrow: 'Tomorrow', friday: 'Friday', nextWeek: 'Next week' }

const { defineField, handleSubmit, errors, isSubmitting } = useForm<HandOverValues>({
  validationSchema: toTypedSchema(schema),
  initialValues: { delegate: [], note: '', due: choices[0]!.key, dueDay: '' },
})
const [delegate] = defineField('delegate')
const [note] = defineField('note')
const [due] = defineField('due')
const [dueDay] = defineField('dueDay')

const ui = reactive({ busy: false, error: null as string | null })
/** The server's question about files of the original that could not be scanned; null when there is none. */
const unscanned = ref<string | null>(null)
/** The user answered that question: the next submit forwards those files too. */
let acceptUnscanned = false
const firstField = ref<HTMLElement | null>(null)
// Today in the user's own calendar; a day whose due time passed already is refused by the schema.
const minDay = dayValue(new Date())
/** A hand-over is under way: from the first press on, while the form validates, until the server answered. */
const submitting = computed(() => isSubmitting.value || ui.busy)

const person = computed(() => delegate.value?.[0] ?? null)
const submitText = computed(() => (person.value === null ? 'Hand over' : `Hand over to ${firstName(person.value)}`))
const noteLabel = computed(() => (person.value === null ? 'Note' : `Note for ${firstName(person.value)}`))

function weekday(at: Date): string {
  return at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

const submit = handleSubmit(async (values) => {
  const dueAt = values.due === 'custom' ? pickedDue(values.dueDay) : (choices.find((choice) => choice.key === values.due)?.at ?? null)
  const to = values.delegate[0]
  if (dueAt === null || to === undefined) {
    return
  }
  unscanned.value = null
  ui.busy = true
  ui.error = null
  try {
    await handOvers.handOver(props.message, { delegate: to, note: values.note, dueAt, dueLabel: dueLabel(dueAt.toISOString()), acceptUnscanned })
  } catch (error) {
    if (error instanceof UnscannedFilesError) {
      unscanned.value = error.message
    } else {
      ui.error = errorMessage(error)
    }
  } finally {
    // A confirmation is for the files of this attempt only.
    acceptUnscanned = false
    ui.busy = false
  }
})

function handOverAnyway(): void {
  acceptUnscanned = true
  void submit()
}

function cancel(): void {
  if (!submitting.value) {
    handOvers.close()
  }
}

function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    // A second press while the first is on its way would forward the conversation twice.
    if (!submitting.value) {
      void submit()
    }
  }
}

onMounted(async () => {
  await nextTick()
  firstField.value?.querySelector<HTMLInputElement>('input')?.focus()
})
</script>

<template>
  <div class="backdrop" @mousedown.self="cancel">
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="hand-over-title" @keydown="keydown">
      <header class="head">
        <h2 id="hand-over-title">Hand over</h2>
        <p class="about">{{ message.subject || '(no subject)' }}, from {{ senderName(message.from) }}</p>
      </header>
      <form class="form" novalidate @submit.prevent="!submitting && submit()">
        <div ref="firstField">
          <RecipientField v-model="delegate" label="Hand over to" :error="errors.delegate" />
        </div>

        <label class="field">
          <FieldLabel name="note">{{ noteLabel }}</FieldLabel>
          <textarea v-model="note" rows="4" :maxlength="MAX_NOTE" placeholder="What should they do, and anything they need to know?" :aria-invalid="errors.note ? 'true' : undefined" />
          <small class="hint">Sent with the forward, above the original message and its files.</small>
          <small v-if="errors.note" class="error">{{ errors.note }}</small>
        </label>

        <fieldset class="field">
          <FieldLabel name="due" tag="legend">Due</FieldLabel>
          <div class="choices">
            <label v-for="choice in choices" :key="choice.key" class="choice" :class="{ on: due === choice.key }">
              <input v-model="due" type="radio" name="due" :value="choice.key" class="visually-hidden" />
              <span class="choice-label">{{ choiceText[choice.key] }}</span>
              <span class="choice-sub">{{ weekday(choice.at) }}</span>
            </label>
            <label class="choice" :class="{ on: due === 'custom' }">
              <input v-model="due" type="radio" name="due" value="custom" class="visually-hidden" />
              <span class="choice-label">Pick a date</span>
            </label>
          </div>
          <label v-if="due === 'custom'" class="day">
            <span class="visually-hidden">Due on</span>
            <input v-model="dueDay" type="date" :min="minDay" :aria-invalid="errors.dueDay ? 'true' : undefined" />
          </label>
          <small v-if="errors.dueDay" class="error">{{ errors.dueDay }}</small>
          <small class="hint">You see it in Waiting on until they reply. If the date passes without a reply, Tresso tells you and offers a nudge.</small>
        </fieldset>

        <p v-if="ui.error" class="form-error" role="alert">{{ ui.error }}</p>
        <div v-if="unscanned" class="unscanned" role="alert">
          <p>{{ unscanned }}</p>
          <button type="button" class="button button-quiet" :disabled="submitting" @click="handOverAnyway">Hand over anyway</button>
        </div>

        <footer class="actions">
          <button type="button" class="button button-quiet" :disabled="submitting" @click="cancel">Cancel <kbd>Esc</kbd></button>
          <button type="submit" class="button button-primary" :disabled="submitting">{{ submitting ? 'Handing over…' : submitText }}</button>
        </footer>
      </form>
    </section>
  </div>
</template>

<style scoped>
.backdrop {
  animation: fade-in var(--motion-base) ease-out;
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 10vh 16px 16px;
  background: rgb(22 24 29 / 32%);
  overflow-y: auto;
}
.dialog {
  animation: pop-in var(--motion-base) var(--ease-out);
  width: min(560px, 100%);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: var(--raised);
}
.head {
  padding: 22px 24px 14px;
  border-bottom: 1px solid var(--line);
}
h2 {
  margin: 0;
  font: 700 22px/28px var(--font-display);
}
.about {
  margin: 4px 0 0;
  color: var(--ink-2);
  font-size: 13px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px 24px 22px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
textarea,
.day input {
  font: inherit;
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--ink);
}
textarea {
  resize: vertical;
}
.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.choice {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 44px;
  padding: 4px 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  cursor: pointer;
}
.choice.on {
  border-color: var(--ink);
  background: var(--ink);
  color: var(--surface);
}
.choice:focus-within {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.choice-label {
  font-weight: 600;
  font-size: 13px;
}
.choice-sub {
  font-size: 12px;
  color: var(--ink-2);
}
.choice.on .choice-sub {
  color: color-mix(in srgb, var(--surface) 80%, transparent);
}
.hint {
  color: var(--ink-2);
  font-size: 12px;
}
.error,
.form-error {
  color: var(--danger);
  font-size: 13px;
}
.form-error {
  margin: 0;
}
.unscanned {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 10px 12px;
  border-radius: var(--radius-control);
  background: var(--danger-soft);
  font-size: 13px;
}
.unscanned p {
  flex: 1;
  margin: 0;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
kbd {
  font: 500 11px var(--font-mono);
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--ground);
  color: var(--ink-2);
}
</style>
