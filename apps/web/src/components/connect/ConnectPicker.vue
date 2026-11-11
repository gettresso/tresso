<script setup lang="ts">
import { computed } from 'vue'
import { oauthProviderFor, type MailServiceProvider, type OAuthProviderId } from '@tresso/core'
import ProviderMark from './ProviderMark.vue'
import { PICKER_ORDER, PROVIDERS, type ProviderChoice } from './providers'

/** Step "Select your email provider": every provider Tresso knows, and setting up any other by hand. */
const props = defineProps<{ address: string | null; signInProviders: OAuthProviderId[] }>()
const emit = defineEmits<{ pick: [choice: ProviderChoice]; otherAddress: [] }>()

function available(choice: ProviderChoice): boolean {
  if (choice === 'exchange' || choice === 'manual') return true
  const oauth = oauthProviderFor(choice as MailServiceProvider)
  return oauth === null || props.signInProviders.includes(oauth)
}

/** The operator did not set up signing in with Google or Microsoft (or the list could not be loaded). */
const someUnavailable = computed(() => PICKER_ORDER.some((choice) => !available(choice)))
</script>

<template>
  <div class="cf-heading">
    <h1 id="connect-title">Select your email provider</h1>
    <p class="cf-lead">
      <template v-if="address">We could not tell who handles mail for {{ address }}. Pick your provider below, or enter the server settings yourself.</template>
      <template v-else>Pick your provider below, or enter the server settings yourself.</template>
    </p>
  </div>
  <div class="tiles">
    <button
      v-for="choice in PICKER_ORDER"
      :key="choice"
      type="button"
      class="tile"
      :class="{ wide: choice === 'manual' }"
      :disabled="!available(choice)"
      @click="emit('pick', choice)"
    >
      <ProviderMark :provider="choice" :size="40" />
      <span class="tile-text">
        <span class="tile-name">{{ PROVIDERS[choice].name }}</span>
        <span class="tile-note">{{ PROVIDERS[choice].note }}</span>
      </span>
    </button>
  </div>
  <p v-if="someUnavailable" class="cf-hint">
    Signing in with Google or Microsoft is not available right now; you can still connect with a password.
  </p>
  <div class="cf-footer">
    <button type="button" class="button button-quiet" @click="emit('otherAddress')">Use another email address</button>
  </div>
</template>

<style scoped>
.tiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.tile {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: 12px 16px 12px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--paper);
  color: var(--ink);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--motion-fast) ease,
    transform var(--motion-fast) var(--ease-out);
}
.tile:hover:not(:disabled) {
  border-color: var(--ink-3);
}
.tile:active:not(:disabled) {
  transform: scale(0.98);
}
.tile:disabled {
  opacity: 0.5;
  cursor: default;
}
.tile.wide {
  grid-column: 1 / -1;
  border-style: dashed;
}
.tile-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tile-name {
  font-size: 15px;
  font-weight: 600;
}
.tile-note {
  color: var(--ink-2);
  font-size: 12px;
  line-height: 16px;
}
@media (max-width: 600px) {
  .tiles {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (prefers-reduced-motion: reduce) {
  .tile:active:not(:disabled) {
    transform: none;
  }
}
</style>
