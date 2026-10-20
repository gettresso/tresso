<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { batchTimeLabel } from '@tresso/core'
import type { Conversation } from '@/mail/db'
import { dayLabel, senderName, shortTime } from '@/mail/format'
import { useMailStore } from '@/stores/mail'
import { useSelectionStore } from '@/stores/selection'
import AppIcon from '@/components/AppIcon.vue'
import BulkBar from '@/components/BulkBar.vue'
import ClassificationMenu from '@/components/ClassificationMenu.vue'
import MenuButton from '@/components/MenuButton.vue'
import SearchField from '@/components/SearchField.vue'
import SenderAvatar from '@/components/SenderAvatar.vue'

const props = defineProps<{
  title: string
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
}>()
defineSlots<{
  /** Under the title, e.g. when the next batch comes. */
  aside?: () => unknown
  /** Under a row, e.g. its unsubscribe button. */
  extra?: (props: { conversation: Conversation }) => unknown
}>()
const emit = defineEmits<{ showMore: [] }>()

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

function groupOf(conversation: Conversation): { key: string; label: string } {
  if (props.groupBy === 'batch' && conversation.batchedAt !== null) {
    return { key: `batch-${conversation.batchedAt}`, label: `Delivered at ${batchTimeLabel(conversation.batchedAt)}` }
  }
  const label = dayLabel(conversation.lastMessageAt)

  return { key: label, label }
}

const days = computed(() => {
  const groups: { key: string; label: string; conversations: Conversation[] }[] = []
  for (const conversation of props.conversations) {
    const { key, label } = groupOf(conversation)
    const last = groups[groups.length - 1]
    if (last?.key === key) {
      last.conversations.push(conversation)
    } else {
      groups.push({ key, label, conversations: [conversation] })
    }
  }

  return groups
})
</script>

<template>
  <section class="list" :aria-label="title">
    <header class="header">
      <div class="title">
        <h1>{{ title }}</h1>
        <span class="title-actions">
          <RouterLink v-if="manageTo" :to="manageTo" class="manage">Manage senders</RouterLink>
          <MenuButton label="Select" menu-label="Select conversations" :items="ages" :disabled="conversations.length === 0" @choose="selectOlderThan" />
        </span>
      </div>
      <slot name="aside" />
      <SearchField />
    </header>

    <div class="scroll">
      <BulkBar v-if="selection.active" :conversations="conversations" />
      <section v-for="day in days" :key="day.key" :aria-label="day.label">
        <h2 class="day">{{ day.label }}</h2>
        <div
          v-for="conversation in day.conversations"
          :key="conversation.threadId"
          class="row"
          :class="{ unread: conversation.unreadCount > 0, checked: selection.has(conversation.threadId) }"
        >
          <button
            type="button"
            class="check"
            role="checkbox"
            :aria-checked="selection.has(conversation.threadId)"
            :aria-label="`Select ${conversation.subject || '(no subject)'}, from ${senderName(conversation.senders[0] ?? { name: null, address: '?' })}, ${shortTime(conversation.lastMessageAt)}`"
            :disabled="selection.busy"
            @click="check($event, conversation.threadId)"
            @keydown.shift.space.prevent="rangeByKey(conversation.threadId)"
            @keyup.space="spaceReleased(conversation.threadId)"
          >
            <span class="box" aria-hidden="true" />
          </button>
          <RouterLink :to="linkTo(conversation.threadId)" class="link" :aria-current="conversation.threadId === selectedThreadId ? 'true' : undefined">
            <span class="dot" :aria-label="conversation.unreadCount > 0 ? 'Unread' : undefined" />
            <SenderAvatar :sender="conversation.senders[0] ?? { name: null, address: '?' }" />
            <span class="body">
              <span class="top">
                <span class="senders">{{ conversation.senders.map(senderName).join(', ') }}</span>
                <span v-if="conversation.messageCount > 1" class="count">{{ conversation.messageCount }}</span>
                <span class="time">{{ shortTime(conversation.lastMessageAt) }}</span>
              </span>
              <span class="subject">
                <AppIcon v-if="conversation.flagged" name="flag" :size="14" label="Flagged" />
                <AppIcon v-if="conversation.attachmentsBlocked" name="shieldAlert" :size="14" label="Attachment blocked: contains malware" class="blocked" />
                <AppIcon v-else-if="conversation.hasAttachments" name="attachment" :size="14" label="Has attachments" />
                {{ conversation.subject || '(no subject)' }}
              </span>
              <span class="snippet">{{ conversation.snippet }}</span>
            </span>
          </RouterLink>
          <ClassificationMenu
            class="classification"
            :thread-id="conversation.threadId"
            :subject="conversation.subject"
            :smart-inbox-id="conversation.smartInboxId || null"
            :verdict="conversation.verdict ?? null"
          />
          <div v-if="$slots.extra" class="extra"><slot name="extra" :conversation="conversation" /></div>
        </div>
      </section>

      <p v-if="conversations.length === 0 && !loading && !hasAccounts" class="empty">
        Connect a mail account to see your mail here. <RouterLink :to="{ name: 'settings-accounts-new' }">Add account</RouterLink>
      </p>
      <p v-else-if="conversations.length === 0 && !loading" class="empty">{{ emptyText ?? 'Nothing in this inbox.' }}</p>
      <p v-if="conversations.length === 0 && loading" class="empty">Loading your mail…</p>
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
  margin: 0;
  font: 700 28px/34px var(--font-display);
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
  display: flex;
  align-items: center;
  gap: 8px;
}
.manage {
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
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
.link[aria-current='true'] {
  background: var(--selected);
  box-shadow: inset 3px 0 0 var(--focus);
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
</style>
