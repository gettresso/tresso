import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ConnectedApp } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'

/**
 * The apps that are not ours which the user allowed to act for them, read and disconnected through the API (they are
 * not part of the synced copy).
 */
export const useConnectedAppsStore = defineStore('connectedApps', () => {
  const auth = useAuthStore()

  const apps = ref<ConnectedApp[]>([])

  async function load(): Promise<ConnectedApp[]> {
    apps.value = await auth.api<ConnectedApp[]>('/api/v1/connected-apps')
    return apps.value
  }

  /** Disconnects the app: its tokens stop working at once, and it is gone from the list. */
  async function disconnect(id: string): Promise<void> {
    await auth.send<void>('DELETE', `/api/v1/connected-apps/${encodeURIComponent(id)}`)
    apps.value = apps.value.filter((app) => app.id !== id)
  }

  // The desktop app signs another user in without a reload: nothing of the previous one may show meanwhile.
  watch(
    () => auth.generation,
    () => {
      apps.value = []
    },
  )

  return { apps, load, disconnect }
})
