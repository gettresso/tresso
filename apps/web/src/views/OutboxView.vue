<script setup lang="ts">
import { ref } from 'vue'
import type { SyncedOutgoingMessage } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'

const mail = useMailStore()
const compose = useComposeStore()
const busy = ref<string | null>(null)

const statusText: Record<SyncedOutgoingMessage['status'], string> = {
  scheduled: 'Scheduled',
  queued: 'Sending',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Not sent',
  cancelled: 'Cancelled',
}

function recipients(message: SyncedOutgoingMessage): string {
  return [...message.recipients.to, ...message.recipients.cc, ...message.recipients.bcc].map((r) => r.name || r.address).join(', ')
}

async function cancel(message: SyncedOutgoingMessage): Promise<void> {
  busy.value = message.id
  try {
    await mail.cancelOutgoing(message.id)
    const draft = await compose.draftFor(message.id)
    compose.notify(
      draft
        ? { text: 'Cancelled.', tone: 'info', action: { label: 'Open the draft', run: () => void compose.openDraft(draft.id) } }
        : { text: 'Cancelled.', tone: 'info' },
    )
  } catch (e) {
    compose.notify({ text: errorMessage(e), tone: 'error' })
  } finally {
    busy.value = null
  }
}

async function edit(message: SyncedOutgoingMessage): Promise<void> {
  const draft = await compose.draftFor(message.id)
  if (draft) {
    await compose.openDraft(draft.id)
  } else {
    compose.notify({ text: 'The draft of this message was written on another device.', tone: 'info' })
  }
}
</script>

<template>
  <main class="outbox">
    <h1>Outbox</h1>
    <p class="lead">Mail that is scheduled, on its way, or could not be sent.</p>
    <p v-if="mail.outbox.length === 0" class="lead">Nothing waiting.</p>
    <ul class="list">
      <li v-for="message in mail.outbox" :key="message.id" class="item" :class="message.status">
        <div class="text">
          <span class="subject">{{ message.subject || '(no subject)' }}</span>
          <span class="to">To {{ recipients(message) }}</span>
          <span class="when">
            {{ statusText[message.status] }}
            <template v-if="message.status === 'scheduled'">
              for {{ new Date(message.sendAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }}</template
            >
          </span>
          <span v-if="message.lastError" class="error">{{ message.lastError }}</span>
        </div>
        <button v-if="message.status === 'scheduled' || message.status === 'queued'" type="button" class="button button-quiet" :disabled="busy === message.id" @click="cancel(message)">Cancel</button>
        <button v-if="message.status === 'failed'" type="button" class="button button-primary" @click="edit(message)">Edit and send again</button>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.outbox {
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
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--surface);
}
.item.failed {
  border-color: var(--danger);
}
.text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.subject {
  font-weight: 600;
}
.to,
.when {
  font-size: 13px;
  color: var(--ink-2);
}
.error {
  font-size: 13px;
  color: var(--danger);
}
</style>
