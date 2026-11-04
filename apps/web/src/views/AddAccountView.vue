<script setup lang="ts">
import FieldLabel from '@/forms/FieldLabel.vue'
import { provideRequiredFields } from '@/forms/required'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { connectErrorMessage, defaultPort, providerName, signInProvider, type MailAccount, type OAuthProviderId, type ProviderFeature, type SuggestedServerSettings } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { addressSchema, connectSchema, serverErrors, type AddressValues, type ConnectValues } from '@/forms/accounts'
import { useAccountsStore } from '@/stores/accounts'
import { useAuthStore } from '@/stores/auth'
import { useMailStore } from '@/stores/mail'
import ServerFields from '@/components/ServerFields.vue'
import LogoLoader from '@/components/LogoLoader.vue'

type Step = 'address' | 'settings' | 'connecting'

/** How long to wait for the first sync before telling the user it continues in the background. */
const PATIENCE_MS = 45_000

const auth = useAuthStore()
const accounts = useAccountsStore()
const mail = useMailStore()
const route = useRoute()
const router = useRouter()

provideRequiredFields(addressSchema, connectSchema)

const step = ref<Step>('address')
const suggestion = ref<SuggestedServerSettings | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
/** The provider whose sign-in page the browser is about to open. */
const openingProvider = ref<OAuthProviderId | null>(null)
const providersUnavailable = ref(false)
/** The created account; a second submit fixes it instead of creating another. */
const accountId = ref<string | null>(null)
const waitedTooLong = ref(false)
/** The account as the API last returned it: the create or update response, then a fresh read after every change. */
const current = ref<MailAccount | null>(null)
let patience: ReturnType<typeof setTimeout> | null = null

const addressForm = useForm<AddressValues>({
  validationSchema: toTypedSchema(addressSchema),
  initialValues: { emailAddress: '', displayName: auth.me?.displayName ?? '' },
})
const [emailAddress] = addressForm.defineField('emailAddress')
const [displayName] = addressForm.defineField('displayName')

const connectForm = useForm<ConnectValues>({
  validationSchema: toTypedSchema(connectSchema),
  initialValues: {
    username: '',
    password: '',
    imap: { host: '', port: defaultPort('imap', 'tls'), security: 'tls' },
    smtp: { host: '', port: defaultPort('smtp', 'tls'), security: 'tls' },
  },
})
const [username] = connectForm.defineField('username')
const [password] = connectForm.defineField('password')
const [imap] = connectForm.defineField('imap')
const [smtp] = connectForm.defineField('smtp')

/** Set for Gmail and Microsoft 365 accounts, which sign in with their provider instead of a password. */
const currentProvider = computed(() => (current.value === null ? null : signInProvider(current.value)))

const domain = computed(() => (emailAddress.value ?? '').split('@')[1] ?? '')
const passwordUnusual = computed(() => suggestion.value?.found === true && !suggestion.value.authentication.includes('password'))
const outcome = computed<'waiting' | 'connected' | 'failed'>(() => {
  const account = current.value
  if (account === null) return 'waiting'
  if (account.status === 'auth_failed' || account.status === 'error') return 'failed'
  return account.lastSyncedAt !== null ? 'connected' : 'waiting'
})

const findSettings = addressForm.handleSubmit(async (values) => {
  busy.value = true
  error.value = null
  try {
    const found = await accounts.suggest(values.emailAddress)
    suggestion.value = found
    connectForm.setFieldValue('username', found.username ?? values.emailAddress)
    if (found.imap && found.smtp) {
      connectForm.setFieldValue('imap', found.imap)
      connectForm.setFieldValue('smtp', found.smtp)
    }
    step.value = 'settings'
  } catch (e) {
    if (e instanceof ApiError && e.violations.emailAddress) {
      addressForm.setFieldError('emailAddress', e.violations.emailAddress)
    } else {
      error.value = errorMessage(e)
    }
  } finally {
    busy.value = false
  }
})

const connect = connectForm.handleSubmit(async (values) => {
  busy.value = true
  error.value = null
  try {
    if (accountId.value === null) {
      const created = await accounts.create({
        emailAddress: addressForm.values.emailAddress?.trim() ?? '',
        displayName: addressForm.values.displayName?.trim() ?? '',
        username: values.username,
        password: values.password,
        imap: values.imap,
        smtp: values.smtp,
      })
      accountId.value = created.id
      current.value = created
    } else {
      current.value = await accounts.update(accountId.value, { username: values.username, password: values.password, imap: values.imap, smtp: values.smtp })
    }
    connectForm.setFieldValue('password', '')
    step.value = 'connecting'
    startWaiting()
  } catch (e) {
    error.value = errorMessage(e)
    if (e instanceof ApiError) {
      connectForm.setErrors(e.violations)
      for (const field of ['emailAddress', 'displayName'] as const) {
        if (e.violations[field]) {
          addressForm.setFieldError(field, e.violations[field])
          step.value = 'address'
        }
      }
    }
  } finally {
    busy.value = false
  }
})

/** Calendars are asked for only when the user chooses to sync them; they can also be allowed later, per account. */
const withCalendars = ref(false)

/** Leaves for the provider's sign-in page; the API sends the browser back here with the provider's answer. */
async function signInWith(provider: OAuthProviderId, mailAccountId?: string): Promise<void> {
  openingProvider.value = provider
  error.value = null
  try {
    const features: ProviderFeature[] = mailAccountId === undefined && withCalendars.value ? ['mail', 'calendar'] : ['mail']
    window.location.assign(await accounts.startProviderSignIn(provider, mailAccountId, features))
  } catch (e) {
    error.value = errorMessage(e)
    openingProvider.value = null
  }
}

/** Back from a provider sign-in: finish it, then wait for the connected account, or say why it did not work. */
async function finishProviderSignIn(): Promise<void> {
  const query = route.query
  if (query.provider === undefined) return
  // The query holds a one-time code; it leaves the address bar and the history before anything else happens.
  await router.replace({ query: {} })

  try {
    const result = await accounts.finishProviderSignIn(query)
    if (result === null) return
    if (result.connectError !== null) {
      error.value = connectErrorMessage(result.connectError, result.provider)
      return
    }
    if (result.connected === null) return
    const account = await accounts.get(result.connected)
    accountId.value = account.id
    current.value = account
    addressForm.setFieldValue('emailAddress', account.emailAddress)
    step.value = 'connecting'
    startWaiting()
  } catch (e) {
    error.value = errorMessage(e)
  }
}

onMounted(async () => {
  await finishProviderSignIn()
  try {
    await accounts.loadProviders()
  } catch {
    providersUnavailable.value = true
  }
})

function startWaiting(): void {
  waitedTooLong.value = false
  if (patience !== null) clearTimeout(patience)
  patience = setTimeout(() => (waitedTooLong.value = true), PATIENCE_MS)
}

// The worker's progress reaches the synced copy in real time; read the account again whenever it changes there.
watch(
  () => {
    const synced = mail.accounts.find((account) => account.id === accountId.value)
    return synced ? `${synced.status}:${synced.statusDetail}:${synced.lastSyncedAt}` : null
  },
  async (signature) => {
    if (signature === null || accountId.value === null || step.value !== 'connecting') return
    try {
      current.value = await accounts.get(accountId.value)
    } catch (e) {
      error.value = errorMessage(e)
    }
  },
)

watch(outcome, (value) => {
  if (value !== 'waiting' && patience !== null) {
    clearTimeout(patience)
    patience = null
  }
})
onBeforeUnmount(() => {
  if (patience !== null) clearTimeout(patience)
})
</script>

<template>
  <section class="add">
    <RouterLink :to="{ name: 'settings-accounts' }" class="back">← Accounts</RouterLink>

    <form v-if="step === 'address'" class="form" novalidate @submit.prevent="findSettings">
      <h2>Connect a mail account</h2>
      <p class="lead">Work, support, personal: add every account you read. They all land in one Unified Inbox.</p>
      <div v-if="accounts.providers.length > 0" class="providers">
        <button
          v-for="provider in accounts.providers"
          :key="provider.id"
          type="button"
          class="button provider"
          :disabled="openingProvider !== null"
          @click="signInWith(provider.id)"
        >
          <template v-if="openingProvider === provider.id"><LogoLoader /> Opening {{ provider.name }}…</template><template v-else>Sign in with {{ provider.name }}</template>
        </button>
        <label class="calendars">
          <input v-model="withCalendars" type="checkbox" />
          Also sync my calendars
        </label>
        <p class="hint">For Gmail, Google Workspace, Outlook.com and Microsoft 365. Tresso never sees your password.</p>
        <p class="divider"><span>or connect any other provider</span></p>
      </div>
      <p v-else-if="providersUnavailable" class="hint">Signing in with Google or Microsoft is not available right now; you can still connect with a password.</p>
      <label class="field">
        <FieldLabel name="emailAddress">Email address</FieldLabel>
        <input v-model="emailAddress" type="email" autocomplete="email" maxlength="320" :aria-invalid="addressForm.errors.value.emailAddress ? 'true' : undefined" />
        <small v-if="addressForm.errors.value.emailAddress" class="error">{{ addressForm.errors.value.emailAddress }}</small>
      </label>
      <label class="field">
        <FieldLabel name="displayName">Display name</FieldLabel>
        <input v-model="displayName" maxlength="120" :aria-invalid="addressForm.errors.value.displayName ? 'true' : undefined" />
        <small class="hint">Shown to people you write to.</small>
        <small v-if="addressForm.errors.value.displayName" class="error">{{ addressForm.errors.value.displayName }}</small>
      </label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="actions">
        <button type="submit" class="button button-primary" :disabled="busy"><template v-if="busy"><LogoLoader tone="current" /> Looking up your provider…</template><template v-else>Continue</template></button>
      </div>
    </form>

    <form v-else-if="step === 'settings'" class="form" novalidate @submit.prevent="connect">
      <h2>{{ emailAddress }}</h2>
      <p class="lead">
        <template v-if="suggestion?.found">We filled in the settings we found for {{ domain }}. Check them, then enter your password.</template>
        <template v-else>We could not find the settings for {{ domain }}. Your provider lists them in its help pages.</template>
      </p>
      <p v-if="passwordUnusual" class="note">
        This provider normally signs you in through its own page. For Gmail and Microsoft 365, go back and use Sign in with
        Google or Microsoft. Otherwise create an app password at your provider and use that.
      </p>

      <label class="field">
        <FieldLabel name="username">Username</FieldLabel>
        <input v-model="username" autocomplete="off" spellcheck="false" :aria-invalid="connectForm.errors.value.username ? 'true' : undefined" />
        <small v-if="connectForm.errors.value.username" class="error">{{ connectForm.errors.value.username }}</small>
      </label>
      <label class="field">
        <FieldLabel name="password">Password or app password</FieldLabel>
        <input v-model="password" type="password" autocomplete="current-password" :aria-invalid="connectForm.errors.value.password ? 'true' : undefined" />
        <small class="hint">Stored encrypted and only used to sync and send your mail.</small>
        <small v-if="connectForm.errors.value.password" class="error">{{ connectForm.errors.value.password }}</small>
      </label>
      <ServerFields v-if="imap" v-model="imap" protocol="imap" title="Incoming mail" :errors="serverErrors(connectForm.errors.value, 'imap')" />
      <ServerFields v-if="smtp" v-model="smtp" protocol="smtp" title="Outgoing mail" :errors="serverErrors(connectForm.errors.value, 'smtp')" />

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="actions">
        <button type="submit" class="button button-primary" :disabled="busy">{{ accountId ? 'Try again' : 'Connect' }}</button>
        <button v-if="!accountId" type="button" class="button button-quiet" :disabled="busy" @click="step = 'address'">Back</button>
      </div>
    </form>

    <div v-else class="form" aria-live="polite">
      <h2>{{ emailAddress }}</h2>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <template v-if="outcome === 'connected'">
        <p class="success">Connected. Your mail is arriving, newest first.</p>
        <div class="actions">
          <RouterLink :to="{ name: 'account', params: { accountId: accountId } }" class="button button-primary">Open the inbox</RouterLink>
          <RouterLink :to="{ name: 'settings-accounts' }" class="button button-quiet">Back to accounts</RouterLink>
        </div>
      </template>
      <template v-else-if="outcome === 'failed'">
        <div class="alert" role="alert">
          <strong>{{ current?.status === 'auth_failed' ? 'Signing in failed.' : 'Connecting failed.' }}</strong>
          <span v-if="current?.statusDetail">The server said: {{ current.statusDetail }}</span>
        </div>
        <div class="actions">
          <button
            v-if="currentProvider !== null && current !== null"
            type="button"
            class="button button-primary"
            :disabled="openingProvider !== null"
            @click="signInWith(currentProvider, current.id)"
          >
            Sign in with {{ providerName(currentProvider) }} again
          </button>
          <button v-else type="button" class="button button-primary" @click="step = 'settings'">Change the settings</button>
          <RouterLink :to="{ name: 'settings-accounts' }" class="button button-quiet">Back to accounts</RouterLink>
        </div>
      </template>
      <template v-else>
        <p class="lead" role="status"><LogoLoader /> Signing in and fetching your folders…</p>
        <p v-if="waitedTooLong" class="note">
          This takes longer than usual. You can leave this page: the account keeps connecting, and its status shows under Accounts.
        </p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.add {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 640px;
}
.back {
  color: var(--ink-2);
  text-decoration: none;
  font-weight: 600;
  font-size: 13px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
h2 {
  margin: 0;
  font: 700 28px/34px var(--font-display);
  overflow-wrap: anywhere;
}
.lead {
  margin: 0;
  color: var(--ink-2);
}
.note {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--radius-card);
  background: var(--delegate-soft);
  color: var(--ink);
}
.success {
  margin: 0;
  color: var(--know);
  font-weight: 600;
}
.alert {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-radius: var(--radius-card);
  background: var(--danger-soft);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.providers {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.provider {
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--ink);
}
.provider:hover {
  background: var(--ground);
}
.calendars {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.providers .hint {
  margin: 0;
  color: var(--ink-2);
  font-size: 13px;
}
.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0 0;
  color: var(--ink-2);
  font-size: 13px;
}
.divider::before,
.divider::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--line);
}
.actions .button {
  text-decoration: none;
}
</style>
