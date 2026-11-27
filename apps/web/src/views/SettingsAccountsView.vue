<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { accountSubtitle, providerSignInOutcome, signedInAgainNotice } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { useAccountImportsStore } from '@/stores/accountImports'
import { useAccountsStore } from '@/stores/accounts'
import { useChatsStore } from '@/stores/chats'
import { useMailStore } from '@/stores/mail'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import { phoneNumber } from '@/components/chat/whatsappTexts'
import AccountCard from '@/components/AccountCard.vue'
import ApprovalLink from '@/components/ApprovalLink.vue'
import ListRow from '@/components/ListRow.vue'
import LogoLoader from '@/components/LogoLoader.vue'
import ProviderMark from '@/components/ProviderMark.vue'

/**
 * finishesSignIn: whether this page finishes a provider sign-in that came back to it (signing an account in again, or
 * allowing its calendars). Off under the connect dialog, which finishes the sign-ins that come back to its address.
 */
const props = withDefaults(defineProps<{ finishesSignIn?: boolean }>(), { finishesSignIn: true })

const accounts = useAccountsStore()
const imports = useAccountImportsStore()
/**
 * "Add several accounts" continues the newest list that still has addresses to connect, or skipped ones to add back (a
 * list is kept for 24 hours), and otherwise starts a new one.
 */
const severalTarget = computed(() => {
  const open = imports.lists.find((list) => list.progress.todo > 0 || list.progress.failed > 0 || list.progress.skipped > 0)
  return open ? { name: 'settings-accounts-import', params: { importId: open.id } } : { name: 'settings-accounts-import' }
})
const mail = useMailStore()
const whatsapp = useWhatsAppRelayStore()
const chats = useChatsStore()
/** In the browser: the server's WhatsApp account, while the copy holds one (a Mac relays it); null otherwise. */
const serverWhatsApp = computed(() => (chats.serverOnly && chats.enabled ? chats.serverAccount : null))
/** The WhatsApp row: in the browser while a Mac relays the chats, and on a Mac where WhatsApp is turned on. */
const showWhatsApp = computed(() => serverWhatsApp.value !== null || whatsapp.available)
/** The WhatsApp row's line: the linked number when known, and where the chats live. */
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

/**
 * A link to one account (#account-<id>, as the MCP tool reconnect_mail_account hands out): once the list is there,
 * that account is scrolled to and focused, so a screen reader starts there too.
 */
async function showLinkedAccount(): Promise<void> {
  const match = /^#account-([0-9a-f-]{36})$/i.exec(route.hash)
  if (match === null) return
  await nextTick()
  const card = document.getElementById(`account-${match[1]!.toLowerCase()}`)
  card?.scrollIntoView({ block: 'start' })
  card?.focus({ preventScroll: true })
}

// A link to another account while the page is open (the hash changes only) goes there too.
watch(
  () => route.hash,
  () => void showLinkedAccount(),
)

onMounted(async () => {
  await readSignInResult()
  await load()
  await showLinkedAccount()
  try {
    await imports.loadLists()
  } catch {
    // Without the lists "Add several accounts" starts a new one; an open list is still reached by its link.
  }
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
      <div class="heading">
        <h2>Accounts</h2>
        <p>Mail stays with your provider. Sign-ins are stored encrypted.</p>
      </div>
      <RouterLink :to="severalTarget" class="button button-quiet several">Add several</RouterLink>
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

    <!--
      One card holds the account rows, and WhatsApp as its last row under a hairline: the desktop app on macOS once
      WhatsApp is turned on there, and the browser while a Mac relays the chats.
    -->
    <div v-if="accounts.accounts.length > 0 || showWhatsApp" role="list" aria-label="Accounts" class="card">
      <AccountCard v-for="account in accounts.accounts" :key="account.id" :account="account" />
      <ListRow v-if="showWhatsApp" aria-label="WhatsApp" :class="{ 'after-accounts': accounts.accounts.length > 0 }">
        <template #mark><ProviderMark kind="whatsapp" /></template>
        <template #title>WhatsApp</template>
        <template #line>
          <span v-if="serverWhatsApp" dir="auto">{{ accountSubtitle(serverWhatsApp, '') }}</span>
          <template v-else>{{ whatsapp.connected ? whatsappLine : 'Chats next to your mail, on this Mac.' }}</template>
        </template>
        <template v-if="serverWhatsApp || whatsapp.connected || whatsapp.configLoaded" #action>
          <RouterLink v-if="serverWhatsApp || whatsapp.connected" :to="{ name: 'settings-whatsapp' }" class="button row-button">Settings</RouterLink>
          <RouterLink v-else :to="{ name: 'settings-whatsapp-connect' }" class="button row-button">Connect WhatsApp</RouterLink>
        </template>
      </ListRow>
    </div>
  </section>
</template>

<style scoped>
.accounts {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: var(--measure);
}
.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.heading {
  display: flex;
  flex: 1 1 260px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 24px;
  line-height: 30px;
  font-weight: 700;
}
.heading p,
.state,
.approval {
  margin: 0;
  font-size: 13px;
  line-height: 19px;
  color: var(--ink-2);
}
.header .button {
  flex-shrink: 0;
}
/* The quiet second action of the head, in the ink as the board draws it. */
.several {
  padding: 0 12px;
  color: var(--ink);
}
.done {
  margin: 0;
  color: var(--know);
  font-weight: 500;
}
/* The card that holds rows of one kind (the List row board): paper, a hairline edge drawn inside, radius 14. */
.card {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-panel);
  background: var(--paper);
  box-shadow: inset 0 0 0 1px var(--line);
}
/* WhatsApp under the account rows, whatever those rows draw themselves (the hairline the board draws there). */
.after-accounts {
  border-top: 1px solid var(--line);
}
/* The one control of a row: a plain button with a hairline edge, below the head's 36. */
.row-button {
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
}
.row-button:hover {
  background: var(--ground);
}
</style>
