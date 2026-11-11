<script setup lang="ts" generic="T extends string">
import KeyShortcut from '@/components/KeyShortcut.vue'

export interface Segment<V extends string> {
  value: V
  label: string
  /** The key that chooses it, shown as a keycap. */
  keys?: string
  /** A class for the segment, for a look of its own when chosen (the answers to an invitation). */
  tone?: string
}

/**
 * One choice among a few, side by side: the brief's grouping, the calendar's view, the answer to an invitation.
 * "radio" is a choice that is always made (a radio group); "pressed" is a set of buttons, the current one pressed.
 */
const props = withDefaults(defineProps<{ label: string; options: Segment<T>[]; selected: T | null; mode?: 'radio' | 'pressed'; disabled?: boolean }>(), {
  mode: 'pressed',
  disabled: false,
})
const emit = defineEmits<{ choose: [value: T] }>()
</script>

<template>
  <div class="segmented" :role="props.mode === 'radio' ? 'radiogroup' : 'group'" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="segment"
      :class="option.tone"
      :role="props.mode === 'radio' ? 'radio' : undefined"
      :aria-checked="props.mode === 'radio' ? (selected === option.value ? 'true' : 'false') : undefined"
      :aria-pressed="props.mode === 'pressed' ? (selected === option.value ? 'true' : 'false') : undefined"
      :aria-keyshortcuts="option.keys"
      :disabled="disabled"
      @click="emit('choose', option.value)"
    >
      {{ option.label }} <KeyShortcut v-if="option.keys" :keys="option.keys" />
    </button>
  </div>
</template>

<style scoped>
.segmented {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: calc(var(--radius-control) + 2px);
  background: var(--ground);
}
.segment {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  font: 600 13px var(--font-ui);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    box-shadow var(--motion-fast) ease,
    transform var(--motion-fast) var(--ease-out);
}
.segment:hover:not(:disabled) {
  background: var(--surface);
  color: var(--ink);
}
.segment:active:not(:disabled) {
  transform: scale(0.97);
}
.segment[aria-pressed='true'],
.segment[aria-checked='true'] {
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 1px 2px rgb(22 24 29 / 8%);
}
.segment:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.segment:disabled {
  opacity: 0.55;
  cursor: default;
}
/* Touch size on a phone. */
@media (max-width: 760px) {
  .segment {
    height: 44px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .segment:active:not(:disabled) {
    transform: none;
  }
}
</style>
