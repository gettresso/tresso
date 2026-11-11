import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { openUrl } from '@tauri-apps/plugin-opener'
import { markHandled, wasHandled } from '@/platform/handledLinks'

/**
 * The bridge to the Tauri desktop shell (`apps/desktop`). The web client runs unchanged inside it; only sign-in and
 * token storage go through the shell: the system browser signs in, a `tresso://` link brings the result back, and the
 * tokens live in the OS keychain.
 */
export const isDesktop = isTauri()

/**
 * The keychain commands run off the shell's main thread, so two of them could pass each other: a save and the
 * sign-out's clear right after it would leave the tokens behind. Each one waits for the one asked for before it.
 */
let keychainQueue: Promise<unknown> = Promise.resolve()

function inOrder<T>(command: () => Promise<T>): Promise<T> {
  const result = keychainQueue.then(command, command)
  keychainQueue = result.catch(() => undefined)
  return result
}

export function loadKeychainTokens(): Promise<string | null> {
  return inOrder(() => invoke<string | null>('load_tokens'))
}

export function saveKeychainTokens(tokens: string): Promise<void> {
  return inOrder(() => invoke('save_tokens', { tokens }))
}

export function clearKeychainTokens(): Promise<void> {
  return inOrder(() => invoke('clear_tokens'))
}

export function openInBrowser(url: string): Promise<void> {
  return openUrl(url)
}

/**
 * Calls `handle` with every link the app is opened with: the one that started it, if any, and each one after. The
 * link that started the app is handled once per window, not again after the window reloads.
 */
export async function onDeepLinks(handle: (url: string) => void): Promise<void> {
  const handleAndRemember = (url: string) => {
    markHandled(url)
    handle(url)
  }
  for (const url of (await getCurrent()) ?? []) {
    if (!wasHandled(url)) {
      handleAndRemember(url)
    }
  }
  await onOpenUrl((urls) => urls.forEach(handleAndRemember))
}
