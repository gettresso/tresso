<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterView, useRouter } from 'vue-router'
import { errorMessage } from '@/api/errors'
import { shortcutAllowed } from '@/mail/useMessageActions'
import { useAuthStore } from '@/stores/auth'
import { useComposeStore } from '@/stores/compose'
import { useHandOversStore } from '@/stores/handOvers'
import { useMailStore } from '@/stores/mail'
import { startTimeZoneSync, storedSentZone } from '@/platform/timeZone'
import { releaseOtherUsersPush } from '@/platform/webPush'
import NoticeStack from '@/components/NoticeStack.vue'
import { problemPlacement } from '@/components/problemPlacement'
import { useFocusReturn } from '@/components/focusReturn'
import UpdateCard from '@/components/UpdateCard.vue'
import { useUpdatesStore } from '@/stores/updates'
import { useBillingStore } from '@/stores/billing'
import { useBulkStore } from '@/stores/bulk'
import { TRIAL_REMINDER_DAYS, trialDaysLeft, type BillingStatus } from '@tresso/core'
import { isDesktop } from '@/platform/desktop'
import { vibrant } from '@/platform/vibrancy'

const auth = useAuthStore()
const mail = useMailStore()
const compose = useComposeStore()
/** Where the problem banner goes, out of the compose window's way (problemPlacement). */
const problemPlace = computed(() => problemPlacement(compose.draft === null ? null : { minimized: compose.minimized }))
/** The sync error the user hid; a different error shows again. */
const hiddenSyncError = ref<string | null>(null)
// One source with the sync status at the foot of the sidebar: the status machine sets a failure, both show it.
const syncProblem = computed(() => mail.syncStatus.problem)
// A sync error hidden by the user shows again on a later outage, once a pull worked in between (the failure cleared).
watch(syncProblem, (problem) => {
  if (problem === null) {
    hiddenSyncError.value = null
  }
})
// Started with the app: it tells the user about hand-overs past their due date wherever they are.
const handOvers = useHandOversStore()
// The hand-over dialog gives focus back to what opened it once it has left the page.
const handOverFocus = useFocusReturn(() => handOvers.handingOver !== null)
// The editor is large; it loads the first time a message is written.
const ComposeWindow = defineAsyncComponent(() => import('@/components/ComposeWindow.vue'))
const HandOverDialog = defineAsyncComponent(() => import('@/components/HandOverDialog.vue'))
const PaymentScreen = defineAsyncComponent(() => import('@/components/PaymentScreen.vue'))
const billing = useBillingStore()
// Started with the app: a bulk action this tab followed before a reload is followed again to its result and undo.
const bulk = useBulkStore()
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

// "C" writes a new message, as the other shortcuts work: not while typing, in a dialog or menu, or held down.
function shortcut(event: KeyboardEvent): void {
  if (shortcutAllowed(event, false) && auth.isAuthenticated && !auth.paymentRequired && event.key.toLowerCase() === 'c' && compose.draft === null && handOvers.handingOver === null) {
    event.preventDefault()
    compose.openNew()
  }
}
onMounted(() => window.addEventListener('keydown', shortcut))

// A sign-out whose sign-in pages did not answer left this browser signed in there: once they answer, end it.
onMounted(() => {
  if (!auth.isAuthenticated) {
    auth.endOpenBrowserSession().catch((cause: unknown) => console.error('Ending the session at the sign-in pages failed', cause))
    // Mail a sign-out could not remove (the sign-in screen says so) goes now that nothing uses it.
    void mail.removeLeftCopies()
  }
})

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

/** The first wait before starting again after a failed start, doubled after each failure up to the cap. */
const RETRY_FIRST_MS = 5_000
const RETRY_CAP_MS = 300_000
/** Raised by every change of the session and every start, so an older start that finishes late changes nothing. */
let startRun = 0
let starting = false
let retryAttempt = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

function cancelRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

/**
 * Starts the signed-in session: who the user is, then their mail copy. The copy of the user the server last confirmed
 * for these tokens opens at once, before it answers, so the mail is there when the app starts offline; until the
 * server confirms that user it is only read (no sync, nothing sent, no other copy removed). A start that fails
 * (offline, the server down, the copy refused) says so, with what still shows, and a button to try again; it also
 * tries again by itself: after a growing wait, and at once when the device is back online.
 */
async function startSession(): Promise<void> {
  cancelRetry()
  const run = ++startRun
  starting = true
  try {
    const known = auth.knownUserId
    // Settled here and awaited below, so its failure is reported once, with the rest of the start.
    const early = known === null ? Promise.resolve() : mail.start(known, { confirmed: false })
    const openedEarly = early.then(
      () => null,
      (cause: unknown) => cause,
    )
    await auth.loadMe()
    if (run !== startRun || !auth.isAuthenticated) {
      return
    }
    if (auth.me) {
      if (stopTimeZone === null) {
        stopTimeZone = startTimeZoneSync(auth.api, storedSentZone(auth.me.id), (e) => compose.notify({ text: `Reminders may come at the wrong time: your time zone could not be saved (${errorMessage(e)}).`, tone: 'error' }))
      }
      // Pushes someone else turned on in this browser stop once another user signs in here.
      releaseOtherUsersPush(auth.me.id).catch((e) => compose.notify({ text: `Another account's notifications may still show in this browser: ${errorMessage(e)}`, tone: 'error' }))
      // The copy opened early is the right one (one that failed to open is opened again), or this start overtakes it
      // and opens the user's own; a draft opened in the other user's copy never moves into it.
      if (auth.me.id === known) {
        await openedEarly
      } else if (known !== null) {
        // Nothing shown of the other copy carries over: the message being written, a hand-over, a followed bulk action.
        compose.reset()
        handOvers.reset()
        bulk.reset()
      }
      await mail.start(auth.me.id, { confirmed: true })
      if (run !== startRun || !auth.isAuthenticated) {
        return
      }
      // The server confirmed who is signed in: copies other users left here can go.
      await mail.removeOtherUsersCopies(auth.me.id)
    }
    if (run !== startRun) {
      return
    }
    error.value = null
    retryAttempt = 0
  } catch (e) {
    if (run !== startRun || !auth.isAuthenticated) {
      return
    }
    error.value = errorMessage(e)
    const wait = Math.min(RETRY_FIRST_MS * 2 ** retryAttempt, RETRY_CAP_MS)
    retryAttempt += 1
    retryTimer = setTimeout(() => void startSession(), wait)
  } finally {
    if (run === startRun) {
      starting = false
    }
  }
}

/** The Retry button and the device coming back online: start again now, unless a start is under way. */
function retryNow(): void {
  if (auth.isAuthenticated && error.value !== null && !starting) {
    void startSession()
  }
}
/**
 * Try again on a sync error: a pull when the copy is syncing; otherwise (the copy was removed elsewhere and could not
 * be opened again) the start, which opens it.
 */
function retrySync(): void {
  if (mail.synced) {
    void mail.syncNow()
  } else if (auth.isAuthenticated && !starting) {
    void startSession()
  }
}
onMounted(() => window.addEventListener('online', retryNow))
onBeforeUnmount(() => {
  window.removeEventListener('online', retryNow)
  cancelRetry()
  startRun += 1
})

// The mail copy runs for the whole session, so every screen (inbox, settings) sees live changes.
watch(
  () => auth.isAuthenticated,
  (authenticated) => {
    stopTimeZone?.()
    stopTimeZone = null
    cancelRetry()
    retryAttempt = 0
    error.value = null
    startRun += 1
    starting = false
    if (!authenticated) {
      billing.reset()
      return
    }
    // Where billing stands decides what shows: the payment screen, a trial reminder, the settings page.
    billing
      .load()
      .then(remindOfTrial)
      .catch((cause: unknown) => console.error('Loading billing failed', cause))
    void startSession()
  },
  { immediate: true },
)

// Keeping the sign-in fails right after a sign-in or a refresh, so while the app is on screen: the sign-in screen is
// not, and the user would only learn of it by being signed out at the next launch.
watch(
  () => auth.storageFailures,
  () => {
    if (auth.storageError !== null && auth.isAuthenticated) {
      compose.notify({ text: auth.storageError, tone: 'error' }, 30_000)
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
      <Transition name="layer" @after-leave="handOverFocus.restore()"><HandOverDialog v-if="handOvers.handingOver" :key="handOvers.handingOver.id" :message="handOvers.handingOver" /></Transition>
      <NoticeStack />
      <UpdateCard v-if="isDesktop" />
    </template>
  </div>
  <PaymentScreen v-if="auth.isAuthenticated && auth.paymentRequired" />
  <p v-if="mail.updatedElsewhere" class="problem" :class="problemPlace" role="alert">
    {{ mail.updatedElsewhere }}
    <button type="button" class="reload" @click="reload">Reload</button>
  </p>
  <!-- The mail kept on this device shows already, read only, while the server cannot say who is signed in. -->
  <p v-else-if="!auth.paymentRequired && error && mail.ready" class="problem" :class="problemPlace" role="status">
    Showing mail kept on this device. Tresso is still connecting.
    <button type="button" class="reload" @click="retryNow">Try again</button>
  </p>
  <p v-else-if="!auth.paymentRequired && error" class="problem" :class="problemPlace" role="alert">
    Tresso could not start, it tries again by itself: {{ error }}
    <button type="button" class="reload" @click="retryNow">Retry</button>
  </p>
  <p v-else-if="!auth.paymentRequired && syncProblem !== null && syncProblem !== hiddenSyncError" class="problem" :class="problemPlace" role="alert">
    {{ syncProblem }}
    <button type="button" class="reload" @click="retrySync">Try again</button>
    <button type="button" class="hide" aria-label="Hide this message" @click="hiddenSyncError = syncProblem">×</button>
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
/* The signed-in desktop shell has its own title strip and moves the window there (AppShell). */
html.frame-shell .titlebar {
  display: none;
}
.problem {
  animation: fade-in var(--motion-base) ease-out;
  position: fixed;
  /* Centred across the full width, so a long error wraps to a few wide lines rather than a narrow column. */
  left: 16px;
  right: 16px;
  bottom: 16px;
  /*
   * Below the compose window (20) and the notices (30): Send, Undo and a minimized draft always stay on top and take
   * clicks. problemPlacement moves the banner out of their way; Hide takes a sync error away altogether.
   */
  z-index: 15;
  width: fit-content;
  max-width: min(560px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 10px 16px;
  border-radius: var(--radius-card);
  background: var(--ink);
  color: var(--paper);
  box-shadow: var(--raised);
}
/* A draft open or minimized on a wide window: along the top edge, clear of the compose window. */
@media (min-width: 761px) {
  .problem.with-draft,
  .problem.with-minimized-draft {
    top: calc(var(--titlebar, 0px) + 12px);
    bottom: auto;
    /*
     * At the left, and no wider than the room beside a compose window (640 px plus its 24 px edge and a gap), so a
     * tall compose window does not hide its buttons; from about 1240 px up it is fully clear.
     */
    max-width: min(560px, max(280px, calc(100vw - 696px)));
    margin: 0 auto 0 0;
  }
}
/* On a phone an open draft covers the screen (the banner waits behind it); above a minimized draft's 64 px bar. */
@media (max-width: 760px) {
  .problem.with-minimized-draft {
    bottom: 76px;
  }
}
.hide {
  margin-left: 8px;
  min-width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 16px;
  cursor: pointer;
}
@media (max-width: 760px) {
  .reload,
  .hide {
    min-width: 44px;
    min-height: 44px;
  }
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
