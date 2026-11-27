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

<style scoped>
/*
 * The rows fade out at both ends of the scroller instead of ending in a hard line under the top band and above the sync
 * status (the glass sidebar board, on glass and without it). A mask, so it costs nothing while the list sits still and
 * needs no script. The fade is as long as the scroller's own padding (--frame-scroll-inset, assets/frame.css): at rest
 * the first and the last row sit just past it, and a row the keyboard brings into view stops that far from the edge
 * (scroll-padding), so its focus ring is never faded.
 */
.frame-scroll {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 var(--frame-scroll-inset), #000 calc(100% - var(--frame-scroll-inset)), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 var(--frame-scroll-inset), #000 calc(100% - var(--frame-scroll-inset)), transparent 100%);
}
</style>
