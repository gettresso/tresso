<script setup lang="ts">
import { computed } from 'vue'

/**
 * A QR code from the bridge (BridgeState.qr: one string of `0` light and `1` dark per row, quiet zone included), drawn
 * as one SVG path of dark squares on white. It stays dark on light in both themes: a phone cannot read a code drawn
 * light on dark. Rows that are not a square of 0 and 1 draw nothing (the parent says the code could not be shown).
 */
const props = withDefaults(defineProps<{ rows: readonly string[]; label: string; size?: number }>(), { size: 232 })

const side = computed(() => props.rows.length)
const valid = computed(() => side.value >= 21 && props.rows.every((row) => row.length === side.value && /^[01]+$/.test(row)))

/** One `h` run per stretch of dark modules in a row: far fewer path commands than a square per module. */
const path = computed(() => {
  if (!valid.value) {
    return ''
  }
  const parts: string[] = []
  props.rows.forEach((row, y) => {
    for (const run of row.matchAll(/1+/g)) {
      parts.push(`M${run.index} ${y}h${run[0].length}v1h-${run[0].length}z`)
    }
  })
  return parts.join('')
})

defineExpose({ valid })
</script>

<template>
  <svg
    v-if="valid"
    class="qr"
    role="img"
    :aria-label="label"
    :width="size"
    :height="size"
    :viewBox="`0 0 ${side} ${side}`"
    shape-rendering="crispEdges"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect width="100%" height="100%" fill="#ffffff" />
    <path :d="path" fill="#000000" />
  </svg>
</template>

<style scoped>
.qr {
  display: block;
  flex-shrink: 0;
  border-radius: 8px;
  /* The code keeps its own white and black in dark mode; the outline only marks its edge on a light page. */
  outline: 1px solid var(--line);
}
</style>
