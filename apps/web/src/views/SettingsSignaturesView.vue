<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import type { SignatureUpdate, SyncedSignature } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import FieldLabel from '@/forms/FieldLabel.vue'
import { provideRequiredFields } from '@/forms/required'
import { signatureSchema, type SignatureValues } from '@/forms/signatures'
import { useMailStore } from '@/stores/mail'
import { useSignaturesStore } from '@/stores/signatures'
import SignaturePreview from '@/components/SignaturePreview.vue'
import KeyShortcut from '@/components/KeyShortcut.vue'

const NEW = 'new'

provideRequiredFields(signatureSchema)

const store = useSignaturesStore()
const mail = useMailStore()

/** The signature being edited, or NEW for one that is not saved yet. */
const selectedId = ref<string | null>(null)
const saving = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)
const confirmingRemoval = ref(false)

const { defineField, handleSubmit, errors, values, meta: formMeta, resetForm, setErrors, setFieldValue } = useForm<SignatureValues>({
  validationSchema: toTypedSchema(signatureSchema),
  initialValues: { name: '', html: '', defaultFor: [] },
})
const [name] = defineField('name')
const [html] = defineField('html')
const draftDefaults = computed(() => values.defaultFor ?? [])

const selected = computed<SyncedSignature | null>(() => store.signatures.find((s) => s.id === selectedId.value) ?? null)
function saved(): SignatureValues {
  const signature = selected.value
  if (signature === null) {
    return { name: '', html: '', defaultFor: [] }
  }

  return { name: signature.name, html: signature.html, defaultFor: store.defaultFor(signature.id) }
}

function sameAccounts(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id))
}

const dirty = computed(() => formMeta.value.dirty)

const size = computed(() => {
  const bytes = new TextEncoder().encode(values.html ?? '').length

  return bytes === 1 ? '1 byte' : `${bytes} bytes`
})


const defaultForError = computed(() => Object.entries(errors.value).find(([path]) => path.startsWith('defaultFor'))?.[1] ?? null)

function reset(): void {
  const current = saved()
  resetForm({ values: { ...current, defaultFor: [...current.defaultFor] } })
  confirmingRemoval.value = false
}

function select(id: string | null): void {
  selectedId.value = id
  message.value = null
  error.value = null
  reset()
}

function startNew(): void {
  select(NEW)
}

// Opens the first signature once the synced copy has them, and follows changes from other devices while the draft
// has no changes of its own. A signature deleted elsewhere closes.
watch(
  () => [store.signatures, store.accounts] as const,
  () => {
    if (selectedId.value === null) {
      if (store.signatures.length > 0) {
        select(store.signatures[0]!.id)
      }
      return
    }
    if (selectedId.value !== NEW && selected.value === null) {
      select(store.signatures[0]?.id ?? null)
      return
    }
    if (selectedId.value !== NEW && !saving.value && !dirty.value) {
      reset()
    }
  },
  { immediate: true },
)

function meta(signature: SyncedSignature): string {
  const count = store.defaultFor(signature.id).length
  if (count === 0) {
    return 'Not a default'
  }

  return count === 1 ? 'Default for 1 account' : `Default for ${count} accounts`
}

/** For an account left unticked: what it inserts after saving, so ticking it shows what it replaces. */
function currentDefault(accountId: string): string | null {
  if (draftDefaults.value.includes(accountId)) {
    return null
  }
  const current = store.accounts.find((a) => a.id === accountId)?.defaultSignatureId ?? null
  const other = current === selectedId.value ? undefined : store.signatures.find((s) => s.id === current)

  return other?.name ?? 'no signature'
}

function toggleDefault(accountId: string): void {
  const ids = draftDefaults.value
  setFieldValue('defaultFor', ids.includes(accountId) ? ids.filter((id) => id !== accountId) : [...ids, accountId])
}

function changes(current: SignatureValues): SignatureUpdate {
  const original = saved()
  const changed: SignatureUpdate = {}
  if (current.name !== original.name) changed.name = current.name
  if (current.html !== original.html) changed.html = current.html
  if (!sameAccounts(current.defaultFor, original.defaultFor)) changed.defaultFor = current.defaultFor

  return changed
}

async function run(action: () => Promise<void>, done: string): Promise<void> {
  saving.value = true
  error.value = null
  message.value = null
  try {
    await action()
    message.value = done
  } catch (e) {
    error.value = errorMessage(e)
    if (e instanceof ApiError) setErrors(e.violations)
  } finally {
    saving.value = false
  }
}

const save = handleSubmit((current) => {
  if (selectedId.value === NEW) {
    return run(async () => {
      const created = await store.create({ name: current.name, html: current.html, defaultFor: current.defaultFor })
      selectedId.value = created.id
      reset()
    }, 'Saved. Scripts and external styles, if any, were removed.')
  }

  const id = selectedId.value
  const changed = changes(current)
  if (id === null || Object.keys(changed).length === 0) {
    message.value = 'Nothing changed.'
    return
  }

  return run(async () => {
    await store.update(id, changed)
    reset()
  }, 'Saved. Scripts and external styles, if any, were removed.')
})

function remove(): Promise<void> {
  const id = selectedId.value
  if (id === null || id === NEW) {
    return Promise.resolve()
  }

  return run(async () => {
    await store.remove(id)
    select(store.signatures.find((s) => s.id !== id)?.id ?? null)
  }, 'Signature deleted.')
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
  <section class="signatures">
    <header class="header">
      <div>
        <h2>Signatures</h2>
        <p>HTML signatures, synced to every device and available to the API.</p>
      </div>
      <button type="button" class="button new" :disabled="saving" @click="startNew">New signature</button>
    </header>

    <p v-if="!mail.ready" class="state">Loading signatures…</p>
    <p v-else-if="store.signatures.length === 0 && selectedId !== NEW" class="state">
      No signatures yet. Create one to add it to new messages automatically.
    </p>

    <div v-if="mail.ready && (store.signatures.length > 0 || selectedId === NEW)" class="layout">
      <div role="listbox" aria-label="Signatures" class="list">
        <button
          v-for="signature in store.signatures"
          :key="signature.id"
          type="button"
          role="option"
          class="option"
          :aria-selected="signature.id === selectedId"
          @click="select(signature.id)"
        >
          <span class="option-name">{{ signature.name }}</span>
          <span class="option-meta">{{ meta(signature) }}</span>
        </button>
        <button v-if="selectedId === NEW" type="button" role="option" class="option" aria-selected="true">
          <span class="option-name">{{ (name ?? '').trim() || 'New signature' }}</span>
          <span class="option-meta">Not saved yet</span>
        </button>
      </div>

      <form v-if="selectedId !== null" class="editor" aria-label="Signature editor" novalidate @submit.prevent="save" @keydown="saveShortcut">
        <label class="field">
          <FieldLabel name="name">Name</FieldLabel>
          <input v-model="name" maxlength="120" :aria-invalid="errors.name ? 'true' : undefined" />
          <small v-if="errors.name" class="error">{{ errors.name }}</small>
        </label>

        <div class="code">
          <div class="code-bar">
            <span>Inline styles only. Scripts and external CSS are removed on save.</span>
            <span class="size">{{ size }}</span>
          </div>
          <label for="signature-html" class="visually-hidden">Signature HTML</label>
          <textarea
            id="signature-html"
            v-model="html"
            spellcheck="false"
            rows="8"
            :aria-invalid="errors.html ? 'true' : undefined"
          />
        </div>
        <small v-if="errors.html" class="form-error">{{ errors.html }}</small>

        <div class="previews">
          <span class="label">Live preview</span>
          <div class="preview-grid">
            <div class="preview light">
              <span class="preview-label">Light background</span>
              <SignaturePreview :html="html ?? ''" background="light" />
            </div>
            <div class="preview dark">
              <span class="preview-label">Dark background</span>
              <SignaturePreview :html="html ?? ''" background="dark" />
            </div>
          </div>
        </div>

        <fieldset class="defaults">
          <legend>Default for</legend>
          <p v-if="store.accounts.length === 0" class="hint">Add a mail account to use this signature by default.</p>
          <label v-for="account in store.accounts" :key="account.id" class="check">
            <input type="checkbox" :checked="draftDefaults.includes(account.id)" @change="toggleDefault(account.id)" />
            <span>{{ account.displayName }}</span>
            <span v-if="currentDefault(account.id)" class="now">(now {{ currentDefault(account.id) }})</span>
          </label>
          <small v-if="defaultForError" class="error">{{ defaultForError }}</small>
        </fieldset>

        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <p v-if="message" class="done" role="status">{{ message }}</p>

        <div class="actions">
          <button
            v-if="selectedId !== NEW"
            type="button"
            class="button button-danger"
            :disabled="saving"
            @click="confirmingRemoval = true"
          >
            Delete
          </button>
          <span class="spacer" />
          <button type="button" class="button button-quiet" :disabled="saving || !dirty" @click="reset">Discard changes</button>
          <button type="submit" class="button button-primary" :disabled="saving">
            Save signature <KeyShortcut keys="Mod+S" />
          </button>
        </div>

        <div v-if="confirmingRemoval" class="confirm" role="alertdialog" aria-labelledby="delete-title">
          <p id="delete-title"><strong>Delete {{ selected?.name }}?</strong></p>
          <p>It disappears on every device. Accounts that use it by default get no signature.</p>
          <div class="actions">
            <button type="button" class="button button-danger" :disabled="saving" @click="remove">Delete signature</button>
            <button type="button" class="button button-quiet" @click="confirmingRemoval = false">Keep it</button>
          </div>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.signatures {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 980px;
}
.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
h2 {
  margin: 0 0 4px;
  font-size: 20px;
  line-height: 28px;
}
.header p,
.state {
  margin: 0;
  color: var(--ink-2);
}
.new {
  flex-shrink: 0;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--ink);
}
.layout {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 16px;
}
.list {
  display: flex;
  flex: 1 1 200px;
  flex-direction: column;
  gap: 2px;
  max-width: 240px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}
.option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--radius-card);
  background: transparent;
  color: var(--ink);
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.option[aria-selected='true'] {
  background: var(--ground);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.option-name {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.option-meta {
  font-size: 12px;
  color: var(--ink-2);
}
.editor {
  display: flex;
  flex: 999 1 420px;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 18px 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}
.code {
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-card);
}
.code-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--ground);
  color: var(--ink-2);
  font-size: 12px;
}
.code-bar span:first-child {
  flex: 1;
}
.size {
  font: 500 11px var(--font-mono);
}
textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 156px;
  margin: 0;
  padding: 12px 14px;
  border: 0;
  outline: 0;
  resize: vertical;
  background: var(--surface);
  color: var(--ink);
  font: 400 12px/19px var(--font-mono);
  white-space: pre;
}
.code:focus-within {
  border-color: var(--focus);
}
.previews {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.label,
legend {
  font-size: 13px;
  font-weight: 600;
}
.preview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}
.preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-radius: var(--radius-card);
}
.preview.light {
  border: 1px solid #e3e5e9;
  background: #fff;
}
.preview.dark {
  border: 1px solid #2c3038;
  background: #1b1d22;
}
.preview-label {
  font-size: 11px;
  font-weight: 600;
}
.light .preview-label {
  color: #4a505c;
}
.dark .preview-label {
  color: #c4c8d0;
}
.defaults {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  margin: 0;
  padding: 12px 0 0;
  border: 0;
  border-top: 1px solid var(--line);
}
.defaults legend {
  padding: 0 0 6px;
}
.defaults .hint {
  margin: 0;
  color: var(--ink-2);
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  font-size: 14px;
  cursor: pointer;
}
.check input {
  width: 18px;
  height: 18px;
  margin: 0;
  accent-color: var(--ink);
}
.now {
  color: var(--ink-2);
}
.error {
  flex-basis: 100%;
  font-weight: 500;
  color: var(--danger);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.spacer {
  flex: 1;
}
.done {
  margin: 0;
  color: var(--know);
  font-weight: 500;
}
.form-error {
  margin: 0;
}
.confirm {
  padding: 14px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-card);
}
.confirm p {
  margin: 0 0 8px;
}
@media (max-width: 760px) {
  .list {
    max-width: none;
  }
}
</style>
