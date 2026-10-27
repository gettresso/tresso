<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import TressoMark from '@/components/TressoMark.vue'
import { isDesktop } from '@/platform/desktop'
import { chooseServer, defaultServer, normalizeServer, reachServer, server } from '@/platform/server'

const auth = useAuthStore()
const signInError = ref<string | null>(null)

/** The desktop app signs in to the hosted Tresso unless the user names their own server here. */
const CLOUD_HOST = 'api.tresso.app'
const onDefault = computed(() => server.value === defaultServer)
const defaultName = computed(() => (new URL(defaultServer).host === CLOUD_HOST ? 'Tresso Cloud' : new URL(defaultServer).host))
const serverName = computed(() => (onDefault.value ? defaultName.value : new URL(server.value).host))
const editingServer = ref(false)
const serverAddress = ref('')
const serverError = ref<string | null>(null)
const checkingServer = ref(false)
const serverInput = ref<HTMLInputElement | null>(null)
/** The check that is running; closing the form aborts it, so a server the user gave up on is never chosen. */
let check: AbortController | null = null

async function editServer(): Promise<void> {
  serverAddress.value = onDefault.value ? '' : server.value
  serverError.value = null
  editingServer.value = true
  await nextTick()
  serverInput.value?.focus()
}

async function useServer(): Promise<void> {
  serverError.value = null
  let address: string
  try {
    address = normalizeServer(serverAddress.value)
  } catch (error) {
    serverError.value = error instanceof Error ? error.message : String(error)
    return
  }
  check?.abort()
  const current = new AbortController()
  check = current
  checkingServer.value = true
  try {
    await reachServer(address, current.signal)
    if (current.signal.aborted) {
      return
    }
    chooseServer(address)
    editingServer.value = false
  } catch (error) {
    if (!current.signal.aborted) {
      serverError.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (check === current) {
      check = null
      checkingServer.value = false
    }
  }
}

function closeServerForm(): void {
  check?.abort()
  check = null
  checkingServer.value = false
  editingServer.value = false
}

function useDefaultServer(): void {
  check?.abort()
  check = null
  checkingServer.value = false
  serverError.value = null
  try {
    chooseServer(null)
    editingServer.value = false
  } catch (error) {
    serverError.value = error instanceof Error ? error.message : String(error)
  }
}

async function signIn(): Promise<void> {
  signInError.value = null
  try {
    await auth.signIn()
  } catch (error) {
    signInError.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <main class="welcome">
    <TressoMark :size="56" />
    <h1>Every email is something to do, to hand over, or to know.</h1>
    <template v-if="auth.awaitingBrowser">
      <p class="hint" role="status">Continue in your browser. Tresso opens again once you have signed in.</p>
      <button type="button" class="button button-quiet" @click="signIn">Open the browser again</button>
    </template>
    <button v-else type="button" class="button button-primary sign-in" :disabled="editingServer" @click="signIn">Sign in</button>
    <p v-if="signInError" class="error" role="alert">Sign-in could not start: {{ signInError }}</p>
    <template v-if="isDesktop && !auth.awaitingBrowser">
      <form v-if="editingServer" class="server-form" novalidate @submit.prevent="useServer">
        <label class="field">
          Your Tresso server
          <input
            ref="serverInput"
            v-model="serverAddress"
            type="url"
            inputmode="url"
            autocomplete="url"
            spellcheck="false"
            placeholder="mail.example.com"
            :aria-invalid="serverError ? 'true' : undefined"
            @keydown.esc="closeServerForm"
          />
          <small v-if="serverError" class="error" role="alert">{{ serverError }}</small>
        </label>
        <div class="server-actions">
          <button type="submit" class="button button-primary" :disabled="checkingServer">{{ checkingServer ? 'Checking...' : 'Use this server' }}</button>
          <button v-if="!onDefault" type="button" class="button button-quiet" @click="useDefaultServer">Use {{ defaultName }}</button>
          <button type="button" class="button button-quiet" @click="closeServerForm">Cancel</button>
        </div>
      </form>
      <p v-else class="server">
        Signing in to <strong>{{ serverName }}</strong>
        <button type="button" class="server-change" @click="editServer">Use another server</button>
      </p>
    </template>
    <p v-if="auth.storageError" class="error" role="alert">{{ auth.storageError }}</p>
  </main>
</template>

<style scoped>
.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  min-height: 100%;
  padding: 32px 16px;
  text-align: center;
}
h1 {
  max-width: 640px;
  margin: 0;
  font: 700 40px/46px var(--font-display);
  letter-spacing: -0.02em;
}
.hint {
  max-width: 420px;
  margin: 0;
  color: var(--ink-2);
}
.error {
  max-width: 480px;
  margin: 0;
  color: var(--danger);
}
.server {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: baseline;
  gap: 4px 10px;
  margin: 0;
  color: var(--ink-2);
  font-size: 13px;
}
.server strong {
  color: var(--ink);
  font-weight: 600;
}
.server-change {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink-2);
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.server-change:hover {
  color: var(--ink);
}
.server-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(420px, 100%);
  text-align: left;
  animation: rise-in var(--motion-base) var(--ease-out);
}
.server-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.sign-in {
  height: 44px;
  padding: 0 24px;
  font-size: 15px;
}
</style>
