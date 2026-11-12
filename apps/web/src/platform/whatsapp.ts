import type { BridgeRow } from '@tresso/core'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/**
 * The desktop shell's WhatsApp commands (apps/desktop/src-tauri/src/whatsapp.rs), macOS only. The shell starts the
 * user's own whatsapp-mcp bridge from the folder the user picked, reads its store read only and calls its REST API on
 * 127.0.0.1; the relay logic that uses these lives in packages/core/src/chat. Outside macOS every command but
 * `whatsappAvailable` rejects with `unsupported`.
 *
 * Errors are rejections with a string: a code the caller can act on (`busy`, `no_store`, `not_chosen`, `no_folder`,
 * `bridge_stopped`, `not_found`, `not_media`, `failed`, `refused`, `mismatch`, `too_large`, `unsupported`) or a
 * sentence for anything else.
 */

/** The event the shell sends every change of the bridge's state on (EVENT in whatsapp.rs). */
export const WHATSAPP_EVENT = 'whatsapp'

export type BridgeProcess = 'owned' | 'stopped'
export type BridgeLink = 'linked' | 'unlinked' | 'waiting_for_scan' | 'unknown'
/**
 * `not_built`: no built bridge in the folder. `exited`: it stopped three times within a minute. `port_busy`: another
 * bridge or program holds the port. `unprotected`: a bridge answers without Tresso's token (upstream whatsapp-mcp, or
 * one started in a terminal), so anything on the Mac could send through it (docs/whatsapp-bridge.md). `unsafe`: the
 * binary or its folder can be changed by another user.
 */
export type BridgeFailure = 'not_built' | 'exited' | 'port_busy' | 'unprotected' | 'unsafe'

export interface BridgeState {
  /** `owned`: Tresso started it (Tresso uses no bridge it did not start). */
  process: BridgeProcess
  port: number | null
  /** Whether its REST API listens on 127.0.0.1 only; null while unknown. */
  loopbackOnly: boolean | null
  link: BridgeLink
  /** The QR code to scan: one string of `0` (light) and `1` (dark) per row, quiet zone included. */
  qr: string[] | null
  error: BridgeFailure | null
}

export interface BridgeInspection {
  /** `whatsapp-bridge/main.go` is in the folder. */
  found: boolean
  /** `whatsapp-bridge/whatsapp-bridge` is built. */
  built: boolean
  /** The bridge ran once and has a store. */
  hasStore: boolean
  /** The binary and its folder belong to this user and nobody else may write them; else it is not started. */
  safe: boolean
}

export interface WhatsAppConfig {
  folder: string
  mode: 'local' | 'all'
  deviceId: string
  deviceName: string
  linkedAt: string | null
  includeGroups: boolean
  notify: boolean
  leftOut: string[]
}

export interface BridgeRows {
  /** Text and file names are cut at 65536 characters. */
  rows: BridgeRow[]
  maxRowid: number
  /** Names the store and its numbering; when it changes, a rowid cursor means nothing and reading starts at 0. */
  storeId: string
}

export interface WhatsAppIdentity {
  number: string
  name: string | null
}

export interface SenderName {
  /** Digits only; null for a sender id not known to be a phone number. */
  number: string | null
  name: string | null
}

export type SendResult = { ok: true; message: 'sent' } | { ok: false; message: 'bridge_stopped' | 'not_linked' | 'refused' | 'unconfirmed' }

export interface DownloadedFile {
  path: string
  /** Its SHA-256 matches the store's; false only when the store holds no hash. */
  verified: boolean
}

/** What the wrappers call; the Tauri API in the app, a fake in tests. */
export interface WhatsAppShell {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>
}

const tauriShell: WhatsAppShell = { invoke, listen }

export function whatsAppShell(shell: WhatsAppShell = tauriShell) {
  return {
    /** True on macOS, the only platform with WhatsApp. */
    available: () => shell.invoke<boolean>('whatsapp_available'),
    /** This computer's name, for "via <device>". */
    device: () => shell.invoke<{ name: string }>('whatsapp_device'),
    loadConfig: (userId: string) => shell.invoke<WhatsAppConfig | null>('whatsapp_config_load', { userId }),
    /** The folder must be one `chooseFolder` returned. */
    saveConfig: (userId: string, config: WhatsAppConfig) => shell.invoke<void>('whatsapp_config_save', { userId, config }),
    /** On disconnect and sign-out; stops the bridge Tresso started from that folder. */
    clearConfig: (userId: string) => shell.invoke<void>('whatsapp_config_clear', { userId }),
    /** The folder dialog; null when cancelled. Only a folder picked here can be used. */
    chooseFolder: () => shell.invoke<string | null>('whatsapp_choose_folder'),
    inspect: (folder: string) => shell.invoke<BridgeInspection>('whatsapp_inspect', { folder }),
    /** Uses a bridge that already runs, else starts the one in the folder. */
    start: (folder: string) => shell.invoke<BridgeState>('whatsapp_start', { folder }),
    stop: () => shell.invoke<BridgeState>('whatsapp_stop'),
    state: () => shell.invoke<BridgeState>('whatsapp_state'),
    identity: (folder: string) => shell.invoke<WhatsAppIdentity | null>('whatsapp_identity', { folder }),
    /** At most 500 rows after `afterRowid`; rejects with `busy` while the bridge writes (skip the round). */
    read: (folder: string, afterRowid: number, limit: number) => shell.invoke<BridgeRows>('whatsapp_read', { folder, afterRowid, limit }),
    names: (folder: string, ids: string[]) => shell.invoke<Record<string, SenderName>>('whatsapp_names', { folder, ids }),
    /** `mediaPath` must be a file `chooseFile` returned. */
    send: (recipient: string, text: string, mediaPath: string | null = null) => shell.invoke<SendResult>('whatsapp_send', { recipient, text, mediaPath }),
    download: (folder: string, messageId: string, chatJid: string) => shell.invoke<DownloadedFile>('whatsapp_download', { folder, messageId, chatJid }),
    /** Opens a file `download` returned with its default app. */
    openFile: (path: string) => shell.invoke<void>('whatsapp_open_file', { path }),
    /** The file dialog for Attach; null when cancelled. */
    chooseFile: () => shell.invoke<string | null>('whatsapp_choose_file'),
    /** Calls `handle` with the bridge's state on every change; returns the function that stops listening. */
    onState: (handle: (state: BridgeState) => void) => shell.listen(WHATSAPP_EVENT, ({ payload }) => handle(payload as BridgeState)),
  }
}

export type WhatsAppCommands = ReturnType<typeof whatsAppShell>
