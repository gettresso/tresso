<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import {
  DEFAULT_PERSONAL_ACCESS_TOKEN_LIFETIME,
  PERSONAL_ACCESS_TOKEN_LIFETIMES,
  PERSONAL_ACCESS_TOKEN_SCOPES,
  personalAccessTokenScopeLabel,
  personalAccessTokenStatus,
  type CreatedPersonalAccessToken,
  type PersonalAccessToken,
  type PersonalAccessTokenLifetime,
} from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import FieldLabel from '@/forms/FieldLabel.vue'
import { personalAccessTokenSchema, type PersonalAccessTokenValues } from '@/forms/personalAccessTokens'
import { provideRequiredFields } from '@/forms/required'
import { backdropClose } from '@/components/backdropClose'
import { usePersonalAccessTokensStore } from '@/stores/personalAccessTokens'

provideRequiredFields(personalAccessTokenSchema)

const store = usePersonalAccessTokensStore()
const loading = ref(true)
const loadError = ref<string | null>(null)

const LIFETIME_TEXT: Record<PersonalAccessTokenLifetime, string> = { 30: '30 days', 90: '90 days', 365: '1 year' }

onMounted(async () => {
  try {
    await store.load()
  } catch (e) {
    loadError.value = errorMessage(e)
  } finally {
    loading.value = false
  }
})

function day(at: string): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function scopes(token: PersonalAccessToken): string {
  return token.scopes.map(personalAccessTokenScopeLabel).join(', ')
}

function validity(token: PersonalAccessToken): string {
  switch (personalAccessTokenStatus(token)) {
    case 'revoked':
      return `Revoked ${day(token.revokedAt!)}`
    case 'expired':
      return `Expired ${day(token.expiresAt)}`
    default:
      return `Expires ${day(token.expiresAt)}`
  }
}

function lastUsed(token: PersonalAccessToken): string {
  return token.lastUsedAt === null ? 'Never used' : `Last used ${day(token.lastUsedAt)}`
}

// Revoking, confirmed inline under the token.
const confirmingRevoke = ref<string | null>(null)
const revoking = ref(false)
const revokeError = ref<string | null>(null)

async function revoke(token: PersonalAccessToken): Promise<void> {
  revoking.value = true
  revokeError.value = null
  try {
    await store.revoke(token.id)
    confirmingRevoke.value = null
  } catch (e) {
    revokeError.value = errorMessage(e)
  } finally {
    revoking.value = false
  }
}

// Making a token, in a dialog that shows the secret once it is made.
const dialog = ref<HTMLDialogElement | null>(null)
const dialogOpen = ref(false)
const saving = ref(false)
const createError = ref<string | null>(null)
/** The token just made, with its secret; cleared when the dialog closes, so the secret is gone for good. */
const created = ref<CreatedPersonalAccessToken | null>(null)
const copied = ref(false)

const { defineField, handleSubmit, errors, resetForm, setErrors } = useForm<PersonalAccessTokenValues>({
  validationSchema: toTypedSchema(personalAccessTokenSchema),
  initialValues: { name: '', scopes: [], expiresInDays: DEFAULT_PERSONAL_ACCESS_TOKEN_LIFETIME },
})
const [name] = defineField('name')
const [chosenScopes] = defineField('scopes')
const [expiresInDays] = defineField('expiresInDays')

const expiresOn = computed(() => {
  const days = expiresInDays.value ?? DEFAULT_PERSONAL_ACCESS_TOKEN_LIFETIME

  return day(new Date(Date.now() + days * 86_400_000).toISOString())
})

async function openDialog(): Promise<void> {
  resetForm({ values: { name: '', scopes: [], expiresInDays: DEFAULT_PERSONAL_ACCESS_TOKEN_LIFETIME } })
  created.value = null
  copied.value = false
  createError.value = null
  dialogOpen.value = true
  await nextTick()
  dialog.value?.showModal?.()
  dialog.value?.querySelector<HTMLInputElement>('input')?.focus()
}

function closeDialog(): void {
  if (saving.value) {
    return
  }
  dialog.value?.close?.()
  dialogOpen.value = false
  created.value = null
  copied.value = false
}

const backdrop = backdropClose(() => {
  // With the secret on screen, closing takes a deliberate press on Done.
  if (created.value === null) closeDialog()
})

/** The API reports a refused scope as scopes[0]; the form shows it for the whole group. */
function fieldErrors(violations: Record<string, string>): Partial<Record<keyof PersonalAccessTokenValues, string>> {
  const mapped: Partial<Record<keyof PersonalAccessTokenValues, string>> = {}
  for (const [path, message] of Object.entries(violations)) {
    if (path.startsWith('scopes')) mapped.scopes = message
    else if (path === 'name' || path === 'expiresInDays') mapped[path] = message
  }
  return mapped
}

const create = handleSubmit(async (values) => {
  saving.value = true
  createError.value = null
  try {
    created.value = await store.create({ name: values.name.trim(), scopes: values.scopes, expiresInDays: values.expiresInDays })
  } catch (e) {
    createError.value = errorMessage(e)
    if (e instanceof ApiError) setErrors(fieldErrors(e.violations))
  } finally {
    saving.value = false
  }
})

async function copy(): Promise<void> {
  if (created.value === null) {
    return
  }
  try {
    await navigator.clipboard.writeText(created.value.token)
    copied.value = true
  } catch {
    // Without clipboard access the field stays selectable, so the token can still be copied by hand.
    copied.value = false
    createError.value = 'Copying did not work. Select the token and copy it yourself.'
  }
}

function selectSecret(event: FocusEvent): void {
  ;(event.target as HTMLInputElement).select()
}
</script>

<template>
  <section class="access-tokens" aria-labelledby="access-tokens-title">
    <header class="header">
      <div>
        <h2 id="access-tokens-title">Access tokens</h2>
        <p class="lead">
          Personal access tokens let your own scripts and tools use the Tresso API as you, with only the permissions you
          give them. Treat a token like a password.
        </p>
      </div>
      <button type="button" class="button new" @click="openDialog">New token</button>
    </header>

    <p v-if="loading" class="state" role="status">Loading tokens…</p>
    <p v-else-if="loadError" class="form-error" role="alert">{{ loadError }}</p>
    <p v-else-if="store.tokens.length === 0" class="state">No access tokens yet.</p>

    <ul v-else class="tokens" aria-label="Access tokens">
      <li v-for="token in store.tokens" :key="token.id" class="token" :class="{ inactive: personalAccessTokenStatus(token) !== 'active' }">
        <div class="token-main">
          <div class="token-head">
            <span class="token-name">{{ token.name }}</span>
            <code class="prefix">{{ token.prefix }}…</code>
          </div>
          <span class="token-scopes">{{ scopes(token) }}</span>
          <span class="token-meta">{{ validity(token) }} · {{ lastUsed(token) }}</span>
        </div>
        <button
          v-if="personalAccessTokenStatus(token) === 'active'"
          type="button"
          class="button button-danger"
          :disabled="revoking"
          @click="confirmingRevoke = token.id; revokeError = null"
        >
          Revoke
        </button>

        <div v-if="confirmingRevoke === token.id" class="confirm" role="alertdialog" :aria-labelledby="`revoke-${token.id}`">
          <p :id="`revoke-${token.id}`"><strong>Revoke {{ token.name }}?</strong></p>
          <p>Scripts and tools that use it stop working right away. This cannot be undone.</p>
          <p v-if="revokeError" class="form-error" role="alert">{{ revokeError }}</p>
          <div class="actions">
            <button type="button" class="button button-danger" :disabled="revoking" @click="revoke(token)">Revoke token</button>
            <button type="button" class="button button-quiet" @click="confirmingRevoke = null">Keep it</button>
          </div>
        </div>
      </li>
    </ul>

    <p class="hint">Revoked and expired tokens disappear from this list after 30 days.</p>

    <dialog
      v-if="dialogOpen"
      ref="dialog"
      class="token-dialog"
      aria-labelledby="token-dialog-title"
      @cancel.prevent="created === null && closeDialog()"
      @pointerdown="backdrop.onPointerdown"
      @click="backdrop.onClick"
    >
      <template v-if="created === null">
        <form class="form" novalidate @submit.prevent="create">
          <h2 id="token-dialog-title">New access token</h2>

          <label class="field">
            <FieldLabel name="name">Name</FieldLabel>
            <input v-model="name" maxlength="80" placeholder="For example: Backup script" :aria-invalid="errors.name ? 'true' : undefined" />
            <small class="hint">So you know later what the token is for.</small>
            <small v-if="errors.name" class="error">{{ errors.name }}</small>
          </label>

          <fieldset class="group">
            <FieldLabel name="scopes" tag="legend">What it may do</FieldLabel>
            <div class="scopes">
              <label v-for="scope in PERSONAL_ACCESS_TOKEN_SCOPES" :key="scope.value" class="check">
                <input v-model="chosenScopes" type="checkbox" :value="scope.value" />
                <span>
                  <span class="check-label">{{ scope.label }}</span>
                  <span class="hint">{{ scope.description }}</span>
                </span>
              </label>
            </div>
            <small v-if="errors.scopes" class="error">{{ errors.scopes }}</small>
          </fieldset>

          <fieldset class="group">
            <FieldLabel name="expiresInDays" tag="legend">Expires after</FieldLabel>
            <div class="lifetimes">
              <label v-for="days in PERSONAL_ACCESS_TOKEN_LIFETIMES" :key="days" class="lifetime" :class="{ on: expiresInDays === days }">
                <input v-model="expiresInDays" type="radio" name="expiresInDays" :value="days" class="visually-hidden" />
                <span>{{ LIFETIME_TEXT[days] }}</span>
              </label>
            </div>
            <small class="hint">Stops working on {{ expiresOn }}. Make a new one when it does.</small>
            <small v-if="errors.expiresInDays" class="error">{{ errors.expiresInDays }}</small>
          </fieldset>

          <p v-if="createError" class="form-error" role="alert">{{ createError }}</p>

          <div class="actions">
            <button type="submit" class="button button-primary" :disabled="saving">{{ saving ? 'Creating…' : 'Create token' }}</button>
            <button type="button" class="button button-quiet" :disabled="saving" @click="closeDialog">Cancel</button>
          </div>
        </form>
      </template>

      <div v-else class="form">
        <h2 id="token-dialog-title">Copy your new token</h2>
        <p class="warning" role="alert">This is the only time you see this token. Copy it now and keep it somewhere safe, like a password manager.</p>
        <div class="secret">
          <label for="new-token-secret" class="visually-hidden">Token for {{ created.name }}</label>
          <input id="new-token-secret" :value="created.token" readonly spellcheck="false" @focus="selectSecret" />
          <button type="button" class="button button-primary" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
        </div>
        <p class="hint">Send it as <code>Authorization: Bearer &lt;token&gt;</code> to the Tresso API.</p>
        <p v-if="createError" class="form-error" role="alert">{{ createError }}</p>
        <div class="actions">
          <button type="button" class="button button-quiet" @click="closeDialog">Done</button>
        </div>
      </div>
    </dialog>
  </section>
</template>

<style scoped>
.access-tokens {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 760px;
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
.lead,
.state {
  margin: 0;
  color: var(--ink-2);
  line-height: 21px;
}
.new {
  flex-shrink: 0;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--ink);
}
.tokens {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}
.token {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
}
.token + .token {
  border-top: 1px solid var(--line);
}
.token-main {
  display: flex;
  flex: 1 1 320px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.token-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.token-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.prefix {
  font-size: 12px;
  color: var(--ink-2);
}
.token-scopes,
.token-meta,
.hint {
  margin: 0;
  font-size: 13px;
  color: var(--ink-2);
}
.inactive .token-name,
.inactive .token-scopes {
  color: var(--ink-2);
}
.confirm {
  flex-basis: 100%;
  padding: 12px 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-card);
  background: var(--ground);
}
.confirm p {
  margin: 0 0 8px;
}
.actions {
  display: flex;
  gap: 8px;
}
.token-dialog {
  animation: pop-in var(--motion-base) var(--ease-out);
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  color: var(--ink);
  box-shadow: var(--raised);
}
.token-dialog h2 {
  margin: 0;
  font: 700 18px/24px var(--font-display);
}
.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 13px;
  font-weight: 600;
}
.group .check-label,
.group .lifetime {
  font-size: 14px;
}
.group .hint {
  font-weight: 400;
}
.scopes {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.check {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}
.check input {
  width: 16px;
  height: 16px;
  margin: 2px 0 0;
}
.check > span {
  display: flex;
  flex-direction: column;
}
.check-label {
  font-weight: 600;
}
.lifetimes {
  display: flex;
  gap: 8px;
}
.lifetime {
  padding: 6px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  cursor: pointer;
}
.lifetime.on {
  border-color: var(--ink);
  font-weight: 600;
}
.lifetime:focus-within {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.warning {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-card);
  background: var(--ground);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  font-weight: 600;
}
.secret {
  display: flex;
  gap: 8px;
}
.secret input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--ink);
  font: 400 13px var(--font-mono);
}
.group .error {
  font-weight: 500;
  color: var(--danger);
}
@media (max-width: 520px) {
  .header {
    flex-direction: column;
  }
}
</style>
