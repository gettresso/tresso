<script setup lang="ts">
import type { RelayNotice } from '@/components/chat/chatTexts'

/**
 * In the browser: what the relaying Mac's state means for the chats (the WhatsAppStates board's banner, relayNotice).
 * Nothing can be done about it here, so it has no action: the Mac has to run, its bridge to run and be linked.
 */
defineProps<{ notice: RelayNotice }>()
</script>

<template>
  <div class="relay-notice" role="status">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
    <span class="text"><strong>{{ notice.title }}</strong> {{ notice.body }}</span>
  </div>
</template>

<style scoped>
.relay-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px 12px;
  padding: 12px 20px;
  background: var(--delegate-soft);
  color: var(--ink);
}
.relay-notice svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--delegate);
}
.text {
  flex: 1 1 240px;
  font-size: 13px;
  line-height: 19px;
}
</style>
