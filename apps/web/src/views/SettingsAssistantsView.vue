<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { activeText, ASSISTANT_SCOPES, recentText, recentTime, recentTool, shortDay, type AppActivityEntry, type ConnectedApp, type ServerInfo } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { appInitials } from '@/components/apps/appMarks'
import { installs, type InstallId } from '@/components/apps/assistantInstalls'
import LogoLoader from '@/components/LogoLoader.vue'
import { isDesktop, openInBrowser } from '@/platform/desktop'
import { useAppActivityStore } from '@/stores/appActivity'
import { useAuthStore } from '@/stores/auth'
import { useConnectedAppsStore } from '@/stores/connectedApps'

/**
 * Settings, Apps, AI assistants (the "Settings: apps, AI assistants (MCP)" board): adding an assistant (an install link
 * where its maker documents one, a command for Claude Code, the manual steps for the others), this server's MCP
 * endpoint, and every connected assistant with a switch per permission, revoking, and what it did lately.
 *
 * A switch saves at once (PATCH /api/v1/connected-apps/{id}); a failed save says why under it and puts it back. Only a
 * permission the user granted on the consent screen can be switched on: anything more needs the consent screen, so
 * such a switch is shown off and cannot be turned on here. Revoking disconnects the app at once and cannot be undone
 * (the app has to ask for permission again), so the page offers no undo.
 */
const auth = useAuthStore()
const connectedApps = useConnectedAppsStore()
const activity = useAppActivityStore()
const route = useRoute()
const router = useRouter()

const loading = ref(true)
const loadError = ref<string | null>(null)
const endpoint = ref('')
const lastActive = ref<Record<string, string>>({})
const now = ref(new Date())

onMounted(async () => {
  const results = await Promise.allSettled([
    auth.api<ServerInfo>('/api/v1/server-info').then((info) => (endpoint.value = info.mcpEndpoint)),
    connectedApps.load(),
    activity.lastActive().then((last) => (lastActive.value = last)),
  ])
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  loadError.value = failed === undefined ? null : errorMessage(failed.reason)
  now.value = new Date()
  loading.value = false
})

// Adding an assistant: one tile per assistant, the panel of the chosen one.
const install = ref<InstallId>('claude')
const how = computed(() => installs(endpoint.value).find((item) => item.id === install.value)!)
const tiles = ref<HTMLButtonElement[]>([])
async function onTileKey(event: KeyboardEvent, index: number): Promise<void> {
  const list = installs(endpoint.value)
  const last = list.length - 1
  const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key]
  if (next === undefined) return
  event.preventDefault()
  pick(list[next]!.id)
  await nextTick()
  tiles.value[next]?.focus()
}
function pick(id: InstallId): void {
  install.value = id
  copied.value = ''
  copyError.value = null
}

/** The desktop app hands the install link to the system, which opens the assistant. */
async function openLink(event: MouseEvent, url: string): Promise<void> {
  if (!isDesktop) return
  event.preventDefault()
  try {
    await openInBrowser(url)
  } catch (cause) {
    copyError.value = errorMessage(cause)
  }
}

// Copy: the endpoint or the command; the button says Copied, and a screen reader hears it once.
const copied = ref<'' | 'url' | 'command'>('')
const copyError = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
async function copy(what: 'url' | 'command', text: string): Promise<void> {
  copyError.value = null
  try {
    await navigator.clipboard.writeText(text)
    copied.value = what
    if (copiedTimer !== null) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = ''), 2000)
  } catch {
    copyError.value = 'Your browser did not allow copying. Select the text and copy it yourself.'
  }
}
onBeforeUnmount(() => {
  if (copiedTimer !== null) clearTimeout(copiedTimer)
})

// The connected assistants, and the one shown.
const revoked = ref<ConnectedApp[]>([])
const clients = computed(() => [...connectedApps.apps, ...revoked.value])
const isRevoked = (app: ConnectedApp) => revoked.value.some((gone) => gone.id === app.id)
const selectedId = ref<string | null>(typeof route.query.app === 'string' ? route.query.app : null)
const selected = computed(() => clients.value.find((app) => app.id === selectedId.value) ?? clients.value[0] ?? null)
function select(app: ConnectedApp): void {
  selectedId.value = app.id
  void router.replace({ query: { ...route.query, app: app.id } })
}
function meta(app: ConnectedApp): string {
  if (isRevoked(app)) return 'Access revoked'
  return activeText(lastActive.value[app.activityKey] ?? app.lastUsedAt, now.value) ?? 'Never used'
}

// Recent activity of the one shown.
const recent = ref<AppActivityEntry[]>([])
const recentError = ref<string | null>(null)
watch(
  () => selected.value?.activityKey,
  async (key) => {
    recent.value = []
    recentError.value = null
    if (key === undefined) return
    try {
      const entries = await activity.recent(key)
      if (selected.value?.activityKey === key) recent.value = entries
    } catch (cause) {
      recentError.value = errorMessage(cause)
    }
  },
  { immediate: true },
)

// Switches: what is shown while a change is on its way, errors by scope, and one save at a time.
const picked = reactive<Record<string, boolean>>({})
const errors = reactive<Record<string, string>>({})
let saving: Promise<unknown> = Promise.resolve()
function checked(app: ConnectedApp, scope: string): boolean {
  if (isRevoked(app)) return false
  return picked[`${app.id} ${scope}`] ?? app.scopes.includes(scope)
}
function granted(app: ConnectedApp, scope: string): boolean {
  return app.grantedScopes.includes(scope)
}
function toggle(app: ConnectedApp, scope: string): void {
  if (isRevoked(app) || (!granted(app, scope) && !checked(app, scope))) return
  const key = `${app.id} ${scope}`
  const on = !checked(app, scope)
  picked[key] = on
  errors[key] = ''
  saving = saving.then(async () => {
    const current = connectedApps.apps.find((known) => known.id === app.id)
    if (current === undefined) return
    const scopes = on ? [...new Set([...current.scopes, scope])] : current.scopes.filter((held) => held !== scope)
    try {
      await connectedApps.narrow(app.id, scopes)
    } catch (cause) {
      errors[key] = errorMessage(cause)
    } finally {
      delete picked[key]
    }
  })
}

// Revoking: at once, for good.
const revokeError = ref<string | null>(null)
const revoking = ref(false)
async function revoke(app: ConnectedApp): Promise<void> {
  if (revoking.value) return
  revoking.value = true
  revokeError.value = null
  try {
    await connectedApps.disconnect(app.id)
    // It stays on screen, revoked, until the page is left.
    selectedId.value = app.id
    revoked.value = [...revoked.value, app]
  } catch (cause) {
    revokeError.value = errorMessage(cause)
  } finally {
    revoking.value = false
  }
}
</script>

<template>
  <section class="assistants" aria-labelledby="assistants-title">
    <header class="header">
      <RouterLink :to="{ name: 'settings-apps' }" class="back" aria-label="Back to apps">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>
      </RouterLink>
      <div class="heading">
        <h2 id="assistants-title" class="title">AI assistants</h2>
        <span class="lead">Let an AI assistant work with your Tresso through MCP. You decide what each one may do.</span>
      </div>
    </header>

    <p v-if="loading" class="state" role="status"><LogoLoader /> Loading AI assistants…</p>
    <template v-else>
      <p v-if="loadError" class="form-error" role="alert">{{ loadError }}</p>

      <section class="panel add" aria-labelledby="add-title">
        <div class="section-head">
          <h3 id="add-title">Add an assistant</h3>
          <span class="sub">Pick your assistant. It gets your Tresso address, then you sign in to Tresso in your browser and approve what it may do.</span>
        </div>

        <div role="tablist" aria-label="Assistant to add" class="tiles">
          <button
            v-for="(item, index) in installs(endpoint)"
            :id="`install-${item.id}`"
            :key="item.id"
            ref="tiles"
            type="button"
            role="tab"
            class="tile"
            :aria-selected="install === item.id ? 'true' : 'false'"
            aria-controls="install-panel"
            :tabindex="install === item.id ? 0 : -1"
            @click="pick(item.id)"
            @keydown="onTileKey($event, index)"
          >
            <span class="tile-mark" aria-hidden="true">{{ item.mark }}</span>
            <span class="tile-text">
              <span class="tile-name">{{ item.name }}</span>
              <span class="tile-effort">{{ item.effort }}</span>
            </span>
          </button>
        </div>

        <div id="install-panel" role="tabpanel" :aria-label="how.title" class="how">
          <div class="how-head">
            <span class="how-text">
              <span class="how-title">{{ how.title }}</span>
              <span class="how-line">{{ how.text }}</span>
            </span>
            <a v-if="how.kind === 'link' && how.url" :href="how.url" class="button button-primary how-link" @click="openLink($event, how.url!)">
              {{ how.button }}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"></path></svg>
            </a>
          </div>
          <div v-if="how.kind === 'command'" class="copy-row">
            <label for="mcp-command" class="visually-hidden">Command for Claude Code</label>
            <input id="mcp-command" class="mono" readonly :value="how.command" />
            <button type="button" class="button button-primary" @click="copy('command', how.command ?? '')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a1 1 0 011-1h10"></path></svg>
              {{ copied === 'command' ? 'Copied' : 'Copy command' }}
            </button>
          </div>
          <ol v-if="how.kind === 'steps'" class="steps">
            <li v-for="(step, index) in how.steps" :key="step"><span class="step-n" aria-hidden="true">{{ index + 1 }}</span>{{ step }}</li>
          </ol>
        </div>

        <div class="endpoint">
          <label for="mcp-url" class="endpoint-label">Your MCP endpoint</label>
          <div class="copy-row">
            <input id="mcp-url" class="mono quiet" readonly :value="endpoint" aria-describedby="mcp-url-note" />
            <button type="button" class="button copy-plain" @click="copy('url', endpoint)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a1 1 0 011-1h10"></path></svg>
              {{ copied === 'url' ? 'Copied' : 'Copy' }}
            </button>
          </div>
          <span id="mcp-url-note" class="note">Streamable HTTP.</span>
          <p v-if="copyError" class="form-error" role="alert">{{ copyError }}</p>
          <span class="visually-hidden" role="status">{{ copied === '' ? '' : 'Copied' }}</span>
        </div>

        <div class="oauth">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 018 0v3"></path></svg>
          <span>Every assistant signs in with OAuth, in your browser. You never paste a password or a token into an AI tool.</span>
        </div>
      </section>

      <div v-if="selected" class="connected">
        <section class="panel clients" aria-labelledby="clients-title">
          <h3 id="clients-title">Connected assistants</h3>
          <button v-for="app in clients" :key="app.id" type="button" class="client" :aria-pressed="selected.id === app.id ? 'true' : 'false'" @click="select(app)">
            <span class="client-mark" aria-hidden="true">{{ appInitials(app.name) }}</span>
            <span class="client-text">
              <span class="client-name">{{ app.name }}</span>
              <span class="client-meta" :class="{ revoked: isRevoked(app) }">{{ meta(app) }}</span>
            </span>
          </button>
        </section>

        <section class="panel client-detail" aria-labelledby="client-title">
          <div class="detail-head">
            <div class="detail-text">
              <h3 id="client-title">{{ selected.name }}</h3>
              <span class="sub">Connected {{ shortDay(new Date(selected.connectedAt)) }} by you.</span>
            </div>
            <button v-if="!isRevoked(selected)" type="button" class="button revoke" :disabled="revoking" @click="revoke(selected)">Revoke access</button>
          </div>
          <p v-if="revokeError" class="form-error" role="alert">{{ revokeError }}</p>
          <div v-if="isRevoked(selected)" role="status" class="revoked-note">Access revoked. The next request from {{ selected.name }} is refused and it has to ask for permission again.</div>

          <div role="group" aria-labelledby="perm-title" class="perms">
            <span id="perm-title" class="perms-title">Permissions</span>
            <div class="perm-grid">
              <div v-for="scope in ASSISTANT_SCOPES" :key="scope.value" class="perm" :class="{ dim: isRevoked(selected) }">
                <span class="perm-text">
                  <span class="perm-label">{{ scope.label }}</span>
                  <span :id="`perm-note-${scope.value}`" class="perm-note">{{ scope.description }}</span>
                  <span class="perm-scope">{{ scope.value }}</span>
                  <span v-if="errors[`${selected.id} ${scope.value}`]" class="form-error" role="alert">{{ errors[`${selected.id} ${scope.value}`] }}</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  class="switch"
                  :aria-checked="checked(selected, scope.value) ? 'true' : 'false'"
                  :aria-label="`${scope.label} for ${selected.name}`"
                  :aria-describedby="`perm-note-${scope.value}`"
                  :aria-disabled="isRevoked(selected) || (!granted(selected, scope.value) && !checked(selected, scope.value)) ? 'true' : undefined"
                  @click="toggle(selected, scope.value)"
                >
                  <span class="knob" />
                </button>
              </div>
            </div>
            <span class="perm-foot">With Change settings an assistant may prepare a list of mail addresses to add. You sign in to each account yourself.</span>
            <span class="perm-foot more">File links are never given to an assistant.</span>
            <span class="perm-foot more">Tresso does not ask you again before an assistant sends a WhatsApp message: your assistant asks you. An app can queue at most 20 messages in 10 minutes and 100 a day.</span>
          </div>

          <div class="recent">
            <span class="perms-title">Recent activity</span>
            <p v-if="recentError" class="form-error" role="alert">{{ recentError }}</p>
            <ol class="recent-list">
              <li v-for="entry in recent" :key="entry.id">
                <span class="recent-time">{{ recentTime(entry.occurredAt, now) }}</span>
                <span class="recent-text">
                  <span class="recent-title">{{ recentText(entry) }}</span>
                  <span class="recent-tool">{{ recentTool(entry) }}</span>
                </span>
              </li>
            </ol>
            <RouterLink :to="{ name: 'settings-apps-activity', query: { app: selected.activityKey } }" class="full-log">Full activity log</RouterLink>
          </div>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.assistants {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 960px;
}
.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 4px 4px 0;
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
.lead,
.state {
  margin: 0;
  font-size: 14px;
  color: var(--ink-2);
}
.panel {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-panel);
  background: var(--paper);
}
.add {
  gap: 12px;
  padding: 18px 20px;
}
.section-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.sub {
  font-size: 13px;
  color: var(--ink-2);
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
}
.tile {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-card);
  background: var(--paper);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  color: var(--ink);
  text-align: left;
  cursor: pointer;
}
.tile[aria-selected='true'] {
  background: var(--canvas);
  box-shadow: inset 0 0 0 1.5px var(--ink);
}
.tile-mark,
.client-mark {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--line-strong);
  color: var(--ink-2);
  font-size: 11px;
  font-weight: 700;
}
.tile-text,
.client-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.tile-name {
  font-size: 13px;
  font-weight: 600;
}
.tile-effort {
  font-size: 11px;
  color: var(--ink-2);
}
.how {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--canvas);
}
.how-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
}
.how-text {
  display: flex;
  flex: 1 1 320px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.how-title {
  font-size: 14px;
  font-weight: 600;
}
.how-line {
  font-size: 13px;
  line-height: 19px;
  color: var(--ink-2);
}
.how-link {
  white-space: nowrap;
}
.copy-row {
  display: flex;
  gap: 8px;
}
.copy-row input {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--paper);
  color: var(--ink);
}
.copy-row input.quiet {
  background: var(--canvas);
}
.mono {
  font: 500 12px var(--font-mono);
}
.copy-row .button {
  height: 38px;
  white-space: nowrap;
}
.copy-plain {
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
}
.steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
  line-height: 19px;
}
.steps li {
  display: flex;
  gap: 10px;
}
.step-n {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--paper);
  color: var(--ink-2);
  font: 500 11px var(--font-mono);
}
.endpoint {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.endpoint-label {
  font-size: 13px;
  font-weight: 600;
}
.note {
  font-size: 12px;
  color: var(--ink-2);
}
.oauth {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-card);
  background: var(--canvas);
  color: var(--ink);
  font-size: 13px;
  line-height: 19px;
}
.oauth svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--ink-2);
}
.connected {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 16px;
}
.clients {
  flex: 1 1 240px;
  gap: 4px;
  max-width: 300px;
  padding: 14px 10px;
}
.clients h3 {
  padding: 0 8px 6px;
}
.client {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 0;
  border-radius: var(--radius-card);
  background: transparent;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
}
.client[aria-pressed='true'] {
  background: var(--canvas);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.client .client-mark {
  width: 32px;
  height: 32px;
  font-size: 12px;
}
.client-name {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.client-meta {
  font-size: 12px;
  color: var(--ink-2);
}
.client-meta.revoked {
  color: var(--danger);
}
.client-detail {
  flex: 999 1 380px;
  gap: 14px;
  min-width: 0;
  padding: 18px 20px;
  box-sizing: border-box;
}
.detail-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px;
}
.detail-text {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: 2px;
}
.detail-text h3 {
  font-size: 18px;
  line-height: 24px;
  overflow-wrap: anywhere;
}
.revoke {
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--danger);
}
.revoked-note {
  padding: 10px 12px;
  border-radius: var(--radius-card);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 13px;
  line-height: 19px;
}
.perms,
.recent {
  display: flex;
  flex-direction: column;
}
.perms-title {
  padding-bottom: 4px;
  font-size: 13px;
  font-weight: 600;
}
.perm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 0 24px;
}
.perm {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-height: 48px;
  padding: 8px 0;
  box-sizing: border-box;
  border-top: 1px solid var(--line);
}
.perm.dim {
  opacity: 0.5;
}
.perm-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.perm-label {
  font-size: 14px;
  font-weight: 500;
}
.perm-note {
  font-size: 12px;
  line-height: 17px;
  color: var(--ink-2);
}
.perm-scope,
.recent-time,
.recent-tool {
  font: 400 11px var(--font-mono);
  color: var(--ink-2);
}
.perm-text .form-error {
  font-size: 12px;
}
.switch {
  display: flex;
  flex-shrink: 0;
  justify-content: flex-start;
  width: 40px;
  height: 24px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--line-strong);
  cursor: pointer;
  transition: background-color var(--motion-fast) ease;
}
.switch[aria-checked='true'] {
  justify-content: flex-end;
  background: var(--ink);
}
.switch[aria-disabled='true'] {
  cursor: default;
}
.knob {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--paper);
  box-shadow: 0 1px 2px rgb(22 24 29 / 20%);
}
.perm-foot {
  padding-top: 8px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  line-height: 18px;
  color: var(--ink-2);
}
.perm-foot.more {
  padding-top: 6px;
  border-top: 0;
}
.recent-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.recent-list li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-height: 40px;
  padding: 8px 0;
  box-sizing: border-box;
  border-top: 1px solid var(--line);
}
.recent-time {
  flex-shrink: 0;
  width: 64px;
}
.recent-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.recent-title {
  font-size: 13px;
  font-weight: 500;
}
.full-log {
  padding-top: 8px;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
</style>
