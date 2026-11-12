<script setup lang="ts">
import { inject } from 'vue'
import { FRAME_STRIP } from '@/components/frame'

/**
 * A group of toolbar actions drawn as one capsule in the desktop shell's title strip (assets/frame.css); everywhere else
 * the actions stay as they are, with nothing around them.
 */
const strip = inject(FRAME_STRIP, false)
</script>

<template>
  <div v-if="strip" class="frame-capsule"><slot /></div>
  <slot v-else />
</template>
