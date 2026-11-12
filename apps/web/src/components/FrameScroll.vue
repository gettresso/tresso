<script setup lang="ts">
import { inject } from 'vue'
import { FRAME_STRIP } from '@/components/frame'

/**
 * The part of the sidebar card that scrolls in the desktop shell: between the band of the traffic lights and the toggle
 * above it and the sync status pinned below it (MailboxSidebar.vue). Everywhere else its content stays as it is, with
 * nothing around it, and the whole sidebar scrolls as before.
 */
const strip = inject(FRAME_STRIP, false)
</script>

<template>
  <div v-if="strip" class="frame-scroll"><slot /></div>
  <slot v-else />
</template>
