<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
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
import KeyShortcut from '@/components/KeyShortcut.vue'
import LogoLoader from '@/components/LogoLoader.vue'
import { backdropClose } from '@/components/backdropClose'

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

// Escape reaches the dialog as its cancel event; a popup inside it (the suggestion list) that handles Escape itself
// prevents that, so closing the popup does not close the dialog and lose the note.
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    // A second press while the first is on its way would forward the conversation twice.
    if (!submitting.value) {
      void submit()
    }
  }
}

const dialog = ref<HTMLDialogElement | null>(null)
// A click on the backdrop closes it like Cancel.
const backdrop = backdropClose(cancel)

// Focus goes back to what opened the dialog once it has left the page (App.vue, useFocusReturn): while it is open,
// also through its leave animation, everything outside it is inert.
let unmounted = false

onMounted(async () => {
  // Modal: the page behind is inert, so Tab stays inside the dialog and a screen reader does not read behind it.
  dialog.value?.showModal?.()
  await nextTick()
  firstField.value?.querySelector<HTMLInputElement>('input')?.focus()
})

onBeforeUnmount(() => {
  unmounted = true
})

/**
 * The browser closed the dialog itself: Chromium lets a page refuse Escape (cancel) only once without a click or key
 * in between, then closes anyway. While a hand-over is on its way the dialog comes back, so its outcome (or error)
 * stays in view; otherwise closing it this way is Cancel.
 */
function closed(): void {
  if (unmounted) {
    return
  }
  if (submitting.value) {
    dialog.value?.showModal?.()
    return
  }
  handOvers.close()
}
</script>

<template>
  <dialog ref="dialog" class="dialog" aria-labelledby="hand-over-title" @cancel.prevent="cancel" @close="closed" @keydown="keydown" @pointerdown="backdrop.onPointerdown" @click="backdrop.onClick">
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
        <button type="button" class="button button-quiet" :disabled="submitting" @click="cancel">Cancel <KeyShortcut keys="Esc" /></button>
        <button type="submit" class="button button-primary" :disabled="submitting"><template v-if="submitting"><LogoLoader tone="current" /> Handing over…</template><template v-else>{{ submitText }}</template></button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.dialog {
  animation: pop-in var(--motion-base) var(--ease-out);
  width: min(560px, calc(100vw - 32px));
  /* Opens at the same height whatever it holds, so the form does not jump when an error appears; its bottom stays
     16 px inside the window (10vh above it plus at most 90vh - 16px of dialog), so the footer can always be reached. */
  max-height: calc(90vh - 16px);
  margin: 10vh auto auto;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  color: var(--ink);
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
  color: var(--paper);
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
  color: color-mix(in srgb, var(--paper) 80%, transparent);
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
</style>
