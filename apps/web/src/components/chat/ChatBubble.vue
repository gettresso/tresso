<script setup lang="ts">
import { replyErrorText, type ChatOutgoingError, type SyncedChatMessage } from '@tresso/core'
import type { MediaState } from '@/stores/chats'
import ChatMediaRow from '@/components/chat/ChatMediaRow.vue'

/** A bubble of the timeline as the chat pane works it out. */
export interface BubbleView {
  key: string
  /** Sent from this account (a reply from Tresso, or a message typed on the phone). */
  mine: boolean
  /** The text as written (line breaks kept); empty for a file without text. */
  text: string
  /** The message, when it carries a file. */
  media: SyncedChatMessage | null
  /** A group sender's name above the first of their bubbles in a row, in their colour. */
  sender: { label: string; tone: number } | null
  /** Under the text: `10:02`, `10:02, sent`, `Not sent, tap to retry`. */
  meta: string
  /** A reply's state; `none` for a message from the bridge's store. */
  state: 'none' | 'waiting' | 'sending' | 'sent' | 'failed' | 'unconfirmed'
  error: ChatOutgoingError | null
  /** The reply's id, for its actions. */
  outgoingId: string | null
  /** What a screen reader calls it: sender, time and state. */
  label: string
  /** Follows a bubble of the same sender: closer to it. */
  grouped: boolean
}

/** `mediaRemote`: files stay on the relaying Mac (the browser), so file rows offer no download. */
defineProps<{ bubble: BubbleView; mediaState?: MediaState; busy?: boolean; mediaRemote?: boolean }>()
const emit = defineEmits<{ retry: []; cancel: []; download: []; open: [] }>()
</script>

<template>
  <li class="item" :class="{ mine: bubble.mine, grouped: bubble.grouped }">
    <div class="bubble" role="group" :aria-label="bubble.label">
      <span v-if="bubble.sender" class="sender" :class="`sender-${bubble.sender.tone}`" dir="auto">{{ bubble.sender.label }}</span>
      <ChatMediaRow v-if="bubble.media" :message="bubble.media" :state="mediaState ?? { state: 'idle' }" :remote="mediaRemote" @download="emit('download')" @open="emit('open')" />
      <span v-if="bubble.text" class="text" dir="auto">{{ bubble.text }}</span>
      <button v-if="bubble.state === 'failed'" type="button" class="meta failed" :disabled="busy" @click="emit('retry')">{{ bubble.meta }}</button>
      <span v-else class="meta" :class="{ waiting: bubble.state === 'waiting', unconfirmed: bubble.state === 'unconfirmed' }">{{ bubble.meta }}</span>
    </div>
    <div v-if="bubble.state === 'failed' || bubble.state === 'unconfirmed'" class="under">
      <span class="why" :class="{ unconfirmed: bubble.state === 'unconfirmed' }">{{ bubble.error === null ? '' : replyErrorText(bubble.error) }}</span>
      <button type="button" class="button button-quiet small" :disabled="busy" @click="emit('retry')">Try again</button>
      <button type="button" class="button button-quiet small" :disabled="busy" @click="emit('cancel')">Delete</button>
    </div>
    <div v-else-if="bubble.state === 'waiting'" class="under">
      <button type="button" class="button button-quiet small" :disabled="busy" @click="emit('cancel')">Cancel</button>
    </div>
  </li>
</template>

<style scoped>
.item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin-top: 10px;
}
.item.grouped {
  margin-top: 4px;
}
.item.mine {
  align-items: flex-end;
}
.bubble {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: min(70%, 560px);
  padding: 10px 14px;
  border: 1px solid var(--bubble-theirs-edge);
  border-radius: 14px 14px 14px 4px;
  background: var(--bubble-theirs);
  color: var(--ink);
}
.mine .bubble {
  border-color: transparent;
  border-radius: 14px 14px 4px 14px;
  background: var(--bubble-mine);
}
.sender {
  font-size: 12px;
  font-weight: 700;
  unicode-bidi: isolate;
}
.sender-0 {
  color: var(--sender-0);
}
.sender-1 {
  color: var(--sender-1);
}
.sender-2 {
  color: var(--sender-2);
}
.sender-3 {
  color: var(--sender-3);
}
.sender-4 {
  color: var(--sender-4);
}
.sender-5 {
  color: var(--sender-5);
}
.text {
  font-size: 15px;
  line-height: 22px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  unicode-bidi: isolate;
}
.meta {
  align-self: flex-end;
  font-size: 11px;
  color: var(--bubble-meta);
}
.meta.waiting {
  color: var(--delegate);
  font-weight: 600;
}
.meta.unconfirmed,
.meta.failed {
  color: var(--danger);
  font-weight: 600;
}
button.meta {
  padding: 0;
  border: 0;
  background: none;
  font-family: inherit;
  text-decoration: underline;
  cursor: pointer;
}
button.meta:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.under {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 4px 8px;
  max-width: min(70%, 560px);
  margin-top: 4px;
}
.item:not(.mine) .under {
  justify-content: flex-start;
}
.why {
  flex: 1 1 100%;
  font-size: 12px;
  color: var(--danger);
  text-align: right;
}
.small {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  font-size: 12px;
}
@media (max-width: 760px) {
  .bubble,
  .under {
    max-width: 85%;
  }
  .small {
    min-height: 44px;
  }
}
</style>
