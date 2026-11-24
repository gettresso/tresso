<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { activeText, ASSISTANT_SCOPES, recentText, recentTime, recentTool, shortDay, type AppActivityEntry, type ConnectedApp, type ServerInfo } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { appInitials } from '@/components/apps/appMarks'
import { checkedEndpoint, installs, type InstallId } from '@/components/apps/assistantInstalls'
import { backdropClose } from '@/components/backdropClose'
import LogoLoader from '@/components/LogoLoader.vue'
import { isDesktop, openCursorInstall } from '@/platform/desktop'
import { useAppActivityStore } from '@/stores/appActivity'
import { useAuthStore } from '@/stores/auth'
import { useConnectedAppsStore } from '@/stores/connectedApps'

/**
 * Settings, Apps, AI assistants and apps (the "Settings: apps, AI assistants (MCP)" board): adding an assistant (an
 * install link where its maker documents one, a command for Claude Code, the manual steps for the others), this
 * server's MCP endpoint, and every app the user allowed through OAuth with a switch per permission, revoking, and what
 * it did lately.
 *
 * The endpoint comes from the server and goes into a command and a link: it is used only when it is a plain address
 * (checkedEndpoint); otherwise the page says so and offers no command, link or Copy. On the desktop app the shell
 * builds Cursor's link itself.
 *
 * A switch saves at once (PATCH /api/v1/connected-apps/{id}); quick toggles of one app are sent as their last state,
 * and a failed save says why under the switch and puts it back. Only a permission the user granted on the consent
 * screen can be switched on: anything more needs the consent screen, which the switch says. Revoking is confirmed
 * first and cannot be undone (the app has to ask for permission again), so the page offers no undo.
 */
const auth = useAuthStore()
const connectedApps = useConnectedAppsStore()
const activity = useAppActivityStore()
const route = useRoute()
const router = useRouter()

const NOT_GRANTED = 'Not allowed when this app was connected. Connect it again to allow it.'
const NO_ENDPOINT = 'Tresso could not read this server\'s MCP address, so there is nothing to copy or open. Reload the page to try again.'

const loading = ref(true)
const loadError = ref<string | null>(null)
/** The server's MCP endpoint when it is a plain address; null while unknown or when it is not one. */
const endpoint = ref<string | null>(null)
const lastActive = ref<Record<string, string>>({})
const now = ref(new Date())

onMounted(async () => {
  const results = await Promise.allSettled([
    auth.api<ServerInfo>('/api/v1/server-info').then((info) => (endpoint.value = checkedEndpoint((info as Partial<ServerInfo>).mcpEndpoint))),
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
const list = computed(() => installs(endpoint.value))
const how = computed(() => list.value.find((item) => item.id === install.value)!)
const tiles = ref<HTMLButtonElement[]>([])
async function onTileKey(event: KeyboardEvent, index: number): Promise<void> {
  const last = list.value.length - 1
  const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key]
  if (next === undefined) return
  event.preventDefault()
  pick(list.value[next]!.id)
  await nextTick()
  tiles.value[next]?.focus()
}
function pick(id: InstallId): void {
  install.value = id
  copied.value = ''
  copyError.value = null
}

/** The desktop app asks the shell, which builds Cursor's link from the endpoint itself and opens it. */
async function openLink(event: MouseEvent): Promise<void> {
  if (!isDesktop || endpoint.value === null) return
  event.preventDefault()
  copyError.value = null
  try {
    await openCursorInstall(endpoint.value)
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

// The connected apps, and the one shown.
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
const recentLoading = ref(false)
const recentError = ref<string | null>(null)
watch(
  () => selected.value?.activityKey,
  async (key) => {
    recent.value = []
    recentError.value = null
    if (key === undefined) return
    recentLoading.value = true
    try {
      const entries = await activity.recent(key)
      if (selected.value?.activityKey === key) recent.value = entries
    } catch (cause) {
      if (selected.value?.activityKey === key) recentError.value = errorMessage(cause)
    } finally {
      if (selected.value?.activityKey === key) recentLoading.value = false
    }
  },
  { immediate: true },
)

// Switches: per app, the scopes it should have now (the last toggle wins), sent one save at a time.
const wanted = reactive<Record<string, string[]>>({})
const errors = reactive<Record<string, string>>({})
const saving = new Set<string>()
function scopesShown(app: ConnectedApp): string[] {
  return wanted[app.id] ?? app.scopes
}
function checked(app: ConnectedApp, scope: string): boolean {
  return !isRevoked(app) && scopesShown(app).includes(scope)
}
function granted(app: ConnectedApp, scope: string): boolean {
  return app.grantedScopes.includes(scope)
}
function locked(app: ConnectedApp, scope: string): boolean {
  return isRevoked(app) || (!granted(app, scope) && !checked(app, scope))
}
function toggle(app: ConnectedApp, scope: string): void {
  if (locked(app, scope)) return
  const shown = scopesShown(app)
  wanted[app.id] = shown.includes(scope) ? shown.filter((held) => held !== scope) : [...shown, scope]
  errors[`${app.id} ${scope}`] = ''
  void save(app.id)
}
async function save(id: string): Promise<void> {
  if (saving.has(id)) return
  saving.add(id)
  try {
    for (;;) {
      const scopes = wanted[id]
      const current = connectedApps.apps.find((known) => known.id === id)
      if (scopes === undefined || current === undefined) break
      if (sameScopes(scopes, current.scopes)) {
        delete wanted[id]
        break
      }
      try {
        await connectedApps.narrow(id, scopes)
      } catch (cause) {
        // Every switch that differs from what is saved goes back, and says why.
        for (const scope of new Set([...scopes, ...current.scopes])) {
          if (scopes.includes(scope) !== current.scopes.includes(scope)) errors[`${id} ${scope}`] = errorMessage(cause)
        }
        delete wanted[id]
        break
      }
    }
  } finally {
    saving.delete(id)
  }
}
function sameScopes(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((scope) => b.includes(scope))
}

// Revoking: confirmed in a dialog first, then at once and for good.
const dialog = ref<HTMLDialogElement | null>(null)
const keepButton = ref<HTMLButtonElement | null>(null)
const revokeButton = ref<HTMLButtonElement | null>(null)
const confirming = ref<ConnectedApp | null>(null)
const revokeError = ref<string | null>(null)
const revoking = ref(false)
const revokedNote = ref<HTMLElement | null>(null)
/** What the live region says per revoked app, set once the region is on screen so a screen reader hears it. */
const revokedSaid = ref<Record<string, string>>({})
async function ask(app: ConnectedApp): Promise<void> {
  confirming.value = app
  revokeError.value = null
  await nextTick()
  dialog.value?.showModal?.()
  keepButton.value?.focus()
}
function close(): void {
  if (revoking.value) return
  dialog.value?.close?.()
  confirming.value = null
}
// Kept: the focus goes back to the button that opened the dialog.
watch(confirming, async (now, before) => {
  if (now === null && before !== null && !isRevoked(before)) {
    await nextTick()
    revokeButton.value?.focus()
  }
})
const backdrop = backdropClose(close)
async function revoke(): Promise<void> {
  const app = confirming.value
  if (app === null || revoking.value) return
  revoking.value = true
  revokeError.value = null
  try {
    await connectedApps.disconnect(app.id)
    // It stays on screen, revoked, until the page is left.
    selectedId.value = app.id
    revoked.value = [...revoked.value, app]
    revoking.value = false
    dialog.value?.close?.()
    confirming.value = null
    await nextTick()
    revokedSaid.value = { ...revokedSaid.value, [app.id]: `Access revoked. The next request from ${app.name} is refused and it has to ask for permission again.` }
    revokedNote.value?.focus()
  } catch (cause) {
    revokeError.value = errorMessage(cause)
  } finally {
    revoking.value = false
  }
}

// The desktop app signs another user in without a reload: nothing of the previous one may show meanwhile.
watch(
  () => auth.generation,
  () => {
    revoked.value = []
    recent.value = []
    lastActive.value = {}
    revokedSaid.value = {}
    for (const key of Object.keys(wanted)) delete wanted[key]
    for (const key of Object.keys(errors)) delete errors[key]
  },
)
</script>

<template>
  <section class="assistants" aria-labelledby="assistants-title">
    <header class="header">
      <RouterLink :to="{ name: 'settings-apps' }" class="back" aria-label="Back to apps">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>
      </RouterLink>
      <div class="heading">
        <h2 id="assistants-title" class="title">AI assistants and apps</h2>
        <span class="lead">Let an AI assistant or another app work with your Tresso. You decide what each one may do.</span>
      </div>
    </header>

    <p v-if="loading" class="state" role="status"><LogoLoader /> Loading AI assistants and apps…</p>
    <template v-else>
      <p v-if="loadError" class="form-error" role="alert">{{ loadError }}</p>

      <section class="panel add" aria-labelledby="add-title">
        <div class="section-head">
          <h3 id="add-title">Add an assistant</h3>
          <span class="sub">Pick your assistant. It gets your Tresso address, then you sign in to Tresso in your browser and approve what it may do.</span>
        </div>

        <div role="tablist" aria-label="Assistant to add" class="tiles">
          <button
            v-for="(item, index) in list"
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
            <a v-if="how.kind === 'link' && how.url" :href="how.url" class="button button-primary how-link" @click="openLink($event)">
              {{ how.button }}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"></path></svg>
            </a>
          </div>
          <div v-if="how.kind === 'command' && how.command" class="copy-row">
            <label for="mcp-command" class="visually-hidden">Command for Claude Code</label>
            <input id="mcp-command" class="mono" readonly :value="how.command" />
            <button type="button" class="button button-primary" @click="copy('command', how.command)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a1 1 0 011-1h10"></path></svg>
              {{ copied === 'command' ? 'Copied' : 'Copy command' }}
            </button>
          </div>
          <ol v-if="how.kind === 'steps'" class="steps">
            <li v-for="(step, index) in how.steps" :key="step"><span class="step-n" aria-hidden="true">{{ index + 1 }}</span>{{ step }}</li>
          </ol>
        </div>

        <div class="endpoint">
          <template v-if="endpoint !== null">
            <label for="mcp-url" class="endpoint-label">Your MCP endpoint</label>
            <div class="copy-row">
              <input id="mcp-url" class="mono quiet" readonly :value="endpoint" aria-describedby="mcp-url-note" />
              <button type="button" class="button copy-plain" @click="copy('url', endpoint)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a1 1 0 011-1h10"></path></svg>
                {{ copied === 'url' ? 'Copied' : 'Copy' }}
              </button>
            </div>
            <span id="mcp-url-note" class="note">Streamable HTTP.</span>
          </template>
          <template v-else>
            <span class="endpoint-label">Your MCP endpoint</span>
            <p class="form-error endpoint-error" role="alert">{{ NO_ENDPOINT }}</p>
          </template>
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
          <h3 id="clients-title">Connected assistants and apps</h3>
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
            <button v-if="!isRevoked(selected)" ref="revokeButton" type="button" class="button revoke" @click="ask(selected)">Revoke access</button>
          </div>
          <div v-show="isRevoked(selected)" ref="revokedNote" tabindex="-1" role="status" class="revoked-note">{{ revokedSaid[selected.id] ?? '' }}</div>

          <div role="group" aria-labelledby="perm-title" class="perms">
            <span id="perm-title" class="perms-title">Permissions</span>
            <div class="perm-grid">
              <div v-for="scope in ASSISTANT_SCOPES" :key="scope.value" class="perm" :class="{ dim: isRevoked(selected), never: !isRevoked(selected) && locked(selected, scope.value) }">
                <span class="perm-text">
                  <span class="perm-label">{{ scope.label }}</span>
                  <span :id="`perm-note-${scope.value}`" class="perm-note">{{ scope.description }}</span>
                  <span class="perm-scope">{{ scope.value }}</span>
                  <span v-if="!isRevoked(selected) && locked(selected, scope.value)" :id="`perm-never-${scope.value}`" class="perm-never">{{ NOT_GRANTED }}</span>
                  <span v-if="errors[`${selected.id} ${scope.value}`]" class="form-error" role="alert">{{ errors[`${selected.id} ${scope.value}`] }}</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  class="switch"
                  :aria-checked="checked(selected, scope.value) ? 'true' : 'false'"
                  :aria-label="`${scope.label} for ${selected.name}`"
                  :aria-describedby="!isRevoked(selected) && locked(selected, scope.value) ? `perm-never-${scope.value}` : `perm-note-${scope.value}`"
                  :aria-disabled="locked(selected, scope.value) ? 'true' : undefined"
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
            <p v-else-if="recentLoading" class="recent-state" role="status"><LogoLoader /> Loading recent activity…</p>
            <p v-else-if="recent.length === 0" class="recent-state">Nothing yet</p>
            <ol v-else class="recent-list">
              <li v-for="entry in recent" :key="entry.id">
                <span class="recent-time">{{ recentTime(entry.occurredAt, now) }}</span>
                <span class="recent-text">
                  <span class="recent-title">{{ recentText(entry) }}</span>
                  <span class="recent-tool">{{ recentTool(entry) }}</span>
                </span>
              </li>
            </ol>
            <RouterLink :to="{ name: 'settings-apps-activity', query: { app: selected.activityKey, period: '90d' } }" class="full-log">Full activity log</RouterLink>
          </div>
        </section>
      </div>
    </template>

    <dialog
      v-if="confirming"
      ref="dialog"
      class="confirm-dialog"
      role="alertdialog"
      aria-labelledby="revoke-title"
      aria-describedby="revoke-description"
      @cancel.prevent="close"
      @pointerdown="backdrop.onPointerdown"
      @click="backdrop.onClick"
    >
      <h2 id="revoke-title">Revoke access for {{ confirming.name }}?</h2>
      <p id="revoke-description">It stops working with your account right away. To use it again, it has to ask for permission again.</p>
      <p v-if="revokeError" class="form-error" role="alert">{{ revokeError }}</p>
      <div class="dialog-actions">
        <button type="button" class="button button-danger" :disabled="revoking" @click="revoke">
          <template v-if="revoking"><LogoLoader tone="current" /> Revoking…</template><template v-else>Revoke access</template>
        </button>
        <button ref="keepButton" type="button" class="button button-quiet" :disabled="revoking" @click="close">Keep it</button>
      </div>
    </dialog>
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
  background: var(--ground);
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
  background: var(--ground);
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
  background: var(--canvas);
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
.perm.never .perm-label,
.perm.never .perm-note,
.perm.never .switch {
  opacity: 0.5;
}
.perm-never {
  font-size: 12px;
  line-height: 17px;
  color: var(--ink-2);
}
.recent-state {
  margin: 0;
  padding: 8px 0;
  border-top: 1px solid var(--line);
  font-size: 13px;
  color: var(--ink-2);
}
.revoked-note:focus {
  outline: none;
}
.confirm-dialog {
  animation: pop-in var(--motion-base) var(--ease-out);
  width: min(440px, calc(100vw - 32px));
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  color: var(--ink);
  box-shadow: var(--raised);
}
.confirm-dialog h2 {
  margin: 0 0 8px;
  font: 700 18px/24px var(--font-display);
  overflow-wrap: anywhere;
}
.confirm-dialog p {
  margin: 0 0 16px;
  color: var(--ink-2);
}
.dialog-actions {
  display: flex;
  gap: 8px;
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
  box-shadow: var(--switch-knob-shadow);
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
