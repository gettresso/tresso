<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterView, useRouter } from 'vue-router'
import { errorMessage } from '@/api/errors'
import { useAuthStore } from '@/stores/auth'
import { useComposeStore } from '@/stores/compose'
import { useHandOversStore } from '@/stores/handOvers'
import { useMailStore } from '@/stores/mail'
import { startTimeZoneSync, storedSentZone } from '@/platform/timeZone'
import { releaseOtherUsersPush } from '@/platform/webPush'
import NoticeStack from '@/components/NoticeStack.vue'
import UpdateCard from '@/components/UpdateCard.vue'
import { useUpdatesStore } from '@/stores/updates'
import { useBillingStore } from '@/stores/billing'
import { TRIAL_REMINDER_DAYS, trialDaysLeft, type BillingStatus } from '@tresso/core'
import { isDesktop } from '@/platform/desktop'
import { vibrant } from '@/platform/vibrancy'

const auth = useAuthStore()
const mail = useMailStore()
const compose = useComposeStore()
// Started with the app: it tells the user about hand-overs past their due date wherever they are.
const handOvers = useHandOversStore()
// The editor is large; it loads the first time a message is written.
const ComposeWindow = defineAsyncComponent(() => import('@/components/ComposeWindow.vue'))
const HandOverDialog = defineAsyncComponent(() => import('@/components/HandOverDialog.vue'))
const PaymentScreen = defineAsyncComponent(() => import('@/components/PaymentScreen.vue'))
const billing = useBillingStore()
const router = useRouter()

/** Reminds an owner a few days before their own trial ends, once per launch. */
function remindOfTrial(status: BillingStatus): void {
  const own = status.organizations.find((organization) => organization.personal)
  if (!status.enabled || own === undefined || own.status !== 'trial' || !own.canManage) {
    return
  }
  const days = trialDaysLeft(own)
  if (days > 0 && days <= TRIAL_REMINDER_DAYS) {
    const end = new Date(own.trialEndsAt).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })
    compose.notify(
      {
        text: `Your free trial ends on ${end}.`,
        tone: 'info',
        action: { label: 'Subscribe', run: () => void router.push({ name: 'settings-billing' }) },
      },
      20_000,
    )
  }
}
const error = ref<string | null>(null)

/** After another tab moved to a newer Tresso, only a reload brings this tab the code that opens the new copy. */
function reload(): void {
  window.location.reload()
}

// "C" writes a new message, unless the user is typing somewhere.
function shortcut(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  const typing = target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  if (!typing && auth.isAuthenticated && !auth.paymentRequired && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'c' && compose.draft === null && handOvers.handingOver === null) {
    event.preventDefault()
    compose.openNew()
  }
}
onMounted(() => window.addEventListener('keydown', shortcut))

// While the payment screen shows, no key reaches a listener: inert stops pointers and focus, but window shortcuts
// (archive, snooze, triage, the calendar's) would still see keys, even those sent to the screen. The browser's own
// handling (Tab, Enter and Space on a button) is not prevented, and the screen itself needs no key listener.
function blockShortcuts(event: KeyboardEvent): void {
  if (auth.paymentRequired) {
    event.stopImmediatePropagation()
  }
}
onMounted(() => window.addEventListener('keydown', blockShortcuts, { capture: true }))
onBeforeUnmount(() => window.removeEventListener('keydown', blockShortcuts, { capture: true }))

// The desktop app learns how it updates; release builds then look for new releases on their own (Windows, Linux).
const updates = useUpdatesStore()
if (isDesktop) {
  updates.start(import.meta.env.PROD).catch((cause: unknown) => console.error('Starting the update checks failed', cause))
}
onBeforeUnmount(() => updates.stop())
onBeforeUnmount(() => window.removeEventListener('keydown', shortcut))

// Reminders are planned in the zone a device of the user last sent. This one sends its zone the first time and when
// it changes, not on every reload, so it does not take the zone back from a device the user moved on to.
let stopTimeZone: (() => void) | null = null
onBeforeUnmount(() => stopTimeZone?.())

// The mail copy runs for the whole session, so every screen (inbox, settings) sees live changes.
watch(
  () => auth.isAuthenticated,
  async (authenticated) => {
    stopTimeZone?.()
    stopTimeZone = null
    if (!authenticated) {
      billing.reset()
      return
    }
    // Where billing stands decides what shows: the payment screen, a trial reminder, the settings page.
    billing
      .load()
      .then(remindOfTrial)
      .catch((cause: unknown) => console.error('Loading billing failed', cause))
    try {
      await auth.loadMe()
      if (auth.me) {
        stopTimeZone = startTimeZoneSync(auth.api, storedSentZone(auth.me.id), (e) => compose.notify({ text: `Reminders may come at the wrong time: your time zone could not be saved (${errorMessage(e)}).`, tone: 'error' }))
        // Pushes someone else turned on in this browser stop once another user signs in here.
        releaseOtherUsersPush(auth.me.id).catch((e) => compose.notify({ text: `Another account's notifications may still show in this browser: ${errorMessage(e)}`, tone: 'error' }))
        await mail.start(auth.me.id)
      }
      error.value = null
    } catch (e) {
      error.value = errorMessage(e)
    }
  },
  { immediate: true },
)
</script>

<template>
  <!-- The macOS app's title bar: the window buttons sit on it, and dragging it moves the window. -->
  <div v-if="vibrant" class="titlebar" data-tauri-drag-region aria-hidden="true" />
  <!-- Behind the payment screen nothing can be reached, by pointer, keyboard or screen reader. -->
  <div class="app-layer" :inert="auth.paymentRequired">
    <RouterView />
    <template v-if="auth.isAuthenticated">
      <Transition name="sink"><ComposeWindow v-if="compose.draft" /></Transition>
      <Transition name="layer"><HandOverDialog v-if="handOvers.handingOver" :key="handOvers.handingOver.id" :message="handOvers.handingOver" /></Transition>
      <NoticeStack />
      <UpdateCard v-if="isDesktop" />
    </template>
  </div>
  <PaymentScreen v-if="auth.isAuthenticated && auth.paymentRequired" />
  <p v-if="mail.updatedElsewhere" class="problem" role="alert">
    {{ mail.updatedElsewhere }}
    <button type="button" class="reload" @click="reload">Reload</button>
  </p>
  <p v-else-if="!auth.paymentRequired && (error || mail.syncState === 'error')" class="problem" role="alert">
    {{ error ?? `Sync stopped: ${mail.syncError}` }}
  </p>
</template>

<style scoped>
/* Only a wrapper for inert: it takes no box of its own. */
.app-layer {
  display: contents;
}
.titlebar {
  position: fixed;
  inset: 0 0 auto;
  z-index: 60;
  height: var(--titlebar);
}
.problem {
  animation: fade-in var(--motion-base) ease-out;
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  margin: 0;
  padding: 10px 16px;
  border-radius: var(--radius-card);
  background: var(--ink);
  color: var(--paper);
  box-shadow: var(--raised);
}
.reload {
  margin-left: 12px;
  padding: 4px 10px;
  border: 1px solid currentcolor;
  border-radius: var(--radius-control);
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
</style>
