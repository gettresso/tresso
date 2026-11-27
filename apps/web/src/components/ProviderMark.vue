<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { PROVIDER_MARKS, type ProviderKind } from './providerMarks'

/**
 * The mark of a mail account or WhatsApp (the "Icons and marks" section of the building blocks board). `brand`: the mark
 * in its own colour on a `--tile`, as in Settings. `ink`: the mark alone in the second ink, as in the sidebar. A mail
 * server account has no brand and shows the mail icon in the second ink in both tones. Always hidden from assistive
 * technology: the account's name stands next to it.
 */
const props = withDefaults(defineProps<{ kind: ProviderKind; /** The tile in `brand`, the mark itself in `ink`. */ size?: number; tone?: 'brand' | 'ink' }>(), { tone: 'brand' })

const brand = computed(() => (props.kind === 'mail' ? null : PROVIDER_MARKS[props.kind]))
/** The board draws a 36 tile; the sidebar's ink mark is 16. */
const outer = computed(() => props.size ?? (props.tone === 'brand' ? 36 : 16))
/** On the board an 18 mark sits on a 36 tile with radius 10; other sizes keep those proportions. */
const glyph = computed(() => Math.round(outer.value / 2))
const radius = computed(() => Math.round((outer.value * 10) / 36))
</script>

<template>
  <span v-if="tone === 'brand'" class="provider-mark tile" :class="kind" :style="{ width: `${outer}px`, height: `${outer}px`, borderRadius: `${radius}px` }" aria-hidden="true">
    <svg v-if="brand" :width="glyph" :height="glyph" viewBox="0 0 24 24" aria-hidden="true"><path :d="brand.path" :fill="brand.color" /></svg>
    <AppIcon v-else name="mail" :size="glyph" />
  </span>
  <svg v-else-if="brand" class="provider-mark ink" :class="kind" :width="outer" :height="outer" viewBox="0 0 24 24" aria-hidden="true"><path :d="brand.path" fill="currentColor" /></svg>
  <AppIcon v-else class="provider-mark ink" :class="kind" name="mail" :size="outer" />
</template>

<style scoped>
.provider-mark {
  flex-shrink: 0;
}
.tile {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--tile);
}
/* The mail icon is a line icon: the second ink in both tones, as is the ink tone of every mark. */
.tile.mail,
.ink {
  color: var(--ink-2);
}
/* Microsoft's grey (#5E5E5E) fails contrast on the dark tile; the board gives it the dark theme's second ink there. */
@media (prefers-color-scheme: dark) {
  .tile.microsoft path {
    fill: #b5bbc6;
  }
}
</style>
