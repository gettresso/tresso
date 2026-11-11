<script setup lang="ts">
import { computed, ref } from 'vue'
import { calendarNeedsAttention, calendarStatusLabel, NO_UNSUBSCRIBE_ON_IMAP, oneClickUnsubscribeAvailable, providerName, signInProvider, type MailAccount } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { fullTime } from '@/mail/format'
import { useAccountsStore } from '@/stores/accounts'
import ProviderAccountForm from '@/components/ProviderAccountForm.vue'
import SenderAvatar from '@/components/SenderAvatar.vue'
import ServerAccountForm from '@/components/ServerAccountForm.vue'

const props = defineProps<{ account: MailAccount }>()

const accounts = useAccountsStore()
// Opens by itself when something needs the user: the mail, or the calendars (not allowed, or a server to confirm).
const open = ref(props.account.status === 'auth_failed' || props.account.status === 'error' || calendarNeedsAttention(props.account.calendarStatus))
/** Said in the collapsed card too, so an account without calendar access shows without opening it. */
const calendarBadge = computed(() => calendarStatusLabel(props.account.calendarStatus))
const saving = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)
const confirmingRemoval = ref(false)

/** Gmail and Microsoft 365 accounts sign in with their provider; the others have a password and servers. */
const provider = computed(() => signInProvider(props.account))
const servers = computed(() => {
  const { username, imap, smtp } = props.account
  return username !== null && imap !== null && smtp !== null ? { username, imap, smtp } : null
})

const problem = computed(() => props.account.status === 'auth_failed' || props.account.status === 'error')
const statusLabel = computed(
  () =>
    ({
      active: props.account.lastSyncedAt === null ? 'Connecting' : 'Syncing',
      paused: 'Paused',
      auth_failed: 'Sign-in failed',
      error: 'Sync problem',
    })[props.account.status],
)
const fixHint = computed(() =>
  provider.value === null
    ? 'New mail is not arriving until this is fixed. Check the password (or app password) and the server settings below.'
    : `New mail is not arriving until this is fixed. Sign in with ${providerName(provider.value)} again below.`,
)

async function run(action: () => Promise<unknown>, done: string): Promise<void> {
  saving.value = true
  error.value = null
  message.value = null
  try {
    await action()
    message.value = done
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    saving.value = false
  }
}

function togglePause(): Promise<void> {
  const paused = props.account.status === 'paused'
  return run(() => accounts.update(props.account.id, { status: paused ? 'active' : 'paused' }), paused ? 'Syncing resumed.' : 'Syncing paused.')
}

function remove(): Promise<void> {
  return run(() => accounts.remove(props.account.id), 'Removed.')
}
</script>

<template>
  <section class="card" :class="{ problem }" :aria-label="account.displayName">
    <button type="button" class="head" :aria-expanded="open" @click="open = !open">
      <SenderAvatar :sender="{ name: account.displayName, address: account.emailAddress }" :size="36" />
      <span class="who">
        <span class="name">{{ account.displayName }}</span>
        <span class="address">{{ account.emailAddress }}</span>
      </span>
      <span class="badges">
        <span v-if="calendarBadge" class="status calendar">{{ calendarBadge }}</span>
        <span class="status" :class="account.status">{{ statusLabel }}</span>
      </span>
    </button>

    <div v-if="open" class="body">
      <div v-if="problem" class="alert" role="alert">
        <strong>{{ account.status === 'auth_failed' ? 'Tresso could not sign in to this account.' : 'Syncing this account failed.' }}</strong>
        <span v-if="account.statusDetail">The server said: {{ account.statusDetail }}</span>
        <span>{{ fixHint }}</span>
      </div>
      <p v-else class="sync">
        {{ account.lastSyncedAt ? `Last synced ${fullTime(account.lastSyncedAt)}.` : 'Not synced yet.' }}
      </p>

      <p v-if="!oneClickUnsubscribeAvailable(account)" class="note">{{ NO_UNSUBSCRIBE_ON_IMAP }}</p>

      <ProviderAccountForm v-if="provider !== null" :account="account" :provider="provider" />
      <ServerAccountForm v-else-if="servers !== null" :account="account" :servers="servers" />

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-if="message" class="done" role="status">{{ message }}</p>

      <div class="actions">
        <span class="spacer" />
        <button v-if="account.status === 'active' || account.status === 'paused'" type="button" class="button button-quiet" :disabled="saving" @click="togglePause">
          {{ account.status === 'paused' ? 'Resume syncing' : 'Pause syncing' }}
        </button>
        <button type="button" class="button button-danger" :disabled="saving" @click="confirmingRemoval = true">Remove account</button>
      </div>

      <div v-if="confirmingRemoval" class="confirm" role="alertdialog" aria-labelledby="remove-title">
        <p id="remove-title"><strong>Remove {{ account.emailAddress }}?</strong></p>
        <p>
          Its mail disappears from Tresso on every device. Nothing is deleted at your provider, and you can add the account again later.
          <template v-if="provider !== null">Tresso also deletes its access to your {{ providerName(provider) }} account.</template>
        </p>
        <div class="actions">
          <button type="button" class="button button-danger" :disabled="saving" @click="remove">Remove account</button>
          <button type="button" class="button button-quiet" @click="confirmingRemoval = false">Keep it</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.note {
  margin: 0;
  color: var(--ink-2);
  font-size: 13px;
}
.card {
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}
.card.problem {
  border-color: var(--danger);
}
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 16px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.who {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.name {
  font-weight: 600;
}
.address {
  font-size: 13px;
  color: var(--ink-2);
}
.badges {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.status.calendar {
  background: var(--delegate-soft);
  color: var(--delegate);
}
.status {
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
}
.status.active {
  background: var(--know-soft);
  color: var(--know);
}
.status.auth_failed,
.status.error {
  background: var(--danger-soft);
  color: var(--danger);
}
.body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 16px 16px;
}
.alert {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-radius: var(--radius-card);
  background: var(--danger-soft);
  color: var(--ink);
}
.sync {
  margin: 0;
  color: var(--ink-2);
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
.confirm {
  padding: 14px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-card);
}
.confirm p {
  margin: 0 0 8px;
}
</style>
