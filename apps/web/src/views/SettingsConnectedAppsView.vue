<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { personalAccessTokenScopeLabel, type ConnectedApp } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { backdropClose } from '@/components/backdropClose'
import { useConnectedAppsStore } from '@/stores/connectedApps'

const store = useConnectedAppsStore()
const loading = ref(true)
const loadError = ref<string | null>(null)

onMounted(async () => {
  try {
    await store.load()
  } catch (e) {
    loadError.value = errorMessage(e)
  } finally {
    loading.value = false
  }
})

function day(at: string): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function scopes(app: ConnectedApp): string {
  return app.scopes.map(personalAccessTokenScopeLabel).join(', ')
}

function lastUsed(app: ConnectedApp): string {
  return app.lastUsedAt === null ? 'Never used' : `Last used ${day(app.lastUsedAt)}`
}

// Disconnecting, confirmed in a dialog.
const dialog = ref<HTMLDialogElement | null>(null)
const confirming = ref<ConnectedApp | null>(null)
const disconnecting = ref(false)
const disconnectError = ref<string | null>(null)

async function ask(app: ConnectedApp): Promise<void> {
  confirming.value = app
  disconnectError.value = null
  await nextTick()
  dialog.value?.showModal?.()
}

function close(): void {
  if (disconnecting.value) {
    return
  }
  dialog.value?.close?.()
  confirming.value = null
}

const backdrop = backdropClose(close)

async function disconnect(): Promise<void> {
  if (confirming.value === null) {
    return
  }
  disconnecting.value = true
  disconnectError.value = null
  try {
    await store.disconnect(confirming.value.id)
    disconnecting.value = false
    close()
  } catch (e) {
    disconnectError.value = errorMessage(e)
  } finally {
    disconnecting.value = false
  }
}
</script>

<template>
  <section class="connected-apps" aria-labelledby="connected-apps-title">
    <header class="header">
      <h2 id="connected-apps-title">Connected apps</h2>
      <p class="lead">
        Apps you allowed to use your Tresso account, such as AI assistants. They can do only what you allowed. Tresso has
        not checked these apps: disconnect any you do not recognize.
      </p>
    </header>

    <p v-if="loading" class="state" role="status">Loading apps…</p>
    <p v-else-if="loadError" class="form-error" role="alert">{{ loadError }}</p>
    <p v-else-if="store.apps.length === 0" class="state">No connected apps. When an app asks to use your account and you allow it, it shows up here.</p>

    <ul v-else class="apps" aria-label="Connected apps">
      <li v-for="app in store.apps" :key="app.id" class="app">
        <div class="app-main">
          <div class="app-head">
            <span class="app-name">{{ app.name }}</span>
            <span class="domain">{{ app.domain }}</span>
          </div>
          <span class="app-scopes">{{ scopes(app) }}</span>
          <span class="app-meta">Connected {{ day(app.connectedAt) }} · {{ lastUsed(app) }}</span>
        </div>
        <button type="button" class="button button-danger" @click="ask(app)">Disconnect</button>
      </li>
    </ul>

    <dialog
      v-if="confirming"
      ref="dialog"
      class="confirm-dialog"
      role="alertdialog"
      aria-labelledby="disconnect-title"
      aria-describedby="disconnect-description"
      @cancel.prevent="close"
      @pointerdown="backdrop.onPointerdown"
      @click="backdrop.onClick"
    >
      <h2 id="disconnect-title">Disconnect {{ confirming.name }}?</h2>
      <p id="disconnect-description">
        It stops working with your account right away. To use it again, you have to allow it again.
      </p>
      <p v-if="disconnectError" class="form-error" role="alert">{{ disconnectError }}</p>
      <div class="actions">
        <button type="button" class="button button-danger" :disabled="disconnecting" @click="disconnect">
          {{ disconnecting ? 'Disconnecting…' : 'Disconnect' }}
        </button>
        <button type="button" class="button button-quiet" :disabled="disconnecting" @click="close">Keep it</button>
      </div>
    </dialog>
  </section>
</template>

<style scoped>
.connected-apps {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 760px;
}
h2 {
  margin: 0 0 4px;
  font-size: 20px;
  line-height: 28px;
}
.lead,
.state {
  margin: 0;
  color: var(--ink-2);
  line-height: 21px;
}
.apps {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}
.app {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
}
.app + .app {
  border-top: 1px solid var(--line);
}
.app-main {
  display: flex;
  flex: 1 1 320px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.app-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.app-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.domain {
  font-size: 13px;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.app-scopes,
.app-meta {
  margin: 0;
  font-size: 13px;
  color: var(--ink-2);
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
.actions {
  display: flex;
  gap: 8px;
}
</style>
