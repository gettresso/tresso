<script setup lang="ts">
import { computed } from 'vue'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import QrCode from './QrCode.vue'
import { linkText, LINK_NOTE } from './whatsappTexts'

/**
 * Linking the bridge to the phone: the QR code the bridge printed (a new one replaces the old one about every 20
 * seconds), what to do with it, and `Show a new code` once the bridge stopped waiting. Used by check 3 of the connect
 * dialog and by "Show how to link" in Settings. The code itself is not announced: only the change of state is, by the
 * page's live region.
 */
const wa = useWhatsAppRelayStore()
const link = computed(() => linkText(wa.bridge, wa.identity))
const rows = computed(() => (link.value.qr ? (wa.bridge.qr ?? []) : []))
</script>

<template>
  <div class="link">
    <p class="note">{{ LINK_NOTE }}</p>
    <div v-if="link.qr" class="code">
      <QrCode :rows="rows" label="QR code to scan with WhatsApp on your phone" />
    </div>
    <p v-else-if="link.detail" class="note">{{ link.detail }}</p>
    <div v-if="link.expired">
      <button type="button" class="button button-primary" :disabled="wa.busy !== null" @click="wa.start()">Show a new code</button>
    </div>
  </div>
</template>

<style scoped>
.link {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.note {
  margin: 0;
  color: var(--ink-2);
  font-size: 13px;
  line-height: 19px;
}
.code {
  display: flex;
  padding: 4px 0;
}
</style>
