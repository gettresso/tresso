<script setup lang="ts">
import { computed } from 'vue'
import type { MailAccountCheck, MailCheckStatus, ServerSettings } from '@tresso/core'
import { serverErrors } from '@/forms/accounts'
import ServerFields from '@/components/ServerFields.vue'

/**
 * Step "Set up manually": incoming and outgoing server, then the sign-in. After a failed check it says which server
 * failed and how, on the form itself.
 */
const props = defineProps<{
  /** The address once valid. */
  address: string | null
  /** The user chose to set up by hand without typing an address first: it is asked for here. */
  askAddress: boolean
  lead: string
  /** Shown above the form: the provider usually signs in through its own page, which this server does not offer. */
  note: string | null
  /** Validation messages by field path: emailAddress, imap.host, smtp.port, username, password. */
  errors: Record<string, string>
  check: MailAccountCheck | null
  formError: string | null
  allowUnencrypted: boolean
  busy: boolean
}>()
const imap = defineModel<ServerSettings>('imap', { required: true })
const smtp = defineModel<ServerSettings>('smtp', { required: true })
const username = defineModel<string>('username', { required: true })
const password = defineModel<string>('password', { required: true })
const email = defineModel<string>('email', { required: true })
const emit = defineEmits<{ back: []; connect: [] }>()

const CHIP: Record<Exclude<MailCheckStatus, 'ok' | 'not_checked'>, string> = {
  unreachable: 'No answer',
  certificate: 'Certificate not valid',
  blocked: 'Not allowed',
  failed: 'Unexpected answer',
  auth_failed: 'Sign-in refused',
}

/** The server that failed the check, and how; null when none did. */
const failure = computed<{ side: 'imap' | 'smtp'; status: Exclude<MailCheckStatus, 'ok' | 'not_checked'> } | null>(() => {
  const check = props.check
  if (check === null) return null
  if (check.imap !== 'ok' && check.imap !== 'not_checked') return { side: 'imap', status: check.imap }
  if (check.smtp !== 'ok' && check.smtp !== 'not_checked') return { side: 'smtp', status: check.smtp }
  return null
})

function chip(side: 'imap' | 'smtp'): { label: string; tone: 'danger' | 'neutral' } | null {
  const found = failure.value
  if (found === null) return null
  if (found.side === side) return { label: CHIP[found.status], tone: 'danger' }
  return side === 'smtp' && found.side === 'imap' ? { label: 'Not checked yet', tone: 'neutral' } : null
}

/** A refused IMAP sign-in shows at the password; everything else gets the banner. */
const banner = computed<{ title: string; text: string } | null>(() => {
  const found = failure.value
  if (found === null || (found.side === 'imap' && found.status === 'auth_failed')) return null
  const server = found.side === 'imap' ? imap.value : smtp.value
  const notChecked = found.side === 'imap' ? ' Outgoing mail was not checked yet.' : ''
  switch (found.status) {
    case 'unreachable':
      return {
        title: `We could not reach ${server.host}`,
        text: `The server did not answer on port ${server.port}. Check the server name and the port, or ask your mail provider for the right settings.${notChecked}`,
      }
    case 'certificate':
      return {
        title: `The security certificate of ${server.host} could not be verified`,
        text: `Tresso only connects when the certificate is valid for the server name. Check the server name, or ask your mail provider which name to use.${notChecked}`,
      }
    case 'blocked':
      return {
        title: `Tresso may not connect to ${server.host}`,
        text: `This server is on a private network, or the connection is not encrypted. Use the public name of your mail server with SSL/TLS or STARTTLS.${notChecked}`,
      }
    case 'failed':
      return {
        title: `${server.host} did not answer like a mail server`,
        text: `Check the server name, the port and the security setting.${notChecked}`,
      }
    case 'auth_failed':
      return {
        title: 'The outgoing mail server did not accept this username or password',
        text: `Incoming mail works with them, but ${server.host} refused them. Check the outgoing mail settings, or ask your mail provider.`,
      }
  }
  return null
})

const failedSide = computed(() => (failure.value !== null && failure.value.status !== 'auth_failed' ? failure.value.side : null))
const passwordError = computed(() => props.errors.password ?? (failure.value?.side === 'imap' && failure.value.status === 'auth_failed' ? 'The mail server did not accept this username or password.' : null))
</script>

<template>
  <form class="cf-form" novalidate @submit.prevent="emit('connect')">
    <div class="cf-heading">
      <h1 id="connect-title">Set up manually</h1>
      <p class="cf-lead">{{ lead }}</p>
    </div>
    <p v-if="note" class="cf-note">{{ note }}</p>
    <div v-if="banner" class="banner" role="alert">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg>
      <span class="banner-text">
        <strong>{{ banner.title }}</strong>
        <span>{{ banner.text }}</span>
        <span v-if="check?.detail" class="technical">{{ check.detail }}</span>
      </span>
    </div>
    <label v-if="askAddress" class="cf-field">
      <span class="cf-label">Email address</span>
      <input v-model="email" type="email" autocomplete="email" placeholder="you@example.com" maxlength="320" :aria-invalid="errors.emailAddress ? 'true' : undefined" />
      <span v-if="errors.emailAddress" class="cf-error" role="alert">{{ errors.emailAddress }}</span>
    </label>
    <ServerFields v-model="imap" protocol="imap" title="Incoming mail" :errors="serverErrors(errors, 'imap')" :allow-unencrypted="allowUnencrypted" :status="chip('imap')" :failed="failedSide === 'imap'" />
    <ServerFields v-model="smtp" protocol="smtp" title="Outgoing mail" :errors="serverErrors(errors, 'smtp')" :allow-unencrypted="allowUnencrypted" :status="chip('smtp')" :failed="failedSide === 'smtp'" />
    <fieldset class="sign-in">
      <legend>Sign in</legend>
      <div class="pair">
        <label class="field">
          <span>Username</span>
          <input v-model="username" autocomplete="off" spellcheck="false" maxlength="320" :aria-invalid="errors.username ? 'true' : undefined" />
          <small v-if="errors.username" class="error" role="alert">{{ errors.username }}</small>
        </label>
        <label class="field">
          <span>Password</span>
          <input v-model="password" type="password" autocomplete="off" data-1p-ignore data-lpignore="true" maxlength="1024" :aria-invalid="passwordError ? 'true' : undefined" />
          <small v-if="passwordError" class="error" role="alert">{{ passwordError }}</small>
        </label>
      </div>
    </fieldset>
    <p v-if="formError" class="cf-error" role="alert">{{ formError }}</p>
    <div class="cf-footer">
      <button type="button" class="button button-quiet" @click="emit('back')">Back</button>
      <button type="submit" class="button button-primary" :disabled="busy">Connect</button>
    </div>
  </form>
</template>

<style scoped>
.banner {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 16px;
  background: var(--danger-soft);
  color: var(--danger);
}
.banner svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.banner-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--ink);
  font-size: 14px;
  line-height: 20px;
}
.technical {
  color: var(--ink-2);
  font: 400 12px var(--font-mono);
  overflow-wrap: anywhere;
}
.sign-in {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.sign-in legend {
  padding: 0 0 8px;
  font-weight: 600;
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
</style>
