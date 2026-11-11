<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { signInProvider, type SyncedCalendar, type SyncedMailAccount } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { useAccountsStore } from '@/stores/accounts'

/**
 * On the calendar page: the mail accounts whose calendars do not show, and why. An account without calendar access
 * gets "Allow calendar access" right here (one sign-in at its provider); a calendar server that refused, failed or
 * needs its address confirmed points to the account's settings.
 */
const props = defineProps<{ accounts: SyncedMailAccount[]; calendars: SyncedCalendar[] }>()

const store = useAccountsStore()
const opening = ref<string | null>(null)
const inBrowser = ref(false)
const error = ref<string | null>(null)

interface Notice {
  account: SyncedMailAccount
  kind: 'allow' | 'settings' | 'looking'
  text: string
}

const notices = computed<Notice[]>(() => {
  const withCalendars = new Set(props.calendars.map((calendar) => calendar.mailAccountId))
  const list: Notice[] = []
  for (const account of props.accounts) {
    if (account.status === 'paused') continue
    const address = account.emailAddress
    switch (account.calendarStatus) {
      case 'not_granted':
        if (signInProvider(account) !== null) list.push({ account, kind: 'allow', text: `Tresso may not use the calendars of ${address} yet.` })
        break
      case 'auth_failed':
      case 'error':
      case 'unconfirmed':
        list.push({ account, kind: 'settings', text: account.calendarStatusDetail ?? `The calendars of ${address} could not be synced.` })
        break
      case 'unknown':
        if (!withCalendars.has(account.id)) list.push({ account, kind: 'looking', text: `Looking for the calendars of ${address}...` })
        break
    }
  }
  return list
})

async function allow(account: SyncedMailAccount): Promise<void> {
  const provider = signInProvider(account)
  if (provider === null) return
  opening.value = account.id
  error.value = null
  try {
    inBrowser.value = (await store.openProviderSignIn(provider, account.id, ['calendar'])) === 'browser'
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    opening.value = null
  }
}
</script>

<template>
  <ul v-if="notices.length > 0" class="access" aria-label="Calendars that do not show">
    <li v-for="notice in notices" :key="notice.account.id" :class="notice.kind">
      <span class="text">{{ notice.text }}</span>
      <button v-if="notice.kind === 'allow'" type="button" class="button button-quiet" :disabled="opening !== null" @click="allow(notice.account)">Allow calendar access</button>
      <RouterLink v-else-if="notice.kind === 'settings'" :to="{ name: 'settings-accounts' }" class="button button-quiet">Open account settings</RouterLink>
    </li>
    <li v-if="inBrowser" class="looking" role="status">Continue in your browser. Tresso shows the result under Settings, Accounts once you have allowed it.</li>
    <li v-if="error" class="error" role="alert">{{ error }}</li>
  </ul>
</template>

<style scoped>
.access {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: var(--radius-card);
  background: var(--delegate-soft);
  color: var(--ink);
  font-size: 13px;
}
li.looking {
  background: var(--ground);
  color: var(--ink-2);
}
li.error {
  background: var(--danger-soft);
  color: var(--danger);
}
.text {
  flex: 1;
  min-width: 200px;
}
.button {
  height: 30px;
  text-decoration: none;
}
</style>
