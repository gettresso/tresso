<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  BULK_AGES,
  bulkActionLabel,
  cleanupSuggestionText,
  conversationCount,
  readRate,
  type BulkAction,
  type BulkActionRequest,
  type CleanupSuggestion,
  type SmartInboxSenders,
} from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { senderName, shortTime } from '@/mail/format'
import { useBulkStore } from '@/stores/bulk'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import AppIcon from '@/components/AppIcon.vue'
import MenuButton from '@/components/MenuButton.vue'
import SenderAvatar from '@/components/SenderAvatar.vue'

/**
 * Manages a smart inbox in bulk: everything it lists (or only what is older than an age) and each of its senders,
 * with how much of their mail is read. Big actions are confirmed with their count first; a sender's goes at once,
 * with an undo.
 */
const props = defineProps<{ smartInboxId: string }>()

const mail = useMailStore()
const bulk = useBulkStore()
const compose = useComposeStore()

const smartInbox = computed(() => mail.smartInboxes.find((item) => item.id === props.smartInboxId) ?? null)
const name = computed(() => smartInbox.value?.name ?? 'Smart inbox')
const stats = ref<SmartInboxSenders | null>(null)
const suggestion = ref<CleanupSuggestion | null>(null)
const loadError = ref<string | null>(null)
/** null: everything; otherwise only conversations older than this many days. */
const olderThanDays = ref<number | null>(null)
const pending = ref<{ request: BulkActionRequest; label: string; folderName?: string; question: string } | null>(null)
const counting = ref(false)

const busy = computed(() => bulk.busy || counting.value)
const subtitle = computed(() => {
  if (stats.value === null) {
    return ''
  }
  const senders = stats.value.senders.length
  return `${conversationCount(stats.value.conversations)} from ${senders === 1 ? 'one sender' : `${senders} senders`}, ${stats.value.unread.toLocaleString('en')} unread`
})
const moveTargets = computed(() => {
  const several = mail.accounts.length > 1
  return mail.allFolders
    .filter((folder) => folder.role !== 'drafts' && folder.role !== 'all')
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((folder) => ({
      id: folder.id,
      label: several ? `${folder.displayName} (${mail.accounts.find((account) => account.id === folder.mailAccountId)?.emailAddress ?? ''})` : folder.displayName,
    }))
})
const ageChoices = computed(() => [{ days: null, label: 'Everything' }, ...BULK_AGES.map((age) => ({ days: age.days, label: `Older than ${age.label}` }))])

async function load(): Promise<void> {
  loadError.value = null
  try {
    const [senders, suggestions] = await Promise.all([bulk.senders(props.smartInboxId), bulk.suggestions()])
    stats.value = senders
    suggestion.value = suggestions.suggestions.find((item) => item.smartInboxId === props.smartInboxId) ?? null
  } catch (error) {
    loadError.value = errorMessage(error)
  }
}
watch(() => props.smartInboxId, load, { immediate: true })

/** Counts what the action takes on the whole smart inbox, then asks before doing it. */
async function askEverything(action: BulkAction, folderId?: string): Promise<void> {
  const folder = folderId === undefined ? undefined : mail.allFolders.find((item) => item.id === folderId)
  const request: BulkActionRequest = {
    in: 'smartInbox',
    smartInboxId: props.smartInboxId,
    olderThanDays: olderThanDays.value,
    action,
    ...(folder === undefined ? {} : { folderId: folder.id, mailAccountId: folder.mailAccountId }),
  }
  counting.value = true
  try {
    const count = await bulk.count(request)
    if (count.conversations === 0) {
      compose.notify({ text: 'Nothing to do: no conversations match.', tone: 'info' })
      return
    }
    const age = BULK_AGES.find((choice) => choice.days === olderThanDays.value)
    const where = `in ${name.value}${age === undefined ? '' : ` with no new mail for over ${age.label}`}${folder === undefined || mail.accounts.length < 2 ? '' : ` in ${mail.accounts.find((account) => account.id === folder.mailAccountId)?.emailAddress ?? 'this account'}`}`
    const label = bulkActionLabel(action, count.conversations, folder?.displayName)
    pending.value = { request, label, folderName: folder?.displayName, question: `${label} ${where}?` }
  } catch (error) {
    compose.notify({ text: errorMessage(error), tone: 'error' })
  } finally {
    counting.value = false
  }
}

async function confirm(): Promise<void> {
  const asked = pending.value
  if (asked === null) {
    return
  }
  pending.value = null
  await bulk.start(asked.request, asked.folderName)
  await load()
}

/** A sender's conversations in this smart inbox, at once: the notice offers the undo. */
async function onSender(address: string, action: BulkAction): Promise<void> {
  await bulk.start({ in: 'smartInbox', smartInboxId: props.smartInboxId, sender: address, olderThanDays: olderThanDays.value, action })
  await load()
}

async function onSuggestion(item: CleanupSuggestion): Promise<void> {
  await bulk.start({ ...item.scope, action: item.action })
  await load()
}
</script>

<template>
  <section class="panel" :aria-label="`${name}: senders`">
    <header class="header">
      <RouterLink :to="{ name: 'smart-inbox', params: { smartInboxId } }" class="back"><AppIcon name="back" :size="14" />{{ name }}</RouterLink>
      <h1>Senders</h1>
      <p class="subtitle">{{ subtitle }}</p>
    </header>

    <div class="content">
      <div class="toolbar" role="toolbar" :aria-label="`Everything in ${name}`">
        <div class="ages" role="group" aria-label="Which conversations">
          <button
            v-for="choice in ageChoices"
            :key="choice.label"
            type="button"
            class="age"
            :aria-pressed="olderThanDays === choice.days"
            :disabled="busy"
            @click="olderThanDays = choice.days"
          >
            {{ choice.label }}
          </button>
        </div>
        <span class="spacer" />
        <button type="button" class="tool" :disabled="busy" @click="askEverything('markRead')"><AppIcon name="know" :size="15" />Mark read</button>
        <button type="button" class="tool" :disabled="busy" @click="askEverything('archive')"><AppIcon name="archive" :size="15" />Archive</button>
        <MenuButton label="Move" menu-label="Move to folder" icon="folder" :items="moveTargets" :disabled="busy" @choose="(id) => askEverything('move', id)" />
        <button type="button" class="tool danger" :disabled="busy" @click="askEverything('trash')"><AppIcon name="trash" :size="15" />Delete</button>
      </div>

      <div v-if="pending" class="confirm" role="alertdialog" aria-labelledby="bulk-question">
        <p id="bulk-question"><strong>{{ pending.question }}</strong></p>
        <p>Tresso works through them in batches. You can undo it once it is done.</p>
        <div class="actions">
          <button type="button" class="button button-primary" @click="confirm">{{ pending.label }}</button>
          <button type="button" class="button button-quiet" @click="pending = null">Cancel</button>
        </div>
      </div>

      <p v-if="bulk.progress" class="progress" role="status">
        {{ bulk.progress }}
        <button v-if="bulk.running" type="button" class="button button-quiet stop" @click="bulk.cancel()">Stop</button>
      </p>

      <div v-if="suggestion" class="suggested">
        <AppIcon name="shield" :size="16" />
        <span class="suggested-text"><strong>Suggested:</strong> {{ cleanupSuggestionText(suggestion, name).detail }}</span>
        <button type="button" class="button button-quiet outlined" :disabled="busy" @click="onSuggestion(suggestion)">{{ cleanupSuggestionText(suggestion, name).button }}</button>
      </div>

      <p v-if="loadError" class="error" role="alert">The senders could not be loaded: {{ loadError }}</p>
      <p v-else-if="stats === null" class="empty">Counting…</p>
      <p v-else-if="stats.senders.length === 0" class="empty">Nothing in this smart inbox.</p>

      <div v-else role="table" :aria-label="`Senders of ${name}, most conversations first`" class="table">
        <div role="row" class="row head">
          <span role="columnheader">Sender</span>
          <span role="columnheader">Conversations</span>
          <span role="columnheader">Read</span>
          <span role="columnheader"><span class="visually-hidden">Actions</span></span>
        </div>
        <div v-for="sender in stats.senders" :key="sender.address" role="row" class="row">
          <span role="cell" class="sender">
            <SenderAvatar :sender="{ name: sender.name, address: sender.address }" :size="30" />
            <span class="sender-text">
              <span class="sender-name">{{ senderName({ name: sender.name, address: sender.address }) }}</span>
              <span class="sender-address">{{ sender.address }}</span>
            </span>
          </span>
          <span role="cell" class="volume">
            <span class="bar" aria-hidden="true"><span :style="{ width: `${Math.round((sender.conversations / stats.senders[0]!.conversations) * 100)}%` }" /></span>
            <span class="mono">{{ sender.conversations.toLocaleString('en') }}</span>
          </span>
          <span role="cell" class="rate">
            <span class="mono">{{ readRate(sender) }}%</span>
            <span class="last">Last {{ shortTime(Date.parse(sender.lastReceivedAt)) }}</span>
          </span>
          <span role="cell" class="row-actions">
            <button v-if="sender.unread > 0" type="button" class="tool" :disabled="busy" :aria-label="`Mark mail from ${sender.address} read`" @click="onSender(sender.address, 'markRead')">
              Mark read
            </button>
            <button type="button" class="tool outlined" :disabled="busy" :aria-label="`Archive mail from ${sender.address}`" @click="onSender(sender.address, 'archive')">
              Archive
            </button>
            <button type="button" class="tool danger" :disabled="busy" :aria-label="`Delete mail from ${sender.address}`" @click="onSender(sender.address, 'trash')">
              <AppIcon name="trash" :size="15" />
            </button>
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: var(--glass-edge);
  border-left: 1px solid var(--line);
}
.header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 22px 24px 16px;
  border-bottom: 1px solid var(--line);
}
.back {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
  text-decoration: none;
}
h1 {
  margin: 0;
  font: 700 28px/34px var(--font-display);
}
.subtitle {
  margin: 0;
  color: var(--ink-2);
}
.content {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 24px 32px;
  overflow-y: auto;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: var(--raised);
}
.ages {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.age {
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
  cursor: pointer;
}
.age[aria-pressed='true'] {
  border-color: var(--focus);
  background: var(--selected);
  color: var(--focus);
}
.spacer {
  flex: 1;
}
.tool {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.tool:hover:not(:disabled) {
  background: var(--ground);
  color: var(--ink);
}
.tool:disabled,
.age:disabled {
  opacity: 0.5;
  cursor: default;
}
.outlined {
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--ink);
}
.danger {
  color: var(--danger);
}
.confirm {
  padding: 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-card);
}
.confirm p {
  margin: 0 0 8px;
}
.actions {
  display: flex;
  gap: 8px;
}
.progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--ink-2);
  font-weight: 600;
}
.suggested {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  padding: 12px 16px;
  border: 1px solid var(--do-soft);
  border-radius: var(--radius-card);
  background: var(--selected);
  color: var(--focus);
}
.suggested-text {
  flex: 1 1 300px;
  color: var(--ink);
}
.suggested-text strong {
  color: var(--focus);
}
.error {
  color: var(--danger);
}
.empty {
  color: var(--ink-3);
}
.table {
  display: flex;
  flex-direction: column;
}
.row {
  display: grid;
  grid-template-columns: minmax(0, 2.2fr) minmax(0, 1.2fr) minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  min-height: 52px;
  padding: 6px 0;
  border-top: 1px solid var(--line);
}
.row.head {
  min-height: 0;
  padding: 8px 0;
  border-top: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
}
.sender {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.sender-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.sender-name,
.sender-address {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sender-name {
  font-weight: 600;
}
.sender-address,
.last {
  font-size: 12px;
  color: var(--ink-2);
}
.volume {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bar {
  flex: 1;
  max-width: 120px;
  height: 6px;
  border-radius: 999px;
  background: var(--ground);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--ink-2);
}
.mono {
  font: 500 13px var(--font-mono);
}
.rate {
  display: flex;
  flex-direction: column;
}
.row-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

@media (max-width: 760px) {
  .row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .row.head,
  .volume,
  .rate {
    display: none;
  }
}
</style>
