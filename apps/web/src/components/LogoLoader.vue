<script setup lang="ts">
/**
 * The Tresso loader: the three parts of the mark step out in turn (do, hand over, know) and settle back.
 * Decorative only: the text next to it says what is loading. `tone="current"` draws it in the text color, for use
 * on buttons and other filled surfaces where the brand colors would lack contrast.
 */
withDefaults(defineProps<{ size?: number | string; tone?: 'brand' | 'current' }>(), { size: '1.25em', tone: 'brand' })
</script>

<template>
  <svg class="logo-loader" :class="tone" :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect class="bar do" x="3" y="4" width="8.5" height="5" rx="2.5" />
    <rect class="bar delegate" x="12.5" y="4" width="8.5" height="5" rx="2.5" />
    <rect class="bar know" x="9.5" y="10.5" width="5" height="10" rx="2.5" />
  </svg>
</template>

<style scoped>
.logo-loader {
  display: inline-block;
  flex: none;
  overflow: visible;
  vertical-align: -0.3em;
}
.bar {
  opacity: 0.35;
  animation: 2.4s cubic-bezier(0.65, 0, 0.35, 1) infinite both;
}
.do {
  fill: #2341d6;
  animation-name: out-left;
}
.delegate {
  fill: #e0701b;
  animation-name: out-right;
  animation-delay: 0.8s;
}
.know {
  fill: #2f9c86;
  animation-name: out-down;
  animation-delay: 1.6s;
}
@media (prefers-color-scheme: dark) {
  .do {
    fill: #8fa2ff;
  }
  .delegate {
    fill: #f29a55;
  }
  .know {
    fill: #6cc7b2;
  }
}
.current .bar {
  fill: currentColor;
}
@keyframes out-left {
  0%,
  36%,
  100% {
    opacity: 0.35;
    transform: translateX(0);
  }
  12%,
  22% {
    opacity: 1;
    transform: translateX(-1.5px);
  }
}
@keyframes out-right {
  0%,
  36%,
  100% {
    opacity: 0.35;
    transform: translateX(0);
  }
  12%,
  22% {
    opacity: 1;
    transform: translateX(1.5px);
  }
}
@keyframes out-down {
  0%,
  36%,
  100% {
    opacity: 0.35;
    transform: translateY(0);
  }
  12%,
  22% {
    opacity: 1;
    transform: translateY(1.5px);
  }
}
@keyframes glow {
  0%,
  40%,
  100% {
    opacity: 0.35;
  }
  15%,
  25% {
    opacity: 1;
  }
}
/* Nothing moves: the parts only light up in turn, slower. */
@media (prefers-reduced-motion: reduce) {
  .bar {
    animation-name: glow;
    animation-duration: 3.6s;
  }
  .delegate {
    animation-delay: 1.2s;
  }
  .know {
    animation-delay: 2.4s;
  }
}
</style>
