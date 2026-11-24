<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, type RouteLocationRaw } from 'vue-router'
import {
  ACTIVITY_KIND_LABELS,
  ACTIVITY_RESULT_LABELS,
  activityAppName,
  activityTime,
  durationText,
  permissionUsed,
  touched,
  type AppActivityEntry,
  type AppActivityKind,
  type AppActivityPeriod,
  type AppActivityResult,
} from '@tresso/core'
import { errorMessage } from '@/api/errors'
import LogoLoader from '@/components/LogoLoader.vue'
import { useAppActivityStore, type AppActivityFilters } from '@/stores/appActivity'

/**
 * Settings, Apps, Activity log (the "Settings: apps, activity log" board): everything apps and AI assistants did
 * through MCP and the API, newest first, with filters by app, kind, result and period. A row opens to show the
 * permission used, what was touched, how it came in and why it was refused or failed. The log holds no content.
 */
const store = useAppActivityStore()
const route = useRoute()

const app = ref(typeof route.query.app === 'string' ? route.query.app : 'all')
const kind = ref<'all' | AppActivityKind>('all')
const result = ref<'all' | AppActivityResult>('all')
const period = ref<AppActivityPeriod>('24h')
const PERIODS: [AppActivityPeriod, string][] = [
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['90d', 'Last 90 days'],
]

const filters = computed<AppActivityFilters>(() => ({
  period: period.value,
  app: app.value === 'all' ? undefined : app.value,
  kind: kind.value === 'all' ? undefined : kind.value,
  result: result.value === 'all' ? undefined : result.value,
}))

const loading = ref(true)
const loadError = ref<string | null>(null)
const loadingMore = ref(false)
const open = ref<string | null>(null)
const now = ref(new Date())

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  open.value = null
  try {
    await store.load(filters.value)
  } catch (cause) {
    loadError.value = errorMessage(cause)
  } finally {
    now.value = new Date()
    loading.value = false
  }
}
onMounted(load)
watch(filters, load)

async function more(): Promise<void> {
  loadingMore.value = true
  loadError.value = null
  try {
    await store.more(filters.value)
  } catch (cause) {
    loadError.value = errorMessage(cause)
  } finally {
    loadingMore.value = false
  }
}

/** Nothing at all in the log (no app has an entry in 90 days), as opposed to nothing that matches the filters. */
const empty = computed(() => store.apps.length === 0 && store.entries.length === 0)
const countLabel = computed(() => (store.entries.length === 1 ? '1 entry' : `${store.entries.length} entries`))

function manage(entry: AppActivityEntry): { to: RouteLocationRaw; label: string } {
  if (entry.channel === 'mcp' && entry.app.type === 'client') {
    return {
      to: { name: 'settings-apps-assistants', query: entry.app.connectedAppId === null ? {} : { app: entry.app.connectedAppId } },
      label: `Change what ${activityAppName(entry.app)} may do`,
    }
  }
  return { to: { name: entry.app.type === 'token' ? 'settings-access-tokens' : 'settings-connected-apps' }, label: 'Open tokens and connected apps' }
}

const SKELETON = [
  ['88px', '52%'],
  ['64px', '38%'],
  ['112px', '60%'],
  ['72px', '44%'],
  ['96px', '56%'],
  ['64px', '34%'],
]
</script>

<template>
  <section class="activity" aria-labelledby="activity-title">
    <header class="header">
      <RouterLink :to="{ name: 'settings-apps' }" class="back" aria-label="Back to apps">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>
      </RouterLink>
      <div class="heading">
        <h2 id="activity-title" class="title">Activity log</h2>
        <span class="lead">Everything AI assistants and apps did with your Tresso, through MCP and the API.</span>
      </div>
    </header>

    <section aria-label="What the log keeps" class="panel keeps">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 018 0v3"></path></svg>
      <span>The log keeps the time, the app, the action, the result, and the kind and id of what was touched. It does not keep message text, file content or the addresses of other people. Entries are removed after 90 days.</span>
    </section>

    <section aria-labelledby="log-title" class="panel log">
      <div class="filters">
        <h3 id="log-title">Entries</h3>
        <span class="field-wrap">
          <label for="log-app">App</label>
          <select id="log-app" v-model="app" class="app-select">
            <option value="all">All apps</option>
            <option v-for="known in store.apps" :key="known.key" :value="known.key">{{ activityAppName(known) }}</option>
            <option v-if="app !== 'all' && !store.apps.some((known) => known.key === app)" :value="app">This app</option>
          </select>
        </span>
        <span class="field-wrap">
          <label for="log-kind">Kind</label>
          <select id="log-kind" v-model="kind">
            <option value="all">All kinds</option>
            <option v-for="(label, value) in ACTIVITY_KIND_LABELS" :key="value" :value="value">{{ label }}</option>
          </select>
        </span>
        <span class="field-wrap">
          <label for="log-result">Result</label>
          <select id="log-result" v-model="result">
            <option value="all">All results</option>
            <option v-for="(label, value) in ACTIVITY_RESULT_LABELS" :key="value" :value="value">{{ label }}</option>
          </select>
        </span>
        <span class="field-wrap">
          <label for="log-period">Period</label>
          <select id="log-period" v-model="period" class="period-select">
            <option v-for="[value, label] in PERIODS" :key="value" :value="value">{{ label }}</option>
          </select>
        </span>
      </div>

      <p v-if="loadError" class="form-error" role="alert">{{ loadError }}</p>

      <div v-if="loading" role="status" aria-label="Loading the log" class="loading">
        <span class="loading-line"><LogoLoader /> Loading the log</span>
        <div v-for="(widths, index) in SKELETON" :key="index" aria-hidden="true" class="skeleton">
          <span class="bar time" />
          <span class="bar" :style="{ width: widths[0] }" />
          <span class="grow"><span class="bar" :style="{ width: widths[1] }" /></span>
          <span class="chip short" />
          <span class="chip" />
          <span class="bar tiny" />
        </div>
      </div>

      <div v-else-if="empty && !loadError" class="empty">
        <span class="empty-mark" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"></path></svg>
        </span>
        <span class="empty-title">Nothing in the log yet</span>
        <span class="empty-line">When an AI assistant or an app uses your Tresso through MCP or the API, every action shows up here.</span>
        <RouterLink :to="{ name: 'settings-apps-assistants' }" class="empty-link">Add an AI assistant</RouterLink>
      </div>

      <template v-else-if="!loadError">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">App</th>
              <th scope="col">Action</th>
              <th scope="col">Kind</th>
              <th scope="col">Result</th>
              <th scope="col" class="right">Duration</th>
              <th scope="col"><span class="visually-hidden">Details</span></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="entry in store.entries" :key="entry.id">
              <tr :class="{ opened: open === entry.id }">
                <td class="mono nowrap">{{ activityTime(entry.occurredAt, now) }}</td>
                <td class="app-cell">{{ activityAppName(entry.app) }}</td>
                <td>
                  <span class="action">
                    <span class="action-title">{{ entry.action.title }}</span>
                    <span class="action-name">{{ entry.action.name }}</span>
                  </span>
                </td>
                <td><span class="kind">{{ ACTIVITY_KIND_LABELS[entry.kind] }}</span></td>
                <td>
                  <span class="result-cell">
                    <span class="result" :class="entry.result">{{ ACTIVITY_RESULT_LABELS[entry.result] }}</span>
                    <span v-if="entry.reason" class="reason" :class="entry.result">{{ entry.reason.label }}</span>
                  </span>
                </td>
                <td class="mono nowrap right">{{ durationText(entry.durationMs) }}</td>
                <td class="toggle-cell">
                  <button
                    type="button"
                    class="toggle"
                    :aria-expanded="open === entry.id ? 'true' : 'false'"
                    :aria-controls="`detail-${entry.id}`"
                    :aria-label="`Details of ${entry.action.title} by ${activityAppName(entry.app)} at ${activityTime(entry.occurredAt, now)}`"
                    @click="open = open === entry.id ? null : entry.id"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" :class="{ flipped: open === entry.id }"><path d="M6 9l6 6 6-6"></path></svg>
                  </button>
                </td>
              </tr>
              <tr v-if="open === entry.id" :id="`detail-${entry.id}`" class="detail-row">
                <td colspan="7">
                  <div class="detail-grid">
                    <div class="fact">
                      <span class="fact-label">Permission used</span>
                      <span class="fact-value">{{ permissionUsed(entry).label }}</span>
                      <span class="fact-mono">{{ permissionUsed(entry).scopes }}</span>
                    </div>
                    <div class="fact">
                      <span class="fact-label">What it touched</span>
                      <span class="fact-value">{{ touched(entry).label }}</span>
                      <span class="fact-mono">{{ touched(entry).id }}</span>
                    </div>
                    <div class="fact">
                      <span class="fact-label">Came in through</span>
                      <span class="fact-value">{{ entry.channel === 'mcp' ? 'MCP' : 'API' }}</span>
                    </div>
                  </div>
                  <div v-if="entry.reason" class="why" :class="entry.result">
                    <strong>{{ entry.result === 'failed' ? 'Why it failed.' : 'Why it was refused.' }}</strong> {{ entry.reason.sentence }}
                  </div>
                  <div class="detail-foot">
                    <span>Only the kind and the id are kept. The content of what was touched is not in the log.</span>
                    <RouterLink :to="manage(entry).to">{{ manage(entry).label }}</RouterLink>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>

        <div v-if="store.entries.length === 0" role="status" class="no-match">
          <span class="no-match-title">No entries match these filters</span>
          <span class="no-match-line">Choose another app, kind or result, or a longer period.</span>
        </div>

        <div v-else class="foot">
          <span class="count" role="status">{{ countLabel }}</span>
          <button v-if="store.nextCursor !== null" type="button" class="button older" :disabled="loadingMore" @click="more">Show older entries</button>
        </div>
      </template>
    </section>
  </section>
</template>

<style scoped>
.activity {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1040px;
}
.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 0 4px;
}
.back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-control);
  color: var(--ink-2);
}
.heading {
  display: flex;
  flex: 1 1 300px;
  flex-direction: column;
  gap: 2px;
}
.title {
  margin: 0;
  font: 700 28px/34px var(--font-display);
}
.lead {
  font-size: 14px;
  color: var(--ink-2);
}
.panel {
  border-radius: var(--radius-panel);
  background: var(--paper);
}
.keeps {
  display: flex;
  gap: 12px;
  padding: 14px 20px;
  font-size: 13px;
  line-height: 19px;
}
.keeps svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--ink-2);
}
.log {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px 12px;
}
.filters h3 {
  flex: 1 1 120px;
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 34px;
}
.field-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-wrap label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
}
.field-wrap select {
  min-width: 112px;
  height: 34px;
  padding: 0 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--paper);
  color: var(--ink);
  font: 500 13px var(--font-ui);
}
.field-wrap select.app-select {
  min-width: 168px;
}
.field-wrap select.period-select {
  min-width: 136px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th {
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
}
th:first-child,
td:first-child {
  padding-left: 0;
}
td {
  padding: 8px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
tr.opened {
  background: var(--ground);
}
.mono {
  font: 400 12px/19px var(--font-mono);
}
.nowrap {
  white-space: nowrap;
}
.right {
  text-align: right;
}
.app-cell {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.action {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.action-title {
  font-weight: 500;
}
.action-name {
  font: 400 11px var(--font-mono);
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.kind,
.result {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--canvas);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
}
.result-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}
.result.done {
  background: var(--know-soft);
  color: var(--know);
}
.result.refused {
  background: var(--delegate-soft);
  color: var(--delegate);
}
.result.failed {
  background: var(--danger-soft);
  color: var(--danger);
}
.reason {
  font-size: 12px;
  line-height: 17px;
}
.reason.refused {
  color: var(--delegate);
}
.reason.failed {
  color: var(--danger);
}
.toggle-cell {
  padding: 4px 0;
  text-align: right;
}
.toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
}
.flipped {
  transform: rotate(180deg);
}
.detail-row td {
  padding: 0 0 12px;
  background: var(--ground);
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px 20px;
  padding: 12px 12px 0;
}
.fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.fact-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
}
.fact-value {
  font-size: 13px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.fact-mono {
  font: 400 11px var(--font-mono);
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.why {
  margin: 12px 12px 0;
  padding: 10px 12px;
  border-radius: var(--radius-card);
  font-size: 13px;
  line-height: 19px;
}
.why.refused {
  background: var(--delegate-soft);
  color: var(--ink);
}
.why.failed {
  background: var(--danger-soft);
  color: var(--danger);
}
.why strong {
  font-weight: 600;
}
.detail-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 10px 12px 0;
}
.detail-foot span {
  flex: 1 1 260px;
  font-size: 12px;
  line-height: 17px;
  color: var(--ink-2);
}
.detail-foot a,
.empty-link {
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
.no-match,
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 28px 12px 20px;
  text-align: center;
}
.empty {
  gap: 6px;
  padding: 40px 12px 32px;
  border-top: 1px solid var(--line);
}
.no-match-title {
  font-size: 14px;
  font-weight: 600;
}
.no-match-line,
.empty-line {
  font-size: 13px;
  line-height: 19px;
  color: var(--ink-2);
}
.empty-line {
  max-width: 440px;
}
.empty-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  margin-bottom: 6px;
  border-radius: 999px;
  background: var(--canvas);
  color: var(--ink-2);
}
.empty-title {
  font-size: 15px;
  font-weight: 600;
}
.empty-link {
  padding-top: 6px;
}
.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.count {
  flex: 1 1 200px;
  font-size: 13px;
  color: var(--ink-2);
}
.older {
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
}
.loading {
  display: flex;
  flex-direction: column;
}
.loading-line {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0 10px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
  color: var(--ink-2);
}
.skeleton {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 44px;
  border-bottom: 1px solid var(--line);
  animation: pulse 1.6s ease-in-out infinite;
}
.bar {
  width: 40px;
  height: 10px;
  border-radius: 999px;
  background: var(--line-strong);
}
.bar.time {
  width: 64px;
}
.grow {
  display: flex;
  flex: 1;
}
.chip {
  width: 56px;
  height: 18px;
  border-radius: 999px;
  background: var(--ground);
}
.chip.short {
  width: 48px;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .skeleton {
    animation: none;
  }
}
</style>
