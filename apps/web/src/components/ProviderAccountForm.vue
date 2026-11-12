<script setup lang="ts">
import FieldLabel from '@/forms/FieldLabel.vue'
import { provideRequiredFields } from '@/forms/required'
import { computed, ref, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { providerCalendarProblem, providerName, type MailAccount, type OAuthProviderId, type ProviderFeature } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { providerAccountSchema, type ProviderAccountValues } from '@/forms/accounts'
import { useAccountsStore } from '@/stores/accounts'
import LogoLoader from '@/components/LogoLoader.vue'

/** The name of a Gmail or Microsoft 365 account, and signing in with the provider again. */
const props = defineProps<{ account: MailAccount; provider: OAuthProviderId }>()

provideRequiredFields(providerAccountSchema)

const accounts = useAccountsStore()
const saving = ref(false)
const signingIn = ref(false)
/** The desktop app opened the provider's page in the system browser; the accounts page gets the answer. */
const continueInBrowser = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)

const { defineField, handleSubmit, errors, resetForm, setErrors } = useForm<ProviderAccountValues>({
  validationSchema: toTypedSchema(providerAccountSchema),
  initialValues: { displayName: props.account.displayName },
})
const [displayName] = defineField('displayName')

function reset(): void {
  resetForm({ values: { displayName: props.account.displayName } })
}
watch(() => props.account, reset)

const save = handleSubmit(async (values) => {
  message.value = null
  if (values.displayName === props.account.displayName) {
    message.value = 'Nothing changed.'
    return
  }
  saving.value = true
  error.value = null
  try {
    await accounts.update(props.account.id, { displayName: values.displayName })
    message.value = 'Saved.'
  } catch (e) {
    error.value = errorMessage(e)
    if (e instanceof ApiError) setErrors(e.violations)
  } finally {
    saving.value = false
  }
})

/**
 * Opens the provider's sign-in page; the API sends the browser back to the accounts page (in the desktop app, through
 * its `tresso://` link, while the page in the system browser is left behind). Signing in again asks for mail and
 * whatever the account allows already; allowing calendars adds just them.
 */
/** Why the calendars do not sync, as the sync said it, and what fixes it (see providerCalendarProblem). */
const calendarProblem = computed(() => providerCalendarProblem(props.account, props.provider))

function fixCalendars(kind: 'allow' | 'sign-in'): Promise<void> {
  return kind === 'allow' ? signInAgain(['calendar']) : signInAgain()
}

async function signInAgain(features?: ProviderFeature[]): Promise<void> {
  signingIn.value = true
  error.value = null
  try {
    if ((await accounts.openProviderSignIn(props.provider, props.account.id, features)) === 'browser') {
      signingIn.value = false
      continueInBrowser.value = true
    }
  } catch (e) {
    error.value = errorMessage(e)
    signingIn.value = false
  }
}
</script>

<template>
  <form class="form" novalidate @submit.prevent="save">
    <label class="field">
      <FieldLabel name="displayName">Display name</FieldLabel>
      <input v-model="displayName" maxlength="120" :aria-invalid="errors.displayName ? 'true' : undefined" />
      <small class="hint">Recipients see: {{ displayName }} &lt;{{ account.emailAddress }}&gt;</small>
      <small v-if="errors.displayName" class="error">{{ errors.displayName }}</small>
    </label>
    <p class="signs-in">
      Signs in with {{ providerName(provider) }}. Tresso never sees the password; you can withdraw its access in your
      {{ providerName(provider) }} account settings.
    </p>

    <p v-if="calendarProblem" class="calendars" role="status">
      {{ calendarProblem.text }}
      <button v-if="calendarProblem.action" type="button" class="button button-quiet" :disabled="signingIn" @click="fixCalendars(calendarProblem.action.kind)">{{ calendarProblem.action.label }}</button>
    </p>

    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="message" class="done" role="status">{{ message }}</p>
    <p v-if="continueInBrowser" class="hint" role="status">Continue in your browser. Tresso shows the result here once you have signed in.</p>

    <div class="actions">
      <button type="submit" class="button button-primary" :disabled="saving">Save changes</button>
      <button type="button" class="button button-quiet" :disabled="saving" @click="reset">Undo changes</button>
      <button type="button" class="button button-quiet" :disabled="signingIn" @click="signInAgain()">
        <template v-if="signingIn"><LogoLoader /> Opening {{ providerName(provider) }}…</template><template v-else>Sign in with {{ providerName(provider) }} again</template>
      </button>
    </div>
  </form>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.signs-in,
.hint {
  margin: 0;
  color: var(--ink-2);
}
.calendars {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
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
