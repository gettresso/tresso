<script setup lang="ts">
import { ref } from 'vue'
import { fileSize, SCAN_TEXT, type DraftAttachment } from '@tresso/core'
import AppIcon from '@/components/AppIcon.vue'
import LogoLoader from '@/components/LogoLoader.vue'

defineProps<{ attachments: DraftAttachment[]; attaching: string[] }>()
const emit = defineEmits<{ open: [id: string]; openUnscanned: [id: string]; remove: [id: string] }>()

/** A file that could not be scanned opens only after the user confirms the warning, once per click. */
const confirming = ref<string | null>(null)

function open(attachment: DraftAttachment): void {
  if (attachment.scanStatus === 'failed') {
    confirming.value = confirming.value === attachment.id ? null : attachment.id
    return
  }
  emit('open', attachment.id)
}

function openAnyway(id: string): void {
  confirming.value = null
  emit('openUnscanned', id)
}
</script>

<template>
  <ul v-if="attachments.length > 0 || attaching.length > 0" class="attachments" aria-label="Attachments">
    <li v-for="attachment in attachments" :key="attachment.id" class="attachment" :class="{ blocked: attachment.scanStatus === 'infected' }">
      <span class="icon"><AppIcon :name="attachment.scanStatus === 'infected' ? 'blocked' : attachment.scanStatus === 'failed' ? 'shieldAlert' : 'attachment'" /></span>
      <span class="text">
        <button
          type="button"
          class="name"
          :disabled="attachment.scanStatus === 'infected' || attachment.scanStatus === 'pending'"
          :aria-expanded="attachment.scanStatus === 'failed' ? confirming === attachment.id : undefined"
          @click="open(attachment)"
        >
          {{ attachment.filename }}
        </button>
        <span class="detail">{{ fileSize(attachment.size) }}, {{ SCAN_TEXT[attachment.scanStatus] }}</span>
        <span v-if="confirming === attachment.id" class="confirm">
          Not checked for malware.
          <button type="button" class="confirm-link" @click="openAnyway(attachment.id)">Open anyway</button>
        </span>
      </span>
      <button type="button" class="remove" :aria-label="`Remove ${attachment.filename}`" @click="emit('remove', attachment.id)">
        <AppIcon name="close" />
      </button>
    </li>
    <li v-for="(name, index) in attaching" :key="`attaching-${index}`" class="attachment attaching" aria-busy="true">
      <span class="icon"><LogoLoader /></span>
      <span class="text">
        <span class="name">{{ name }}</span>
        <span class="detail">Attaching…</span>
      </span>
    </li>
  </ul>
</template>

<style scoped>
.confirm {
  font-size: 12px;
  color: var(--ink);
}
.confirm-link {
  margin-left: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--focus);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.attachment {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 280px;
  max-width: 100%;
  padding: 8px 6px 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
}
.icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-control);
  background: var(--ground);
  color: var(--ink-2);
  flex-shrink: 0;
}
.blocked .icon {
  background: var(--danger-soft);
  color: var(--danger);
}
.text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.name {
  overflow: hidden;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
button.name:disabled {
  cursor: default;
}
.detail {
  color: var(--ink-2);
  font-size: 12px;
}
.blocked .detail {
  color: var(--danger);
}
.remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--ink-2);
  cursor: pointer;
}
.remove:hover {
  background: var(--ground);
}
.attaching {
  opacity: 0.7;
}
</style>
