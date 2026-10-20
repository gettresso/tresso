<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { errorMessage } from '@/api/errors'
import type { Draft } from '@/mail/db'
import { senderName, shortTime } from '@/mail/format'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'

const mail = useMailStore()
const compose = useComposeStore()
const drafts = ref<Draft[]>([])
const busy = ref<string | null>(null)

async function load(): Promise<void> {
  // Messages that were sent stay here until their outcome is known; they are not drafts any more.
  drafts.value = (await mail.drafts()).filter((draft) => draft.outgoingId === null)
}

onMounted(load)
watch(() => [mail.conversations, mail.outbox, compose.draft], load)

function recipients(draft: Draft): string {
  const people = [...draft.to, ...draft.cc, ...draft.bcc]
  return people.length === 0 ? 'No recipients yet' : `To ${people.map(senderName).join(', ')}`
}

async function remove(draft: Draft): Promise<void> {
  busy.value = draft.id
  try {
    await mail.deleteDraftEverywhere(draft.id)
    await load()
  } catch (e) {
    compose.notify({ text: errorMessage(e), tone: 'error' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <main class="drafts">
    <h1>Drafts</h1>
    <p class="lead">Messages you started, on every device and in each account's Drafts folder.</p>
    <p v-if="drafts.length === 0" class="lead">No drafts.</p>
    <ul class="list">
      <li v-for="draft in drafts" :key="draft.id" class="item">
        <button type="button" class="open" @click="compose.openDraft(draft.id)">
          <span class="subject">{{ draft.subject || '(no subject)' }}</span>
          <span class="to">{{ recipients(draft) }}</span>
          <span class="when">
            Edited {{ shortTime(draft.updatedAt) }}
            <template v-if="draft.pendingSave"> · not on other devices yet</template>
            <template v-if="draft.remoteVersion !== null"> · changed on another device</template>
          </span>
        </button>
        <button type="button" class="button button-quiet" :disabled="busy === draft.id" @click="remove(draft)">Delete</button>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.drafts {
  max-width: 760px;
  margin: 0 auto;
  padding: 32px 24px;
}
h1 {
  margin: 0 0 4px;
  font: 700 28px/34px var(--font-display);
}
.lead {
  margin: 0 0 16px;
  color: var(--ink-2);
}
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px 4px 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--surface);
}
.open {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.subject {
  font-weight: 600;
}
.to,
.when {
  font-size: 13px;
  color: var(--ink-2);
}
</style>
