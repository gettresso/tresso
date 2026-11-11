<script setup lang="ts">
import { computed } from 'vue'
import type { Address } from '@tresso/core'

const props = defineProps<{ sender: Address; size?: number }>()

// Neutral-leaning tints (--avatar-N tokens in main.css, deep fills with light letters in the dark theme); color
// carries no meaning here, it only tells people apart.
const TINTS = 5

const initials = computed(() => {
  const source = props.sender.name?.trim() || props.sender.address
  const words = source.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
  const letters = words.length > 1 ? (words[0]![0] ?? '') + (words[words.length - 1]![0] ?? '') : source.slice(0, 2)

  return letters.toUpperCase()
})

const tint = computed(() => {
  let hash = 0
  for (const char of props.sender.address.toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }

  return hash % TINTS
})
</script>

<template>
  <span
    class="avatar"
    :class="`tint-${tint}`"
    aria-hidden="true"
    :style="{ width: `${size ?? 40}px`, height: `${size ?? 40}px`, fontSize: `${Math.round((size ?? 40) / 3)}px` }"
    >{{ initials }}</span
  >
</template>

<style scoped>
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 999px;
  font-weight: 700;
}
.tint-0 {
  background: var(--avatar-0-fill);
  color: var(--avatar-0-text);
}
.tint-1 {
  background: var(--avatar-1-fill);
  color: var(--avatar-1-text);
}
.tint-2 {
  background: var(--avatar-2-fill);
  color: var(--avatar-2-text);
}
.tint-3 {
  background: var(--avatar-3-fill);
  color: var(--avatar-3-text);
}
.tint-4 {
  background: var(--avatar-4-fill);
  color: var(--avatar-4-text);
}
</style>
