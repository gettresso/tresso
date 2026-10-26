<script setup lang="ts">
import type { ParticipationStatus } from '@tresso/core'
import type { Response } from '@/stores/calendar'

/** Accept, Maybe, Decline: the answer to an invitation, with the current one pressed. */
defineProps<{ current: ParticipationStatus | null; busy?: boolean; label: string; shortcuts?: boolean }>()
const emit = defineEmits<{ respond: [response: Response] }>()

const OPTIONS: { value: Response; label: string; key: string }[] = [
  { value: 'accepted', label: 'Accept', key: 'Y' },
  { value: 'tentative', label: 'Maybe', key: 'M' },
  { value: 'declined', label: 'Decline', key: 'N' },
]
</script>

<template>
  <div class="responses" role="group" :aria-label="label">
    <button
      v-for="option in OPTIONS"
      :key="option.value"
      type="button"
      class="response"
      :class="option.value"
      :aria-pressed="current === option.value ? 'true' : 'false'"
      :disabled="busy"
      @click="emit('respond', option.value)"
    >
      {{ option.label }}<kbd v-if="shortcuts">{{ option.key }}</kbd>
    </button>
  </div>
</template>

<style scoped>
/* One segmented control: calm until answered, then the answer takes its colour (yes green, maybe neutral, no red). */
.responses {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: calc(var(--radius-control) + 2px);
  background: var(--ground);
}
.response {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 72px;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  font: 600 13px var(--font-ui);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    box-shadow var(--motion-fast) ease,
    transform var(--motion-fast) var(--ease-out);
}
.response:hover:not(:disabled) {
  background: var(--surface);
  color: var(--ink);
}
.response:active:not(:disabled) {
  transform: scale(0.97);
}
.response[aria-pressed='true'] {
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 1px 2px rgb(22 24 29 / 8%);
}
.response.accepted[aria-pressed='true'] {
  background: var(--know-soft);
  color: var(--know);
}
.response.declined[aria-pressed='true'] {
  background: var(--danger-soft);
  color: var(--danger);
}
.response:disabled {
  opacity: 0.55;
  cursor: default;
}
kbd {
  font: 500 11px var(--font-mono);
  opacity: 0.7;
}
@media (prefers-reduced-motion: reduce) {
  .response:active:not(:disabled) {
    transform: none;
  }
}
</style>
