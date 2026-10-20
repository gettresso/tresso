<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import TressoMark from '@/components/TressoMark.vue'

const auth = useAuthStore()
const signInError = ref<string | null>(null)

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
    <button v-else type="button" class="button button-primary sign-in" @click="signIn">Sign in</button>
    <p v-if="signInError" class="error" role="alert">Sign-in could not start: {{ signInError }}</p>
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
.sign-in {
  height: 44px;
  padding: 0 24px;
  font-size: 15px;
}
</style>
