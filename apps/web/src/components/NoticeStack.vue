<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useComposeStore } from '@/stores/compose'
import { collapseLeave } from '@/components/listMotion'

const compose = useComposeStore()
const now = ref(Date.now())
const timer = setInterval(() => (now.value = Date.now()), 250)
onBeforeUnmount(() => clearInterval(timer))

/** A notice that goes slides back toward the edge it came from and folds shut, so the ones above settle down. */
function leave(element: Element, done: () => void): void {
  collapseLeave(element, done, -16)
}
</script>

<template>
  <TransitionGroup tag="div" class="notices" aria-live="polite" :css="false" @leave="leave">
    <div v-if="compose.undoable" key="undo" class="notice">
      <span>Sending in {{ Math.max(0, Math.ceil((compose.undoable.until - now) / 1000)) }} s</span>
      <button type="button" class="action" @click="compose.undo()">Undo</button>
    </div>
    <div v-for="notice in compose.notices" :key="notice.id" class="notice" :class="notice.tone" :role="notice.tone === 'error' ? 'alert' : 'status'">
      <span>{{ notice.text }}</span>
      <button
        v-if="notice.action"
        type="button"
        class="action"
        @click="
          () => {
            notice.action?.run()
            compose.dismiss(notice.id)
          }
        "
      >
        {{ notice.action.label }}
      </button>
      <button type="button" class="close" aria-label="Dismiss" @click="compose.dismiss(notice.id)">×</button>
    </div>
  </TransitionGroup>
</template>

<style scoped>
.notices {
  position: fixed;
  left: 24px;
  bottom: 24px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(480px, calc(100vw - 48px));
}
.notice {
  animation: rise-in var(--motion-base) var(--ease-out);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px 10px 16px;
  border-radius: var(--radius-card);
  /* Dark glass: the page shows through, blurred, while the text keeps its contrast. */
  background: color-mix(in srgb, var(--ink) 82%, transparent);
  color: var(--paper);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 14%), 0 12px 32px rgb(22 24 29 / 22%);
}
@media (prefers-reduced-transparency: reduce) {
  .notice {
    background: var(--ink);
  }
  .notice.error {
    background: var(--danger);
  }
}
html.reduce-transparency .notice {
  background: var(--ink);
}
html.reduce-transparency .notice.error {
  background: var(--danger);
}
.notice span {
  flex: 1;
}
.notice.error {
  background: color-mix(in srgb, var(--danger) 88%, transparent);
  color: #fff;
}
.action {
  border: 0;
  background: none;
  color: inherit;
  font-weight: 700;
  text-decoration: underline;
  cursor: pointer;
}
.close {
  border: 0;
  background: none;
  color: inherit;
  font-size: 16px;
  cursor: pointer;
  opacity: 0.8;
}
</style>
