<script setup lang="ts">
import { computed } from 'vue'
import type { ParticipationStatus } from '@tresso/core'
import type { Response } from '@/stores/calendar'
import SegmentedControl, { type Segment } from '@/components/SegmentedControl.vue'

/** Accept, Maybe, Decline: the answer to an invitation, with the current one pressed. */
const props = defineProps<{ current: ParticipationStatus | null; busy?: boolean; label: string; shortcuts?: boolean }>()
const emit = defineEmits<{ respond: [response: Response] }>()

const OPTIONS: { value: Response; label: string; key: string }[] = [
  { value: 'accepted', label: 'Accept', key: 'Y' },
  { value: 'tentative', label: 'Maybe', key: 'M' },
  { value: 'declined', label: 'Decline', key: 'N' },
]

const segments = computed<Segment<Response>[]>(() => OPTIONS.map((option) => ({ value: option.value, label: option.label, keys: props.shortcuts ? option.key : undefined, tone: `response ${option.value}` })))
const selected = computed(() => OPTIONS.find((option) => option.value === props.current)?.value ?? null)
</script>

<template>
  <SegmentedControl class="responses" :label="label" :options="segments" :selected="selected" :disabled="busy" @choose="(response) => emit('respond', response)" />
</template>

<style scoped>
/* Calm until answered, then the answer takes its colour (yes green, maybe neutral, no red). */
.responses :deep(.response) {
  min-width: 72px;
}
.responses :deep(.response.accepted[aria-pressed='true']) {
  background: var(--know-soft);
  color: var(--know);
}
.responses :deep(.response.declined[aria-pressed='true']) {
  background: var(--danger-soft);
  color: var(--danger);
}
</style>
