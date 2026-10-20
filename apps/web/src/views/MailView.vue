<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, type RouteLocationRaw } from 'vue-router'
import { unsubscribeOffer, type UnsubscribeOffer } from '@tresso/core'
import { useBatchesStore } from '@/stores/batches'
import { useMailStore } from '@/stores/mail'
import { useSelectionStore } from '@/stores/selection'
import CleanupPanel from '@/components/CleanupPanel.vue'
import ConversationList from '@/components/ConversationList.vue'
import ReadingPane from '@/components/ReadingPane.vue'
import SmartInboxManage from '@/components/SmartInboxManage.vue'
import UnsubscribeAction from '@/components/UnsubscribeAction.vue'
import MiniAgenda from '@/components/calendar/MiniAgenda.vue'

const mail = useMailStore()
const route = useRoute()
const batches = useBatchesStore()

const accountId = computed(() => (typeof route.params.accountId === 'string' ? route.params.accountId : null))
const smartInboxId = computed(() => (typeof route.params.smartInboxId === 'string' ? route.params.smartInboxId : null))
/** A screen that takes the list's and the reading pane's place: a smart inbox's senders, or the cleanup suggestions. */
const wide = computed(() => (route.name === 'smart-inbox-manage' || route.name === 'cleanup' ? route.name : null))
const threadId = computed(() => (typeof route.params.threadId === 'string' ? route.params.threadId : null))
const inBatches = computed(() => route.name === 'batches' || route.name === 'batches-thread')
const title = computed(() => {
  if (inBatches.value) {
    return 'Batches'
  }
  if (smartInboxId.value !== null) {
    return mail.smartInboxes.find((s) => s.id === smartInboxId.value)?.name ?? 'Smart inbox'
  }

  return accountId.value === null ? 'Unified Inbox' : (mail.accounts.find((a) => a.id === accountId.value)?.displayName ?? 'Inbox')
})
const backTo = computed(() => {
  if (inBatches.value) {
    return '/batches'
  }
  if (smartInboxId.value !== null) {
    return `/smart/${smartInboxId.value}`
  }

  return accountId.value === null ? '/' : `/accounts/${accountId.value}`
})

const emptyText = computed(() => {
  if (inBatches.value) {
    return 'No batch delivered yet.'
  }

  return smartInboxId.value === null ? 'Nothing in this inbox.' : 'Nothing in this smart inbox.'
})

function linkTo(id: string): RouteLocationRaw {
  if (inBatches.value) {
    return { name: 'batches-thread', params: { threadId: id } }
  }
  if (smartInboxId.value !== null) {
    return { name: 'smart-inbox-thread', params: { smartInboxId: smartInboxId.value, threadId: id } }
  }

  return accountId.value === null
    ? { name: 'unified-thread', params: { threadId: id } }
    : { name: 'account-thread', params: { accountId: accountId.value, threadId: id } }
}

const selection = useSelectionStore()
// A selection belongs to the list it was made in.
watch(
  [accountId, smartInboxId, inBatches],
  ([account, smartInbox, batched]) => {
    selection.clear()
    if (batched) {
      void mail.showBatches()
    } else {
      void (smartInbox === null ? mail.showMailbox(account) : mail.showSmartInbox(smartInbox))
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => selection.clear())

/**
 * What each batch conversation on screen offers to unsubscribe from. Only the listed conversations' messages are read,
 * again when the list or the requests change; an older read that finishes late is dropped.
 */
const offers = shallowRef(new Map<string, UnsubscribeOffer | null>())
let offersRun = 0
watch(
  [inBatches, () => mail.conversations, () => mail.unsubscriptions, () => mail.smartInboxes],
  async ([batched, conversations, unsubscriptions, smartInboxes]) => {
    const run = ++offersRun
    if (!batched) {
      offers.value = new Map()
      return
    }
    const spam = smartInboxes.find((s) => s.builtin === 'spam')?.id
    const shown = conversations.filter((c) => spam === undefined || c.smartInboxId !== spam)
    const messages = await mail.threadMessages(shown.map((c) => c.threadId))
    if (run !== offersRun) {
      return
    }
    offers.value = new Map(shown.map((c) => [c.threadId, unsubscribeOffer(messages.get(c.threadId) ?? [], unsubscriptions)]))
  },
  { immediate: true },
)
</script>

<template>
  <div class="shell" :class="{ reading: threadId !== null }">

    <SmartInboxManage v-if="wide === 'smart-inbox-manage' && smartInboxId" class="wide" :smart-inbox-id="smartInboxId" />
    <CleanupPanel v-else-if="wide === 'cleanup'" class="wide" />
    <template v-else>
      <ConversationList
        class="conversations"
        :title="title"
        :conversations="mail.conversations"
        :selected-thread-id="threadId"
        :has-more="mail.hasMore"
        :loading="!mail.ready || mail.syncState === 'syncing'"
        :has-accounts="mail.accounts.length > 0"
        :empty-text="emptyText"
        :link-to="linkTo"
        :group-by="inBatches ? 'batch' : 'day'"
        :manage-to="smartInboxId === null ? undefined : { name: 'smart-inbox-manage', params: { smartInboxId } }"
        @show-more="mail.showMore()"
      >
        <template v-if="inBatches" #aside>
          <p class="next-batch">
            <span v-if="batches.nextBatchLabel">Next batch at {{ batches.nextBatchLabel }}</span>
            <RouterLink :to="{ name: 'settings-batches' }">Change batch times</RouterLink>
          </p>
        </template>
        <template v-if="inBatches" #extra="{ conversation }">
          <UnsubscribeAction :offer="offers.get(conversation.threadId) ?? null" />
        </template>
      </ConversationList>

      <ReadingPane v-if="threadId" :key="threadId" class="reading-pane" :thread-id="threadId" :back-to="backTo" />
      <div v-else class="reading-pane placeholder">
        <MiniAgenda />
      </div>
    </template>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: minmax(360px, 520px) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.conversations,
.reading-pane,
.wide {
  min-height: 0;
}
.next-batch {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: -4px 0 0;
  font-size: 13px;
  color: var(--ink-2);
}
.next-batch a {
  font-weight: 600;
  text-decoration: none;
}
.wide {
  grid-column: 1 / -1;
}
.placeholder {
  display: flex;
  justify-content: center;
  overflow-y: auto;
  background: var(--surface);
  color: var(--ink);
}

@media (max-width: 1100px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
  }
  .shell.reading .conversations,
  .shell:not(.reading) .reading-pane {
    display: none;
  }
}
</style>
