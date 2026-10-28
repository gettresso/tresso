import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
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

/** A newer signed release, or null when this is the latest (Windows and Linux). */
export function findUpdate(): Promise<Update | null> {
  return check()
}

/** Restarts into the version just installed. */
export function restart(): Promise<void> {
  return relaunch()
}

export type { Update }
