<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { handOverStatus, type SyncedMailAccount, type SyncedSmartInbox } from '@tresso/core'
import AppIcon from '@/components/AppIcon.vue'
import SenderAvatar from '@/components/SenderAvatar.vue'
import SmartInboxMark from '@/components/SmartInboxMark.vue'
import { briefProgress } from '@tresso/core'
import { useBriefStore } from '@/stores/brief'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import { useTodosStore } from '@/stores/todos'
import type { SidebarPage } from '@/components/sidebarPage'

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
  live: boolean
  /** A page of its own on screen instead of a list of mail. */
  page?: SidebarPage
}>()
const emit = defineEmits<{ signOut: [] }>()

const mail = useMailStore()
const compose = useComposeStore()
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

const totalUnread = computed(() => [...props.unreadCounts.values()].reduce((sum, count) => sum + count, 0))

const statusText: Record<SyncedMailAccount['status'], string | null> = {
  active: null,
  paused: 'Paused',
  auth_failed: 'Sign-in failed',
  error: 'Sync problem',
}
</script>

<template>
  <nav class="sidebar" aria-label="Mailboxes">
    <div class="profile">
      <SenderAvatar :sender="{ name: displayName, address: email }" :size="28" />
      <span class="profile-text">
        <span class="profile-name">{{ displayName }}</span>
        <span class="profile-detail">{{ accounts.length === 1 ? '1 account' : `${accounts.length} accounts` }}</span>
      </span>
      <button type="button" class="button button-quiet sign-out" @click="emit('signOut')">Sign out</button>
    </div>

    <button type="button" class="button button-primary compose" @click="compose.openNew()">Compose <kbd>C</kbd></button>

    <div class="group">
      <RouterLink :to="{ name: 'unified' }" class="item" :aria-current="inList && mailbox === null && smartInbox === null && !batches ? 'page' : undefined">
        <AppIcon name="inbox" />
        <span class="label">Unified Inbox</span>
        <span v-if="totalUnread > 0" class="count">{{ totalUnread }}<span class="visually-hidden"> unread</span></span>
      </RouterLink>
      <RouterLink :to="{ name: 'brief' }" class="item" :aria-current="page === 'brief' ? 'page' : undefined">
        <AppIcon name="know" />
        <span class="label">Daily brief</span>
        <span v-if="briefIsNew" class="new">New</span>
        <span v-if="briefLeft > 0" class="count">{{ briefLeft }}<span class="visually-hidden"> to note</span></span>
      </RouterLink>
      <RouterLink :to="{ name: 'todos' }" class="item" :aria-current="page === 'todos' ? 'page' : undefined">
        <AppIcon name="todo" />
        <span class="label">Todos</span>
        <span v-if="todos.openCount > 0" class="count">{{ todos.openCount }}<span class="visually-hidden"> open</span></span>
      </RouterLink>
      <RouterLink :to="{ name: 'waiting' }" class="item" :aria-current="page === 'waiting' ? 'page' : undefined">
        <AppIcon name="delegate" />
        <span class="label">Waiting on</span>
        <span v-if="waitingCount > 0" class="count" :class="{ failed: overdueCount > 0 }"
          >{{ waitingCount }}<span class="visually-hidden">{{ overdueCount > 0 ? `, ${overdueCount} past due` : ' waiting' }}</span></span
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
        <span class="count" :class="{ failed: failedCount > 0 }">{{ outboxCount }}</span>
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
        <span v-if="(smartInboxCounts.get(item.id) ?? 0) > 0" class="count">{{ smartInboxCounts.get(item.id) }}<span class="visually-hidden"> unread</span></span>
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
      <RouterLink
        v-for="account in accounts"
        :key="account.id"
        :to="{ name: 'account', params: { accountId: account.id } }"
        class="item account"
        :aria-current="inList && mailbox === account.id && smartInbox === null && !batches ? 'page' : undefined"
      >
        <SenderAvatar :sender="{ name: account.displayName, address: account.emailAddress }" :size="24" />
        <span class="account-text">
          <span class="account-name">{{ account.displayName }}</span>
          <span class="account-address">{{ statusText[account.status] ?? account.emailAddress }}</span>
        </span>
        <span v-if="(unreadCounts.get(account.id) ?? 0) > 0" class="count">{{ unreadCounts.get(account.id) }}<span class="visually-hidden"> unread</span></span>
      </RouterLink>
      <RouterLink :to="{ name: 'settings-accounts-new' }" class="add">+ Add account</RouterLink>
    </div>

    <RouterLink :to="{ name: 'settings-accounts' }" class="item settings" :aria-current="page === 'settings' ? 'page' : undefined">
      <AppIcon name="settings" />
      <span class="label">Settings</span>
    </RouterLink>

    <p class="live" :class="{ on: live }" role="status">{{ live ? 'Up to date' : 'Connecting…' }}</p>
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
.compose kbd {
  font: 500 11px var(--font-mono);
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--surface) 25%, transparent);
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
  box-shadow: 0 1px 2px rgb(22 24 29 / 6%);
  font-weight: 600;
}
.account {
  min-height: 44px;
  padding: 4px 10px;
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
.live {
  margin: 0;
  padding: 0 10px;
  font-size: 12px;
  color: var(--ink-3);
}
.live::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 999px;
  background: var(--ink-3);
  vertical-align: middle;
}
.live::before {
  transition: background-color var(--motion-base) ease;
}
.live.on::before {
  background: var(--know);
}
</style>
