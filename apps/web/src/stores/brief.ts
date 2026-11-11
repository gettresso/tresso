import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { DailyBriefSettings, DailyBriefSettingsUpdate } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'

const SEEN_KEY = 'tresso.brief.seen'

/**
 * The daily brief settings, read and written through the API, and which brief the user last opened on this device.
 * The briefs themselves come with the synced copy (see the mail store).
 */
export const useBriefStore = defineStore('brief', () => {
  const auth = useAuthStore()

  const settings = ref<DailyBriefSettings | null>(null)
  const seenBriefId = ref<string | null>(readSeen())

  async function load(): Promise<DailyBriefSettings> {
    const loaded = await auth.api<DailyBriefSettings>('/api/v1/daily-brief-settings')
    settings.value = loaded
    return loaded
  }

  async function save(update: DailyBriefSettingsUpdate): Promise<DailyBriefSettings> {
    const saved = await auth.send<DailyBriefSettings>('PUT', '/api/v1/daily-brief-settings', update)
    settings.value = saved
    return saved
  }

  /** Remembers the brief as opened, so it no longer shows as new on this device. */
  function seen(briefId: string): void {
    seenBriefId.value = briefId
    try {
      localStorage.setItem(SEEN_KEY, briefId)
    } catch {
      // Without storage (a private window) the brief shows as new again after a reload; nothing else depends on it.
    }
  }

  // The desktop app signs another user in without a reload: nothing of the previous one may show meanwhile.
  watch(
    () => auth.generation,
    () => {
      settings.value = null
    },
  )

  return { settings, seenBriefId, load, save, seen }
})

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY)
  } catch {
    return null
  }
}
