<script setup lang="ts">
import { inject } from 'vue'
import { FRAME_STRIP, FRAME_TITLE_TARGET } from '@/components/frame'

/**
 * A view's title. In the desktop shell it goes into the title strip, in the frame's size (assets/frame.css);
 * everywhere else it is the same h1 in the same place as before, with the attributes the view gives it.
 *
 * `framedOnly`: a title the strip shows but the view has no heading for in the browser (Search), or whose heading is
 * content of its own (Triage's subject); outside the desktop shell nothing is rendered. `tag` is the strip's element
 * for it: an h1, or a `p` where the view keeps its own h1.
 */
defineOptions({ inheritAttrs: false })
withDefaults(defineProps<{ framedOnly?: boolean; tag?: 'h1' | 'p' }>(), { framedOnly: false, tag: 'h1' })
const strip = inject(FRAME_STRIP, false)
</script>

<template>
  <Teleport v-if="strip" defer :to="FRAME_TITLE_TARGET">
    <component :is="tag" v-bind="$attrs"><slot /></component>
  </Teleport>
  <h1 v-else-if="!framedOnly" v-bind="$attrs"><slot /></h1>
</template>
