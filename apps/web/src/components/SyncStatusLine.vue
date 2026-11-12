<script setup lang="ts">
import { computed } from 'vue'
import type { SyncStatus, SyncStatusKind } from '@tresso/core'
import LogoLoader from '@/components/LogoLoader.vue'

/**
 * The sync status at the foot of the sidebar (see describeSync): one line of text, the loader while something is under
 * way, and a thin progress line when the fraction is known. Screen readers hear the status through a polite live
 * region that changes with the kind and every quarter of progress, not with every percent.
 */
const props = defineProps<{ status: SyncStatus }>()

const BUSY: SyncStatusKind[] = ['opening', 'updating', 'firstSync', 'catchingUp', 'connecting', 'reconnecting']
const busy = computed(() => BUSY.includes(props.status.kind))
const tone = computed(() => (props.status.kind === 'live' ? 'on' : props.status.kind === 'error' ? 'problem' : null))
</script>

<template>
  <div class="sync-status" :class="[tone, status.kind]">
    <p v-if="status.text !== ''" class="line"><LogoLoader v-if="busy" size="12" class="loader" />{{ status.text }}</p>
    <div v-if="status.fraction !== null" class="progress" aria-hidden="true">
      <span class="fill" :style="{ transform: `scaleX(${status.fraction})` }" />
    </div>
    <p class="visually-hidden" role="status" aria-live="polite">{{ status.announcement }}</p>
  </div>
</template>

<style scoped>
.sync-status {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 10px;
}
.line {
  margin: 0;
  font-size: 12px;
  color: var(--ink-3);
}
.on .line::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 999px;
  background: var(--know);
  vertical-align: middle;
}
.problem .line {
  color: var(--danger);
  font-weight: 600;
}
.loader {
  margin-right: 6px;
  vertical-align: -1px;
}
.progress {
  height: 2px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
}
.fill {
  display: block;
  height: 100%;
  background: var(--do);
  transform-origin: left center;
  transition: transform var(--motion-base) var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .fill {
    transition: none;
  }
}
</style>
