<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { previewLine, type ChatSummary, type SyncedChatMessage } from '@tresso/core'
import { shortTime } from '@/mail/format'
import SenderAvatar from '@/components/SenderAvatar.vue'
import { chatName } from '@/components/chat/chatTexts'

/**
 * A chat in a list (the WhatsAppInbox board's chat row): unread dot, avatar with the WhatsApp badge, name, time and
 * the newest message on one line. No checkbox: chats are not part of a bulk selection.
 */
const props = defineProps<{
  summary: ChatSummary
  selected: boolean
  to: RouteLocationRaw
  /** The newest message with its sender's name as this session knows it (chats.named). */
  named?: (message: SyncedChatMessage) => SyncedChatMessage
}>()

const name = computed(() => chatName(props.summary.chat))
const preview = computed(() => {
  const newest = props.summary.newest
  return previewLine(props.summary.chat, newest === null ? null : (props.named?.(newest) ?? newest))
})
</script>

<template>
  <div class="chat-row" :class="{ unread: summary.unread > 0, selected }">
    <RouterLink :to="to" class="link" :aria-current="selected ? 'true' : undefined">
      <span v-if="summary.unread > 0" class="visually-hidden">Unread. </span>
      <span class="dot" aria-hidden="true" />
      <span class="avatar">
        <SenderAvatar :sender="{ name, address: summary.chat.jid }" />
        <span class="badge" title="WhatsApp" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1.4-4.2A8 8 0 1112 20a8 8 0 01-3.8-1z" /></svg>
        </span>
      </span>
      <span class="body">
        <span class="top">
          <span class="name" dir="auto">{{ name }}</span><span class="visually-hidden">, WhatsApp, </span>
          <span class="time">{{ shortTime(summary.lastMessageAt) }}</span>
        </span>
        <span class="preview" dir="auto">{{ preview }}</span>
      </span>
    </RouterLink>
  </div>
</template>

<style scoped>
.chat-row {
  display: flex;
  transition: background-color var(--motion-fast) ease;
}
.chat-row:hover {
  background: var(--ground);
}
.chat-row.selected {
  background: var(--selected);
  box-shadow: inset 3px 0 0 var(--focus), var(--glass-edge);
}
.chat-row:has(.link:focus-visible) {
  box-shadow: inset 0 0 0 2px var(--focus);
}
.link {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  /* Lined up with the mail rows, whose checkbox takes the room before the dot. */
  padding: 12px 20px 12px 46px;
  color: var(--ink);
  text-decoration: none;
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
.avatar {
  position: relative;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
}
.badge {
  position: absolute;
  right: -3px;
  bottom: -3px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  box-sizing: border-box;
  border: 2px solid var(--paper);
  border-radius: 999px;
  background: var(--whatsapp);
  color: var(--whatsapp-text);
}
.body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.top {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 15px;
  white-space: nowrap;
  text-overflow: ellipsis;
  unicode-bidi: isolate;
}
.unread .name {
  font-weight: 600;
}
.time {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ink-3);
}
.preview {
  overflow: hidden;
  color: var(--ink-2);
  white-space: nowrap;
  text-overflow: ellipsis;
  unicode-bidi: isolate;
}
</style>
