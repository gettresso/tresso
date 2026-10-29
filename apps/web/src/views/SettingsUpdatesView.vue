<script setup lang="ts">
import { computed } from 'vue'
import { useUpdatesStore } from '@/stores/updates'

/** The desktop app's version, and a check for a newer one: Sparkle's window on macOS, the update card elsewhere. */
const updates = useUpdatesStore()

const status = computed(() => {
  if (updates.phase === 'waiting') {
    return updates.waitingFor === 'sending' ? 'The update is ready. Tresso restarts once your message is on its way.' : 'The update is ready. Tresso restarts once your files are attached.'
  }
  if (updates.channel === 'sparkle') {
    return 'Tresso checks for updates on its own every few hours. Sparkle asks before it installs anything.'
  }
  switch (updates.phase) {
    case 'checking':
      return 'Checking…'
    case 'latest':
      return 'Tresso is up to date.'
    case 'available':
    case 'downloading':
    case 'installing':
      return updates.update ? `Tresso ${updates.update.version} is available.` : null
    case 'ready':
      return updates.update ? `Tresso ${updates.update.version} is downloaded. Restart Tresso to start it.` : null
    default:
      return 'Tresso checks for updates on its own every few hours, and asks before it installs one.'
  }
})
</script>

<template>
  <section class="updates">
    <header>
      <h2>Updates</h2>
      <p v-if="updates.version">You have Tresso {{ updates.version }}.</p>
    </header>
    <template v-if="updates.channel === 'none'">
      <p class="hint">This build does not update itself. Install a release to get updates.</p>
    </template>
    <template v-else>
      <p class="hint" role="status">{{ status }}</p>
      <p v-if="updates.error" class="form-error" role="alert">{{ updates.error }}</p>
      <div class="actions">
        <button
          type="button"
          class="button button-primary"
          :disabled="updates.phase === 'checking' || updates.phase === 'downloading' || updates.phase === 'waiting' || updates.phase === 'installing'"
          @click="updates.checkNow(true)"
        >
          Check for updates
        </button>
        <button v-if="updates.channel === 'tauri' && (updates.phase === 'available' || updates.phase === 'ready')" type="button" class="button button-quiet" @click="updates.install()">
          {{ updates.phase === 'ready' ? 'Restart to update' : 'Install and relaunch' }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.updates {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 640px;
}
h2 {
  margin: 0 0 4px;
  font: 700 22px/28px var(--font-display);
}
header p,
.hint {
  margin: 0;
  color: var(--ink-2);
}
.actions {
  display: flex;
  gap: 8px;
}
</style>
