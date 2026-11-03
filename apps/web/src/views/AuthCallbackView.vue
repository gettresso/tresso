<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LogoLoader from '@/components/LogoLoader.vue'

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
      await router.replace({ name: 'unified' })
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  },
  { immediate: true },
)
</script>

<template>
  <main>
    <p v-if="error" role="alert">
      Sign-in failed: {{ error }}
      <RouterLink :to="{ name: 'unified' }">Try again</RouterLink>
    </p>
    <p v-else role="status"><LogoLoader /> Signing you in…</p>
  </main>
</template>
