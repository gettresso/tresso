<script setup lang="ts">
import { computed } from 'vue'
import { NOTICES, type ChatNoticeKind } from '@/components/chat/chatTexts'

/** What keeps a chat from coming in or going out, at the top of the chat (the WhatsAppStates board's banner). */
const props = defineProps<{ kind: ChatNoticeKind; busy?: boolean }>()
const emit = defineEmits<{ act: [] }>()
const notice = computed(() => NOTICES[props.kind])
</script>

<template>
  <div class="notice" role="status">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path v-if="kind === 'unlinked'" d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
      <template v-else><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></template>
    </svg>
    <span class="text"><strong>{{ notice.title }}</strong> {{ notice.body }}</span>
    <button type="button" class="button button-quiet action" :disabled="busy" @click="emit('act')">{{ notice.action }}</button>
  </div>
</template>

<style scoped>
.notice {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 12px;
  padding: 12px 20px;
  background: var(--delegate-soft);
  color: var(--ink);
}
.notice svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--delegate);
}
.text {
  flex: 1 1 240px;
  font-size: 13px;
  line-height: 19px;
}
.action {
  flex: none;
  height: 32px;
  border: 1px solid var(--line-strong);
}
</style>
