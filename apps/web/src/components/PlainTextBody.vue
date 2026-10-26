<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ text: string }>()

// Plain text is rendered as text nodes; only http(s) and mailto links become anchors, built by Vue, never as HTML.
const LINK = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]|mailto:[^\s<>"']+)/gi

const parts = computed(() => {
  const result: { text: string; href: string | null }[] = []
  let last = 0
  for (const match of props.text.matchAll(LINK)) {
    const index = match.index ?? 0
    if (index > last) {
      result.push({ text: props.text.slice(last, index), href: null })
    }
    result.push({ text: match[0], href: match[0] })
    last = index + match[0].length
  }
  if (last < props.text.length) {
    result.push({ text: props.text.slice(last), href: null })
  }

  return result
})
</script>

<template>
  <div class="plain">
    <template v-for="(part, i) in parts" :key="i"
      ><a v-if="part.href" :href="part.href" target="_blank" rel="noopener noreferrer">{{ part.text }}</a
      ><template v-else>{{ part.text }}</template></template
    >
  </div>
</template>

<style scoped>
.plain {
  font-size: 16px;
  line-height: 26px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
