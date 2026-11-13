<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { accountSubtitle, handOverStatus, type SyncedMailAccount, type SyncedSmartInbox } from '@tresso/core'
import AppIcon from '@/components/AppIcon.vue'
import SenderAvatar from '@/components/SenderAvatar.vue'
import SmartInboxMark from '@/components/SmartInboxMark.vue'
import { briefProgress } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'
import { useBriefStore } from '@/stores/brief'
import { useChatsStore } from '@/stores/chats'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import { useTodosStore } from '@/stores/todos'
import type { SidebarPage } from '@/components/sidebarPage'
import KeyShortcut from '@/components/KeyShortcut.vue'
import TickCount from '@/components/TickCount.vue'
import SyncStatusLine from '@/components/SyncStatusLine.vue'
import FrameScroll from '@/components/FrameScroll.vue'

const props = defineProps<{
  displayName: string
  email: string
  accounts: SyncedMailAccount[]
  unreadCounts: Map<string, number>
  mailbox: string | null
  smartInboxes: SyncedSmartInbox[]
  smartInboxCounts: Map<string, number>
  /** The smart inbox on screen; null when an inbox is. */
  smartInbox: string | null
  /** Whether the batches are on screen. */
  batches: boolean
  /** When the next batch comes, e.g. "13:00"; null while unknown. */
  nextBatch: string | null
  /** A page of its own on screen instead of a list of mail. */
  page?: SidebarPage
  /** The WhatsApp list (or a chat in it) is on screen. */
  whatsapp?: boolean
}>()
const emit = defineEmits<{ signOut: [] }>()

const mail = useMailStore()
const compose = useComposeStore()
const auth = useAuthStore()
const outboxCount = computed(() => mail.outbox.length)
const todos = useTodosStore()
const failedCount = computed(() => mail.outbox.filter((message) => message.status === 'failed').length)
const waitingCount = computed(() => mail.handOvers.filter((handOver) => handOver.state === 'open').length)
const overdueCount = computed(() => mail.handOvers.filter((handOver) => handOverStatus(handOver) === 'overdue').length)
const inList = computed(() => props.page === undefined)

const brief = useBriefStore()
const briefLeft = computed(() => {
  const latest = mail.latestBrief
  if (latest === null) {
    return 0
  }
  const { noted, total } = briefProgress(latest.entries)
  return total - noted
})
const briefIsNew = computed(() => mail.latestBrief !== null && briefLeft.value > 0 && mail.latestBrief.brief.id !== brief.seenBriefId)

const chats = useChatsStore()
const wa = useWhatsAppRelayStore()
/** The WhatsApp row (the Sidebar board's account row): only where WhatsApp is on and connected. */
const whatsappRow = computed(() => {
  const config = wa.config
  if (!chats.enabled || config === null) {
    return null
  }
  const address = chats.account?.address ?? wa.identity?.number ?? null
  return { subtitle: accountSubtitle({ address, relayDeviceId: config.deviceId, relayDeviceName: config.deviceName }, config.deviceId), unread: chats.unread }
})
const whatsappRows = computed(() => (whatsappRow.value === null ? [] : [whatsappRow.value]))
const profileDetail = computed(() => {
  const count = props.accounts.length
  if (whatsappRow.value === null) {
    return count === 1 ? '1 account' : `${count} accounts`
  }
  return `${count === 1 ? '1 mail account' : `${count} mail accounts`}, WhatsApp`
})

/** Unread mail of every account, and the chats in the Unified Inbox with unread messages. */
const totalUnread = computed(() => [...props.unreadCounts.values()].reduce((sum, count) => sum + count, 0) + (whatsappRow.value?.unread ?? 0))

const statusText: Record<SyncedMailAccount['status'], string | null> = {
  active: null,
  paused: 'Paused',
  auth_failed: 'Sign-in failed',
  error: 'Sync problem',
}

/** Sign-in failed or sync broke: the user has to act, in Settings, before mail comes in again. */
function failed(account: SyncedMailAccount): boolean {
  return account.status === 'auth_failed' || account.status === 'error'
}
</script>

<template>
  <nav class="sidebar" aria-label="Mailboxes">
    <!-- In the desktop shell only the rows scroll, under the window's title band and above the sync status. -->
    <FrameScroll>
      <div class="profile">
        <SenderAvatar :sender="{ name: displayName, address: email }" :size="28" />
        <span class="profile-text">
          <span class="profile-name">{{ displayName }}</span>
          <span class="profile-detail">{{ profileDetail }}</span>
        </span>
        <button type="button" class="button button-quiet sign-out" :disabled="auth.signingOut" :aria-busy="auth.signingOut" @click="emit('signOut')">
          {{ auth.signingOut ? 'Signing out…' : 'Sign out' }}
        </button>
      </div>

      <button type="button" class="button button-primary compose" @click="compose.openNew()">Compose <KeyShortcut keys="C" /></button>

      <div class="group">
        <RouterLink :to="{ name: 'unified' }" class="item" :aria-current="inList && mailbox === null && smartInbox === null && !batches && !whatsapp ? 'page' : undefined">
          <AppIcon name="inbox" />
          <span class="label">Unified Inbox</span>
          <span v-if="totalUnread > 0" class="count"><TickCount :value="totalUnread" /><span class="visually-hidden"> unread</span></span>
        </RouterLink>
        <RouterLink :to="{ name: 'brief' }" class="item" :aria-current="page === 'brief' ? 'page' : undefined">
          <AppIcon name="know" />
          <span class="label">Daily brief</span>
          <span v-if="briefIsNew" class="new">New</span>
          <span v-if="briefLeft > 0" class="count"><TickCount :value="briefLeft" /><span class="visually-hidden"> to note</span></span>
        </RouterLink>
        <RouterLink :to="{ name: 'todos' }" class="item" :aria-current="page === 'todos' ? 'page' : undefined">
          <AppIcon name="todo" />
          <span class="label">Todos</span>
          <span v-if="todos.openCount > 0" class="count"><TickCount :value="todos.openCount" /><span class="visually-hidden"> open</span></span>
        </RouterLink>
        <RouterLink :to="{ name: 'waiting' }" class="item" :aria-current="page === 'waiting' ? 'page' : undefined">
          <AppIcon name="delegate" />
          <span class="label">Waiting on</span>
          <span v-if="waitingCount > 0" class="count" :class="{ failed: overdueCount > 0 }"
            ><TickCount :value="waitingCount" /><span class="visually-hidden">{{ overdueCount > 0 ? `, ${overdueCount} past due` : ' waiting' }}</span></span
          >
        </RouterLink>
        <RouterLink :to="{ name: 'calendar' }" class="item" :aria-current="page === 'calendar' ? 'page' : undefined">
          <AppIcon name="calendar" />
          <span class="label">Calendar</span>
        </RouterLink>
        <RouterLink :to="{ name: 'triage' }" class="item" :aria-current="page === 'triage' ? 'page' : undefined">
          <AppIcon name="triage" />
          <span class="label">Triage</span>
        </RouterLink>
        <RouterLink :to="{ name: 'drafts' }" class="item" :aria-current="page === 'drafts' ? 'page' : undefined">
          <AppIcon name="draft" />
          <span class="label">Drafts</span>
        </RouterLink>
        <RouterLink :to="{ name: 'cleanup' }" class="item" :aria-current="page === 'cleanup' ? 'page' : undefined">
          <AppIcon name="archive" />
          <span class="label">Clean up</span>
        </RouterLink>
        <RouterLink v-if="outboxCount > 0" :to="{ name: 'outbox' }" class="item" :aria-current="page === 'outbox' ? 'page' : undefined">
          <AppIcon name="outbox" />
          <span class="label">Outbox</span>
          <span class="count" :class="{ failed: failedCount > 0 }"><TickCount :value="outboxCount" /></span>
        </RouterLink>
      </div>

      <div v-if="smartInboxes.length > 0" class="group">
        <h2 class="group-title">Smart inboxes</h2>
        <RouterLink
          v-for="item in smartInboxes"
          :key="item.id"
          :to="{ name: 'smart-inbox', params: { smartInboxId: item.id } }"
          class="item smart"
          :aria-current="inList && smartInbox === item.id ? 'page' : undefined"
        >
          <SmartInboxMark :smart-inbox="item" />
          <span class="label">{{ item.name }}</span>
          <span v-if="(smartInboxCounts.get(item.id) ?? 0) > 0" class="count"><TickCount :value="smartInboxCounts.get(item.id) ?? 0" /><span class="visually-hidden"> unread</span></span>
        </RouterLink>
        <RouterLink :to="{ name: 'batches' }" class="item smart" :aria-current="batches ? 'page' : undefined">
          <AppIcon name="clock" :size="20" class="batches-icon" />
          <span class="label">Batches</span>
          <span v-if="nextBatch" class="count"><span class="visually-hidden">Next batch at </span>{{ nextBatch }}</span>
        </RouterLink>
        <RouterLink :to="{ name: 'settings-smart-inbox', params: { smartInboxId: 'new' } }" class="add">+ New smart inbox</RouterLink>
      </div>

      <div class="group">
        <h2 class="group-title">Accounts</h2>
        <div v-for="account in accounts" :key="account.id" class="account-row">
          <RouterLink
            :to="{ name: 'account', params: { accountId: account.id } }"
            class="item account"
            :aria-current="inList && mailbox === account.id && smartInbox === null && !batches ? 'page' : undefined"
          >
            <SenderAvatar :sender="{ name: account.displayName, address: account.emailAddress }" :size="24" />
            <span class="account-text">
              <span class="account-name">{{ account.displayName }}</span>
              <span class="account-address" :class="{ problem: failed(account) }">{{ statusText[account.status] ?? account.emailAddress }}</span>
            </span>
            <span v-if="(unreadCounts.get(account.id) ?? 0) > 0" class="count"><TickCount :value="unreadCounts.get(account.id) ?? 0" /><span class="visually-hidden"> unread</span></span>
          </RouterLink>
          <!-- A link of its own beside the row (a link cannot hold another): where a failed account is fixed. -->
          <RouterLink v-if="failed(account)" :to="{ name: 'settings-accounts' }" class="fix" :aria-label="`Fix ${account.displayName}`">Fix</RouterLink>
        </div>
        <!-- A list of one or none: an empty list leaves no node at all, so the browser's markup stays as it was. -->
        <RouterLink v-for="whatsappRow in whatsappRows" :key="whatsappRow.subtitle" :to="{ name: 'whatsapp' }" class="item account whatsapp" :aria-current="inList && whatsapp ? 'page' : undefined">
          <span class="wa-mark" aria-hidden="true">WA</span>
          <span class="account-text">
            <span class="account-name">WhatsApp</span>
            <span class="account-address">{{ whatsappRow.subtitle }}</span>
          </span>
          <span v-if="whatsappRow.unread > 0" class="count"><TickCount :value="whatsappRow.unread" /><span class="visually-hidden"> unread</span></span>
        </RouterLink>
        <RouterLink :to="{ name: 'settings-accounts-new' }" class="add">+ Add account</RouterLink>
      </div>

      <RouterLink :to="{ name: 'settings-accounts' }" class="item settings" :aria-current="page === 'settings' ? 'page' : undefined">
        <AppIcon name="settings" />
        <span class="label">Settings</span>
      </RouterLink>

    </FrameScroll>

    <SyncStatusLine :status="mail.syncStatus" />
  </nav>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 20px 12px;
  min-height: 0;
  overflow-y: auto;
}
.profile {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 4px 0 10px;
  min-height: 44px;
}
.profile-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.profile-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.profile-detail,
.account-address {
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sign-out {
  height: 32px;
  padding: 0 8px;
}
.compose {
  height: 40px;
  margin: 0 4px;
}
.new {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--know-soft);
  color: var(--know);
  font-size: 11px;
  font-weight: 700;
}
.count.failed {
  color: var(--danger);
  font-weight: 700;
}
.group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.group-title {
  margin: 0;
  padding: 0 10px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 0 10px;
  border-radius: var(--radius-control);
  color: var(--ink);
  font-weight: 500;
  text-decoration: none;
  transition:
    background-color var(--motion-fast) ease,
    box-shadow var(--motion-fast) ease;
}
.item:hover {
  background: color-mix(in srgb, var(--surface) 60%, transparent);
}
.item[aria-current='page'] {
  background: var(--surface);
  box-shadow: var(--glass-edge), 0 1px 2px rgb(22 24 29 / 6%);
  font-weight: 600;
}
.account {
  min-height: 44px;
  padding: 4px 10px;
}
.account-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.account-row > .account {
  flex: 1;
  min-width: 0;
}
.account-address.problem {
  color: var(--danger);
  font-weight: 600;
}
.fix {
  flex: none;
  padding: 4px 8px;
  border-radius: var(--radius-control);
  color: var(--danger);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}
.fix:hover {
  background: var(--danger-soft);
}
/* Touch size on a phone. */
@media (max-width: 760px) {
  .fix {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 12px;
  }
}
.wa-mark {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: var(--whatsapp);
  color: var(--whatsapp-text);
  font-size: 10px;
  font-weight: 700;
}
.account-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.smart {
  min-height: 32px;
}
.count {
  font-size: 12px;
  color: var(--ink-2);
}
.batches-icon {
  flex-shrink: 0;
  color: var(--ink-2);
}
.add {
  display: flex;
  border-radius: var(--radius-control);
  transition: color var(--motion-fast) ease;
  align-items: center;
  height: 32px;
  padding: 0 10px;
  color: var(--ink-2);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
.add:hover {
  color: var(--ink);
}
.settings {
  margin-top: auto;
}

/*
 * The desktop window frame (assets/frame.css has every number; .frame-shell is set by AppShell in the desktop app
 * only). The card's rows: 32 high with no gap, the selection fill 10 inside the card's edges with radius 8, the icon
 * at x 30 and the label at x 54, the count inside the fill. What the spec does not cover keeps its own height: the
 * profile (44, avatar and Sign out), the ink Compose button (40) and the account rows (44, two lines: name, and address
 * or what failed).
 */
/*
 * The card itself does not scroll: its top band (the traffic lights and the toggle) stays put, the sync status stays at
 * its foot, and only the rows between scroll (FrameScroll). The scroller's 4 px of padding keep a focus ring inside it,
 * and a row brought into view by the keyboard stops that far from its edges.
 */
.frame-shell .sidebar {
  gap: 0;
  overflow: hidden;
  padding: calc(var(--frame-first-row-y) - var(--frame-inset) - var(--frame-scroll-inset)) 0 var(--frame-row-inset);
}
.frame-shell .frame-scroll {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  padding: var(--frame-scroll-inset) var(--frame-row-inset);
  scroll-padding-block: var(--frame-scroll-inset);
}
.frame-shell .profile {
  padding: 0 4px 0 var(--frame-row-icon-x);
}
.frame-shell .compose {
  flex: none;
  margin: var(--frame-group-gap) 0 0;
}
.frame-shell .group {
  gap: 0;
  margin-top: var(--frame-group-gap);
}
/* A labelled group is set off by its label's strip instead. */
.frame-shell .group:has(> .group-title) {
  margin-top: 0;
}
.frame-shell .group-title {
  display: flex;
  align-items: center;
  height: var(--frame-group-label-height);
  padding: 0 var(--frame-row-icon-x);
  font-size: var(--frame-group-label-size);
}
.frame-shell .item {
  min-height: var(--frame-row-height);
  padding: 0 var(--frame-row-trailing) 0 var(--frame-row-icon-x);
  gap: var(--frame-row-label-gap);
  border-radius: var(--frame-row-radius);
}
.frame-shell .item.account {
  min-height: 44px;
  padding-block: 4px;
}
.frame-shell .item > svg,
.frame-shell .item > .mark {
  flex: none;
  width: var(--frame-row-icon);
  height: var(--frame-row-icon);
}
.frame-shell .item > .mark {
  border-radius: 4px;
  font-size: 10px;
}
.frame-shell .add {
  height: var(--frame-row-height);
  padding: 0 var(--frame-row-icon-x);
  border-radius: var(--frame-row-radius);
}
.frame-shell .group:has(+ .settings) {
  margin-bottom: var(--frame-group-gap);
}
.frame-shell .sync-status {
  flex: none;
  margin-top: 4px;
  padding: 0 calc(var(--frame-row-inset) + var(--frame-row-icon-x));
}
/* The selected row: grey while the content has focus (or the window is in the back), the accent while the sidebar has. */
.frame-shell .item[aria-current='page'] {
  background: var(--frame-selection-fill);
  box-shadow: var(--frame-selection-edge);
}
.frame-shell .sidebar.active .item[aria-current='page'] {
  background: var(--frame-selection-accent);
  box-shadow: none;
  color: var(--frame-selection-text);
}
.frame-shell .sidebar.active .item[aria-current='page'] :is(.count, .count.failed, .account-address, .account-address.problem, .batches-icon) {
  color: var(--frame-selection-text);
}
/* The "New" badge turns around on the accent: white with the accent's colour (5.4:1 for #0064e1, as white on it). */
.frame-shell .sidebar.active .item[aria-current='page'] .new {
  background: var(--frame-selection-text);
  color: var(--frame-selection-accent);
}
</style>
