<script setup lang="ts">
import { computed } from 'vue'
import { useUpdatesStore } from '@/stores/updates'

/**
 * Windows and Linux: a newer release, offered where it does not get in the way (macOS shows Sparkle's window). On
 * every desktop it also says when the restart into an update waits for files on their way or a message being sent.
 */
const updates = useUpdatesStore()

const waiting = computed(() => updates.phase === 'waiting')
/** macOS: Sparkle's relaunch is held because the draft could not be saved. */
const held = computed(() => updates.channel === 'sparkle' && updates.error !== null)
const shown = computed(() => {
  if (waiting.value) {
    return updates.channel !== 'none'
  }
  if (held.value) {
    return true
  }
  const found = updates.update
  if (updates.channel !== 'tauri' || found === null) {
    return false
  }
  if (updates.phase === 'downloading' || updates.phase === 'installing' || updates.phase === 'failed') {
    return true
  }
  return (updates.phase === 'available' || updates.phase === 'ready') && updates.dismissed !== found.version
})
const title = computed(() => {
  const found = updates.update?.version
  if (waiting.value || held.value || updates.phase === 'ready') {
    return found === undefined || updates.channel !== 'tauri' ? 'The update is ready' : `Tresso ${found} is ready`
  }
  return `Tresso ${found ?? ''} is available`
})
const waitingText = computed(() =>
  updates.waitingFor === 'sending'
    ? 'Tresso restarts once your message is on its way.'
    : updates.waitingFor === 'deleting'
      ? 'Tresso restarts once the draft is deleted.'
      : 'Tresso restarts once your files are attached, so they are not lost.',
)
/** The release notes as plain text: the feed has them as Markdown, under a "What's new" heading. */
const notes = computed(() =>
  (updates.update?.body ?? '')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .trim(),
)
const percent = computed(() => (updates.progress === null ? null : Math.round(updates.progress * 100)))
</script>

<template>
  <Transition name="fade">
    <aside v-if="shown" class="update" role="status" aria-live="polite" aria-labelledby="update-title">
      <p id="update-title" class="title">{{ title }}</p>
      <template v-if="waiting">
        <p class="detail">{{ waitingText }}</p>
        <div class="actions">
          <button type="button" class="button button-quiet" @click="updates.restartNow()">Restart now</button>
          <button type="button" class="button button-quiet" @click="updates.later()">Later</button>
        </div>
      </template>
      <template v-else-if="held">
        <p class="error" role="alert">{{ updates.error }}</p>
        <div class="actions">
          <button type="button" class="button button-primary" @click="updates.checkNow(true)">Try again</button>
          <button type="button" class="button button-quiet" @click="updates.later()">Later</button>
        </div>
      </template>
      <template v-else-if="updates.update">
        <p v-if="updates.version" class="detail">You have {{ updates.version }}.</p>
        <p v-if="notes" class="notes">{{ notes }}</p>
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
            <button type="button" class="button button-primary" @click="updates.install()">
              {{ updates.phase === 'failed' ? 'Try again' : updates.phase === 'ready' ? 'Restart to update' : 'Install and relaunch' }}
            </button>
            <button type="button" class="button button-quiet" @click="updates.later()">Later</button>
          </div>
        </template>
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
