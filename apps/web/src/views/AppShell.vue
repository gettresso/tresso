<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useBatchesStore } from '@/stores/batches'
import { useMailStore } from '@/stores/mail'
import MailboxSidebar from '@/components/MailboxSidebar.vue'
import { sidebarPage } from '@/components/sidebarPage'
import SignInView from '@/views/SignInView.vue'
import { reducedMotion } from '@/components/calendar/genie'

const auth = useAuthStore()
const mail = useMailStore()
const batches = useBatchesStore()
const route = useRoute()

const page = computed(() => sidebarPage(route))
const inBatches = computed(() => route.name === 'batches' || route.name === 'batches-thread')

// The sidebar says when the next batch comes, on every screen. Loading again is free once the schedule is known, so
// each new screen also retries a load that failed before (say while offline).
watch(
  [() => auth.isAuthenticated, () => route.fullPath],
  ([authenticated]) => authenticated && void batches.load(),
  { immediate: true },
)

// On a phone the mailboxes fold away above the screen; going somewhere folds them again.
const narrow = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 760px)') : null
const mailboxesOpen = ref(narrow === null || !narrow.matches)
const mailboxes = ref<HTMLDetailsElement | null>(null)

/** Where the fold is heading; a second tap while it moves turns it around. */
const folding = ref<{ open: boolean; animation: Animation } | null>(null)

/** Folds the mailboxes open or shut on a phone, with their height (and padding) easing instead of the screen jumping. */
async function fold(open: boolean): Promise<void> {
  const list = mailboxes.value?.querySelector<HTMLElement>('nav')
  // Turning around mid-fold starts from where the list is now, not from a full end.
  const from = folding.value === null || list === null || list === undefined ? null : { height: `${list.offsetHeight}px`, opacity: Number(getComputedStyle(list).opacity) }
  folding.value?.animation.cancel()
  folding.value = null
  if (list === null || list === undefined || typeof list.animate !== 'function' || reducedMotion() || !narrow?.matches) {
    mailboxesOpen.value = open
    return
  }
  mailboxesOpen.value = true
  await nextTick()
  const style = getComputedStyle(list)
  const shown = { height: `${list.offsetHeight}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, opacity: 1 }
  const hidden = { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 }
  list.style.overflow = 'hidden'
  const start = from === null ? (open ? hidden : shown) : { ...(open ? hidden : shown), ...from }
  const animation = list.animate([start, open ? shown : hidden], { duration: 220, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' })
  folding.value = { open, animation }
  animation.onfinish = () => {
    list.style.overflow = ''
    folding.value = null
    mailboxesOpen.value = open
  }
}

function summaryClick(event: MouseEvent): void {
  if (narrow?.matches) {
    event.preventDefault()
    void fold(!(folding.value?.open ?? mailboxesOpen.value))
  }
}

watch(
  () => route.fullPath,
  () => {
    if (narrow?.matches && mailboxesOpen.value) {
      void fold(false)
    }
  },
)
function widthChanged(query: MediaQueryListEvent): void {
  mailboxesOpen.value = !query.matches
}
narrow?.addEventListener('change', widthChanged)
onBeforeUnmount(() => narrow?.removeEventListener('change', widthChanged))

function toggled(event: Event): void {
  mailboxesOpen.value = (event.target as HTMLDetailsElement).open
}
</script>

<template>
  <div v-if="auth.isAuthenticated" class="app">
    <details ref="mailboxes" class="mailboxes" :open="mailboxesOpen" @toggle="toggled">
      <summary class="mailboxes-toggle" @click="summaryClick">Mailboxes</summary>
      <MailboxSidebar
        :display-name="auth.me?.displayName ?? ''"
        :email="auth.me?.email ?? ''"
        :accounts="mail.accounts"
        :unread-counts="mail.unreadCounts"
        :mailbox="mail.mailbox"
        :smart-inboxes="mail.smartInboxes"
        :smart-inbox-counts="mail.smartInboxCounts"
        :smart-inbox="mail.smartInbox"
        :batches="inBatches"
        :next-batch="batches.nextBatchLabel"
        :page="page"
        :live="mail.live"
        @sign-out="auth.signOut()"
      />
    </details>
    <div class="stage">
      <RouterView />
    </div>
  </div>
  <SignInView v-else />
</template>

<style scoped>
.app {
  display: grid;
  grid-template-columns: minmax(220px, 272px) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.mailboxes {
  display: contents;
}
.mailboxes-toggle {
  display: none;
}
/* The sidebar is a pane of glass over the canvas; in the macOS app the window's own vibrancy shows through instead. */
.mailboxes > :deep(nav) {
  min-height: 0;
  background: color-mix(in srgb, var(--surface) 60%, transparent);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: inset -1px 0 0 var(--line);
}
html.vibrant .stage {
  background: var(--canvas-light), var(--canvas);
  border-top-left-radius: var(--radius-panel);
  box-shadow: inset 1px 1px 0 var(--line);
}
html.vibrant .mailboxes > :deep(nav) {
  background: transparent;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
.stage {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.stage > :deep(*) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /*
   * A new screen fades in while the sidebar stays put. Moving within one screen, say between conversations, keeps it.
   * Only opacity: a transform here would pin a screen's fixed panels to the screen instead of the window.
   */
  animation: screen-in var(--motion-base) var(--ease-out);
}

@media (max-width: 760px) {
  .app {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .mailboxes {
    display: block;
    border-bottom: 1px solid var(--line);
    background: var(--ground);
  }
  .mailboxes-toggle {
    display: block;
    padding: 12px 16px;
    font-weight: 600;
    cursor: pointer;
  }
  .mailboxes[open] > :deep(nav) {
    max-height: 70vh;
  }
}
</style>
