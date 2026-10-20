<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { briefProgress, briefSender, groupBrief, threadsToNote, type BriefEntry, type BriefGrouping, type BriefView } from '@tresso/core'
import { shortTime } from '@/mail/format'
import { useBriefActions } from '@/mail/useBriefActions'
import { shortcutAllowed } from '@/mail/useMessageActions'
import { useBriefStore } from '@/stores/brief'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import AppIcon from '@/components/AppIcon.vue'
import SenderAvatar from '@/components/SenderAvatar.vue'

const mail = useMailStore()
// The sidebar names the next batch once the mail view loaded it; the brief does not ask for it again.
const brief = useBriefStore()
const compose = useComposeStore()
const route = useRoute()
const actions = useBriefActions()

const GROUPING_KEY = 'tresso.brief.grouping'

const briefId = computed(() => (typeof route.params.briefId === 'string' ? route.params.briefId : null))
const view = ref<BriefView | null>(null)
const loaded = ref(false)
const grouping = ref<BriefGrouping>(readGrouping())

/** Counts the loads, so one that finishes after a newer one does not put back what it read. */
let loads = 0

async function load(): Promise<void> {
  const load = ++loads
  const id = briefId.value ?? mail.dailyBriefs[0]?.id ?? null
  const next = id === null ? null : await mail.dailyBrief(id)
  if (load !== loads) {
    return
  }
  view.value = next
  loaded.value = mail.ready
  // Only the newest brief stops being new by being opened; looking at an older one leaves it new.
  if (next !== null && next.brief.id === mail.dailyBriefs[0]?.id) {
    brief.seen(next.brief.id)
  }
}

// The brief follows the copy: a conversation noted here or on another device shows as noted at once.
watch(
  () => [briefId.value, mail.dailyBriefs, mail.conversations, mail.latestBrief, mail.ready],
  () => {
    load().catch((error: unknown) => console.error('Reading the brief failed', error))
  },
  { immediate: true },
)
watch(grouping, (value) => {
  try {
    localStorage.setItem(GROUPING_KEY, value)
  } catch {
    // Without storage the choice lasts until the page closes.
  }
})

onMounted(() => {
  brief.load().catch(() => {
    // The next brief time is only a hint below the list; the brief itself comes from the copy.
  })
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const entries = computed(() => view.value?.entries ?? [])
const groups = computed(() => groupBrief(entries.value, grouping.value, mail.smartInboxes))
const progress = computed(() => briefProgress(entries.value))
const accountCount = computed(() => new Set(entries.value.map((entry) => entry.conversation.mailAccountId)).size)
const accountNames = computed(() => new Map(mail.accounts.map((account) => [account.id, account.displayName])))
const progressText = computed(() => {
  const { noted, total } = progress.value
  if (total === 0) {
    return ''
  }
  return noted === total ? `All ${total} noted` : `${noted} of ${total} noted`
})
const madeAt = computed(() => {
  const created = view.value?.brief.createdAt
  if (created === undefined) {
    return null
  }
  const date = new Date(created)
  return {
    iso: created,
    day: date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
    time: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  }
})
const nextBrief = computed(() => {
  const next = brief.settings?.nextBriefAt
  if (brief.settings === null) {
    return null
  }
  if (next === null || next === undefined) {
    return 'The daily brief is off.'
  }
  const date = new Date(next)
  return `The next brief arrives ${date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} at ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`
})
const earlier = computed(() => mail.dailyBriefs.filter((candidate) => candidate.id !== view.value?.brief.id))

function sender(entry: BriefEntry): { name: string | null; address: string } {
  return briefSender(entry.conversation) ?? { name: null, address: '' }
}

function senderLabel(entry: BriefEntry): string {
  const from = sender(entry)
  return from.name?.trim() || from.address || 'Unknown sender'
}

function smartInboxName(smartInboxId: string | null): string {
  return mail.smartInboxes.find((smartInbox) => smartInbox.id === smartInboxId)?.name ?? 'another smart inbox'
}

function noteAll(): void {
  const left = threadsToNote(entries.value)
  if (left.length > 0) {
    void actions.note(left)
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'K' || !event.shiftKey || !shortcutAllowed(event, compose.draft !== null && !compose.minimized)) {
    return
  }
  event.preventDefault()
  noteAll()
}

function readGrouping(): BriefGrouping {
  try {
    return localStorage.getItem(GROUPING_KEY) === 'sender' ? 'sender' : 'smartInbox'
  } catch {
    return 'smartInbox'
  }
}

function briefLabel(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}
</script>

<template>
  <div class="shell">

    <main class="main">
      <section class="panel" aria-labelledby="brief-title">
        <header class="header">
          <div class="heading">
            <span class="kind"><AppIcon name="know" :size="16" />Mail to just know</span>
            <h1 id="brief-title">Daily brief</h1>
            <span v-if="madeAt" class="made">
              <time :datetime="madeAt.iso">Brief for {{ madeAt.day }}, made at {{ madeAt.time }}</time>
              from {{ entries.length === 1 ? '1 conversation' : `${entries.length} conversations` }}
              across {{ accountCount === 1 ? '1 account' : `${accountCount} accounts` }}
            </span>
          </div>
          <div v-if="entries.length > 0" class="header-actions">
            <span class="progress" role="status">{{ progressText }}</span>
            <button type="button" class="button button-primary mark-all" :disabled="actions.busy.value || progress.noted === progress.total" @click="noteAll">
              Mark all noted<kbd>Shift K</kbd>
            </button>
          </div>
        </header>

        <div class="body">
          <div class="info">
            <AppIcon name="know" :size="16" />
            <span class="info-text">Nothing below asks anything of you. If one does, choose "Needs me" and it moves to To do.</span>
            <RouterLink :to="{ name: 'settings-brief' }" class="info-link">Brief settings</RouterLink>
          </div>

          <p v-if="!loaded && view === null" class="empty" role="status">Loading the brief…</p>
          <p v-else-if="view === null && briefId !== null" class="empty">This brief is no longer here. Tresso keeps the last two weeks of briefs.</p>
          <div v-else-if="view === null" class="empty">
            <p>No brief yet. Once a day, mail that is good to know but asks nothing of you is gathered here, so it stays out of the way until then.</p>
            <p v-if="nextBrief">{{ nextBrief }}</p>
          </div>
          <p v-else-if="entries.length === 0" class="empty">Everything in this brief is gone from this device.</p>

          <template v-if="entries.length > 0">
            <div class="toolbar">
              <div role="radiogroup" aria-label="Group the brief" class="segmented">
                <button type="button" role="radio" :aria-checked="grouping === 'smartInbox'" @click="grouping = 'smartInbox'">Per smart inbox</button>
                <button type="button" role="radio" :aria-checked="grouping === 'sender'" @click="grouping = 'sender'">Per sender</button>
              </div>
            </div>

            <section v-for="group in groups" :key="group.key" class="group" :aria-label="group.label">
              <h2 class="group-title">{{ group.label }} <span class="group-count">{{ group.entries.length }}</span></h2>
              <ul class="items">
                <li v-for="entry in group.entries" :key="entry.conversation.threadId" class="item" :class="{ done: entry.noted || entry.moved }">
                  <SenderAvatar :sender="sender(entry)" :size="32" />
                  <span class="text">
                    <span class="subject">{{ entry.conversation.subject || '(no subject)' }}</span>
                    <span v-if="entry.conversation.snippet" class="snippet">{{ entry.conversation.snippet }}</span>
                    <span class="meta">
                      <span class="from">{{ senderLabel(entry) }}</span>
                      <span>{{ accountNames.get(entry.conversation.mailAccountId) ?? '' }}</span>
                      <span>{{ shortTime(entry.conversation.lastMessageAt) }}</span>
                    </span>
                  </span>
                  <span class="item-actions">
                    <template v-if="entry.moved">
                      <span class="moved-chip">Moved to {{ smartInboxName(entry.conversation.smartInboxId) }}</span>
                      <RouterLink :to="{ name: 'unified-thread', params: { threadId: entry.conversation.threadId } }" class="button open">Open</RouterLink>
                    </template>
                    <template v-else-if="entry.noted">
                      <span class="noted-chip"><AppIcon name="do" :size="14" />Noted</span>
                      <button
                        v-if="actions.undoable.value.has(entry.conversation.threadId)"
                        type="button"
                        class="button button-quiet"
                        :disabled="actions.busy.value"
                        @click="actions.undo([entry.conversation.threadId])"
                      >
                        Undo
                      </button>
                    </template>
                    <template v-else>
                      <button type="button" class="button button-quiet" :disabled="actions.busy.value" @click="actions.needsMe(entry.conversation.threadId)">Needs me</button>
                      <RouterLink :to="{ name: 'unified-thread', params: { threadId: entry.conversation.threadId } }" class="button open">Open</RouterLink>
                      <button type="button" class="button noted" :disabled="actions.busy.value" @click="actions.note([entry.conversation.threadId])">
                        <AppIcon name="know" :size="14" />Noted
                      </button>
                    </template>
                  </span>
                </li>
              </ul>
            </section>

            <p class="footer">
              Noted emails are marked read and archived.<template v-if="nextBrief"> {{ nextBrief }}</template>
            </p>
          </template>

          <nav v-if="earlier.length > 0" class="earlier" aria-label="Earlier briefs">
            <span>Earlier briefs:</span>
            <RouterLink v-for="item in earlier" :key="item.id" :to="{ name: 'brief-edition', params: { briefId: item.id } }">{{ briefLabel(item.createdAt) }}</RouterLink>
          </nav>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.main {
  min-width: 0;
  min-height: 0;
  padding: 16px 16px 16px 0;
  display: flex;
}
.panel {
  flex: 1;
  min-width: 0;
  background: var(--surface);
  border-radius: var(--radius-panel);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 16px;
  padding: 24px 32px 18px;
  border-bottom: 1px solid var(--line);
}
.heading {
  flex: 1 1 320px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kind {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--know);
}
h1 {
  margin: 0;
  font: 700 30px/36px var(--font-display);
}
.made,
.progress {
  font-size: 14px;
  color: var(--ink-2);
}
.progress {
  font-size: 13px;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.mark-all {
  height: 40px;
  padding: 0 16px;
  font-size: 14px;
  gap: 10px;
}
.mark-all kbd {
  font: 500 11px var(--font-mono);
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--surface) 20%, transparent);
}
.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 980px;
  width: 100%;
  box-sizing: border-box;
  padding: 20px 32px 28px;
}
.info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  padding: 12px 16px;
  border: 1px solid color-mix(in srgb, var(--know) 30%, transparent);
  background: var(--know-soft);
  border-radius: var(--radius-card);
  color: var(--know);
}
.info-text {
  flex: 1 1 300px;
  font-size: 14px;
  line-height: 21px;
  color: var(--ink);
}
.info-link {
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  color: var(--focus);
}
.empty {
  margin: 0;
  color: var(--ink-2);
}
.empty p {
  margin: 0 0 8px;
}
.toolbar {
  display: flex;
  justify-content: flex-end;
}
.segmented {
  display: flex;
  padding: 3px;
  border-radius: 8px;
  background: var(--ground);
}
.segmented button {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  font: 600 12px var(--font-ui);
  cursor: pointer;
}
.segmented button[aria-checked='true'] {
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 1px 2px rgb(22 24 29 / 8%);
}
.group-title {
  margin: 4px 0 8px;
  font-size: 14px;
  font-weight: 600;
}
.group-count {
  color: var(--ink-3);
  font-weight: 500;
}
.items {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
}
.item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
.item:last-child {
  border-bottom: 0;
}
.item.done {
  background: color-mix(in srgb, var(--ground) 40%, var(--surface));
}
.text {
  flex: 1 1 360px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.subject {
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
}
.snippet {
  font-size: 14px;
  line-height: 20px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.done .subject,
.done .snippet {
  color: var(--ink-2);
  font-weight: 500;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 12px;
  color: var(--ink-2);
}
.from {
  font-weight: 600;
}
.item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.item-actions .button {
  height: 32px;
  padding: 0 10px;
}
.open {
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--ink);
  text-decoration: none;
}
.noted {
  border: 1.5px solid var(--know);
  background: var(--know-soft);
  color: var(--know);
  gap: 6px;
}
.moved-chip {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--do-soft);
  color: var(--do);
  font-size: 12px;
  font-weight: 600;
}
.noted-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--know-soft);
  color: var(--know);
  font-size: 12px;
  font-weight: 600;
}
.footer {
  margin: 0;
  font-size: 13px;
  color: var(--ink-2);
}
.earlier {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  font-size: 13px;
  color: var(--ink-2);
}
.earlier a {
  color: var(--focus);
  font-weight: 600;
  text-decoration: none;
}

@media (max-width: 760px) {
  .main {
    padding: 0;
  }
  .panel {
    border-radius: 0;
  }
  .header,
  .body {
    padding-left: 16px;
    padding-right: 16px;
  }
}
</style>
