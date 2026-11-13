import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { MeetingPreferences, MeetingPreferencesUpdate } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'

const PATH = '/api/v1/calendar/meeting-preferences'

/**
 * The user's meeting preferences (GET and PATCH /api/v1/calendar/meeting-preferences): the own room link, the default
 * app per mail account, the apps switched off in Tresso and whether a guest switches the link on. Not in the sync
 * delta: Settings, Meeting apps, the event editor and the popover read it here.
 */
export const useMeetingAppsStore = defineStore('meetingApps', () => {
  const auth = useAuthStore()
  const preferences = ref<MeetingPreferences | null>(null)
  let loading: Promise<void> | null = null

  /** Reads the preferences from the server, also when they were read before. */
  async function reload(): Promise<void> {
    const generation = auth.generation
    const read = await auth.api<MeetingPreferences>(PATH)
    // Another user signed in meanwhile (desktop): the answer was for the previous one.
    if (generation === auth.generation) {
      preferences.value = read
    }
  }

  /** Reads them once; callers at the same time share one request, and a failed read is tried again next time. */
  function ensureLoaded(): Promise<void> {
    if (preferences.value !== null) {
      return Promise.resolve()
    }
    if (loading === null) {
      loading = reload().finally(() => {
        loading = null
      })
    }
    return loading
  }

  /** Saves a change and takes the server's answer as the new state; on an error the state stays as it was. */
  async function update(patch: MeetingPreferencesUpdate): Promise<MeetingPreferences> {
    const generation = auth.generation
    const saved = await auth.send<MeetingPreferences>('PATCH', PATH, patch)
    if (generation === auth.generation) {
      preferences.value = saved
    }
    return saved
  }

  // The desktop app signs another user in without a reload: nothing of the previous one may show meanwhile.
  watch(
    () => auth.generation,
    () => {
      preferences.value = null
      loading = null
    },
  )

  return { preferences, reload, ensureLoaded, update }
})
