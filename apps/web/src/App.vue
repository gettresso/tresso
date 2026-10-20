<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterView } from 'vue-router'
import { errorMessage } from '@/api/errors'
import { useAuthStore } from '@/stores/auth'
import { useComposeStore } from '@/stores/compose'
import { useHandOversStore } from '@/stores/handOvers'
import { useMailStore } from '@/stores/mail'
import { startTimeZoneSync, storedSentZone } from '@/platform/timeZone'
import { releaseOtherUsersPush } from '@/platform/webPush'
import NoticeStack from '@/components/NoticeStack.vue'

const auth = useAuthStore()
const mail = useMailStore()
const compose = useComposeStore()
// Started with the app: it tells the user about hand-overs past their due date wherever they are.
const handOvers = useHandOversStore()
// The editor is large; it loads the first time a message is written.
const ComposeWindow = defineAsyncComponent(() => import('@/components/ComposeWindow.vue'))
const HandOverDialog = defineAsyncComponent(() => import('@/components/HandOverDialog.vue'))
const error = ref<string | null>(null)

/** After another tab moved to a newer Tresso, only a reload brings this tab the code that opens the new copy. */
function reload(): void {
  window.location.reload()
}

// "C" writes a new message, unless the user is typing somewhere.
function shortcut(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  const typing = target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  if (!typing && auth.isAuthenticated && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'c' && compose.draft === null && handOvers.handingOver === null) {
    event.preventDefault()
    compose.openNew()
  }
}
onMounted(() => window.addEventListener('keydown', shortcut))
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
      return
    }
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
  <RouterView />
  <template v-if="auth.isAuthenticated">
    <ComposeWindow v-if="compose.draft" />
    <HandOverDialog v-if="handOvers.handingOver" :key="handOvers.handingOver.id" :message="handOvers.handingOver" />
    <NoticeStack />
  </template>
  <p v-if="mail.updatedElsewhere" class="problem" role="alert">
    {{ mail.updatedElsewhere }}
    <button type="button" class="reload" @click="reload">Reload</button>
  </p>
  <p v-else-if="error || mail.syncState === 'error'" class="problem" role="alert">
    {{ error ?? `Sync stopped: ${mail.syncError}` }}
  </p>
</template>

<style scoped>
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
  color: var(--surface);
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
