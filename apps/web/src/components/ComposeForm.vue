<script setup lang="ts">
import FieldLabel from '@/forms/FieldLabel.vue'
import { provideRequiredFields } from '@/forms/required'
import { computed, ref, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import type { Draft } from '@/mail/db'
import { composeSchema, type ComposeValues } from '@/forms/compose'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import RecipientField from '@/components/RecipientField.vue'
import RichEditor from '@/components/RichEditor.vue'
import MessageFrame from '@/components/MessageFrame.vue'
import SignaturePreview from '@/components/SignaturePreview.vue'
import DraftAttachments from '@/components/DraftAttachments.vue'
import { RouterLink } from 'vue-router'
import { sendLaterOptions, type SendLaterKey } from '@tresso/core'

const props = defineProps<{ draft: Draft }>()

provideRequiredFields(composeSchema)

const compose = useComposeStore()
const mail = useMailStore()
const showCopies = ref(props.draft.cc.length > 0 || props.draft.bcc.length > 0)
const laterOpen = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const dropping = ref(false)
/** The files of the draft as the server has them; they are not form fields. Images of the quote are shown in it. */
const attachments = computed(() => (compose.draft?.attachments ?? props.draft.attachments).filter((attachment) => !attachment.inline))

function pickFiles(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  void compose.attach(files)
}

function dropFiles(event: DragEvent): void {
  dropping.value = false
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length > 0) {
    void compose.attach(files)
  }
}
const customTime = ref('')
const timeError = ref<string | null>(null)

const { defineField, handleSubmit, errors, values, setErrors } = useForm<ComposeValues>({
  validationSchema: toTypedSchema(composeSchema),
  initialValues: {
    mailAccountId: props.draft.mailAccountId ?? '',
    to: props.draft.to,
    cc: props.draft.cc,
    bcc: props.draft.bcc,
    subject: props.draft.subject,
    html: props.draft.html,
    signatureId: props.draft.signatureId,
  },
})
const [mailAccountId] = defineField('mailAccountId')
const [to] = defineField('to')
const [cc] = defineField('cc')
const [bcc] = defineField('bcc')
const [subject] = defineField('subject')
const [html] = defineField('html')
const [signatureId] = defineField('signatureId')
const showQuote = ref(false)
/** The quote with the images that go along through fresh links, for the quote it was made from. */
const shownQuote = ref<{ quote: string; shown: string } | null>(null)
watch(
  [showQuote, () => compose.draft?.quoteHtml ?? props.draft.quoteHtml],
  async ([open, quote]) => {
    if (!open) {
      return
    }
    const shown = await compose.shownQuote(quote)
    // A quote changed meanwhile has its own turn.
    if (quote === (compose.draft?.quoteHtml ?? props.draft.quoteHtml)) {
      shownQuote.value = { quote, shown }
    }
  },
  { immediate: true },
)
const signature = computed(() => mail.signatures.find((s) => s.id === signatureId.value) ?? null)

// Switching the account swaps the signature, unless the user picked one by hand.
watch(mailAccountId, (account, previous) => {
  if ((signatureId.value ?? null) === compose.defaultSignature(previous ?? null)) {
    signatureId.value = compose.defaultSignature(account ?? null)
  }
})

// Every edit goes back to the draft, which saves itself on this device.
watch(
  values,
  (current) => {
    compose.update({
      mailAccountId: current.mailAccountId === '' ? null : (current.mailAccountId ?? null),
      to: current.to ?? [],
      cc: current.cc ?? [],
      bcc: current.bcc ?? [],
      subject: current.subject ?? '',
      html: current.html ?? '',
      signatureId: current.signatureId ?? null,
    })
  },
  { deep: true },
)

// What the API refused lands next to the field.
watch(
  () => compose.violations,
  (violations) => {
    const fieldErrors: Partial<Record<string, string>> = {}
    for (const [path, message] of Object.entries(violations)) {
      fieldErrors[path.replace(/\[\d+\].*$/, '')] = message
    }
    setErrors(fieldErrors)
  },
)

const send = handleSubmit(() => compose.send())

const laterLabels: Record<SendLaterKey, string> = {
  thisEvening: 'This evening',
  tomorrowMorning: 'Tomorrow morning',
  tomorrowAfternoon: 'Tomorrow afternoon',
  mondayMorning: 'Monday morning',
}

const laterOptions = computed(() => sendLaterOptions().map((option) => ({ label: laterLabels[option.key], time: option.at })))

const sendLater = (time: Date) =>
  handleSubmit(() => {
    laterOpen.value = false
    return compose.send(time)
  })()

function sendCustom(): void {
  const time = new Date(customTime.value)
  if (Number.isNaN(time.getTime()) || time.getTime() < Date.now()) {
    timeError.value = 'Pick a time in the future.'
    return
  }
  timeError.value = null
  void sendLater(time)
}

function keydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    void send()
  }
}
</script>

<template>
  <form
    class="body"
    :class="{ dropping }"
    novalidate
    @submit.prevent="send"
    @keydown="keydown"
    @dragover.prevent="dropping = true"
    @dragleave.self="dropping = false"
    @drop.prevent="dropFiles"
  >
    <div class="field-row" :class="{ invalid: errors.mailAccountId }">
      <FieldLabel tag="label" for="compose-from" name="mailAccountId" class="label">From</FieldLabel>
      <select id="compose-from" v-model="mailAccountId">
        <option v-if="!mailAccountId" value="">Choose an account</option>
        <option v-for="account in mail.accounts" :key="account.id" :value="account.id">{{ account.displayName }} &lt;{{ account.emailAddress }}&gt;</option>
      </select>
    </div>
    <small v-if="errors.mailAccountId" class="field-error">{{ errors.mailAccountId }}</small>
    <RecipientField v-model="to" label="To" :error="errors.to" />
    <button v-if="!showCopies" type="button" class="copies" @click="showCopies = true">Add Cc or Bcc</button>
    <template v-else>
      <RecipientField v-model="cc" label="Cc" :error="errors.cc" />
      <RecipientField v-model="bcc" label="Bcc" :error="errors.bcc" />
    </template>
    <div class="field-row" :class="{ invalid: errors.subject }">
      <label for="compose-subject" class="label">Subject</label>
      <input id="compose-subject" v-model="subject" class="subject" maxlength="998" />
    </div>
    <small v-if="errors.subject" class="field-error">{{ errors.subject }}</small>

    <RichEditor v-model="html" @submit="send" />
    <small v-if="errors.html" class="field-error">{{ errors.html }}</small>

    <DraftAttachments
      :attachments="attachments"
      :attaching="compose.attaching"
      @open="(id) => compose.openAttachment(id)"
      @open-unscanned="(id) => compose.openAttachment(id, true)"
      @remove="compose.removeAttachment"
    />

    <div class="signature">
      <label for="compose-signature" class="label">Signature</label>
      <select id="compose-signature" v-model="signatureId">
        <option :value="null">No signature</option>
        <option v-for="option in mail.signatures" :key="option.id" :value="option.id">{{ option.name }}</option>
      </select>
      <RouterLink :to="{ name: 'settings-signatures' }" class="edit">Edit</RouterLink>
    </div>
    <SignaturePreview v-if="signature" :html="signature.html" background="light" />

    <div v-if="draft.quoteHtml" class="quote">
      <button type="button" class="toggle" :aria-expanded="showQuote" @click="showQuote = !showQuote">
        {{ showQuote ? 'Hide' : 'Show' }} {{ draft.kind === 'forward' ? 'forwarded message' : 'quoted text' }}
      </button>
      <MessageFrame v-if="showQuote" :html="shownQuote?.quote === draft.quoteHtml ? shownQuote.shown : draft.quoteHtml" :allow-remote-content="false" />
    </div>

    <p v-if="compose.error" class="form-error" role="alert">{{ compose.error }}</p>

    <div v-if="compose.unscannedToConfirm" class="unscanned" role="alertdialog" aria-labelledby="compose-unscanned">
      <p id="compose-unscanned">{{ compose.unscannedToConfirm.message }} Files that were not checked can contain malware.</p>
      <div class="unscanned-actions">
        <button type="button" class="button button-quiet" @click="compose.keepEditing()">Keep editing</button>
        <button type="button" class="button button-danger" :disabled="compose.sending" @click="compose.sendAnyway()">Send anyway</button>
      </div>
    </div>

    <footer class="actions">
      <button type="submit" class="button button-primary" :disabled="compose.sending">Send <kbd>⌘ Enter</kbd></button>
      <div class="later">
        <button type="button" class="button button-quiet" :aria-expanded="laterOpen" @click="laterOpen = !laterOpen">Send later</button>
        <div v-if="laterOpen" class="menu" role="menu">
          <button v-for="option in laterOptions" :key="option.label" type="button" role="menuitem" @click="sendLater(option.time)">
            <span>{{ option.label }}</span>
            <span class="when">{{ option.time.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }}</span>
          </button>
          <div class="custom">
            <label for="compose-later">Pick date and time</label>
            <input id="compose-later" v-model="customTime" type="datetime-local" />
            <small v-if="timeError" class="field-error">{{ timeError }}</small>
            <button type="button" class="button button-quiet" @click="sendCustom">Schedule</button>
          </div>
        </div>
      </div>
      <button type="button" class="button button-quiet" @click="fileInput?.click()">Attach files</button>
      <input ref="fileInput" class="file-input" type="file" multiple tabindex="-1" aria-hidden="true" @change="pickFiles" />
      <span class="spacer" />
      <button type="button" class="button button-quiet" @click="compose.discard()">Discard</button>
    </footer>
  </form>
</template>

<style scoped>
.unscanned {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 12px 0 0;
  padding: 12px 14px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-card);
  background: var(--danger-soft);
  color: var(--ink);
}
.unscanned p {
  flex: 1 1 260px;
  margin: 0;
  font-size: 13px;
}
.unscanned-actions {
  display: flex;
  gap: 8px;
}
.file-input {
  display: none;
}
.dropping {
  outline: 2px dashed var(--focus);
  outline-offset: -4px;
}
.body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
  padding: 0 16px 12px;
}
.field-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--line);
}
.field-row.invalid .label {
  color: var(--danger);
}
.label {
  width: 52px;
  color: var(--ink-2);
  font-size: 13px;
}
select,
.subject {
  flex: 1;
  min-width: 0;
  height: 30px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
}
.subject {
  font-weight: 600;
}
.field-error {
  padding: 2px 0 2px 62px;
  color: var(--danger);
  font-size: 12px;
}
.signature {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0 4px;
  border-top: 1px solid var(--line);
}
.signature select {
  flex: 0 1 auto;
}
.edit {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
}
.quote {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
}
.toggle {
  align-self: flex-start;
  border: 0;
  background: none;
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.copies {
  align-self: flex-start;
  margin: 4px 0;
  border: 0;
  background: none;
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
}
kbd {
  font: 500 11px var(--font-mono);
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--surface) 25%, transparent);
}
.later {
  position: relative;
}
.menu {
  transform-origin: bottom left;
  animation: pop-in var(--motion-fast) var(--ease-out);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  width: 280px;
  padding: 6px;
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: var(--raised);
}
.menu > button {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.menu > button:hover {
  background: var(--ground);
}
.when {
  color: var(--ink-3);
  font-size: 12px;
}
.custom {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px 4px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--ink-2);
}
.custom input {
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--ink);
}
.custom .field-error {
  padding: 0;
}
.spacer {
  flex: 1;
}
</style>
