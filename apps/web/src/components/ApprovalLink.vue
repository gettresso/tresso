<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

/**
 * The link where an organization's administrator approves Tresso, with a button that copies it: the user cannot
 * approve it themselves and passes it on. Shown by the connect dialog and by the accounts page, wherever a provider
 * sign-in comes back asking for that approval.
 */
const props = defineProps<{ url: string }>()

const copied = ref(false)
const failed = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

async function copy(): Promise<void> {
  failed.value = false
  try {
    await navigator.clipboard.writeText(props.url)
  } catch {
    // The browser refused the clipboard (no permission, not focused): the link stays on screen to copy by hand.
    failed.value = true
    return
  }
  copied.value = true
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    copied.value = false
    timer = null
  }, 2000)
}

onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)
})
</script>

<template>
  <div class="approval-link">
    <span class="url">{{ url }}</span>
    <button type="button" class="button copy" @click="copy">{{ copied ? 'Copied' : 'Copy link' }}</button>
  </div>
  <p v-if="failed" class="copy-failed" role="alert">The link could not be copied. Select it and copy it by hand.</p>
</template>

<style scoped>
.approval-link {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 18px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
}
.url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font: 400 13px var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: all;
}
.button.copy {
  flex-shrink: 0;
  height: 34px;
  padding: 0 14px;
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
  font-size: 13px;
}
.copy-failed {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
</style>
