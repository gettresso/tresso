<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { providerSignInOutcome, signedInAgainNotice } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { useAccountsStore } from '@/stores/accounts'
import { useMailStore } from '@/stores/mail'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import { phoneNumber } from '@/components/chat/whatsappTexts'
import AccountCard from '@/components/AccountCard.vue'
import ApprovalLink from '@/components/ApprovalLink.vue'
import LogoLoader from '@/components/LogoLoader.vue'

/**
 * finishesSignIn: whether this page finishes a provider sign-in that came back to it (signing an account in again, or
 * allowing its calendars). Off under the connect dialog, which finishes the sign-ins that come back to its address.
 */
const props = withDefaults(defineProps<{ finishesSignIn?: boolean }>(), { finishesSignIn: true })

const accounts = useAccountsStore()
const mail = useMailStore()
const whatsapp = useWhatsAppRelayStore()
/** The WhatsApp card's second line: the linked number when known, and where the chats live. */
const whatsappLine = computed(() => {
  const number = whatsapp.identity?.number
  return number ? `${phoneNumber(number)}, via this Mac` : 'Via this Mac'
})
const error = ref<string | null>(null)
const route = useRoute()
const router = useRouter()
/**
 * The outcome of signing in again with Google or Microsoft, or of allowing an account's calendars, which returns the
 * browser here; with the link for an organization's administrator when the organization has to approve Tresso first.
 */
const signInResult = ref<{ ok: boolean; text: string; approvalUrl: string | null } | null>(null)

async function load(): Promise<void> {
  try {
    await accounts.load()
    error.value = null
  } catch (e) {
    error.value = errorMessage(e)
  }
}

/** Finishes the sign-in the provider sent the browser back from, and says how it went. */
async function readSignInResult(): Promise<void> {
  const query = route.query
  if (!props.finishesSignIn || query.provider === undefined) return
  // The query holds a one-time code; it leaves the address bar and the history before anything else happens.
  await router.replace({ query: {} })

  try {
    const result = await accounts.finishProviderSignIn(query)
    if (result !== null) {
      // Read as the connect dialog reads it: calendars left unticked at the provider are not reported as success.
      signInResult.value = signedInAgainNotice(providerSignInOutcome(result), result.provider)
    }
  } catch (e) {
    signInResult.value = { ok: false, text: errorMessage(e), approvalUrl: null }
  }
}

// The desktop app gets the answer while this page is open: the `tresso://` link changes only the query.
watch(
  () => route.query.provider,
  (provider) => {
    if (provider !== undefined && props.finishesSignIn) void readSignInResult().then(load)
  },
)

onMounted(async () => {
  await readSignInResult()
  await load()
  try {
    await accounts.loadServerRules()
  } catch {
    // Without it "None" is not offered as connection security, which only local test servers need.
  }
})
// Status changes (a sign-in failure, a first sync, calendars allowed or refused) reach the synced copy in real time;
// refresh the settings then.
watch(() => mail.accounts.map((a) => `${a.id}:${a.status}:${a.statusDetail}:${a.lastSyncedAt}:${a.calendarStatus}:${a.calendarStatusDetail}`).join('|'), load)
</script>

<template>
  <section class="accounts">
    <header class="header">
      <div>
        <h2>Accounts</h2>
        <p>{{ accounts.accounts.length === 1 ? '1 mail account.' : `${accounts.accounts.length} mail accounts.` }} Your mail stays with your provider; passwords and sign-ins are stored encrypted.</p>
      </div>
      <RouterLink :to="{ name: 'settings-accounts-new' }" class="button button-primary">Add account</RouterLink>
    </header>

    <template v-if="signInResult">
      <p :class="signInResult.ok ? 'done' : 'form-error'" :role="signInResult.ok ? 'status' : 'alert'">{{ signInResult.text }}</p>
      <template v-if="signInResult.approvalUrl">
        <p class="approval">Send your IT team this link. Once they approve Tresso, allow calendar access or sign in again.</p>
        <ApprovalLink :url="signInResult.approvalUrl" />
      </template>
    </template>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-else-if="!accounts.loaded" class="state" role="status"><LogoLoader /> Loading accounts…</p>
    <p v-else-if="accounts.accounts.length === 0" class="state">No mail accounts yet. Add one to see your mail in Tresso.</p>

    <AccountCard v-for="account in accounts.accounts" :key="account.id" :account="account" />

    <!-- WhatsApp: the desktop app on macOS once it is turned on there; nothing of it shows elsewhere. -->
    <section v-if="whatsapp.available" class="whatsapp" aria-label="WhatsApp">
      <span class="wa-mark" aria-hidden="true">WA</span>
      <span class="wa-who">
        <span class="wa-name">WhatsApp</span>
        <span class="wa-line">{{ whatsapp.connected ? whatsappLine : 'Chats next to your mail, through whatsapp-mcp on this Mac.' }}</span>
      </span>
      <RouterLink v-if="whatsapp.connected" :to="{ name: 'settings-whatsapp' }" class="button button-quiet wa-open">Settings</RouterLink>
      <RouterLink v-else-if="whatsapp.configLoaded" :to="{ name: 'settings-whatsapp-connect' }" class="button button-quiet wa-open">Connect WhatsApp</RouterLink>
    </section>
  </section>
</template>

<style scoped>
.accounts {
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
.header p,
.state,
.approval {
  margin: 0;
  color: var(--ink-2);
}
.header .button {
  text-decoration: none;
  flex-shrink: 0;
}
.done {
  margin: 0;
  color: var(--know);
  font-weight: 500;
}
.whatsapp {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}
.wa-mark {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  background: var(--know);
  color: var(--paper);
  font-size: 12px;
  font-weight: 700;
}
.wa-who {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.wa-name {
  font-weight: 600;
}
.wa-line {
  color: var(--ink-2);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.wa-open {
  flex-shrink: 0;
  border: 1px solid var(--line-strong);
  color: var(--ink);
}
</style>
