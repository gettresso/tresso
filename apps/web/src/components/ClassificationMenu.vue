<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { openHandOversOf, spamOverruleNotice, VERDICTS, verdictLabel, type Verdict } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { useComposeStore } from '@/stores/compose'
import { useHandOversStore } from '@/stores/handOvers'
import { useMailStore } from '@/stores/mail'
import AppIcon from '@/components/AppIcon.vue'
import VerdictChip from '@/components/VerdictChip.vue'

/**
 * The verdict and smart inbox of a conversation, and the menu to change them. A change is remembered for the sender,
 * so their next mail lands the same way.
 */
const props = defineProps<{
  threadId: string
  subject: string
  smartInboxId: string | null
  verdict: Verdict | null
  /** Also show the smart inbox's name next to the verdict. */
  showSmartInbox?: boolean
}>()

const mail = useMailStore()
const compose = useComposeStore()
const handOvers = useHandOversStore()
const open = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const menu = ref<HTMLElement | null>(null)
const button = ref<HTMLButtonElement | null>(null)

const smartInbox = computed(() => mail.smartInboxes.find((candidate) => candidate.id === props.smartInboxId) ?? null)
const label = computed(() => {
  const where = smartInbox.value?.name ?? 'no smart inbox'
  const verdict = props.verdict === null ? 'no verdict' : verdictLabel(props.verdict)

  return `${verdict}, in ${where}. Change where ${props.subject || '(no subject)'} belongs`
})

async function show(): Promise<void> {
  open.value = true
  error.value = null
  await nextTick()
  menu.value?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus()
}

function close(): void {
  open.value = false
  button.value?.focus()
}

async function choose(smartInboxId: string, verdict?: Verdict): Promise<void> {
  open.value = false
  busy.value = true
  error.value = null
  try {
    const result = await mail.classifyThread(props.threadId, smartInboxId, verdict)
    // An app-wide notice: in a smart inbox the row (and this menu with it) leaves the list as soon as it moves.
    const notice = spamOverruleNotice(result)
    if (notice !== null) {
      compose.notify({ text: notice, tone: 'info' }, 12_000)
    }
    // Judged something to hand over: the hand-over itself is one click away.
    const judged = verdict ?? mail.smartInboxes.find((candidate) => candidate.id === smartInboxId)?.verdict
    if (judged === 'delegate' && props.verdict !== 'delegate' && openHandOversOf(mail.handOvers, props.threadId).length === 0) {
      const threadId = props.threadId
      compose.notify({ text: `${props.subject || '(no subject)'} is for someone else.`, tone: 'info', action: { label: 'Hand over', run: () => void handOvers.openForThread(threadId) } }, 12_000)
    }
  } catch (e) {
    error.value = `Could not move it: ${errorMessage(e)}`
  } finally {
    busy.value = false
  }
}

/** A verdict alone keeps the smart inbox; a conversation without one goes to the first smart inbox with that verdict. */
function chooseVerdict(verdict: Verdict): void {
  const target = smartInbox.value ?? mail.smartInboxes.find((candidate) => candidate.verdict === verdict) ?? mail.smartInboxes[0]
  if (target !== undefined) {
    void choose(target.id, verdict)
  }
}

function keydown(event: KeyboardEvent): void {
  const items = [...(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const focus = (next: number) => items[(next + items.length) % items.length]?.focus()
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      focus(index + 1)
      break
    case 'ArrowUp':
      event.preventDefault()
      focus(index - 1)
      break
    case 'Home':
      event.preventDefault()
      focus(0)
      break
    case 'End':
      event.preventDefault()
      focus(items.length - 1)
      break
    case 'Escape':
    case 'Tab':
      event.preventDefault()
      close()
      break
  }
}

function outside(event: MouseEvent): void {
  const target = event.target as Node | null
  if (open.value && target !== null && !menu.value?.contains(target) && !button.value?.contains(target)) {
    open.value = false
  }
}
onMounted(() => document.addEventListener('mousedown', outside))
onBeforeUnmount(() => document.removeEventListener('mousedown', outside))
</script>

<template>
  <div class="classification" @keydown.esc.stop="open && close()">
    <button
      ref="button"
      type="button"
      class="trigger"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="label"
      :disabled="busy || mail.smartInboxes.length === 0"
      @click="open ? close() : show()"
    >
      <VerdictChip v-if="verdict !== null" :verdict="verdict" />
      <span v-else class="unclassified">Not sorted</span>
      <span v-if="showSmartInbox && smartInbox" class="smart-inbox">{{ smartInbox.name }}</span>
      <AppIcon name="chevron" :size="14" />
    </button>
    <div v-if="open" ref="menu" class="menu" role="menu" aria-label="Where this belongs" @keydown="keydown">
      <div role="group" aria-label="Verdict" class="group">
        <span class="group-title" aria-hidden="true">Verdict</span>
        <button
          v-for="option in VERDICTS"
          :key="option"
          type="button"
          role="menuitemradio"
          tabindex="-1"
          class="item"
          :aria-checked="option === verdict"
          @click="chooseVerdict(option)"
        >
          <AppIcon :name="option" :size="16" /> {{ verdictLabel(option) }}
        </button>
      </div>
      <div role="group" aria-label="Move to smart inbox" class="group">
        <span class="group-title" aria-hidden="true">Move to</span>
        <button
          v-for="candidate in mail.smartInboxes"
          :key="candidate.id"
          type="button"
          role="menuitemradio"
          tabindex="-1"
          class="item"
          :aria-checked="candidate.id === smartInboxId"
          @click="choose(candidate.id)"
        >
          {{ candidate.name }} <span class="item-verdict">{{ verdictLabel(candidate.verdict) }}</span>
        </button>
      </div>
      <p class="note">Tresso remembers this for the sender's next mail.</p>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.classification {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
}
.trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 2px 4px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
}
.trigger:hover:not(:disabled) {
  background: var(--ground);
}
.trigger:disabled {
  cursor: default;
  opacity: 0.7;
}
.unclassified,
.smart-inbox {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.menu {
  transform-origin: top right;
  animation: pop-in var(--motion-fast) var(--ease-out);
  position: absolute;
  top: 32px;
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 240px;
  max-height: 360px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: var(--raised);
}
.group {
  display: flex;
  flex-direction: column;
}
.group-title {
  padding: 6px 12px 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-3);
}
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
}
.item[aria-checked='true'] {
  font-weight: 600;
}
.item:hover,
.item:focus {
  background: var(--selected);
}
.item:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.item-verdict {
  margin-left: auto;
  font-size: 12px;
  color: var(--ink-3);
}
.note {
  margin: 0;
  padding: 6px 12px 8px;
  font-size: 12px;
  color: var(--ink-2);
}
.error {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--danger);
}
</style>
