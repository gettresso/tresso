<script setup lang="ts">
import { inject } from 'vue'
import { FRAME_STRIP, FRAME_TOOLS_TARGET } from '@/components/frame'

/**
 * A view's toolbar actions. In the desktop shell they go to the right of the title strip, in the order the view's
 * groups come; everywhere else they stay where they are, with nothing around them.
 */
const strip = inject(FRAME_STRIP, false)
</script>

<template>
  <Teleport v-if="strip" defer :to="FRAME_TOOLS_TARGET">
    <div class="frame-tools-group"><slot /></div>
  </Teleport>
  <slot v-else />
</template>
