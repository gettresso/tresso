<script setup lang="ts">
/** A short list of things being done in order: done ones ticked, the current one turning, the rest waiting. */
defineProps<{ labels: string[]; stage: number }>()
</script>

<template>
  <ol class="checks">
    <li v-for="(label, index) in labels" :key="label" :class="{ done: index < stage, running: index === stage, pending: index > stage }">
      <span class="icon" aria-hidden="true">
        <span v-if="index < stage" class="tick"
          ><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg
        ></span>
        <svg v-else-if="index === stage" class="spin" width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" class="track" stroke-width="3" />
          <path d="M21 12a9 9 0 00-9-9" class="arc" stroke-width="3" stroke-linecap="round" />
        </svg>
        <span v-else class="dot" />
      </span>
      <span class="label">{{ label }}</span>
      <span class="visually-hidden">{{ index < stage ? '(done)' : index === stage ? '(in progress)' : '(waiting)' }}</span>
    </li>
  </ol>
</template>

<style scoped>
.checks {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  font-size: 15px;
}
.icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
}
.tick {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: var(--know-soft);
  color: var(--know);
}
.track {
  stroke: var(--line-strong);
}
.arc {
  stroke: var(--focus);
}
.spin {
  animation: checks-spin 0.9s linear infinite;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--line-strong);
}
.running .label {
  font-weight: 600;
}
.pending .label {
  color: var(--ink-3);
}
@keyframes checks-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
