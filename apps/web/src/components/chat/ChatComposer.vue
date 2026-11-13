<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { CHAT_REPLY_MAX, replyText } from '@tresso/core'
import KeyShortcut from '@/components/KeyShortcut.vue'
import { COMPOSER_NOTE, COUNTER_FROM } from '@/components/chat/chatTexts'
import { composing } from '@/components/chat/composition'

/**
 * The reply box (the WhatsAppInbox board's composer): Attach a file, a text field that grows to six lines, Send with
 * Enter (Shift+Enter makes a new line). Blank text is not sent; the rule for a valid reply is core's replyText, the
 * one the queue and the server hold too. From 3,900 characters a counter says how many of 4,096 are used. What
 * happens to a reply (sending, sent, not sent) is said in the live region, `announcement`.
 */
const props = defineProps<{
  /** Queues the text; resolves true once it is queued (the field is then emptied). */
  send: (text: string) => Promise<boolean>
  /** Replies cannot be written now; `note` says why (a notice above says more). */
  disabled: boolean
  note?: string | null
  /** Who sends the reply, under the field (COMPOSER_NOTE on the Mac that sends). */
  sendNote?: string
  /** Attach is offered. */
  canAttach: boolean
  /** Why Attach cannot be used here, said next to it; null when it can. */
  attachNote?: string | null
  attaching: boolean
  /** The line about a file being sent or not sent. */
  attachLine?: string | null
  /** The latest change of a reply's state, for screen readers. */
  announcement: string
  /** Why the last send failed, in plain words. */
  error?: string | null
  /** Labels the field: `Reply to <chat>`. */
  label: string
  /** What was typed into this chat before and not sent (chats.draftOf); the field starts with it. */
  draft?: string
}>()
const emit = defineEmits<{ attach: []; 'update:draft': [text: string] }>()

const MAX_LINES = 6
const LINE_HEIGHT = 22
const text = ref(props.draft ?? '')
const sending = ref(false)
const field = ref<HTMLTextAreaElement | null>(null)

const length = computed(() => [...text.value.trim()].length)
const checked = computed(() => replyText(text.value))
const tooLong = computed(() => !checked.value.ok && checked.value.problem === 'too_long')
const showCounter = computed(() => length.value >= COUNTER_FROM)
const counter = computed(() => `${length.value.toLocaleString('en')} of ${CHAT_REPLY_MAX.toLocaleString('en')} characters`)
const canSend = computed(() => !props.disabled && !sending.value && checked.value.ok)

/** The field grows with its text, up to six lines; then it scrolls. */
function grow(): void {
  const element = field.value
  if (element === null) {
    return
  }
  element.style.height = 'auto'
  const padding = 16
  element.style.height = `${Math.min(element.scrollHeight, MAX_LINES * LINE_HEIGHT + padding)}px`
}
watch(text, (value) => {
  emit('update:draft', value)
  void nextTick(grow)
})
onMounted(() => void nextTick(grow))

async function submit(): Promise<void> {
  if (!canSend.value) {
    return
  }
  sending.value = true
  try {
    if (await props.send(text.value)) {
      text.value = ''
    }
  } finally {
    sending.value = false
    await nextTick()
    field.value?.focus()
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !composing(event) && !event.altKey && !event.metaKey && !event.ctrlKey) {
    event.preventDefault()
    void submit()
  }
}

defineExpose({ focus: () => field.value?.focus() })
</script>

<template>
  <form class="composer" novalidate @submit.prevent="submit">
    <div class="row">
      <button
        v-if="canAttach"
        type="button"
        class="attach"
        aria-label="Attach a file"
        :title="attachNote ?? 'Attach a file'"
        :aria-describedby="attachNote ? 'chat-attach-note' : undefined"
        :disabled="disabled || attaching || !!attachNote"
        @click="emit('attach')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 11.5l-8 8a5 5 0 01-7-7l8.5-8.5a3.3 3.3 0 014.7 4.7L9.7 17.2a1.7 1.7 0 01-2.4-2.4l7.5-7.5" />
        </svg>
      </button>
      <textarea
        ref="field"
        v-model="text"
        rows="1"
        class="field"
        dir="auto"
        :aria-label="label"
        :aria-describedby="showCounter ? 'chat-composer-counter chat-composer-note' : 'chat-composer-note'"
        :aria-invalid="tooLong ? 'true' : undefined"
        :disabled="disabled"
        @keydown="onKeydown"
      />
      <button type="submit" class="button button-primary send" :disabled="!canSend">Send <KeyShortcut keys="Enter" /></button>
    </div>
    <span v-if="showCounter" id="chat-composer-counter" class="counter" :class="{ over: tooLong }">{{ counter }}</span>
    <span v-if="checked.ok === false && checked.problem === 'control'" class="problem">The reply cannot contain control characters.</span>
    <span class="attach-line" role="status">{{ attachLine ?? '' }}</span>
    <span v-if="error" class="problem" role="alert">{{ error }}</span>
    <span v-if="canAttach && attachNote" id="chat-attach-note" class="note">{{ attachNote }}</span>
    <span id="chat-composer-note" class="note">{{ disabled && note ? note : (sendNote ?? COMPOSER_NOTE) }}</span>
    <span class="visually-hidden" role="status">{{ announcement }}</span>
  </form>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 24px 18px;
  border-top: 1px solid var(--line);
}
.row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.attach {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
}
.attach:hover:not(:disabled) {
  background: var(--ground);
  color: var(--ink);
}
.attach:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.attach:disabled {
  opacity: 0.5;
  cursor: default;
}
.field {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  box-sizing: border-box;
  padding: 8px 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-card);
  background: var(--paper);
  color: var(--ink);
  font: 400 15px/22px var(--font-ui);
  resize: none;
  overflow-y: auto;
}
.field:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.field:disabled {
  opacity: 0.6;
}
.send {
  flex: none;
  height: 40px;
}
.attach-line:empty {
  display: none;
}
.counter,
.note,
.attach-line {
  font-size: 12px;
  color: var(--ink-2);
}
.counter.over,
.problem {
  font-size: 12px;
  color: var(--danger);
  font-weight: 600;
}
@media (max-width: 760px) {
  .composer {
    padding: 12px 16px;
  }
  .attach,
  .send {
    min-height: 44px;
  }
}
</style>
