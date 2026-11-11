<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Address, MessageBody, SyncedMessage } from '@tresso/core'
import { fullTime, senderName } from '@/mail/format'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import AppIcon from '@/components/AppIcon.vue'
import AttachmentList from '@/components/AttachmentList.vue'
import InvitationCard from '@/components/InvitationCard.vue'
import MessageFrame from '@/components/MessageFrame.vue'
import PlainTextBody from '@/components/PlainTextBody.vue'
import SenderAvatar from '@/components/SenderAvatar.vue'
import LogoLoader from '@/components/LogoLoader.vue'

const props = defineProps<{ message: SyncedMessage; expanded: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const mail = useMailStore()
const compose = useComposeStore()
const body = ref<MessageBody | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

const recipients = computed(() => {
  const list = (label: string, addresses: Address[]) => (addresses.length === 0 ? null : `${label} ${addresses.map(senderName).join(', ')}`)

  return [list('To', props.message.recipients.to), list('cc', props.message.recipients.cc)].filter(Boolean).join(', ')
})
const files = computed(() => body.value?.attachments.filter((attachment) => !attachment.inline) ?? [])

async function load(allowRemoteContent: boolean): Promise<void> {
  loading.value = true
  error.value = null
  try {
    body.value = await mail.body(props.message.id, allowRemoteContent)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

// A scan verdict changes the message. Reload the body for its attachment states and links when the summary moved,
// or when a file was still being scanned (it may be done while another keeps the summary at pending).
watch(
  () => props.message,
  (message, previous) => {
    if (!props.expanded || body.value === null || loading.value || message.id !== previous.id) {
      return
    }
    const scanning = body.value.attachments.some((attachment) => attachment.scanStatus === 'pending')
    if (message.attachmentScan !== previous.attachmentScan || scanning) {
      void load(body.value.remoteContentLoaded)
    }
  },
)

watch(
  () => [props.expanded, props.message.id] as const,
  ([expanded], previous) => {
    if (previous !== undefined && previous[1] !== props.message.id) {
      body.value = null
    }
    if (expanded && body.value === null && !loading.value) {
      void load(false)
    }
  },
  { immediate: true },
)
</script>

<template>
  <article class="message" :class="{ collapsed: !expanded }">
    <button type="button" class="head" :aria-expanded="expanded" @click="emit('toggle')">
      <SenderAvatar :sender="message.from" :size="36" />
      <span class="who">
        <span class="from">
          {{ senderName(message.from) }}
          <span v-if="message.from.name" class="address">{{ message.from.address }}</span>
        </span>
        <span class="meta">{{ expanded ? recipients : message.snippet }}</span>
      </span>
      <time class="time" :datetime="message.receivedAt">{{ fullTime(message.receivedAt) }}</time>
    </button>

    <div v-if="expanded" class="content">
      <InvitationCard v-if="message.calendarMethod !== null" :message-id="message.id" />
      <p v-if="loading && body === null" class="state" role="status"><LogoLoader /> Loading message…</p>
      <p v-else-if="error" class="state error" role="alert">
        This message could not be loaded. <button type="button" class="link" @click="load(body?.remoteContentLoaded ?? false)">Try again</button>
      </p>

      <div v-if="message.attachmentScan === 'infected'" class="malware" role="alert">
        <AppIcon name="shieldAlert" />
        <span><strong>An attachment contains malware.</strong> We blocked it. Be careful with links and requests in this message.</span>
      </div>

      <template v-if="body">
        <div v-if="body.hasRemoteContent && !body.remoteContentLoaded" class="remote" role="note">
          <AppIcon name="image" />
          <span>Images from the internet are hidden, so the sender cannot see that you opened this message.</span>
          <button type="button" class="button button-quiet" :disabled="loading" @click="load(true)">Show images</button>
        </div>

        <MessageFrame v-if="body.html !== null" :html="body.html" :allow-remote-content="body.remoteContentLoaded" />
        <PlainTextBody v-else-if="body.text !== null" :text="body.text" />
        <p v-else class="state">This message has no text.</p>

        <AttachmentList :attachments="files" />

        <div class="respond">
          <button type="button" class="button button-quiet" @click="compose.openReply(message, 'reply')"><AppIcon name="reply" /> Reply</button>
          <button type="button" class="button button-quiet" @click="compose.openReply(message, 'replyAll')"><AppIcon name="replyAll" /> Reply all</button>
          <button type="button" class="button button-quiet" @click="compose.openReply(message, 'forward')"><AppIcon name="forward" /> Forward</button>
        </div>
      </template>
    </div>
  </article>
</template>

<style scoped>
.malware {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-card);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 13px;
}
.malware svg {
  flex-shrink: 0;
}
.message {
  border-bottom: 1px solid var(--line);
}
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.who {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.from {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.address {
  font-weight: 400;
  color: var(--ink-2);
}
.meta {
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.time {
  font-size: 12px;
  color: var(--ink-2);
  flex-shrink: 0;
}
.content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 0 24px 48px;
}
/* On a phone the mail gets the full width; indenting it under the avatar would leave too little for it. */
@media (max-width: 760px) {
  .content {
    padding-left: 0;
  }
}
.remote {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--ground);
  color: var(--ink-2);
  font-size: 13px;
}
.remote span {
  flex: 1;
}
.respond {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.state {
  margin: 0;
  color: var(--ink-3);
}
.error {
  color: var(--danger);
}
.link {
  border: 0;
  padding: 0;
  background: none;
  color: var(--focus);
  text-decoration: underline;
  cursor: pointer;
}
</style>
