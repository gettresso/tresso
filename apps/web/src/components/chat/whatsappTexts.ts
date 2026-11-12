import { phoneLabel } from '@tresso/core'
import type { BridgeFailure, BridgeInspection, BridgeState, WhatsAppIdentity } from '@/platform/whatsapp'

/**
 * What the WhatsApp connect dialog and Settings: WhatsApp say about the bridge, in plain words (the ConnectWhatsApp and
 * SettingsWhatsApp boards, with the corrections of the WhatsApp plan, section 6). Pure, so every state is tested
 * without a shell.
 */

/** The fork of whatsapp-mcp Tresso works with: its bridge checks the token Tresso gives it (docs/whatsapp-bridge.md). */
export const INSTALL_URL = 'https://github.com/gettresso/whatsapp-mcp'
/** What the bridge needs to listen on loopback only and to check Tresso's token. */
export const BRIDGE_DOCS_URL = 'https://github.com/gettresso/tresso/blob/main/docs/whatsapp-bridge.md'
/** Building the bridge once, in the whatsapp-mcp folder. Tresso never runs `go` itself. */
export const BUILD_COMMAND = 'cd whatsapp-bridge && go build -o whatsapp-bridge .'
/** How far back the first import reaches. */
export const IMPORT_DAYS = 30

/** The risk, said before anything links (the owner's decision: plain words, confirmed once). */
export const RISK_TEXT =
  "Tresso connects through the bridge of whatsapp-mcp on this Mac, which signs in to WhatsApp as a linked device over WhatsApp Web. WhatsApp does not officially allow this for other apps and can limit or ban an account that uses it. Use it with an account you can afford to lose access to. Your messages are stored on this Mac, in the bridge's own folder."
export const RISK_CONFIRM = 'I understand the risk and want to connect my WhatsApp account'

export const FOLDER_NOTE = 'The folder with whatsapp-bridge. Tresso starts the bridge from here and reads the messages it stores.'
export const BRIDGE_NOTE = 'The Go bridge receives messages while it runs. Messages that arrive while it is stopped are not picked up.'
export const LINK_NOTE = 'Scan this code with WhatsApp > Linked devices on your phone. WhatsApp can ask you to link again, often after about 20 days.'
export const IMPORT_NOTE = `Tresso reads chats from the last ${IMPORT_DAYS} days now and every new message after that.`

/** A check of the connect dialog, or a row of Settings: what it says now. */
export interface StatusText {
  /** Short, next to the title. */
  status: string
  /** A sentence that says what happened and what to do; null when the status says it all. */
  detail: string | null
  /** The check is done (ticked), or the row is fine (green dot). */
  ok: boolean
}

/** A home folder shown as `~`, as the boards do: `/Users/kim/whatsapp-mcp` is `~/whatsapp-mcp`. */
export function shortFolder(folder: string): string {
  return folder.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

/** A WhatsApp number as stored (digits only) in the international form, without a library for spacing (6.7). */
export function phoneNumber(digits: string): string {
  return phoneLabel(digits) ?? digits
}

/** `Kim Visser, +31612345678`, either part alone, or null when nothing is known. */
export function linkedName(identity: WhatsAppIdentity | null): string | null {
  if (identity === null) {
    return null
  }
  const parts = [identity.name?.trim() || null, identity.number === '' ? null : phoneNumber(identity.number)].filter((part): part is string => part !== null)
  return parts.length === 0 ? null : parts.join(', ')
}

const UNSAFE = 'Another user on this Mac can change the bridge or its folder, so Tresso does not start it. Make the folder yours and writable by you only (in Terminal: chmod -R go-w followed by the folder), then start the bridge again.'

/** Check 1: the folder the user picked. */
export function folderText(inspection: BridgeInspection | null): StatusText {
  if (inspection === null) {
    return { status: 'Choose the folder', detail: null, ok: false }
  }
  if (!inspection.found) {
    return { status: 'Not found', detail: 'There is no whatsapp-bridge folder in it. Choose the whatsapp-mcp folder you downloaded.', ok: false }
  }
  if (!inspection.built) {
    return { status: 'Found, not built yet', detail: 'Build the bridge once in Terminal, in this folder:', ok: false }
  }
  if (!inspection.safe) {
    return { status: 'Found, not safe to start', detail: UNSAFE, ok: false }
  }
  return { status: 'Found', detail: null, ok: true }
}

/** Why the bridge is not running, and what to do; `buildCommand` says to show the build command under it. */
export const BRIDGE_PROBLEMS: Record<BridgeFailure, { status: string; detail: string; buildCommand: boolean }> = {
  not_built: { status: 'Not built yet', detail: 'There is no built bridge in this folder. Build it once in Terminal, in the whatsapp-mcp folder:', buildCommand: true },
  exited: {
    status: 'Stopped',
    detail: 'The bridge quit three times within a minute, so Tresso stopped starting it. Start it again; if it keeps quitting, run it once in Terminal to see why.',
    buildCommand: false,
  },
  port_busy: {
    status: 'Port in use',
    detail: "Another program already uses the bridge's port on this Mac, often a whatsapp-bridge started in Terminal. Quit that one, then start the bridge again.",
    buildCommand: false,
  },
  unprotected: {
    status: 'Not protected',
    detail:
      'This bridge does not check the key Tresso gives it, so any app or web page on this Mac could send WhatsApp messages through it. Tresso does not use it. This happens with the original whatsapp-mcp or with a bridge started in Terminal. Download whatsapp-mcp from gettresso/whatsapp-mcp, build its bridge again and choose that folder; quit a bridge that runs in Terminal.',
    buildCommand: true,
  },
  unsafe: { status: 'Not safe to start', detail: UNSAFE, buildCommand: false },
}

/** The bridge never started in this session (no state from the shell beyond the stopped one). */
export function bridgeIdle(bridge: BridgeState): boolean {
  return bridge.process === 'stopped' && bridge.error === null && bridge.link === 'unknown'
}

/** Check 2 and the Settings `Bridge` row (without the last message, which Settings adds). */
export function bridgeText(bridge: BridgeState, started: boolean): StatusText & { problem: BridgeFailure | null } {
  if (bridge.error !== null) {
    const problem = BRIDGE_PROBLEMS[bridge.error]
    return { status: problem.status, detail: problem.detail, ok: false, problem: bridge.error }
  }
  if (bridge.process === 'owned') {
    if (bridge.port === null) {
      return { status: 'Starting', detail: null, ok: false, problem: null }
    }
    if (bridge.loopbackOnly === false) {
      return { status: `Running, open to your network on port ${bridge.port}`, detail: 'Other computers on your network can reach this bridge.', ok: true, problem: null }
    }
    return { status: 'Running on this Mac', detail: null, ok: true, problem: null }
  }
  if (!started) {
    return { status: 'Not started', detail: null, ok: false, problem: null }
  }
  if (bridge.link === 'unlinked') {
    return { status: 'Stopped', detail: 'Nobody scanned the code for three minutes, so the bridge stopped.', ok: false, problem: null }
  }
  return { status: 'Stopped', detail: 'Tresso starts it again in a moment.', ok: false, problem: null }
}

/** Check 3 and the Settings `Linked to phone` row; `linkedAt` and `now` give Settings its age line. */
export function linkText(bridge: BridgeState, identity: WhatsAppIdentity | null): StatusText & { qr: boolean; expired: boolean } {
  const none = { qr: false, expired: false }
  if (bridge.process === 'owned') {
    switch (bridge.link) {
      case 'linked': {
        const name = linkedName(identity)
        return { status: name === null ? 'Linked' : `Linked as ${name}`, detail: null, ok: true, ...none }
      }
      case 'waiting_for_scan':
        return bridge.qr === null ? { status: 'Waiting for the code', detail: null, ok: false, ...none } : { status: 'Scan the code', detail: null, ok: false, qr: true, expired: false }
      case 'unlinked':
        return { status: 'Not linked', detail: 'WhatsApp ended the link. A new code comes in a moment.', ok: false, ...none }
      default:
        return { status: 'Waiting for the bridge', detail: null, ok: false, ...none }
    }
  }
  if (bridge.link === 'unlinked' && bridge.error === null) {
    return { status: 'Code expired', detail: 'Nobody scanned the code for three minutes. Show a new code to try again.', ok: false, qr: false, expired: true }
  }
  return { status: 'Not linked', detail: null, ok: false, ...none }
}

const DAY = 24 * 60 * 60 * 1000

/** Settings: how long ago Tresso saw the phone link (6.4: no countdown, WhatsApp publishes no expiry). */
export function linkedAge(linkedAt: string | null, now: number): string {
  const at = linkedAt === null ? Number.NaN : Date.parse(linkedAt)
  if (Number.isNaN(at)) {
    return 'Linked.'
  }
  const days = Math.max(0, Math.floor((now - at) / DAY))
  const ago = days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`
  return `Linked ${ago}. WhatsApp can ask you to link again.`
}

/** `last message 2 minutes ago`, for the Settings `Bridge` row. */
export function relativeTime(at: string, now: number): string {
  const ms = now - Date.parse(at)
  if (Number.isNaN(ms) || ms < 60_000) {
    return 'just now'
  }
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) {
    return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  }
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

/** Where the first import is: before it began, while it runs, done, or stuck (ChatRelayImportStuck). */
export type ImportState = 'waiting' | 'reading' | 'done' | 'stuck'

export interface ImportCounts {
  /** Messages handed to the copy in this session. */
  messages: number
  /** Chats they belong to, in this session. */
  chats: number
  /** Chats in the copy (for the done line). */
  stored: number
  /** Messages a stuck import could not store. */
  refused: number
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en')} ${count === 1 ? one : many}`
}

/** Check 4, and the import line in Settings. Counts only. */
export function importText(state: ImportState, counts: ImportCounts): StatusText {
  switch (state) {
    case 'reading':
      return { status: 'Reading', detail: `${plural(counts.messages, 'message', 'messages')} from ${plural(counts.chats, 'chat', 'chats')} so far.`, ok: false }
    case 'done':
      return { status: `${plural(counts.stored, 'chat', 'chats')}, ${IMPORT_DAYS} days`, detail: null, ok: true }
    case 'stuck':
      return {
        status: 'Stuck',
        detail: `${plural(counts.refused, 'message', 'messages')} could not be stored, so reading stopped there. Tresso keeps trying; the bridge keeps every message meanwhile.`,
        ok: false,
      }
    default:
      return { status: 'Waiting', detail: null, ok: false }
  }
}

/** The shell's rejection codes (platform/whatsapp.ts) in plain words; a sentence the shell wrote is kept as it is. */
const SHELL_ERRORS: Record<string, string> = {
  unsupported: 'WhatsApp works in Tresso for Mac only.',
  not_chosen: 'Choose the whatsapp-mcp folder again: Tresso only uses a folder you picked.',
  no_folder: 'The whatsapp-mcp folder is not there any more. Choose it again.',
  no_store: 'The bridge has not stored any messages yet.',
  bridge_stopped: 'The bridge is not running.',
  busy: 'The bridge is busy. Try again in a moment.',
  failed: 'The bridge did not answer. Try again in a moment.',
  refused: 'The bridge refused the request.',
}

/** What to tell the user about a failed shell command. */
export function shellErrorText(error: unknown): string {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  const known = SHELL_ERRORS[text]
  if (known !== undefined) {
    return known
  }
  // The shell's own sentences are written for users (whatsapp.rs); a bare code it may add later is not.
  return /\s/.test(text) ? text : 'Something went wrong with WhatsApp. Try again.'
}

/** A name for an error that is safe to log: a shell code or an error's class, never a message (it may quote content). */
export function errorName(error: unknown): string {
  if (typeof error === 'string') {
    return error in SHELL_ERRORS || /^[a-z_]{1,32}$/.test(error) ? error : 'ShellError'
  }
  return error instanceof Error ? error.name : 'UnknownError'
}
