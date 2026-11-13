<script setup lang="ts">
import { computed } from 'vue'
import type { SyncedChatMessage } from '@tresso/core'
import type { MediaState } from '@/stores/chats'
import AppIcon from '@/components/AppIcon.vue'
import { mediaRetry, mediaStateText, mediaTitle } from '@/components/chat/chatTexts'

/**
 * The file a message carries (the WhatsAppInbox board's picture row, plan 6.7): an icon by kind (there is no thumbnail
 * before a download), the kind and size or a document's name, and what can be done: Download, Open once Tresso has
 * its own checked copy, Try again after a failure that may pass. A voice message gets no play control and no length.
 */
const props = defineProps<{ message: SyncedChatMessage; state: MediaState }>()
const emit = defineEmits<{ download: []; open: [] }>()

const icon = computed(() => (props.message.mediaKind === 'image' ? 'image' : props.message.mediaKind === 'video' ? 'video' : props.message.mediaKind === 'audio' ? 'know' : 'attachment'))
const title = computed(() => mediaTitle(props.message))
const line = computed(() => mediaStateText(props.message, props.state))
const failed = computed(() => props.state.state === 'failed')

</script>

<template>
  <span class="media" :class="{ failed }">
    <span class="icon" aria-hidden="true">
      <svg v-if="message.mediaKind === 'audio'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3z" />
        <path d="M5 11a7 7 0 0014 0M12 18v3" />
      </svg>
      <AppIcon v-else :name="icon" />
    </span>
    <span class="text">
      <span class="title" dir="auto">{{ title }}</span>
      <span class="line" :role="failed ? 'alert' : undefined">{{ line }}</span>
    </span>
    <button v-if="state.state === 'idle'" type="button" class="button button-quiet action" @click="emit('download')"><AppIcon name="download" :size="14" /> Download</button>
    <button v-else-if="state.state === 'downloading'" type="button" class="button button-quiet action" disabled aria-busy="true">Downloading</button>
    <button v-else-if="state.state === 'done'" type="button" class="button button-quiet action" @click="emit('open')">Open</button>
    <button v-else-if="state.state === 'failed' && mediaRetry(state.reason)" type="button" class="button button-quiet action" @click="emit('download')">
      Try again
    </button>
  </span>
</template>

<style scoped>
.media {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border-radius: 8px;
  background: var(--ground);
}
.icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  background: var(--know-soft);
  color: var(--know);
}
.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.title {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
  unicode-bidi: isolate;
}
.line {
  font-size: 12px;
  color: var(--bubble-meta);
}
.failed .line {
  color: var(--danger);
}
.action {
  flex: none;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  font-size: 12px;
  font-weight: 600;
}
</style>
