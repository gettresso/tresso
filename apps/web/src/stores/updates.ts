import { ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  answerRelaunch,
  appVersion,
  checkNatively,
  findUpdate,
  onRelaunchRequested,
  restart,
  updateChannel,
  type Update,
  type UpdateChannel,
} from '@/platform/updates'
import { useComposeStore } from '@/stores/compose'

/** How often a running app looks for a new release (Windows and Linux; Sparkle keeps its own schedule on macOS). */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/**
 * `ready`: downloaded, the restart was put off with "Later". `waiting`: the restart waits for files on their way to a
 * draft or a message being sent (`waitingFor`).
 */
export type UpdatePhase = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'waiting' | 'installing' | 'failed'

/**
 * Updates for the desktop app. On Windows and Linux it checks at launch and every few hours, offers a newer release
 * in a card and installs it on request: the download is verified against the release's signature before anything is
 * replaced, then the app restarts into it. On macOS Sparkle does all that and asks this store before it relaunches.
 *
 * Either way the restart comes after the open draft is saved on this device, and waits for files on their way to a
 * draft and for a message being sent, whose contents would otherwise be lost. The card says so, with "Restart now"
 * to go anyway and "Later" to keep working.
 */
export const useUpdatesStore = defineStore('updates', () => {
  const channel = ref<UpdateChannel>('none')
  const version = ref<string | null>(null)
  const phase = ref<UpdatePhase>('idle')
  // Shallow: the plugin's Update keeps its Rust handle in a private field, which a reactive proxy cannot reach.
  const update = shallowRef<Update | null>(null)
  /** Downloaded share, 0 to 1, or null while the size is unknown. */
  const progress = ref<number | null>(null)
  const error = ref<string | null>(null)
  /** The user put this release aside with "Later"; it comes back with the next one or a check of their own. */
  const dismissed = ref<string | null>(null)
  /** What the restart waits for, while `phase` is `waiting`. */
  const waitingFor = ref<'files' | 'sending' | null>(null)
  let timer: ReturnType<typeof setInterval> | null = null
  /** The release whose download is complete (Windows and Linux), so installing it later does not download it again. */
  let downloaded: Update | null = null
  /** Ends the wait of `waiting`: true restarts, false keeps working. */
  let answer: ((restartNow: boolean) => void) | null = null
  let stopListening: (() => void) | null = null

  /** `automatic`: look for releases on its own (release builds; a development build is always behind). */
  async function start(automatic: boolean): Promise<void> {
    channel.value = await updateChannel()
    if (channel.value !== 'none') {
      version.value = await appVersion()
    }
    if (channel.value === 'sparkle' && stopListening === null) {
      stopListening = await onRelaunchRequested(() => void relaunchForSparkle())
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
    stopListening?.()
    stopListening = null
  }

  /** While a release is on its way in, a check would only replace it with itself. */
  function busy(): boolean {
    return phase.value === 'checking' || phase.value === 'downloading' || phase.value === 'ready' || phase.value === 'waiting' || phase.value === 'installing'
  }

  /** Looks for a newer release. `asked`: the user asked, so "up to date" and failures are shown, and "Later" is undone. */
  async function checkNow(asked: boolean): Promise<void> {
    if (channel.value === 'sparkle') {
      await checkNatively()
      return
    }
    if (channel.value !== 'tauri' || busy()) {
      return
    }
    phase.value = 'checking'
    error.value = null
    try {
      const found = await findUpdate()
      // Each check holds its release on the Rust side until closed; the one it replaces goes.
      const previous = update.value
      update.value = found
      if (previous !== null && previous !== found) {
        if (downloaded === previous) {
          downloaded = null
        }
        void previous.close().catch(() => undefined)
      }
      if (found !== null && asked) {
        dismissed.value = null
      }
      phase.value = found === null ? 'latest' : 'available'
    } catch (cause) {
      // A check in the background that fails (offline, say) stays quiet and is tried again later. One the user asked
      // for says so; a release found before stays on offer, so the card's button still installs rather than checks.
      phase.value = update.value !== null ? 'available' : asked ? 'failed' : 'idle'
      error.value = asked ? `Checking for updates failed: ${cause instanceof Error ? cause.message : String(cause)}` : null
    }
  }

  /**
   * Saves the open draft on this device and waits until no files are on their way to a draft and no message is being
   * sent. Resolves true to restart, false when the user chose "Later".
   */
  async function readyToRestart(): Promise<boolean> {
    const compose = useComposeStore()
    await compose.saveNow()
    if (compose.unfinished === null) {
      return true
    }
    const before = phase.value
    phase.value = 'waiting'
    waitingFor.value = compose.unfinished
    const restartNow = await new Promise<boolean>((resolve) => {
      const stopWatching = watch(
        () => compose.unfinished,
        (now) => {
          waitingFor.value = now
          if (now === null) {
            finish(true)
          }
        },
      )
      function finish(value: boolean): void {
        stopWatching()
        answer = null
        resolve(value)
      }
      answer = finish
    })
    waitingFor.value = null
    if (!restartNow) {
      phase.value = before
      return false
    }
    // What the files or the send changed in the draft is saved as well.
    await compose.saveNow()
    return true
  }

  /** The user's answer while the restart waits: go now (losing what is still under way), or keep working. */
  function restartNow(): void {
    answer?.(true)
  }

  /** macOS: Sparkle has the update and wants to relaunch; it waits for this answer. */
  async function relaunchForSparkle(): Promise<void> {
    if (phase.value === 'waiting' || phase.value === 'installing') {
      return
    }
    const before = phase.value
    let proceed = false
    try {
      proceed = await readyToRestart()
    } catch (cause) {
      // Saving failed: the edits are still here, so the relaunch stays held rather than lose them.
      console.error('Getting ready for the update failed', cause)
    }
    if (proceed) {
      phase.value = 'installing'
    }
    try {
      if (!(await answerRelaunch(proceed)) && proceed) {
        // Sparkle gave the relaunch up meanwhile (an installer error): it offers the update again on its next check.
        phase.value = before
      }
    } catch (cause) {
      phase.value = before
      console.error('Answering Sparkle failed', cause)
    }
  }

  async function install(): Promise<void> {
    const found = update.value
    if (found === null || phase.value === 'downloading' || phase.value === 'waiting' || phase.value === 'installing') {
      return
    }
    error.value = null
    if (downloaded !== found) {
      phase.value = 'downloading'
      progress.value = null
      let total = 0
      let received = 0
      try {
        await found.download((event) => {
          if (event.event === 'Started') {
            total = event.data.contentLength ?? 0
            progress.value = total > 0 ? 0 : null
          } else if (event.event === 'Progress') {
            received += event.data.chunkLength
            progress.value = total > 0 ? Math.min(1, received / total) : null
          }
        })
      } catch (cause) {
        phase.value = 'failed'
        error.value = `Downloading Tresso ${found.version} failed: ${cause instanceof Error ? cause.message : String(cause)}`
        return
      }
      downloaded = found
    }
    // Windows quits the app as soon as the installer starts, so everything is saved before it does.
    phase.value = 'ready'
    let ready = false
    try {
      ready = await readyToRestart()
    } catch (cause) {
      error.value = `The draft could not be saved, so Tresso did not restart: ${cause instanceof Error ? cause.message : String(cause)}`
      return
    }
    if (!ready || update.value !== found) {
      return
    }
    phase.value = 'installing'
    try {
      await found.install()
    } catch (cause) {
      phase.value = 'failed'
      error.value = `Installing Tresso ${found.version} failed: ${cause instanceof Error ? cause.message : String(cause)}`
      return
    }
    try {
      await restart()
    } catch (cause) {
      // Installed, only the restart did not happen: quitting and opening Tresso finishes it.
      error.value = `Tresso ${found.version} is installed. Quit and open Tresso to start it (${cause instanceof Error ? cause.message : String(cause)}).`
    }
  }

  function later(): void {
    if (phase.value === 'waiting') {
      answer?.(false)
      return
    }
    dismissed.value = update.value?.version ?? null
    if (phase.value === 'failed') {
      phase.value = downloaded !== null && downloaded === update.value ? 'ready' : 'available'
      error.value = null
    }
  }

  return { channel, version, phase, update, progress, error, dismissed, waitingFor, start, stop, checkNow, install, restartNow, later }
})
