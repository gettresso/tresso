<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { SyncedChatAccount } from '@tresso/core'
import { relayNotice } from '@/components/chat/chatTexts'

/**
 * In the browser: what the relaying Mac's state means for the chats (the WhatsAppStates board's banner, relayNotice),
 * from the chat account's row. Nothing can be done about it here, so it has no action: the Mac has to run, its bridge
 * to run and be linked. The time is read again every minute, so `since 23:50` becomes a date after midnight. `quiet`:
 * another notice on screen says the same (the chat pane next to the list), so this one is no live region.
 */
const props = defineProps<{ account: Pick<SyncedChatAccount, 'relayOnline' | 'relayOfflineSince' | 'bridge' | 'link'>; quiet?: boolean }>()

const now = ref(new Date())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  clock = setInterval(() => (now.value = new Date()), 60_000)
})
onBeforeUnmount(() => {
  if (clock !== null) clearInterval(clock)
})
const notice = computed(() => relayNotice(props.account, now.value))
</script>

<template>
  <div v-if="notice" class="relay-notice" :role="quiet ? undefined : 'status'">
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
