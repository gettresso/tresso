<script setup lang="ts">
import { ref, watch } from 'vue'
import { reducedMotion } from '@/components/calendar/genie'

/** A count that ticks (a short swell) when it changes, so a new unread or a finished todo is noticed in passing. */
const props = defineProps<{ value: number | string }>()
const element = ref<HTMLElement | null>(null)
watch(
  () => props.value,
  () => {
    if (!reducedMotion()) {
      element.value?.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.2)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: 280, easing: 'ease-out' })
    }
  },
)
</script>

<template>
  <span ref="element" class="tick">{{ value }}</span>
</template>

<style scoped>
.tick {
  display: inline-block;
}
</style>
