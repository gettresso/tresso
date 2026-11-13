import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { MeetingPreferences, MeetingPreferencesUpdate } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'

const PATH = '/api/v1/calendar/meeting-preferences'

/** A change, or one built from the preferences as they are when it is sent (the server replaces maps whole). */
export type MeetingPreferencesChange = MeetingPreferencesUpdate | ((current: MeetingPreferences) => MeetingPreferencesUpdate)

/**
 * The user's meeting preferences (GET and PATCH /api/v1/calendar/meeting-preferences): the own room link, the default
 * app per mail account, the apps switched off in Tresso and whether a guest switches the link on. Not in the sync
 * delta: Settings, Meeting apps, the event editor and the popover read it here.
 *
 * Reads and changes go one after the other, in the order they were asked for: each answer is applied before the next
 * request leaves, so a change built from the current preferences builds on the answer of the one before it, and an
 * older answer never overwrites a newer one.
 */
export const useMeetingAppsStore = defineStore('meetingApps', () => {
  const auth = useAuthStore()
  const preferences = ref<MeetingPreferences | null>(null)
  let loading: Promise<void> | null = null
  let queue: Promise<unknown> = Promise.resolve()

  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work)
    queue = result.catch(() => undefined)
    return result
  }

  /** Takes an answer, unless another user signed in meanwhile (desktop): it was for the previous one. */
  function take(answer: MeetingPreferences, generation: number): void {
    if (generation === auth.generation) {
      preferences.value = answer
    }
  }

  /** Reads the preferences from the server, also when they were read before. */
  function reload(): Promise<void> {
    // The user it is asked for: the answer may only come after another one signed in.
    const generation = auth.generation
    return inTurn(async () => {
      take(await auth.api<MeetingPreferences>(PATH), generation)
    })
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

  /**
   * Saves a change and takes the server's answer as the new state. On an error the preferences are read again (the
   * refusal may come from an old base, such as a mail account deleted elsewhere) and the error is passed on.
   */
  function update(change: MeetingPreferencesChange): Promise<MeetingPreferences> {
    const generation = auth.generation
    return inTurn(async () => {
      if (generation !== auth.generation) {
        throw new Error('Another user signed in. Nothing was saved.')
      }
      const current = preferences.value
      const patch = typeof change === 'function' ? (current === null ? null : change(current)) : change
      if (patch === null) {
        throw new Error('The meeting apps are not loaded yet.')
      }
      try {
        const saved = await auth.send<MeetingPreferences>('PATCH', PATH, patch)
        take(saved, generation)
        return saved
      } catch (error) {
        try {
          // Not for another user who signed in meanwhile: the read would go out with their token, for nothing.
          if (generation === auth.generation) take(await auth.api<MeetingPreferences>(PATH), generation)
        } catch {
          // The read failed too (offline): the save's own error says what happened, and the next read tries again.
        }
        throw error
      }
    })
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
