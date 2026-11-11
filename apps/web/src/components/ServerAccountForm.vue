<script setup lang="ts">
import FieldLabel from '@/forms/FieldLabel.vue'
import { provideRequiredFields } from '@/forms/required'
import { computed, ref, useId, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { foundCalendarUrl, type MailAccount, type MailAccountUpdate, type ServerSettings } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { accountSchema, serverErrors, type AccountValues } from '@/forms/accounts'
import { useAccountsStore } from '@/stores/accounts'
import ServerFields from '@/components/ServerFields.vue'

/** The name, password and servers of an IMAP account, and the address of its calendars. */
const props = defineProps<{ account: MailAccount; servers: { username: string; imap: ServerSettings; smtp: ServerSettings } }>()

provideRequiredFields(accountSchema)

const accounts = useAccountsStore()
const saving = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)

function initialValues(): AccountValues {
  return {
    displayName: props.account.displayName,
    username: props.servers.username,
    password: '',
    imap: { ...props.servers.imap },
    smtp: { ...props.servers.smtp },
    calendarUrl: props.account.calendarUrl ?? '',
  }
}

const { defineField, handleSubmit, errors, resetForm, setErrors } = useForm<AccountValues>({
  validationSchema: toTypedSchema(accountSchema),
  initialValues: initialValues(),
})
const [displayName] = defineField('displayName')
const [username] = defineField('username')
const [password] = defineField('password')
const [imap] = defineField('imap')
const [smtp] = defineField('smtp')
const [calendarUrl] = defineField('calendarUrl')
const calendarUrlId = `${useId()}-calendar-url`

/** What the calendar sync says about this account's calendar server, and an address it found to confirm. */
const calendarState = computed<{ text: string; found: string | null } | null>(() => {
  const { calendarStatus, calendarStatusDetail } = props.account
  switch (calendarStatus) {
    case 'unsupported':
      return { text: 'No calendar server found for this account. Enter its CalDAV address if your provider has one.', found: null }
    case 'unconfirmed':
      return { text: calendarStatusDetail ?? 'Tresso found a calendar server it cannot trust on its own. Confirm its address below.', found: foundCalendarUrl(props.account) }
    case 'auth_failed':
      return { text: calendarStatusDetail ?? 'The calendar server refused the username or password.', found: null }
    case 'error':
      return { text: calendarStatusDetail ?? 'Syncing the calendars failed. Tresso keeps retrying.', found: null }
    default:
      return null
  }
})

function reset(): void {
  resetForm({ values: initialValues() })
}
watch(() => props.account, reset)

function changes(values: AccountValues): MailAccountUpdate {
  const changed: MailAccountUpdate = {}
  if (values.displayName !== props.account.displayName) changed.displayName = values.displayName
  if (values.username !== props.servers.username) changed.username = values.username
  if (values.password !== '') changed.password = values.password
  if (JSON.stringify(values.imap) !== JSON.stringify(props.servers.imap)) changed.imap = values.imap
  if (JSON.stringify(values.smtp) !== JSON.stringify(props.servers.smtp)) changed.smtp = values.smtp
  // An empty address lets Tresso look for the calendar server again.
  if (values.calendarUrl !== (props.account.calendarUrl ?? '')) changed.calendarUrl = values.calendarUrl

  return changed
}

const save = handleSubmit(async (values) => {
  const changed = changes(values)
  message.value = null
  if (Object.keys(changed).length === 0) {
    message.value = 'Nothing changed.'
    return
  }
  saving.value = true
  error.value = null
  try {
    await accounts.update(props.account.id, changed)
    message.value = changed.password ? 'Saved. Tresso connects again with the new password.' : 'Saved.'
  } catch (e) {
    error.value = errorMessage(e)
    if (e instanceof ApiError) setErrors(e.violations)
  } finally {
    saving.value = false
  }
})
</script>

<template>
  <form class="form" novalidate @submit.prevent="save">
    <div class="pair">
      <label class="field">
        <FieldLabel name="displayName">Display name</FieldLabel>
        <input v-model="displayName" maxlength="120" :aria-invalid="errors.displayName ? 'true' : undefined" />
        <small class="hint">Recipients see: {{ displayName }} &lt;{{ account.emailAddress }}&gt;</small>
        <small v-if="errors.displayName" class="error">{{ errors.displayName }}</small>
      </label>
      <label class="field">
        <FieldLabel name="username">Username</FieldLabel>
        <input v-model="username" autocomplete="off" spellcheck="false" :aria-invalid="errors.username ? 'true' : undefined" />
        <small v-if="errors.username" class="error">{{ errors.username }}</small>
      </label>
    </div>
    <label class="field">
      <FieldLabel name="password">New password or app password</FieldLabel>
      <input v-model="password" type="password" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="Leave empty to keep the current one" />
      <small class="hint">Stored encrypted and only used to sync and send your mail.</small>
      <small v-if="errors.password" class="error">{{ errors.password }}</small>
    </label>
    <ServerFields v-if="imap" v-model="imap" protocol="imap" title="Incoming mail" :errors="serverErrors(errors, 'imap')" :allow-unencrypted="accounts.allowUnencrypted" />
    <ServerFields v-if="smtp" v-model="smtp" protocol="smtp" title="Outgoing mail" :errors="serverErrors(errors, 'smtp')" :allow-unencrypted="accounts.allowUnencrypted" />
    <div class="field">
      <FieldLabel name="calendarUrl" tag="label" :for="calendarUrlId">Calendar server (CalDAV)</FieldLabel>
      <p v-if="calendarState" class="calendar-state" :class="account.calendarStatus" role="status">
        <span>{{ calendarState.text }}</span>
        <button v-if="calendarState.found" type="button" class="button button-quiet" @click="calendarUrl = calendarState.found">Use this address</button>
      </p>
      <input :id="calendarUrlId" v-model="calendarUrl" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="Found automatically" maxlength="2048" :aria-invalid="errors.calendarUrl ? 'true' : undefined" />
      <small class="hint">Leave empty to let Tresso find it. A new address needs the password again.</small>
      <small v-if="errors.calendarUrl" class="error">{{ errors.calendarUrl }}</small>
    </div>

    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="message" class="done" role="status">{{ message }}</p>

    <div class="actions">
      <button type="submit" class="button button-primary" :disabled="saving">Save changes</button>
      <button type="button" class="button button-quiet" :disabled="saving" @click="reset">Undo changes</button>
    </div>
  </form>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 600px) {
  .pair {
    grid-template-columns: minmax(0, 1fr);
  }
}
.calendar-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-card);
  background: var(--ground);
  color: var(--ink);
  font-weight: 400;
}
.calendar-state.auth_failed,
.calendar-state.error {
  background: var(--danger-soft);
}
.calendar-state span {
  flex: 1;
  min-width: 200px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.done {
  margin: 0;
  color: var(--know);
  font-weight: 500;
}
</style>
