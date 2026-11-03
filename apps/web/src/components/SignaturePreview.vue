<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { signatureFrameDocument } from '@tresso/core'

/** `app` follows the app's own light or dark look and lets the screen behind show through, as in the compose window. */
const props = defineProps<{ html: string; background: 'light' | 'dark' | 'app' }>()

const frame = ref<HTMLIFrameElement | null>(null)
const height = ref(80)
let observer: ResizeObserver | null = null

const darkQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
const appIsDark = ref(darkQuery?.matches ?? false)
const followScheme = (event: MediaQueryListEvent): void => {
  appIsDark.value = event.matches
}
darkQuery?.addEventListener('change', followScheme)

const scheme = computed(() => (props.background === 'app' ? (appIsDark.value ? 'dark' : 'light') : props.background))
const document = computed(() => signatureFrameDocument(props.html, { background: scheme.value, transparent: props.background === 'app' }))

// Same setup as the message frame: same origin only to measure the height, and without allow-scripts nothing runs.
function measure(): void {
  const root = frame.value?.contentDocument?.documentElement
  if (root) {
    height.value = Math.max(root.scrollHeight, 40)
  }
}

function loaded(): void {
  observer?.disconnect()
  const root = frame.value?.contentDocument?.documentElement
  if (!root) {
    return
  }
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(root)
}

onBeforeUnmount(() => {
  observer?.disconnect()
  darkQuery?.removeEventListener('change', followScheme)
})
</script>

<template>
  <iframe
    ref="frame"
    class="frame"
    :title="`Signature preview on a ${scheme} background`"
    sandbox="allow-same-origin"
    referrerpolicy="no-referrer"
    :srcdoc="document"
    :style="{ height: `${height}px` }"
    @load="loaded"
  />
</template>

<style scoped>
.frame {
  display: block;
  width: 100%;
  border: 0;
}
</style>
