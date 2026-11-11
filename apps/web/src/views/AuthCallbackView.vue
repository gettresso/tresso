<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { takeReturnPath } from '@/router/returnPath'
import LogoLoader from '@/components/LogoLoader.vue'
import TressoMark from '@/components/TressoMark.vue'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const error = ref<string | null>(null)

// The desktop app routes here again for every `tresso://` link, also while this screen is open, so this follows the
// route instead of running once on mount.
watch(
  () => (route.name === 'auth-callback' ? route.fullPath : null),
  async (path) => {
    if (path === null) {
      return
    }
    error.value = null
    try {
      await auth.completeSignIn(new URL(path, window.location.origin).href)
      // Where the user was going before the sign-in (a link from a notification, say), else the Unified Inbox.
      await router.replace(takeReturnPath() ?? { name: 'unified' })
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  },
  { immediate: true },
)
</script>

<template>
  <main class="welcome">
    <TressoMark :size="56" />
    <template v-if="error">
      <p class="error" role="alert">Sign-in failed: {{ error }}</p>
      <RouterLink :to="{ name: 'unified' }" class="button button-primary">Try again</RouterLink>
    </template>
    <p v-else class="status" role="status"><LogoLoader /> Signing you in…</p>
  </main>
</template>

<style scoped>
/* As the sign-in screen: centred, clear of the edges and of the macOS window buttons. */
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
.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--ink-2);
}
.error {
  max-width: 560px;
  margin: 0;
  color: var(--danger);
  overflow-wrap: anywhere;
}
</style>
