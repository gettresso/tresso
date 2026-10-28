<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { cleanupSuggestionText, type CleanupSuggestion } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { useBulkStore } from '@/stores/bulk'
import { useMailStore } from '@/stores/mail'
import AppIcon from '@/components/AppIcon.vue'

/**
 * What to clean up, from fixed rules over the user's mail: each suggestion says what it found and why, with one button
 * that does it (and an undo in the notice afterwards).
 */
const mail = useMailStore()
const bulk = useBulkStore()

const suggestions = ref<CleanupSuggestion[] | null>(null)
const loadError = ref<string | null>(null)
const shown = computed(() =>
  (suggestions.value ?? []).map((suggestion) => ({
    suggestion,
    text: cleanupSuggestionText(suggestion, mail.smartInboxes.find((item) => item.id === suggestion.smartInboxId)?.name),
  })),
)

async function load(): Promise<void> {
  loadError.value = null
  try {
    suggestions.value = (await bulk.suggestions()).suggestions
  } catch (error) {
    loadError.value = errorMessage(error)
  }
}
onMounted(load)

async function clean(suggestion: CleanupSuggestion): Promise<void> {
  await bulk.start({ ...suggestion.scope, action: suggestion.action })
  await load()
}
</script>

<template>
  <section class="panel" aria-label="Clean up">
    <header class="header">
      <h1>Clean up</h1>
      <p class="subtitle">Suggestions from fixed rules about your mail. Nothing is guessed, and every action can be undone.</p>
    </header>

    <div class="content">
      <p v-if="bulk.progress" class="progress" role="status">
        {{ bulk.progress }}
        <button v-if="bulk.running" type="button" class="button button-quiet stop" @click="bulk.cancel()">Stop</button>
      </p>
      <p v-if="loadError" class="error" role="alert">The suggestions could not be loaded: {{ loadError }}</p>
      <p v-else-if="suggestions === null" class="empty">Looking through your mail…</p>
      <p v-else-if="suggestions.length === 0" class="empty">Nothing to clean up right now.</p>

      <ul v-else class="cards">
        <li v-for="{ suggestion, text } in shown" :key="suggestion.id" class="card">
          <AppIcon :name="suggestion.action === 'trash' ? 'trash' : 'archive'" :size="18" />
          <div class="text">
            <h2>{{ text.title }}</h2>
            <p>{{ text.detail }}</p>
            <RouterLink v-if="suggestion.smartInboxId" :to="{ name: 'smart-inbox-manage', params: { smartInboxId: suggestion.smartInboxId } }" class="more">
              See its senders
            </RouterLink>
          </div>
          <button type="button" class="button outlined" :class="{ danger: suggestion.action === 'trash' }" :disabled="bulk.busy" @click="clean(suggestion)">
            {{ text.button }}
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: var(--glass-edge);
  border-left: 1px solid var(--line);
}
.header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 22px 24px 16px;
  border-bottom: 1px solid var(--line);
}
h1 {
  margin: 0;
  font: 700 28px/34px var(--font-display);
}
.subtitle {
  margin: 0;
  color: var(--ink-2);
}
.content {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 24px 32px;
  overflow-y: auto;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.card {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px 16px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  color: var(--ink-2);
}
.text {
  flex: 1 1 320px;
  min-width: 0;
}
h2 {
  margin: 0 0 2px;
  font-size: 15px;
  color: var(--ink);
}
.text p {
  margin: 0;
}
.more {
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
.outlined {
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--ink);
}
.outlined.danger {
  color: var(--danger);
}
.progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-weight: 600;
  color: var(--ink-2);
}
.error {
  color: var(--danger);
}
.empty {
  color: var(--ink-3);
}
</style>
