<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { SyncedChatMessage } from '@tresso/core'
import type { MediaState } from '@/stores/chats'
import AppIcon from '@/components/AppIcon.vue'
import { mediaRetry, mediaStateText, mediaTitle, serverMediaView, UNSCANNED_WARNING } from '@/components/chat/chatTexts'

/**
 * The file a message carries (the WhatsAppInbox board's picture row, plan 6.7): an icon by kind (there is no thumbnail
 * before a download), the kind and size or a document's name, and what can be done: Download, Open once Tresso has
 * its own checked copy, Try again after a failure that may pass. A voice message gets no play control and no length.
 *
 * `server` ("All my devices", a device other than the relaying Mac): the file is asked for from that Mac and opened
 * from the server once it was checked for malware (serverMediaView); `note` is what the last action said. A file that
 * could not be checked opens only after the user confirms the warning. `disabled`: asking is held (writesHeld).
 */
const props = defineProps<{ message: SyncedChatMessage; state: MediaState; server?: boolean; relayOnline?: boolean; note?: string | null; disabled?: boolean }>()
const emit = defineEmits<{ download: []; open: []; openUnscanned: [] }>()

const icon = computed(() => (props.message.mediaKind === 'image' ? 'image' : props.message.mediaKind === 'video' ? 'video' : props.message.mediaKind === 'audio' ? 'know' : 'attachment'))
const title = computed(() => mediaTitle(props.message))
const view = computed(() => (props.server ? serverMediaView(props.message, props.relayOnline ?? false) : null))
const line = computed(() => props.note ?? view.value?.line ?? mediaStateText(props.message, props.state))
const failed = computed(() => (view.value === null ? props.state.state === 'failed' : view.value.failed || !!props.note))

/**
 * "Download anyway" asks first, in the row (as leaving a chat out does): an alertdialog with the warning, the focus on
 * Cancel, Escape to cancel. The browser's own confirm is not used: Enter would accept it, and the desktop webview has
 * none of its own. Closing it (Cancel, Escape, accepting) puts the focus back on the row's button; when the file's state
 * changes meanwhile (no longer one that asks), the dialog closes the same way.
 */
const confirming = ref(false)
const row = ref<HTMLElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const anyway = ref<HTMLButtonElement | null>(null)

/** The focus back in the row: on "Download anyway" while it is there, else on the row's other button, else the row. */
async function focusRow(): Promise<void> {
  await nextTick()
  const target = anyway.value ?? row.value?.querySelector<HTMLButtonElement>('button.action:not([disabled])') ?? row.value
  target?.focus()
}

watch(
  () => view.value?.action,
  (action) => {
    if (confirming.value && action !== 'confirm') {
      confirming.value = false
      void focusRow()
    }
  },
)

async function askUnscanned(): Promise<void> {
  confirming.value = true
  await nextTick()
  cancelButton.value?.focus()
}

async function closeConfirm(): Promise<void> {
  confirming.value = false
  await focusRow()
}

async function acceptUnscanned(): Promise<void> {
  confirming.value = false
  emit('openUnscanned')
  await focusRow()
}
</script>

<template>
  <span ref="row" class="media" :class="{ failed }" tabindex="-1">
    <span class="icon" aria-hidden="true">
      <svg v-if="message.mediaKind === 'audio'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3z" />
        <path d="M5 11a7 7 0 0014 0M12 18v3" />
      </svg>
      <AppIcon v-else :name="icon" />
    </span>
    <span class="text">
      <span class="title" dir="auto">{{ title }}</span>
      <!-- Said as it changes: politely for a new state (Ready to open, Checking for malware), at once for a failure. -->
      <span class="line" :role="failed ? 'alert' : 'status'" :aria-live="failed ? 'assertive' : 'polite'">{{ line }}</span>
    </span>
    <template v-if="view">
      <button v-if="view.action === 'download'" type="button" class="button button-quiet action" :disabled="disabled" @click="emit('download')"><AppIcon name="download" :size="14" /> Download</button>
      <button v-else-if="view.action === 'retry'" type="button" class="button button-quiet action" :disabled="disabled" @click="emit('download')">Try again</button>
      <button v-else-if="view.action === 'open'" type="button" class="button button-quiet action" @click="emit('open')">Open</button>
      <button v-else-if="view.action === 'confirm'" ref="anyway" type="button" class="button button-quiet action" :disabled="confirming" @click="askUnscanned">Download anyway</button>
      <button v-else-if="view.pending" type="button" class="button button-quiet action" disabled aria-busy="true">{{ view.pending }}</button>
    </template>
    <template v-else>
      <button v-if="state.state === 'idle'" type="button" class="button button-quiet action" @click="emit('download')"><AppIcon name="download" :size="14" /> Download</button>
      <button v-else-if="state.state === 'downloading'" type="button" class="button button-quiet action" disabled aria-busy="true">Downloading</button>
      <button v-else-if="state.state === 'done'" type="button" class="button button-quiet action" @click="emit('open')">Open</button>
      <button v-else-if="state.state === 'failed' && mediaRetry(state.reason)" type="button" class="button button-quiet action" @click="emit('download')">
        Try again
      </button>
    </template>
  </span>
  <span
    v-if="confirming"
    class="confirm"
    role="alertdialog"
    :aria-labelledby="`chat-unscanned-${message.id}`"
    @keydown.esc.prevent="closeConfirm"
  >
    <span :id="`chat-unscanned-${message.id}`" class="confirm-text">{{ UNSCANNED_WARNING }}</span>
    <span class="confirm-actions">
      <button type="button" class="button button-danger" @click="acceptUnscanned">Download anyway</button>
      <button ref="cancelButton" type="button" class="button button-quiet" @click="closeConfirm">Cancel</button>
    </span>
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
.confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
  padding: 10px;
  border-radius: 8px;
  background: var(--ground);
  font-size: 12px;
}
.confirm-actions {
  display: flex;
  gap: 8px;
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
