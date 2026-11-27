<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { accountAttention, accountSyncMeta, NO_UNSUBSCRIBE_ON_IMAP, oneClickUnsubscribeAvailable, providerName, readerTimeZone, signInProvider, type MailAccount, type ProviderFeature } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { displayNameSchema } from '@/forms/accounts'
import { useAccountsStore } from '@/stores/accounts'
import AttentionRow from '@/components/AttentionRow.vue'
import ListRow from '@/components/ListRow.vue'
import MenuButton, { type MenuItem } from '@/components/MenuButton.vue'
import ProviderAccountForm from '@/components/ProviderAccountForm.vue'
import ProviderMark from '@/components/ProviderMark.vue'
import { markForAccount } from '@/components/providerMarks'
import ServerAccountForm from '@/components/ServerAccountForm.vue'

/**
 * One mail account in Settings, Accounts, as one calm row (the SettingsAccounts board): its mark, name and address,
 * when it last synced (or a Paused pill), and a More menu with the rare actions. Under it at most one attention line,
 * only when the user has to act (see accountAttention). Rename edits the name in place; Server settings opens the
 * server form of a mail-server account under the row; Remove account asks first.
 */
const props = defineProps<{ account: MailAccount }>()

const accounts = useAccountsStore()
const id = useId()
const row = ref<InstanceType<typeof ListRow> | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
const signIn = ref<InstanceType<typeof ProviderAccountForm> | null>(null)

/** Gmail and Microsoft 365 accounts sign in with their provider; the others have a password and servers. */
const provider = computed(() => signInProvider(props.account))
const servers = computed(() => {
  const { username, imap, smtp } = props.account
  return username !== null && imap !== null && smtp !== null ? { username, imap, smtp } : null
})

const attention = computed(() => accountAttention(props.account))
/**
 * The clock the meta is read against ("Synced 14:20" today, "Fri 14:20" later). The page loads its accounts on
 * mount and after a sign-in, so the clock is read again when the account changes and whenever the page becomes
 * visible: a page left open overnight says the day once the user looks at it again.
 */
const now = ref(Date.now())
const meta = computed(() => accountSyncMeta(props.account, now.value, readerTimeZone()))
watch(
  () => props.account,
  () => {
    now.value = Date.now()
  },
)
function readClock(): void {
  if (document.visibilityState === 'visible') now.value = Date.now()
}
onMounted(() => document.addEventListener('visibilitychange', readClock))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', readClock))

const saving = ref(false)
/** Said to a screen reader once an action from the menu is done; the row itself shows the new state. */
const message = ref<string | null>(null)
const error = ref<string | null>(null)
const confirmingRemoval = ref(false)
const serverSettingsOpen = ref(false)

const renaming = ref(false)
const draft = ref('')
const nameError = ref<string | null>(null)
/** Save shows once the name, without the spaces around it, is another one; Cancel shows all along. */
const nameChanged = computed(() => draft.value.trim() !== props.account.displayName)

const moreLabel = computed(() => `More for ${props.account.emailAddress}`)
const menuItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [{ id: 'rename', label: 'Rename' }]
  if (provider.value !== null) items.push({ id: 'sign-in', label: 'Sign in again' })
  else if (servers.value !== null) items.push({ id: 'server-settings', label: 'Server settings' })
  // A paused account resumes; one whose mail does not arrive is fixed first, as before.
  if (props.account.status === 'active' || props.account.status === 'paused') {
    items.push({ id: 'pause', label: props.account.status === 'paused' ? 'Resume syncing' : 'Pause syncing' })
  }
  items.push({ id: 'remove', label: 'Remove account', danger: true })
  return items
})
/** The attention line's button, when this account can do what it asks. */
const attentionAction = computed(() => {
  const action = attention.value?.action
  if (action === undefined) return undefined
  if (action.kind === 'server-settings') return servers.value !== null ? action.label : undefined
  return provider.value !== null ? action.label : undefined
})
/** The same button stands under several accounts: a screen reader hears which one, after the visible words. */
const attentionActionLabel = computed(() => {
  const action = attention.value?.action
  if (action === undefined) return undefined
  return `${action.kind === 'allow-calendar' ? 'Allow calendar access' : action.label} for ${props.account.emailAddress}`
})

function rowElement(): HTMLElement | null {
  return (row.value?.$el as HTMLElement | undefined) ?? null
}

async function focusMore(): Promise<void> {
  await nextTick()
  rowElement()?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus()
}

function choose(item: string): void {
  // The old buttons were disabled while a request ran: nothing starts until it is done.
  if (saving.value) return
  message.value = null
  error.value = null
  switch (item) {
    case 'rename':
      void startRename()
      break
    case 'sign-in':
      void signInAgain()
      void focusMore()
      break
    case 'server-settings':
      void openServerSettings()
      break
    case 'pause':
      void togglePause().then(focusMore)
      break
    case 'remove':
      void askRemoval()
      break
  }
}

function act(): void {
  const action = attention.value?.action
  if (action === undefined) return
  if (action.kind === 'server-settings') void openServerSettings()
  else void signInAgain(action.kind === 'allow-calendar' ? ['calendar'] : undefined)
}

function signInAgain(features?: ProviderFeature[]): Promise<void> {
  return signIn.value?.signInAgain(features) ?? Promise.resolve()
}

async function startRename(): Promise<void> {
  serverSettingsOpen.value = false
  confirmingRemoval.value = false
  draft.value = props.account.displayName
  nameError.value = null
  renaming.value = true
  await nextTick()
  nameInput.value?.focus()
}

function cancelRename(): void {
  if (saving.value) return
  renaming.value = false
  nameError.value = null
  void focusMore()
}

async function saveName(): Promise<void> {
  if (saving.value) return
  const parsed = displayNameSchema.safeParse(draft.value)
  if (!parsed.success) {
    nameError.value = parsed.error.issues[0]?.message ?? null
    return
  }
  if (parsed.data === props.account.displayName) {
    cancelRename()
    return
  }
  saving.value = true
  nameError.value = null
  try {
    await accounts.update(props.account.id, { displayName: parsed.data })
    renaming.value = false
    message.value = 'Name saved.'
    void focusMore()
  } catch (e) {
    nameError.value = e instanceof ApiError && e.violations.displayName ? e.violations.displayName : errorMessage(e)
    // The name typed stays; the focus goes back to it (from Save) to correct it.
    void nextTick(() => nameInput.value?.focus())
  } finally {
    saving.value = false
  }
}

async function openServerSettings(): Promise<void> {
  renaming.value = false
  confirmingRemoval.value = false
  serverSettingsOpen.value = true
  await nextTick()
  rowElement()?.querySelector<HTMLInputElement>('.server input')?.focus()
}

function closeServerSettings(): void {
  serverSettingsOpen.value = false
  void focusMore()
}

async function askRemoval(): Promise<void> {
  renaming.value = false
  serverSettingsOpen.value = false
  confirmingRemoval.value = true
  await nextTick()
  rowElement()?.querySelector<HTMLButtonElement>('.confirm .keep')?.focus()
}

function keepAccount(): void {
  confirmingRemoval.value = false
  void focusMore()
}

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
  <ListRow ref="row" :id="`account-${account.id}`" class="account" :aria-label="account.displayName" tabindex="-1">
    <template #mark>
      <ProviderMark :kind="markForAccount(account)" />
    </template>

    <template v-if="renaming" #text>
      <form :id="`${id}-rename`" class="rename" novalidate @submit.prevent="saveName" @keydown.esc.prevent="cancelRename">
        <input
          ref="nameInput"
          v-model="draft"
          class="name-field"
          aria-label="Display name"
          maxlength="120"
          dir="auto"
          :readonly="saving"
          @keydown.enter.prevent="saveName"
          :aria-invalid="nameError ? 'true' : undefined"
          :aria-describedby="nameError ? `${id}-recipients ${id}-name-error` : `${id}-recipients`"
        />
        <span :id="`${id}-recipients`" class="recipients">Recipients see: {{ draft }} &lt;{{ account.emailAddress }}&gt;</span>
        <span v-if="nameError" :id="`${id}-name-error`" class="name-error" role="alert">{{ nameError }}</span>
      </form>
    </template>
    <template v-else #title>
      <span dir="auto">{{ account.displayName }}</span>
    </template>
    <template v-if="!renaming" #line>
      <span dir="auto">{{ account.emailAddress }}</span>
    </template>

    <template v-if="!renaming && (account.status === 'paused' || meta)" #meta>
      <span v-if="account.status === 'paused'" class="paused">Paused</span>
      <template v-else>{{ meta }}</template>
    </template>

    <template v-if="!renaming" #action>
      <MenuButton variant="more" :label="moreLabel" :menu-label="moreLabel" :items="menuItems" @choose="choose" />
    </template>
    <template v-else #action>
      <span class="rename-actions">
        <button v-if="nameChanged" type="submit" :form="`${id}-rename`" class="button row-button" :disabled="saving">Save</button>
        <button type="button" class="button button-quiet row-button" :disabled="saving" @click="cancelRename">Cancel</button>
      </span>
    </template>

    <template v-if="attention">
      <AttentionRow :tone="attention.tone" :text="attention.text" :action="attentionAction" :action-label="attentionAction ? attentionActionLabel : undefined" @act="act" />
      <p v-if="attention.detail" class="detail" dir="auto">{{ attention.detail }}</p>
    </template>

    <ProviderAccountForm v-if="provider !== null" ref="signIn" :account="account" :provider="provider" />

    <section v-if="serverSettingsOpen && servers !== null" class="server" :aria-labelledby="`${id}-server`">
      <div class="server-head">
        <h3 :id="`${id}-server`">Server settings</h3>
        <button type="button" class="button button-quiet row-button" @click="closeServerSettings">Close</button>
      </div>
      <p v-if="!oneClickUnsubscribeAvailable(account)" class="note">{{ NO_UNSUBSCRIBE_ON_IMAP }}</p>
      <ServerAccountForm :account="account" :servers="servers" />
    </section>

    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p class="visually-hidden" role="status">{{ message }}</p>

    <div v-if="confirmingRemoval" class="confirm" role="alertdialog" :aria-labelledby="`${id}-remove`">
      <p :id="`${id}-remove`"><strong>Remove {{ account.emailAddress }}?</strong></p>
      <p>
        Its mail disappears from Tresso on every device. Nothing is deleted at your provider, and you can add the account again later.
        <template v-if="provider !== null">Tresso also deletes its access to your {{ providerName(provider) }} account.</template>
      </p>
      <div class="actions">
        <button type="button" class="button button-danger" :disabled="saving" @click="remove">Remove account</button>
        <button type="button" class="button button-quiet keep" @click="keepAccount">Keep it</button>
      </div>
    </div>
  </ListRow>
</template>

<style scoped>
/* The focus a link to this account (#account-<id>) moves here shows on the whole row. */
.account:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
  border-radius: var(--radius-row);
}
/* Grey, as the board's Paused state: no state of an account is a coloured pill. */
.paused {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--tile);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
}
.rename {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.name-field {
  width: 100%;
  max-width: 320px;
  height: 32px;
  box-sizing: border-box;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--paper);
  color: var(--ink);
  font: 600 14px var(--font-ui);
}
.name-field:focus {
  border-color: var(--focus);
}
.name-field[aria-invalid='true'] {
  border-color: var(--danger);
}
.recipients {
  font-size: 12px;
  line-height: 16px;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.name-error {
  font-size: 13px;
  line-height: 19px;
  font-weight: 500;
  color: var(--danger);
}
.rename-actions {
  display: flex;
  gap: 4px;
}
/* The outlined row button (Save) and the quiet one beside it: 32 high, as on the board. */
.row-button {
  height: 32px;
  padding: 0 12px;
}
.rename-actions .button:not(.button-quiet) {
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
}
.rename-actions .button-quiet {
  padding: 0 10px;
}
.server {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 4px;
}
.server-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.server-head h3 {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
}
/* Why, under the attention line it explains: closer than the row's 12 gap, in line with the line's own padding. */
.detail {
  margin: -6px 0 0;
  padding: 0 12px;
  font-size: 13px;
  line-height: 19px;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.note {
  margin: 0;
  color: var(--ink-2);
  font-size: 13px;
}
.form-error {
  margin: 0;
  font-size: 13px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
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
