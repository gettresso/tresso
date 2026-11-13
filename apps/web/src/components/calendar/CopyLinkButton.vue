<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { displayLink } from '@tresso/core'
import AppIcon from '@/components/AppIcon.vue'

/**
 * "Copy link" for a meeting link: puts the whole link on the clipboard on a click, and only then, reads "Copied" with
 * a check for 2 seconds, and says "Link copied" once to a screen reader. When the browser refuses the clipboard the
 * whole link is shown, selectable, to copy by hand (as ApprovalLink does). The link never goes into a message or a log.
 */
const props = defineProps<{
  url: string
  /** 30 px high, for a row in a list. */
  compact?: boolean
}>()

const copied = ref(false)
const failed = ref(false)
/** The polite announcement: set by a click only, so a re-render never repeats it. */
const announcement = ref('')
let timer: ReturnType<typeof setTimeout> | null = null
/** False once unmounted: the clipboard answers later, and no timer may be set for a button that is gone. */
let alive = true

async function copy(): Promise<void> {
  failed.value = false
  try {
    await navigator.clipboard.writeText(props.url)
  } catch {
    if (!alive) return
    // No clipboard (not a secure page) or no permission: the link stays on screen to copy by hand.
    copied.value = false
    failed.value = true
    return
  }
  if (!alive) return
  copied.value = true
  // Emptied first, so a second copy within the 2 seconds is announced again.
  announcement.value = ''
  await nextTick()
  if (!alive) return
  announcement.value = 'Link copied'
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    copied.value = false
    announcement.value = ''
    timer = null
  }, 2000)
}

onBeforeUnmount(() => {
  alive = false
  if (timer !== null) clearTimeout(timer)
  timer = null
})
</script>

<template>
  <button type="button" class="button copy-link" :class="{ compact }" @click="copy">
    <AppIcon v-if="copied" name="check" :size="14" class="done" />
    <AppIcon v-else name="copy" :size="14" />
    {{ copied ? 'Copied' : 'Copy link' }}
  </button>
  <span class="visually-hidden" role="status" aria-live="polite">{{ announcement }}</span>
  <p v-if="failed" class="copy-failed" role="alert">
    The link could not be copied. Select it and copy it by hand.
    <span class="full-link" dir="ltr">{{ displayLink(url) }}</span>
  </p>
</template>

<style scoped>
.copy-link {
  flex: none;
  gap: 6px;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.copy-link.compact {
  height: 30px;
}
.done {
  color: var(--know);
}
.copy-failed {
  flex-basis: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
.full-link {
  max-height: 120px;
  overflow-y: auto;
  unicode-bidi: isolate;
  color: var(--ink);
  font: 400 12px var(--font-mono);
  overflow-wrap: anywhere;
  user-select: all;
}
</style>
