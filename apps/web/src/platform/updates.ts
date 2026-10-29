import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isDesktop } from '@/platform/desktop'

/**
 * How this build updates itself (apps/desktop/src-tauri/src/updates.rs): "sparkle" on macOS, where Sparkle's own
 * windows do everything; "tauri" on Windows and Linux, where the web client checks and shows the update; "none" in the
 * browser and in a development build without Sparkle.
 */
export type UpdateChannel = 'sparkle' | 'tauri' | 'none'

export async function updateChannel(): Promise<UpdateChannel> {
  if (!isDesktop) {
    return 'none'
  }
  return invoke<UpdateChannel>('update_channel')
}

export function appVersion(): Promise<string> {
  return getVersion()
}

/** Opens Sparkle's "Check for Updates" window (macOS). */
export function checkNatively(): Promise<void> {
  return invoke('check_for_updates_natively')
}

/** Sent when Sparkle wants to relaunch into an update it downloaded (apps/desktop/src-tauri/src/updates.rs). */
const RELAUNCH_REQUESTED = 'tresso://update-relaunch-requested'

/**
 * Calls `handler` whenever Sparkle wants to relaunch for an update (macOS); Sparkle then waits for answerRelaunch.
 * Until this runs, Sparkle relaunches without asking, since nobody would answer.
 */
export async function onRelaunchRequested(handler: () => void): Promise<() => void> {
  const unlisten = await listen(RELAUNCH_REQUESTED, handler)
  await invoke('update_listening')
  return unlisten
}

/** Lets Sparkle relaunch now (`proceed`), or keeps the relaunch held. Resolves whether a relaunch went ahead. */
export function answerRelaunch(proceed: boolean): Promise<boolean> {
  return invoke<boolean>('update_relaunch', { proceed })
}

/** A newer signed release, or null when this is the latest (Windows and Linux). */
export function findUpdate(): Promise<Update | null> {
  return check()
}

/** Restarts into the version just installed. */
export function restart(): Promise<void> {
  return relaunch()
}

export type { Update }
