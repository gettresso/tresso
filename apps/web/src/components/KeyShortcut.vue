<script setup lang="ts">
import { computed } from 'vue'

/**
 * A keyboard shortcut as keycaps joined by a plus: "Mod+Enter" shows ⌘ + Enter on a Mac and Ctrl + Enter elsewhere.
 * Screen readers hear the keys spelled out once, not the caps and the plus signs.
 */
const props = defineProps<{ keys: string }>()

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

const SHOWN: Record<string, { mac: string; other: string; spoken: string }> = {
  mod: { mac: '⌘', other: 'Ctrl', spoken: mac ? 'Command' : 'Control' },
  shift: { mac: '⇧', other: 'Shift', spoken: 'Shift' },
  alt: { mac: '⌥', other: 'Alt', spoken: mac ? 'Option' : 'Alt' },
  enter: { mac: 'Enter', other: 'Enter', spoken: 'Enter' },
  esc: { mac: 'Esc', other: 'Esc', spoken: 'Escape' },
}

const caps = computed(() =>
  props.keys.split('+').map((key) => {
    const known = SHOWN[key.trim().toLowerCase()]
    const text = known === undefined ? key.trim() : mac ? known.mac : known.other
    return { text, spoken: known?.spoken ?? key.trim(), symbol: /^[⌘⇧⌥]$/.test(text) }
  }),
)
const spoken = computed(() => caps.value.map((cap) => cap.spoken).join('+'))
</script>

<template>
  <kbd class="shortcut">
    <span class="visually-hidden">{{ spoken }}</span>
    <template v-for="(cap, index) in caps" :key="index">
      <span v-if="index > 0" class="shortcut-plus" aria-hidden="true">+</span>
      <span class="shortcut-key" :class="{ symbol: cap.symbol }" aria-hidden="true">{{ cap.text }}</span>
    </template>
  </kbd>
</template>
