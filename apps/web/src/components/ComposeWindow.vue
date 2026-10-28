<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useComposeStore } from '@/stores/compose'
import ComposeForm from '@/components/ComposeForm.vue'

const compose = useComposeStore()
// The window keeps showing its draft while it animates away after the store let go of it (sent, closed, discarded).
const draft = shallowRef(compose.draft)
watch(
  () => compose.draft,
  (next) => {
    if (next !== null) {
      draft.value = next
    }
  },
)

// Minimizing and expanding settle with a short rise, so the window does not just jump to its new size.
const root = ref<HTMLElement | null>(null)
watch(
  () => compose.minimized,
  () => {
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      root.value?.animate?.([{ opacity: 0.7, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' })
    }
  },
)

const title = computed(() => {
  switch (draft.value?.kind) {
    case 'reply':
    case 'replyAll':
      return 'Reply'
    case 'forward':
      return 'Forward'
    default:
      return 'New message'
  }
})
const savedText = computed(() =>
  compose.savedAt === null ? '' : `Draft saved ${new Date(compose.savedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
)
</script>

<template>
  <section v-if="draft" ref="root" class="compose" :class="{ minimized: compose.minimized }" role="dialog" :aria-label="title" @keydown.esc="compose.close()">
    <header class="bar">
      <h2>{{ title }}</h2>
      <span class="saved" aria-live="polite">{{ savedText }}</span>
      <button type="button" class="icon" :aria-label="compose.minimized ? 'Expand' : 'Minimize'" @click="compose.minimized = !compose.minimized">
        {{ compose.minimized ? '▴' : '▾' }}
      </button>
      <button type="button" class="icon" aria-label="Close and keep the draft" @click="compose.close()">×</button>
    </header>
    <div v-if="compose.conflict" class="conflict" role="alert">
      <span>This draft was changed on another device while you were writing here.</span>
      <button type="button" class="button button-quiet" @click="compose.resolveConflict('theirs')">Use the other version</button>
      <button type="button" class="button button-primary" @click="compose.resolveConflict('mine')">Keep this one</button>
    </div>
    <ComposeForm v-show="!compose.minimized" :key="`${draft.id}:${compose.revision}`" :draft="draft" />
  </section>
</template>

<style scoped>
.compose {
  animation: rise-in var(--motion-base) var(--ease-out);
  position: fixed;
  right: 24px;
  bottom: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  width: min(640px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  border-radius: var(--radius-panel) var(--radius-panel) 0 0;
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: var(--raised);
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--line);
}
.bar h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.saved {
  flex: 1;
  font-size: 12px;
  color: var(--ink-3);
}
.icon {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
  font-size: 16px;
}
.icon:hover {
  background: var(--ground);
}
.conflict {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--delegate-soft);
}
.conflict span {
  flex: 1 1 220px;
}
.minimized {
  width: 320px;
}
@media (max-width: 760px) {
  .compose {
    inset: 0;
    width: 100%;
    max-height: none;
    border-radius: 0;
  }
}
</style>
