<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { batchTimeLabel, mergeInbox, type ChatSummary, type SyncedChatMessage } from '@tresso/core'
import type { Conversation } from '@/mail/db'
import { dayLabel, senderName, shortTime } from '@/mail/format'
import { useMailStore } from '@/stores/mail'
import { useSelectionStore } from '@/stores/selection'
import AppIcon from '@/components/AppIcon.vue'
import BulkBar from '@/components/BulkBar.vue'
import ClassificationMenu from '@/components/ClassificationMenu.vue'
import FrameCapsule from '@/components/FrameCapsule.vue'
import FrameTitle from '@/components/FrameTitle.vue'
import FrameTools from '@/components/FrameTools.vue'
import MenuButton from '@/components/MenuButton.vue'
import SearchField from '@/components/SearchField.vue'
import SyncNotice from '@/components/SyncNotice.vue'
import SenderAvatar from '@/components/SenderAvatar.vue'
import { collapseLeave, expandEnter } from '@/components/listMotion'
import LogoLoader from '@/components/LogoLoader.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import ChatListRow from '@/components/chat/ChatListRow.vue'
import type { InboxChannel } from '@/stores/chats'

const props = defineProps<{
  title: string
  /** Which list this is; a new one starts fresh, without rows animating across the switch. Falls back to the title. */
  listKey?: string
  conversations: Conversation[]
  selectedThreadId: string | null
  hasMore: boolean
  loading: boolean
  hasAccounts: boolean
  linkTo: (threadId: string) => RouteLocationRaw
  emptyText?: string
  /** How the rows are grouped: by day (the default), or by the batch that delivered them. */
  groupBy?: 'day' | 'batch'
  /** Where the list's senders are managed in bulk (a smart inbox's). */
  manageTo?: RouteLocationRaw
  /** Chats placed among the conversations by time, newest first (the Unified Inbox, the WhatsApp list). */
  chatRows?: ChatSummary[]
  selectedChatId?: string | null
  chatLinkTo?: (chatId: string) => RouteLocationRaw
  /** The newest message of a chat with its sender's name as known now (chats.named). */
  namedMessage?: (message: SyncedChatMessage) => SyncedChatMessage
  /** The Unified Inbox's `Channels` tabs, when they show; null or left out shows none. */
  channel?: InboxChannel | null
}>()
defineSlots<{
  /** Under the title, e.g. when the next batch comes. */
  aside?: () => unknown
  /** Under a row, e.g. its unsubscribe button. */
  extra?: (props: { conversation: Conversation }) => unknown
}>()
const emit = defineEmits<{ showMore: []; 'update:channel': [channel: InboxChannel] }>()

const CHANNELS: { value: InboxChannel; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'mail', label: 'Mail' },
  { value: 'whatsapp', label: 'WhatsApp' },
]

const mail = useMailStore()
const selection = useSelectionStore()
const DAY = 86_400_000
const ages = [
  { id: String(7 * DAY), label: 'Older than a week' },
  { id: String(30 * DAY), label: 'Older than a month' },
  { id: String(91 * DAY), label: 'Older than three months' },
  { id: String(365 * DAY), label: 'Older than a year' },
]

/** Shift+Space selected a range on this row; the click a browser may send when Space is let go is not a toggle. */
let rangedByKey: string | null = null

function rangeByKey(threadId: string): void {
  rangedByKey = threadId
  selection.extend(threadId, props.conversations.map((c) => c.threadId))
}

// A browser that sends no click after a handled Shift+Space must not leave the next real click ignored.
function spaceReleased(threadId: string): void {
  if (rangedByKey === threadId) {
    setTimeout(() => {
      rangedByKey = null
    })
  }
}

function check(event: MouseEvent, threadId: string): void {
  if (rangedByKey === threadId) {
    rangedByKey = null
    return
  }
  rangedByKey = null
  if (event.shiftKey) {
    selection.extend(threadId, props.conversations.map((c) => c.threadId))
    return
  }
  selection.toggle(threadId)
}

async function selectOlderThan(age: string): Promise<void> {
  selection.set(await mail.threadsBefore(Date.now() - Number(age)))
}

/** A row of the list: a conversation of mail, or a chat. */
type ListItem = { kind: 'mail'; key: string; conversation: Conversation; lastMessageAt: number } | { kind: 'chat'; key: string; summary: ChatSummary; lastMessageAt: number }

function groupOf(item: ListItem): { key: string; label: string } {
  if (item.kind === 'mail' && props.groupBy === 'batch' && item.conversation.batchedAt !== null) {
    return { key: `batch-${item.conversation.batchedAt}`, label: `Delivered at ${batchTimeLabel(item.conversation.batchedAt)}` }
  }
  const label = dayLabel(item.lastMessageAt)

  return { key: label, label }
}

/** Mail and chats in one list by time, in the same day groups (mergeInbox); a chat has no checkbox. */
const items = computed<ListItem[]>(() => {
  const mail: ListItem[] = props.conversations.map((conversation) => ({ kind: 'mail', key: conversation.threadId, conversation, lastMessageAt: conversation.lastMessageAt }))
  const chats: ListItem[] = (props.chatRows ?? []).map((summary) => ({ kind: 'chat', key: `chat:${summary.chat.id}`, summary, lastMessageAt: summary.lastMessageAt }))
  return chats.length === 0 ? mail : mergeInbox(mail, chats, mail.length + chats.length)
})

const days = computed(() => {
  const groups: { key: string; label: string; items: ListItem[] }[] = []
  for (const item of items.value) {
    const { key, label } = groupOf(item)
    const last = groups[groups.length - 1]
    if (last?.key === key) {
      last.items.push(item)
    } else {
      groups.push({ key, label, items: [item] })
    }
  }

  return groups
})
</script>

<template>
  <section class="list" :aria-label="title">
    <header class="header">
      <div class="title">
        <FrameTitle :title="title">{{ title }}</FrameTitle>
        <span class="title-actions">
          <FrameTools>
            <FrameCapsule v-if="manageTo"><RouterLink :to="manageTo" class="manage">Manage senders</RouterLink></FrameCapsule>
            <FrameCapsule><MenuButton label="Select" menu-label="Select conversations" :items="ages" :disabled="conversations.length === 0" @choose="selectOlderThan" /></FrameCapsule>
          </FrameTools>
        </span>
      </div>
      <slot name="aside" />
      <SegmentedControl v-if="channel" class="channels" label="Channels" :options="CHANNELS" :selected="channel" @choose="emit('update:channel', $event)" />
      <SyncNotice />
      <SearchField />
    </header>

    <!-- A list of its own (another inbox) starts fresh: no rows animate in or out across the switch. -->
    <div :key="listKey ?? title" class="scroll">
      <Transition name="bar">
        <BulkBar v-if="selection.active" :conversations="conversations" />
      </Transition>
      <section v-for="day in days" :key="day.key" :aria-label="day.label">
        <h2 class="day">{{ day.label }}</h2>
        <TransitionGroup :css="false" @enter="expandEnter" @leave="collapseLeave">
        <template v-for="item in day.items" :key="item.key">
        <ChatListRow
          v-if="item.kind === 'chat'"
          :summary="item.summary"
          :selected="item.summary.chat.id === selectedChatId"
          :to="chatLinkTo ? chatLinkTo(item.summary.chat.id) : '/'"
          :named="namedMessage"
        />
        <div
          v-else
          class="row"
          :class="{ unread: item.conversation.unreadCount > 0, checked: selection.has(item.conversation.threadId), selected: item.conversation.threadId === selectedThreadId }"
        >
          <button
            type="button"
            class="check"
            role="checkbox"
            :aria-checked="selection.has(item.conversation.threadId)"
            :aria-label="`Select ${item.conversation.subject || '(no subject)'}, from ${senderName(item.conversation.senders[0] ?? { name: null, address: '?' })}, ${shortTime(item.conversation.lastMessageAt)}`"
            :disabled="selection.busy"
            @click="check($event, item.conversation.threadId)"
            @keydown.shift.space.prevent="rangeByKey(item.conversation.threadId)"
            @keyup.space="spaceReleased(item.conversation.threadId)"
          >
            <span class="box" aria-hidden="true" />
          </button>
          <RouterLink :to="linkTo(item.conversation.threadId)" class="link" :aria-current="item.conversation.threadId === selectedThreadId ? 'true' : undefined">
            <!-- The dot is colour only; a screen reader hears "Unread" as part of the link. -->
            <span v-if="item.conversation.unreadCount > 0" class="visually-hidden">Unread. </span>
            <span class="dot" aria-hidden="true" />
            <SenderAvatar :sender="item.conversation.senders[0] ?? { name: null, address: '?' }" />
            <span class="body">
              <span class="top">
                <span class="senders">{{ item.conversation.senders.map(senderName).join(', ') }}</span>
                <span v-if="item.conversation.messageCount > 1" class="count">{{ item.conversation.messageCount }}</span>
                <span class="time">{{ shortTime(item.conversation.lastMessageAt) }}</span>
              </span>
              <span class="subject">
                <AppIcon v-if="item.conversation.flagged" name="flag" :size="14" label="Flagged" />
                <AppIcon v-if="item.conversation.attachmentsBlocked" name="shieldAlert" :size="14" label="Attachment blocked: contains malware" class="blocked" />
                <AppIcon v-else-if="item.conversation.hasAttachments" name="attachment" :size="14" label="Has attachments" />
                {{ item.conversation.subject || '(no subject)' }}
              </span>
              <span class="snippet">{{ item.conversation.snippet }}</span>
            </span>
          </RouterLink>
          <ClassificationMenu
            class="classification"
            :thread-id="item.conversation.threadId"
            :subject="item.conversation.subject"
            :smart-inbox-id="item.conversation.smartInboxId || null"
            :verdict="item.conversation.verdict ?? null"
          />
          <div v-if="$slots.extra" class="extra"><slot name="extra" :conversation="item.conversation" /></div>
        </div>
        </template>
        </TransitionGroup>
      </section>

      <p v-if="items.length === 0 && !loading && !hasAccounts" class="empty">
        Connect a mail account to see your mail here. <RouterLink :to="{ name: 'settings-accounts-new' }">Add account</RouterLink>
      </p>
      <p v-else-if="items.length === 0 && !loading" class="empty">{{ emptyText ?? 'Nothing in this inbox.' }}</p>
      <p v-if="items.length === 0 && loading" class="empty" role="status"><LogoLoader /> Loading your mail…</p>
      <button v-if="hasMore" type="button" class="button button-quiet more" @click="emit('showMore')">Show older mail</button>
    </div>
  </section>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: var(--glass-edge);
  border-left: 1px solid var(--line);
  border-right: 1px solid var(--line);
}
.header {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 20px 12px;
  border-bottom: 1px solid var(--line);
}
h1 {
  /* A long title (an account named after its address) is cut short, so Select stays in the header. */
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font: 700 28px/34px var(--font-display);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.scroll {
  overflow-y: auto;
  padding-bottom: 16px;
}
.day {
  margin: 0;
  padding: 18px 20px 6px 64px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-3);
}
.title-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
/* A capsule in the desktop shell's title strip gives the link its height. */
.frame-shell .manage {
  display: inline-flex;
  align-items: center;
}
.manage {
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
/* In the desktop shell the title and its actions are in the title strip (FrameTitle, FrameTools). */
.frame-shell .title {
  display: none;
}
.title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  transition: background-color var(--motion-fast) ease;
}
.extra {
  flex-basis: 100%;
  padding: 0 20px 10px 118px;
}
.extra:empty {
  display: none;
}
.row:hover,
.row.checked {
  background: var(--ground);
}
/* The open conversation: the whole row, checkbox to chevron, with the accent along its left edge. */
.row.selected {
  background: var(--selected);
  box-shadow: inset 3px 0 0 var(--focus), var(--glass-edge);
}
/* Keyboard focus on the row's link outlines the whole row, not just the text in the middle. */
.row:has(.link:focus-visible) {
  box-shadow: inset 0 0 0 2px var(--focus);
}
.check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  margin: 14px 0 0 6px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}
.check:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.box {
  width: 16px;
  height: 16px;
  border: 2px solid var(--line-strong);
  border-radius: 4px;
}
.checked .box {
  border-color: var(--focus);
  background: var(--focus);
}
.link {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 20px 12px 4px;
  color: var(--ink);
  text-decoration: none;
}
.classification {
  flex-shrink: 0;
  margin: 34px 12px 0 -12px;
}
.link:focus-visible {
  outline: none;
}
.dot {
  width: 8px;
  height: 8px;
  margin-top: 16px;
  border-radius: 999px;
  flex-shrink: 0;
}
.unread .dot {
  background: var(--unread);
}
.body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.top {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.senders {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.unread .senders,
.unread .subject {
  font-weight: 600;
}
.count,
.time {
  font-size: 12px;
  color: var(--ink-3);
  flex-shrink: 0;
}
.subject {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.subject svg {
  flex-shrink: 0;
  color: var(--ink-2);
}
.subject svg.blocked {
  color: var(--danger);
}
.snippet {
  color: var(--ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty {
  padding: 32px 20px;
  margin: 0;
  color: var(--ink-3);
  text-align: center;
}
.more {
  display: flex;
  margin: 12px auto 0;
}
.bar-enter-active {
  animation: slide-down-in var(--motion-base) var(--ease-out);
}
.bar-leave-active {
  animation: fade-out 100ms ease-in forwards;
}
</style>
