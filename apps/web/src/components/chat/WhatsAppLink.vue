<script setup lang="ts">
import { computed } from 'vue'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import QrCode from './QrCode.vue'
import { CODE_EXPIRED, CODE_EXPIRED_NOTE, CODE_RENEWS, GETTING_CODE, LINK_STEPS, linkStage } from './whatsappTexts'

/**
 * Linking this Mac to the phone (the ConnectWhatsApp board's Scan states): a loader where the code will be while it is
 * on its way, the QR code (a new one replaces it about every 20 seconds, without a sign of it), or `Show a new code`
 * once nobody scanned for three minutes; under it the three steps on the phone. Used by the connect dialog and by
 * "Show how to link" in Settings. The code itself is not announced: only the change of state is, by the page's live
 * region.
 */
const wa = useWhatsAppRelayStore()
const stage = computed(() => linkStage(wa.bridge))
const rows = computed(() => (stage.value === 'scan' ? (wa.bridge.qr ?? []) : []))
</script>

<template>
  <div class="link">
    <div class="tile-row">
      <span v-if="stage === 'scan'" class="tile code"><QrCode :rows="rows" :size="208" label="QR code to scan with WhatsApp on your phone" /></span>
      <span v-else-if="stage === 'expired'" class="tile empty" role="status">
        <span class="words">
          <span class="strong">{{ CODE_EXPIRED }}</span>
          <span class="quiet">{{ CODE_EXPIRED_NOTE }}</span>
        </span>
        <button type="button" class="button button-primary new-code" :disabled="wa.busy !== null" @click="wa.start()">Show a new code</button>
      </span>
      <span v-else class="tile empty" role="status">
        <svg class="spin" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke-opacity="0.16" />
          <path d="M12 3a9 9 0 019 9" />
        </svg>
        <span class="body">{{ GETTING_CODE }}</span>
      </span>
    </div>
    <ol class="steps">
      <li v-for="(step, index) in LINK_STEPS" :key="step">
        <span class="number" aria-hidden="true">{{ index + 1 }}</span><span class="step">{{ step }}</span>
      </li>
    </ol>
    <p v-if="stage === 'scan'" class="renews">{{ CODE_RENEWS }}</p>
  </div>
</template>

<style scoped>
.link {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.tile-row {
  display: flex;
  justify-content: center;
}
.tile {
  box-sizing: border-box;
  display: flex;
  width: 240px;
  height: 240px;
  border-radius: 16px;
}
/* The code keeps dark squares on white in both themes, so a phone can read it. */
.code {
  /* A whole number of pixels per module can make the code a little larger than 208: the tile grows with it. */
  width: auto;
  height: auto;
  min-width: 240px;
  min-height: 240px;
  align-items: center;
  justify-content: center;
  padding: 16px;
  border: 1px solid var(--line);
  background: #ffffff;
}
.empty {
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 20px;
  background: var(--ground);
  text-align: center;
}
.words {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.strong {
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
}
.quiet,
.renews {
  color: var(--ink-2);
  font-size: 13px;
  line-height: 19px;
}
.body {
  font-size: 14px;
  line-height: 21px;
}
.new-code {
  height: 46px;
  padding: 0 24px;
  font-size: 15px;
}
.steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.steps li {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.number {
  flex: 0 0 16px;
  color: var(--ink-2);
  font: 500 13px var(--font-mono);
}
.step {
  font-size: 15px;
  line-height: 22px;
}
.renews {
  margin: 0;
  text-align: center;
}
.spin {
  animation: wa-spin 0.9s linear infinite;
}
@keyframes wa-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
