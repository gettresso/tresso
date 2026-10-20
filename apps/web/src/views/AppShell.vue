<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useBatchesStore } from '@/stores/batches'
import { useMailStore } from '@/stores/mail'
import MailboxSidebar from '@/components/MailboxSidebar.vue'
import { sidebarPage } from '@/components/sidebarPage'
import SignInView from '@/views/SignInView.vue'

const auth = useAuthStore()
const mail = useMailStore()
const batches = useBatchesStore()
const route = useRoute()

const page = computed(() => sidebarPage(route))
const inBatches = computed(() => route.name === 'batches' || route.name === 'batches-thread')

// The sidebar says when the next batch comes, on every screen.
onMounted(() => {
  if (auth.isAuthenticated) {
    void batches.load()
  }
})
watch(
  () => auth.isAuthenticated,
  (authenticated) => authenticated && void batches.load(),
)

// On a phone the mailboxes fold away above the screen; going somewhere folds them again.
const narrow = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 760px)') : null
const mailboxesOpen = ref(narrow === null || !narrow.matches)
watch(
  () => route.fullPath,
  () => {
    if (narrow?.matches) {
      mailboxesOpen.value = false
    }
  },
)
narrow?.addEventListener('change', (query) => (mailboxesOpen.value = !query.matches))

function toggled(event: Event): void {
  mailboxesOpen.value = (event.target as HTMLDetailsElement).open
}
</script>

<template>
  <div v-if="auth.isAuthenticated" class="app">
    <details class="mailboxes" :open="mailboxesOpen" @toggle="toggled">
      <summary class="mailboxes-toggle">Mailboxes</summary>
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
.mailboxes > :deep(nav) {
  min-height: 0;
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
  /* A new screen fades in while the sidebar stays put. Moving within one screen, say between conversations, keeps it. */
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
