<script setup lang="ts">
import { computed } from 'vue'
import { useUpdatesStore } from '@/stores/updates'

/** Windows and Linux: a newer release, offered where it does not get in the way (macOS shows Sparkle's window). */
const updates = useUpdatesStore()

const shown = computed(() => {
  const found = updates.update
  if (updates.channel !== 'tauri' || found === null) {
    return false
  }
  if (updates.phase === 'downloading' || updates.phase === 'installing' || updates.phase === 'failed') {
    return true
  }
  return updates.phase === 'available' && updates.dismissed !== found.version
})
const percent = computed(() => (updates.progress === null ? null : Math.round(updates.progress * 100)))
</script>

<template>
  <Transition name="fade">
    <aside v-if="shown && updates.update" class="update" role="status" aria-live="polite" aria-labelledby="update-title">
      <p id="update-title" class="title">Tresso {{ updates.update.version }} is available</p>
      <p v-if="updates.version" class="detail">You have {{ updates.version }}.</p>
      <p v-if="updates.update.body" class="notes">{{ updates.update.body }}</p>
      <template v-if="updates.phase === 'downloading' || updates.phase === 'installing'">
        <div
          class="bar"
          role="progressbar"
          :aria-valuenow="percent ?? undefined"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="updates.phase === 'installing' ? 'Installing' : 'Downloading'"
        >
          <span :class="{ unknown: percent === null }" :style="percent === null ? undefined : { width: `${percent}%` }" />
        </div>
        <p v-if="updates.error" class="error" role="alert">{{ updates.error }}</p>
        <p v-else class="detail">{{ updates.phase === 'installing' ? 'Installing, Tresso restarts in a moment…' : percent === null ? 'Downloading…' : `Downloading… ${percent}%` }}</p>
      </template>
      <template v-else>
        <p v-if="updates.error" class="error" role="alert">{{ updates.error }}</p>
        <div class="actions">
          <button type="button" class="button button-primary" @click="updates.install()">{{ updates.phase === 'failed' ? 'Try again' : 'Install and relaunch' }}</button>
          <button type="button" class="button button-quiet" @click="updates.later()">Later</button>
        </div>
      </template>
    </aside>
  </Transition>
</template>

<style scoped>
/* Top right: the compose window and notices own the bottom edge. */
.update {
  animation: slide-down-in var(--motion-base) var(--ease-out);
  position: fixed;
  top: calc(var(--titlebar, 0px) + 16px);
  right: 16px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(360px, calc(100vw - 48px));
  padding: 16px;
  border-radius: var(--radius-panel);
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: var(--raised);
}
.title {
  margin: 0;
  font-weight: 700;
}
.detail,
.notes {
  margin: 0;
  color: var(--ink-2);
  font-size: 13px;
}
.notes {
  max-height: 96px;
  overflow-y: auto;
  white-space: pre-line;
}
.error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.bar {
  height: 6px;
  border-radius: 999px;
  background: var(--ground);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--focus);
  transition: width var(--motion-base) var(--ease-out);
}
.bar span.unknown {
  width: 30%;
  animation: indeterminate 1.2s ease-in-out infinite;
}
@keyframes indeterminate {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(340%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .bar span.unknown {
    width: 100%;
    animation: none;
    opacity: 0.5;
  }
}
</style>
