import { ref } from 'vue'
import { defineStore } from 'pinia'
import { appVersion, checkNatively, findUpdate, restart, updateChannel, type Update, type UpdateChannel } from '@/platform/updates'

/** How often a running app looks for a new release (Windows and Linux; Sparkle keeps its own schedule on macOS). */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export type UpdatePhase = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'installing' | 'failed'

/**
 * Updates for the desktop app. On Windows and Linux it checks at launch and every few hours, offers a newer release
 * in a card and installs it on request: the download is verified against the release's signature before anything is
 * replaced, then the app restarts into it. Drafts are kept locally as they are typed, so the restart loses nothing.
 */
export const useUpdatesStore = defineStore('updates', () => {
  const channel = ref<UpdateChannel>('none')
  const version = ref<string | null>(null)
  const phase = ref<UpdatePhase>('idle')
  const update = ref<Update | null>(null)
  /** Downloaded share, 0 to 1, or null while the size is unknown. */
  const progress = ref<number | null>(null)
  const error = ref<string | null>(null)
  /** The user put this release aside with "Later"; it comes back with the next one or a check of their own. */
  const dismissed = ref<string | null>(null)
  let timer: ReturnType<typeof setInterval> | null = null

  /** `automatic`: look for releases on its own (release builds; a development build is always behind). */
  async function start(automatic: boolean): Promise<void> {
    channel.value = await updateChannel()
    if (channel.value !== 'none') {
      version.value = await appVersion()
    }
    if (automatic && channel.value === 'tauri' && timer === null) {
      void checkNow(false)
      timer = setInterval(() => void checkNow(false), CHECK_EVERY_MS)
    }
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  /** Looks for a newer release. `asked`: the user asked, so "up to date" and failures are shown, and "Later" is undone. */
  async function checkNow(asked: boolean): Promise<void> {
    if (channel.value === 'sparkle') {
      await checkNatively()
      return
    }
    if (channel.value !== 'tauri' || phase.value === 'checking' || phase.value === 'downloading' || phase.value === 'installing') {
      return
    }
    phase.value = 'checking'
    error.value = null
    try {
      const found = await findUpdate()
      update.value = found
      if (found !== null && asked) {
        dismissed.value = null
      }
      phase.value = found === null ? 'latest' : 'available'
    } catch (cause) {
      // A check in the background that fails (offline, say) stays quiet and is tried again later.
      phase.value = asked ? 'failed' : update.value === null ? 'idle' : 'available'
      error.value = asked ? `Checking for updates failed: ${cause instanceof Error ? cause.message : String(cause)}` : null
    }
  }

  async function install(): Promise<void> {
    const found = update.value
    if (found === null || phase.value === 'downloading' || phase.value === 'installing') {
      return
    }
    phase.value = 'downloading'
    progress.value = null
    error.value = null
    let total = 0
    let received = 0
    try {
      await found.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0
          progress.value = total > 0 ? 0 : null
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength
          progress.value = total > 0 ? Math.min(1, received / total) : null
        } else {
          phase.value = 'installing'
        }
      })
      await restart()
    } catch (cause) {
      phase.value = 'failed'
      error.value = `Installing Tresso ${found.version} failed: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  }

  function later(): void {
    dismissed.value = update.value?.version ?? null
  }

  return { channel, version, phase, update, progress, error, dismissed, start, stop, checkNow, install, later }
})
