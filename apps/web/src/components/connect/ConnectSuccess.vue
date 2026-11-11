<script setup lang="ts">
import { computed } from 'vue'
import type { CalendarSyncStatus, MailAccountStatus } from '@tresso/core'

/** Step 3: connected. The name on sent mail, how far the mail is, and the account's calendars. */
const props = defineProps<{
  address: string
  /** "Microsoft 365", "iCloud", "IMAP": what the account was connected with. */
  providerName: string
  /** A new sign-in found the account connected already and signed it in again. */
  existing: boolean
  status: MailAccountStatus
  statusDetail: string | null
  lastSyncedAt: string | null
  calendarStatus: CalendarSyncStatus
  calendarStatusDetail: string | null
  /** Calendars of this account that arrived so far. */
  calendarCount: number
  /** Google and Microsoft accounts can allow their calendars here; password accounts cannot. */
  canAllowCalendars: boolean
  /** Calendars were asked for at the provider, and not allowed there. */
  calendarsRefused: boolean
  /** The sign-in asked for calendars; false when the user switched them off (or for a password account). */
  calendarsRequested: boolean
  nameError: string | null
  /** Something that went wrong outside the name: allowing calendars, for one. */
  error: string | null
  /** The desktop app opened the provider's page to allow calendars. */
  calendarsInBrowser: boolean
  busy: boolean
}>()
const name = defineModel<string>('name', { required: true })
const emit = defineEmits<{ saveName: []; allowCalendars: []; addAnother: []; done: [] }>()

const mailProblem = computed(() => props.status === 'auth_failed' || props.status === 'error')

/** What the calendars row says, and whether it offers to allow them. */
const calendars = computed<{ text: string; button: string | null }>(() => {
  const count = props.calendarCount
  if (props.calendarStatus === 'active' || count > 0) {
    return count > 0
      ? { text: `${count === 1 ? '1 calendar' : `${count} calendars`} found. They show up in Calendar in a minute.`, button: null }
      : { text: 'Looking for your calendars...', button: null }
  }
  // Switched off before signing in: the account has no calendar access, whatever the worker has said so far.
  if (props.canAllowCalendars && !props.calendarsRequested && (props.calendarStatus === 'unknown' || props.calendarStatus === 'not_granted')) {
    return { text: 'Not synced. You can turn this on now or later in Settings.', button: 'Turn on' }
  }
  if (props.calendarStatus === 'not_granted' && props.canAllowCalendars) {
    return props.calendarsRefused
      ? { text: 'Calendars were not allowed. You can allow them now or later in Settings.', button: 'Allow calendar access' }
      : { text: 'Not synced. You can turn this on now or later in Settings.', button: 'Turn on' }
  }
  if (props.calendarStatus === 'unknown') return { text: 'Looking for your calendars...', button: null }
  if (props.calendarStatus === 'unsupported' || props.calendarStatus === 'not_granted') return { text: 'Not available for this account yet.', button: null }

  return { text: props.calendarStatusDetail ?? 'Not available for this account yet.', button: null }
})
</script>

<template>
  <div class="connected">
    <span class="check" aria-hidden="true"
      ><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg
    ></span>
    <div class="cf-heading">
      <h1 id="connect-title">{{ existing ? 'Already connected' : "You're connected" }}</h1>
      <p class="cf-lead">
        <template v-if="existing">{{ address }} was already connected. We signed it in again.</template>
        <template v-else>{{ address }}, {{ providerName }}</template>
      </p>
    </div>
  </div>
  <label class="cf-field">
    <span class="cf-label">Your name on sent mail</span>
    <input v-model="name" maxlength="120" autocomplete="name" :aria-invalid="nameError ? 'true' : undefined" @blur="emit('saveName')" />
    <span v-if="nameError" class="cf-error" role="alert">{{ nameError }}</span>
    <span v-else class="cf-hint">People see this when you write from this account: <strong>{{ name.trim() }} &lt;{{ address }}&gt;</strong></span>
  </label>
  <div class="panel">
    <div class="row">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
      <span class="row-text">
        <span class="row-title">Getting your mail</span>
        <template v-if="mailProblem">
          <span class="problem" role="alert">{{ status === 'auth_failed' ? 'Tresso could not sign in to this account.' : 'Syncing this account failed.' }} {{ statusDetail ?? '' }}</span>
        </template>
        <template v-else>
          <span class="bar" role="progressbar" aria-label="Getting your mail" :aria-valuenow="lastSyncedAt ? 100 : undefined" aria-valuemin="0" aria-valuemax="100"
            ><span class="fill" :class="{ full: lastSyncedAt !== null }"
          /></span>
          <span class="row-note">Newest mail first. You can start reading right away; the rest follows in the background.</span>
        </template>
      </span>
    </div>
    <div class="row">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
      <span class="row-text">
        <span class="row-title">Calendars</span>
        <span class="row-note" role="status">{{ calendars.text }}</span>
      </span>
      <button v-if="calendars.button" type="button" class="button cf-small" :disabled="busy" @click="emit('allowCalendars')">{{ calendars.button }}</button>
    </div>
  </div>
  <p v-if="calendarsInBrowser" class="cf-hint" role="status">Continue in your browser. Tresso shows the result under Settings, Accounts once you have allowed it.</p>
  <p v-if="error" class="cf-error" role="alert">{{ error }}</p>
  <div class="cf-footer">
    <button type="button" class="button button-quiet" @click="emit('addAnother')">Add another account</button>
    <button type="button" class="button button-primary" :disabled="busy" @click="emit('done')">Done</button>
  </div>
</template>

<style scoped>
.connected {
  display: flex;
  align-items: center;
  gap: 14px;
}
.check {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 999px;
  background: var(--know-soft);
  color: var(--know);
}
.cf-hint strong {
  color: var(--ink);
  font-weight: 600;
}
.panel {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 16px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  color: var(--ink-2);
}
.row + .row {
  border-top: 1px solid var(--line);
}
.row-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.row-title {
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
}
.row-note {
  font-size: 12px;
}
.problem {
  color: var(--danger);
  font-size: 12px;
}
.bar {
  position: relative;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--line);
}
.fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 30%;
  border-radius: 999px;
  background: var(--focus);
  animation: indeterminate 1.4s var(--ease-out) infinite;
}
.fill.full {
  width: 100%;
  animation: none;
}
@keyframes indeterminate {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(340%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .fill {
    animation: none;
  }
}
</style>
