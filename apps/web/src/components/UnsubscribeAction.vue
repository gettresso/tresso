<script setup lang="ts">
import { ref } from 'vue'
import type { UnsubscribeOffer } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import LogoLoader from '@/components/LogoLoader.vue'

/** One-click unsubscribe for a conversation, as `unsubscribeOffer` describes it: a button, or how far the request got. */
const props = defineProps<{ offer: UnsubscribeOffer | null }>()

const mail = useMailStore()
const compose = useComposeStore()
/** The request is on its way; the offer turns to "pending" once the answer is stored. */
const sending = ref(false)
/** A mailto unsubscribe sends a mail from the user's account: the user sees where it goes and says so first. */
const confirming = ref(false)

async function unsubscribe(): Promise<void> {
  const offer = props.offer
  if (offer?.state !== 'available' || sending.value) {
    return
  }
  if (offer.method === 'mailto' && !confirming.value) {
    confirming.value = true
    return
  }
  confirming.value = false
  sending.value = true
  try {
    await mail.unsubscribe(offer.messageId)
  } catch (error) {
    compose.notify({ text: errorMessage(error), tone: 'error' })
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <span v-if="offer" class="unsubscribe">
    <template v-if="offer.state === 'available' && confirming">
      <small class="confirm">Sends an email saying "unsubscribe" to {{ offer.recipient }} from your account.</small>
      <button type="button" class="button button-quiet action" :aria-label="`Send the unsubscribe email to ${offer.recipient}`" @click="unsubscribe">Send</button>
      <button type="button" class="button button-quiet action" @click="confirming = false">Cancel</button>
    </template>
    <template v-else-if="offer.state === 'available'">
      <button type="button" class="button button-quiet action" :disabled="sending" :aria-label="sending ? undefined : `Unsubscribe from ${offer.sender}`" @click="unsubscribe">
        <template v-if="sending"><LogoLoader tone="current" /> Unsubscribing…</template><template v-else>Unsubscribe</template>
      </button>
      <small v-if="offer.error && !sending" class="failed">The last attempt failed: {{ offer.error }}</small>
    </template>
    <span v-else-if="offer.state === 'pending'" class="chip" role="status"><LogoLoader tone="current" /> Unsubscribing…</span>
    <span v-else class="chip done" role="status">Unsubscribed</span>
  </span>
</template>

<style scoped>
.unsubscribe {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}
.action {
  height: 32px;
  padding: 0 10px;
  font-size: 13px;
}
.confirm {
  font-size: 12px;
  color: var(--ink-2);
}
.failed {
  font-size: 12px;
  color: var(--danger);
}
.chip {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
}
.chip.done {
  background: var(--know-soft);
  color: var(--know);
}
</style>
