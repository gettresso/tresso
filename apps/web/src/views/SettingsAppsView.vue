<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { activeText, permissionLine, personalAccessTokenStatus, phoneLabel } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { appPill, appRows, teamsEmpty, type ProviderApp } from '@/calendar/meetingSettings'
import { phoneNumber } from '@/components/chat/whatsappTexts'
import { appInitials } from '@/components/apps/appMarks'
import LogoLoader from '@/components/LogoLoader.vue'
import { chatsFromServer } from '@/platform/whatsapp'
import { useAccountsStore } from '@/stores/accounts'
import { useAppActivityStore } from '@/stores/appActivity'
import { useAuthStore } from '@/stores/auth'
import { useCalendarStore } from '@/stores/calendar'
import { useChatsStore } from '@/stores/chats'
import { useConnectedAppsStore } from '@/stores/connectedApps'
import { useMeetingAppsStore } from '@/stores/meetingApps'
import { usePersonalAccessTokensStore } from '@/stores/personalAccessTokens'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'

/**
 * Settings, Apps (the "Settings: apps" board): everything connected to Tresso on one page, in two groups by the
 * direction of access, with a category filter on top. A row only shows what the app's own page says and leads there;
 * nothing is connected, changed or revoked here. Rows for things the product does not have are not shown (webhooks);
 * Zoom is listed as not available yet. Every app the user allowed through OAuth is one row of its own, which leads to
 * the AI assistants and apps page.
 */
type Category = 'meetings' | 'messaging' | 'ai' | 'developer'
type Filter = 'all' | Category
type State = 'ok' | 'attention' | 'off' | 'soon' | 'add'
type Mark = 'video' | 'link' | 'key' | 'plus' | 'text'

interface Row {
  key: string
  cat: Category
  name: string
  mark: Mark
  initials?: string
  /** WhatsApp's own colours. */
  whatsapp?: boolean
  line: string
  state: State
  detail: string
  to?: RouteLocationRaw
}

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['meetings', 'Meetings'],
  ['messaging', 'Messaging'],
  ['ai', 'AI assistants and apps'],
  ['developer', 'Developer'],
]
/** The line of an app with every permission switched off: what it can still read needs no permission. */
const NOTHING_ALLOWED = 'Every permission is switched off. It can still see your name, email address and organizations.'
const CATEGORY_LABELS: Record<Category, string> = { meetings: 'Meetings', messaging: 'Messaging', ai: 'AI assistants and apps', developer: 'Developer' }

const accounts = useAccountsStore()
const calendar = useCalendarStore()
const meetingApps = useMeetingAppsStore()
const chats = useChatsStore()
const whatsapp = useWhatsAppRelayStore()
const connectedApps = useConnectedAppsStore()
const tokens = usePersonalAccessTokensStore()
const activity = useAppActivityStore()

const auth = useAuthStore()
const loading = ref(true)
const loadError = ref<string | null>(null)
const lastActive = ref<Record<string, string>>({})
const filter = ref<Filter>('all')
const now = ref(new Date())

onMounted(async () => {
  const results = await Promise.allSettled([
    meetingApps.reload(),
    accounts.load(),
    connectedApps.load(),
    tokens.load(),
    whatsapp.ready(),
    activity.lastActive().then((last) => (lastActive.value = last)),
  ])
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  loadError.value = failed === undefined ? null : errorMessage(failed.reason)
  now.value = new Date()
  loading.value = false
})

// The desktop app signs another user in without a reload: nothing of the previous one may show meanwhile.
watch(
  () => auth.generation,
  () => (lastActive.value = {}),
)

function meetingRow(app: ProviderApp): Row | null {
  const prefs = meetingApps.preferences
  if (prefs === null || !prefs.apps.includes(app)) return null
  const rows = appRows(app, accounts.accounts, calendar.calendars, prefs)
  const pill = appPill(rows)
  const base = app === 'meet'
    ? { key: 'meet', name: 'Google Meet', line: 'Makes meeting links on Google calendars.', empty: 'No Google account yet' }
    : { key: 'teams', name: 'Microsoft Teams', line: 'Makes meeting links on Microsoft 365 calendars.', empty: teamsEmpty(accounts.accounts) }
  const expired = rows.find((row) => row.state === 'expired')
  const connected = rows.filter((row) => row.state === 'connected')
  const state: State = pill.tone === 'warn' ? 'attention' : pill.tone === 'ok' ? 'ok' : 'off'
  const detail = expired !== undefined
    ? `The permission for ${expired.account.emailAddress} expired.`
    : connected.length === 1
      ? connected[0]!.account.emailAddress
      : connected.length > 1
        ? connected.map((row) => row.account.emailAddress).join(', ')
        : rows.length === 0
          ? base.empty
          : ''
  return { key: base.key, cat: 'meetings', name: base.name, mark: 'video', line: base.line, state, detail, to: { name: 'settings-meeting-apps' } }
}

function ownLinkRow(): Row | null {
  const prefs = meetingApps.preferences
  if (prefs === null || !prefs.apps.includes('own')) return null
  const set = prefs.ownLink !== null
  return {
    key: 'own',
    cat: 'meetings',
    name: 'My own link',
    mark: 'link',
    line: 'One room link that you paste, the same for every event.',
    state: set ? 'ok' : 'off',
    detail: set ? 'Your room link is set' : 'No link yet',
    to: { name: 'settings-meeting-apps' },
  }
}

/** WhatsApp as the rest of the app has it: the desktop app once it is turned on there, the browser read side. */
function whatsappRow(): Row | null {
  const base = { key: 'whatsapp', cat: 'messaging' as const, name: 'WhatsApp', mark: 'text' as const, initials: 'WA', whatsapp: true, line: 'Brings your WhatsApp chats into the inbox.' }
  if (chatsFromServer) {
    const account = chats.serverOnly && chats.enabled ? chats.serverAccount : null
    if (account === null) return null
    const trouble = !account.relayOnline ? 'Mac offline' : account.link === 'unlinked' ? 'Not linked' : account.bridge === 'stopped' ? 'Stopped' : null
    const number = account.address === null ? null : phoneLabel(account.address)
    return { ...base, state: trouble === null ? 'ok' : 'attention', detail: trouble ?? number ?? '', to: { name: 'settings-whatsapp' } }
  }
  if (!whatsapp.available) return null
  if (!whatsapp.connected) return { ...base, state: 'off', detail: '', to: { name: 'settings-whatsapp-connect' } }
  const trouble = whatsapp.bridge.link === 'unlinked' ? 'Not linked' : whatsapp.bridge.error !== null ? 'Stopped' : null
  const number = whatsapp.identity?.number
  return { ...base, state: trouble === null ? 'ok' : 'attention', detail: trouble ?? (number ? phoneNumber(number) : ''), to: { name: 'settings-whatsapp' } }
}

const outRows = computed<Row[]>(() => [
  meetingRow('meet'),
  meetingRow('teams'),
  ownLinkRow(),
  whatsappRow(),
  { key: 'zoom', cat: 'meetings', name: 'Zoom', mark: 'video', line: 'Meeting links made by Zoom.', state: 'soon', detail: '' } satisfies Row,
].filter((row): row is Row => row !== null))

const inRows = computed<Row[]>(() => {
  const assistants = connectedApps.apps.map((app): Row => ({
    key: `assistant-${app.id}`,
    cat: 'ai',
    name: app.name,
    mark: 'text',
    initials: appInitials(app.name),
    line: permissionLine(app.scopes) ?? NOTHING_ALLOWED,
    state: 'ok',
    // The name is the app's own; the domain it sends the user back to is what was checked, so it comes first.
    detail: [app.domains[0], activeText(lastActive.value[app.activityKey] ?? app.lastUsedAt, now.value) ?? 'Never used'].filter(Boolean).join(' · '),
    to: { name: 'settings-apps-assistants', query: { app: app.id } },
  }))
  const active = tokens.tokens.filter((token) => personalAccessTokenStatus(token, now.value) === 'active').length
  return [
    ...assistants,
    { key: 'add', cat: 'ai', name: 'Add an AI assistant', mark: 'plus', line: 'Install in a few clicks. No password or token to paste.', state: 'add', detail: '', to: { name: 'settings-apps-assistants' } },
    {
      key: 'tokens',
      cat: 'developer',
      name: 'Personal access tokens',
      mark: 'key',
      line: 'Keys for your own scripts. A token acts as you.',
      state: active > 0 ? 'ok' : 'off',
      detail: active === 0 ? '' : active === 1 ? '1 active token' : `${active} active tokens`,
      to: { name: 'settings-access-tokens' },
    },
  ]
})

const groups = computed(() =>
  [
    { id: 'apps-out', title: 'Tresso uses these', sub: 'Tresso reaches out to these apps for you, to make meeting links and to bring in your chats.', rows: outRows.value, hasLog: false },
    { id: 'apps-in', title: 'These can use your Tresso', sub: 'These apps reach into Tresso. Each one signs in with your permission and can only do what you allow.', rows: inRows.value, hasLog: true },
  ]
    .map((group) => ({ ...group, rows: group.rows.filter((row) => filter.value === 'all' || row.cat === filter.value) }))
    .filter((group) => group.rows.length > 0),
)

const PILL: Record<Exclude<State, 'add'>, string> = { ok: 'Connected', attention: 'Needs attention', off: 'Not connected', soon: 'Not available yet' }
function action(row: Row): string {
  return row.state === 'ok' ? 'Manage' : row.state === 'attention' ? 'Review' : row.state === 'add' ? 'Add' : 'Set up'
}

</script>

<template>
  <section class="apps-page" aria-labelledby="apps-title">
    <header class="header">
      <h2 id="apps-title" class="title">Apps</h2>
      <span class="lead">Everything that is connected to Tresso, in one place: the apps Tresso uses for you, and the apps that may use your Tresso.</span>
    </header>

    <div role="group" aria-label="Category" class="filters">
      <button v-for="[value, label] in FILTERS" :key="value" type="button" class="filter" :aria-pressed="filter === value ? 'true' : 'false'" @click="filter = value">
        {{ label }}
      </button>
    </div>

    <p v-if="loading" class="state" role="status"><LogoLoader /> Loading apps…</p>
    <template v-else>
      <p v-if="loadError" class="form-error" role="alert">{{ loadError }}</p>
      <section v-for="group in groups" :key="group.id" class="group" :aria-labelledby="group.id">
        <div class="group-head">
          <h3 :id="group.id">{{ group.title }}</h3>
          <span class="sub">{{ group.sub }}</span>
        </div>

        <div v-for="row in group.rows" :key="row.key" class="row" :class="{ soon: row.state === 'soon' }" :data-row="row.key">
          <span class="mark" :class="{ add: row.state === 'add', whatsapp: row.whatsapp, initials: row.mark === 'text' && !row.whatsapp }" aria-hidden="true">
            <svg v-if="row.mark === 'video'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"></rect><path d="M16 10l5-3v10l-5-3"></path></svg>
            <svg v-else-if="row.mark === 'link'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.07 0l3-3a5 5 0 00-7.07-7.07l-1.5 1.5"></path><path d="M14 11a5 5 0 00-7.07 0l-3 3a5 5 0 007.07 7.07l1.5-1.5"></path></svg>
            <svg v-else-if="row.mark === 'key'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"></circle><path d="M11 12l8-8M16 7l3 3"></path></svg>
            <svg v-else-if="row.mark === 'plus'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"></path></svg>
            <template v-else>{{ row.initials }}</template>
          </span>

          <span class="main">
            <span class="name-line"><span class="name">{{ row.name }}</span><span class="cat">{{ CATEGORY_LABELS[row.cat] }}</span></span>
            <span class="line">{{ row.line }}</span>
          </span>

          <span class="status">
            <span v-if="row.state !== 'add'" class="pill" :class="row.state">
              <svg v-if="row.state === 'ok'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"></path></svg>
              <svg v-if="row.state === 'attention'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 16H3z"></path><path d="M12 10v4M12 17h.01"></path></svg>
              {{ PILL[row.state] }}</span>
            <span class="detail" :class="{ attention: row.state === 'attention' }" dir="auto">{{ row.detail }}</span>
          </span>

          <span class="action-cell">
            <RouterLink v-if="row.state !== 'soon' && row.to" :to="row.to" class="action" :class="{ primary: row.state === 'attention' }" :aria-label="`${action(row)} ${row.name}`">{{ action(row) }}</RouterLink>
          </span>
        </div>

        <div v-if="group.hasLog" class="log-line">
          <span>Everything these apps do through MCP and the API is written to the activity log.</span>
          <RouterLink :to="{ name: 'settings-apps-activity' }">Open the activity log</RouterLink>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.apps-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 960px;
}
.header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 4px 0;
}
.title {
  margin: 0;
  font: 700 28px/34px var(--font-display);
}
.lead,
.state {
  margin: 0;
  font-size: 14px;
  color: var(--ink-2);
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 4px;
}
.filter {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: var(--paper);
  color: var(--ink-2);
  font: 600 12px var(--font-ui);
  cursor: pointer;
}
.filter[aria-pressed='true'] {
  background: var(--ink);
  color: var(--paper);
}
.group {
  display: flex;
  flex-direction: column;
  padding: 20px 20px 8px;
  border-radius: var(--radius-panel);
  background: var(--paper);
}
.group-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 12px;
}
.group-head h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.sub {
  font-size: 13px;
  color: var(--ink-2);
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  min-height: 64px;
  padding: 10px 0;
  box-sizing: border-box;
  border-top: 1px solid var(--line);
}
.row.soon {
  opacity: 0.6;
}
.mark {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  box-sizing: border-box;
  border-radius: var(--radius-card);
  background: var(--canvas);
  color: var(--ink);
  font-size: 13px;
  font-weight: 700;
}
.mark.initials {
  background: var(--line-strong);
  color: var(--ink-2);
}
.mark.whatsapp {
  background: var(--whatsapp-mark);
  color: var(--whatsapp-mark-text);
}
.mark.add {
  border: 1px dashed var(--line-strong);
  background: var(--paper);
  color: var(--ink-2);
}
.main {
  display: flex;
  flex: 1 1 260px;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.name-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.name {
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.cat {
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-2);
}
.line {
  font-size: 13px;
  line-height: 19px;
  color: var(--ink-2);
}
.status {
  display: flex;
  flex: 0 1 300px;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 0;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--canvas);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.pill.ok {
  background: var(--know-soft);
  color: var(--know);
}
.pill.attention {
  background: var(--delegate-soft);
  color: var(--delegate);
}
.detail {
  font-size: 12px;
  line-height: 17px;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.detail.attention {
  color: var(--delegate);
}
.action-cell {
  display: flex;
  flex: 0 0 84px;
  justify-content: flex-end;
}
.action {
  display: flex;
  align-items: center;
  height: 32px;
  box-sizing: border-box;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--paper);
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.action.primary {
  border: 0;
  background: var(--ink);
  color: var(--paper);
}
.log-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  min-height: 52px;
  padding: 8px 0;
  box-sizing: border-box;
  border-top: 1px solid var(--line);
  font-size: 13px;
  line-height: 19px;
}
.log-line span {
  flex: 1 1 320px;
  color: var(--ink-2);
}
.log-line a {
  font-weight: 600;
  text-decoration: none;
}
</style>
