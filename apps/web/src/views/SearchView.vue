<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { SCAN_TEXT, searchDay, searchFilters, withSearchFilter, type SearchAttachment, type SearchFilterName, type SearchHit, type SyncedFolder } from '@tresso/core'
import { fileSize, shortTime } from '@/mail/format'
import { useMailStore } from '@/stores/mail'
import { useSearchStore } from '@/stores/search'
import AppIcon from '@/components/AppIcon.vue'
import HighlightText from '@/components/HighlightText.vue'
import SearchField from '@/components/SearchField.vue'

const mail = useMailStore()
const search = useSearchStore()
const route = useRoute()
const router = useRouter()

const query = computed(() => (typeof route.query.q === 'string' ? route.query.q : ''))
const folders = ref(new Map<string, SyncedFolder>())

watch(query, (q) => void search.run(q), { immediate: true })
watch(
  () => mail.accounts,
  async () => {
    folders.value = new Map((await mail.folders()).map((folder) => [folder.id, folder]))
  },
  { immediate: true },
)

const filters = computed(() => searchFilters(query.value))

/** The value of the last filter with this name; the API applies all of them, the chips show the last. */
function lastFilter(name: SearchFilterName): string | undefined {
  const matching = filters.value.filter((filter) => filter.name === name)
  return matching[matching.length - 1]?.value
}
const accountFilter = computed(() => {
  const value = lastFilter('in')?.toLowerCase()
  return mail.accounts.find((account) => account.emailAddress === value)?.emailAddress ?? ''
})
const hasAttachment = computed(() => filters.value.some((filter) => filter.name === 'has'))

const periods = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 3 months', days: 91 },
  { label: 'Last year', days: 365 },
]
const periodOptions = computed(() => {
  const now = new Date()
  const options = periods.map((period) => ({ label: period.label, value: searchDay(now, period.days) }))
  const after = lastFilter('after')
  if (after !== undefined && !options.some((option) => option.value === after)) {
    options.push({ label: `Since ${after}`, value: after })
  }
  return options
})
const periodFilter = computed(() => lastFilter('after') ?? '')

function refine(next: string): void {
  const q = next.trim()
  void router.push(q === '' ? { name: 'unified' } : { name: 'search', query: { q } })
}

const matchedAttachments = computed(() =>
  search.hits.flatMap((hit) => hit.attachments.filter((attachment) => attachment.matched).map((attachment) => ({ hit, attachment }))),
)

const summary = computed(() => {
  const emails = `${search.totalHits} ${search.totalHits === 1 ? 'email' : 'emails'}`
  const attachments = matchedAttachments.value.length
  return attachments === 0 ? emails : `${emails}, ${attachments} ${attachments === 1 ? 'attachment' : 'attachments'}`
})

function accountName(hit: SearchHit): string {
  return mail.accounts.find((account) => account.id === hit.accountId)?.displayName ?? ''
}

function folderName(hit: SearchHit): string | null {
  const names = hit.folderIds.map((id) => folders.value.get(id)?.displayName).filter((name): name is string => name !== undefined)
  return names[0] ?? null
}

function shownAttachment(hit: SearchHit): SearchAttachment | null {
  return hit.attachments.find((attachment) => attachment.matched) ?? hit.attachments[0] ?? null
}

function plain(segments: { text: string }[]): string {
  return segments.map((segment) => segment.text).join('')
}

function extension(attachment: SearchAttachment): string {
  const name = plain(attachment.filename)
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot >= name.length - 6 ? name.slice(dot + 1).toUpperCase() : 'FILE'
}

function threadLink(hit: SearchHit) {
  return { name: 'unified-thread', params: { threadId: hit.threadId } }
}
</script>

<template>
  <div class="shell">

    <main class="main">
      <section class="results" aria-label="Search results">
        <header class="header">
          <SearchField :query="query" autofocus />
          <div class="filters">
            <label class="chip">
              <span class="visually-hidden">Account</span>
              <select :value="accountFilter" @change="refine(withSearchFilter(query, 'in', ($event.target as HTMLSelectElement).value || null))">
                <option value="">All accounts</option>
                <option v-for="account in mail.accounts" :key="account.id" :value="account.emailAddress">{{ account.displayName }}</option>
              </select>
            </label>
            <button
              type="button"
              class="chip"
              :aria-pressed="hasAttachment ? 'true' : 'false'"
              @click="refine(withSearchFilter(query, 'has', hasAttachment ? null : 'attachment'))"
            >
              <AppIcon name="attachment" :size="14" />
              Has attachment
            </button>
            <label class="chip" :class="{ on: periodFilter !== '' }">
              <span class="visually-hidden">Received</span>
              <select :value="periodFilter" @change="refine(withSearchFilter(query, 'after', ($event.target as HTMLSelectElement).value || null))">
                <option value="">Any time</option>
                <option v-for="option in periodOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <span class="spacer" />
            <span v-if="!search.loading && search.error === null" class="summary" aria-live="polite">{{ summary }}</span>
          </div>
        </header>

        <p v-if="search.error" class="problem" role="alert">{{ search.error }}</p>

        <div v-else class="columns">
          <section aria-label="Emails" class="emails">
            <h2>Emails</h2>
            <ul v-if="search.hits.length > 0" class="list">
              <li v-for="hit in search.hits" :key="hit.id">
                <RouterLink :to="threadLink(hit)" class="row" :class="{ unread: !hit.seen }">
                  <span class="dot" :aria-label="hit.seen ? undefined : 'Unread'" />
                  <span class="body">
                    <span class="top">
                      <span class="subject">
                        <HighlightText v-if="plain(hit.subject) !== ''" :segments="hit.subject" />
                        <template v-else>(no subject)</template>
                      </span>
                      <span class="time">{{ shortTime(Date.parse(hit.receivedAt)) }}</span>
                    </span>
                    <span class="preview">
                      <span class="from"><HighlightText :segments="hit.from" /></span>
                      <HighlightText :segments="hit.preview" />
                    </span>
                    <span class="tags">
                      <span v-if="accountName(hit)" class="tag">{{ accountName(hit) }}</span>
                      <span v-if="folderName(hit)" class="tag">{{ folderName(hit) }}</span>
                      <span v-if="hit.flagged" class="file"><AppIcon name="flag" :size="13" label="Flagged" /></span>
                      <span v-if="shownAttachment(hit)" class="file">
                        <AppIcon name="attachment" :size="13" />
                        <HighlightText :segments="shownAttachment(hit)!.filename" />
                      </span>
                    </span>
                  </span>
                </RouterLink>
              </li>
            </ul>
            <p v-else-if="search.loading" class="empty">Searching…</p>
            <p v-else class="empty">No mail matches this search.</p>
            <button v-if="search.page < search.totalPages" type="button" class="button button-quiet more" :disabled="search.loading" @click="search.more()">
              Show more results
            </button>
          </section>

          <aside class="side">
            <section v-if="matchedAttachments.length > 0" aria-label="Matching attachments" class="attachments">
              <h2>Attachments</h2>
              <RouterLink
                v-for="{ hit, attachment } in matchedAttachments"
                :key="attachment.id"
                :to="threadLink(hit)"
                class="attachment"
                :class="{ blocked: attachment.scanStatus === 'infected' }"
              >
                <span v-if="attachment.scanStatus === 'infected'" class="extension"><AppIcon name="shieldAlert" :size="16" label="Blocked: contains malware" /></span>
                <span v-else class="extension">{{ extension(attachment) }}</span>
                <span class="attachment-text">
                  <span class="attachment-name"><HighlightText :segments="attachment.filename" /></span>
                  <span class="attachment-meta">
                    {{ fileSize(attachment.size) }}, {{ shortTime(Date.parse(hit.receivedAt))
                    }}<template v-if="attachment.scanStatus !== null && attachment.scanStatus !== 'clean'">, {{ SCAN_TEXT[attachment.scanStatus] }}</template>
                  </span>
                </span>
              </RouterLink>
            </section>
            <p class="tip">
              Tip: combine <code>from:anna</code>, <code>has:attachment</code>, <code>in:archive</code> or <code>before:2026-10-01</code>
              with any words. Press <kbd>/</kbd> to search from anywhere.
            </p>
          </aside>
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
.results {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: var(--radius-panel);
  overflow: hidden;
}
.header {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--line);
}
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink);
  font: 600 13px var(--font-ui);
  cursor: pointer;
}
.chip select {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.chip[aria-pressed='true'],
.chip.on {
  border-color: var(--ink);
  background: var(--ink);
  color: var(--surface);
}
.chip.on option {
  color: var(--ink);
  background: var(--surface);
}
.spacer {
  flex: 1;
}
.summary {
  font-size: 13px;
  color: var(--ink-2);
}
.problem {
  margin: 0;
  padding: 18px 24px;
  color: var(--danger);
}
.columns {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 24px;
  padding: 18px 24px 24px;
}
h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
}
.emails {
  flex: 1.7 1 440px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
}
.list li + li {
  border-top: 1px solid var(--line);
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  color: var(--ink);
  text-decoration: none;
}
.row:hover {
  background: var(--ground);
}
.dot {
  width: 8px;
  height: 8px;
  margin-top: 7px;
  border-radius: 999px;
  flex-shrink: 0;
}
.unread .dot {
  background: var(--unread);
}
.body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.top {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.subject {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.unread .subject {
  font-weight: 600;
}
.time {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-2);
}
.preview {
  font-size: 13px;
  line-height: 19px;
  color: var(--ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.from {
  margin-right: 6px;
  color: var(--ink);
  font-weight: 500;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
}
.tag {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
}
.file {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 12px;
  color: var(--ink-2);
}
.empty {
  margin: 0;
  padding: 24px 0;
  color: var(--ink-3);
}
.more {
  align-self: flex-start;
}
.side {
  flex: 1 1 280px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.attachments {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.attachment {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  color: var(--ink);
  text-decoration: none;
}
.attachment:hover {
  background: var(--ground);
}
.extension {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: var(--radius-control);
  background: var(--ground);
  color: var(--ink-2);
  font: 500 10px var(--font-mono);
}
.blocked .extension {
  background: var(--danger-soft);
  color: var(--danger);
}
.blocked .attachment-meta {
  color: var(--danger);
}
.attachment-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.attachment-name {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.attachment-meta {
  font-size: 12px;
  color: var(--ink-2);
}
.tip {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--ink-2);
}
.tip code,
.tip kbd {
  font: 500 12px var(--font-mono);
}

@media (max-width: 760px) {
  .main {
    padding: 0;
  }
  .results {
    border-radius: 0;
  }
  .header,
  .columns {
    padding-left: 16px;
    padding-right: 16px;
  }
}
</style>
