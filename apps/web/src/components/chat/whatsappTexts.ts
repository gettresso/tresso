import { nameText, phoneLabel } from '@tresso/core'
import type { BridgeFailure, BridgeState, WhatsAppIdentity } from '@/platform/whatsapp'

/**
 * What the WhatsApp connect dialog and Settings: WhatsApp say, in plain words (the ConnectWhatsApp and
 * SettingsWhatsApp boards). Pure, so every state is tested without a shell. Tresso for Mac carries its own link to
 * WhatsApp and starts it by itself, so nothing here names a bridge, a folder, a port or anything to install.
 */

/** How far back the first import reaches. */
export const IMPORT_DAYS = 30

/** The connect dialog's first line. */
export const CONNECT_LEAD = 'Read and answer your WhatsApp chats next to your mail.'
/** The risk, said before anything links (the owner's decision: plain words, confirmed once). */
export const RISK_TEXT = 'WhatsApp does not officially allow other apps to link this way and can limit or ban an account that does. Use an account you can afford to lose access to.'
export const RISK_CONFIRM = 'I understand the risk and want to connect my WhatsApp account'

/** What to do with the code on the phone. */
export const LINK_STEPS = ['Open WhatsApp on your phone.', 'Go to Settings, then Linked devices.', 'Tap Link a device and scan this code.'] as const
export const CODE_RENEWS = 'The code renews by itself.'
export const GETTING_CODE = 'Getting a code\u2026'
export const CODE_EXPIRED = 'The code expired'
export const CODE_EXPIRED_NOTE = 'Nobody scanned it for three minutes.'

/** A config an earlier version connected through whatsapp-mcp: the phone links again to Tresso's own link. */
export const MOVED_TEXT = 'WhatsApp now runs inside Tresso. Link your phone again.'

/** A failure in the connect dialog's one pattern: what happened, one sentence, one button. */
export interface FailureText {
  title: string
  text: string
  action: string
}

/** Why WhatsApp does not run on this Mac (BridgeFailure), as the connect dialog says it. */
export const FAILURES: Record<BridgeFailure, FailureText> = {
  missing: { title: 'WhatsApp could not start on this Mac', text: 'A part of Tresso that WhatsApp needs is missing. Install Tresso again.', action: 'Try again' },
  store: { title: 'WhatsApp could not start on this Mac', text: 'Tresso could not open its WhatsApp data on this Mac. Try again in a moment.', action: 'Try again' },
  offline: { title: 'WhatsApp could not be reached', text: 'Check that this Mac is online, then try again.', action: 'Try again' },
  pair_failed: { title: 'WhatsApp did not accept the link', text: 'Nothing was linked. Try again with a new code.', action: 'Try again' },
  outdated: { title: 'Tresso needs an update for WhatsApp', text: 'WhatsApp no longer accepts this version of Tresso. Update Tresso, then try again.', action: 'Try again' },
  replaced: { title: 'WhatsApp is open elsewhere with this link', text: 'Another copy of Tresso on this Mac uses the same link. Quit it, then try again.', action: 'Try again' },
  banned: { title: 'WhatsApp blocked this account for now', text: 'WhatsApp limits accounts that link this way. Try again later.', action: 'Try again' },
  logged_out: { title: 'This phone signed Tresso out', text: 'New messages do not come in until you link again.', action: 'Link again' },
  exited: { title: 'WhatsApp could not start on this Mac', text: 'Nothing was linked. Try again in a moment.', action: 'Try again' },
}

/** The same failure in Settings, where something was linked before: one sentence. */
export function failureLine(failure: BridgeFailure): string {
  return failure === 'exited' ? 'WhatsApp stopped several times on this Mac. Try again in a moment.' : `${FAILURES[failure].title}. ${FAILURES[failure].text}`
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

/** The linked view's heading: `Linked to +31612345678`, or `Linked` while the number is not known. */
export function linkedTitle(identity: WhatsAppIdentity | null): string {
  return identity !== null && identity.number !== '' ? `Linked to ${phoneNumber(identity.number)}` : 'Linked'
}

/**
 * Where linking stands on this Mac, for the code panels of the dialog and Settings:
 * - `loading`: starting, a code is on its way.
 * - `scan`: a code to scan.
 * - `expired`: nobody scanned for three minutes; a new code waits for the user.
 * - `linked`: the phone is linked.
 * - `failed`: it does not run, for the reason `failure` names (a log out included).
 * - `idle`: not started.
 */
export type LinkStage = 'idle' | 'loading' | 'scan' | 'expired' | 'linked' | 'failed'

export function linkStage(bridge: BridgeState): LinkStage {
  if (bridge.error !== null) {
    return 'failed'
  }
  if (bridge.process === 'owned') {
    if (bridge.link === 'linked') {
      return 'linked'
    }
    return bridge.link === 'waiting_for_scan' && bridge.qr !== null ? 'scan' : 'loading'
  }
  return bridge.link === 'unlinked' ? 'expired' : 'idle'
}

/** Settings' status word for WhatsApp on this Mac (the pill): plain words, nothing about how it runs. */
export function statusWord(bridge: BridgeState, moved: boolean): { text: string; ok: boolean } {
  const stage = linkStage(bridge)
  if (stage === 'linked') {
    return { text: 'Connected', ok: true }
  }
  if (moved) {
    return { text: 'Link again', ok: false }
  }
  switch (stage) {
    case 'failed':
      return bridge.error === 'logged_out' ? { text: 'Not linked', ok: false } : { text: 'Could not start', ok: false }
    case 'loading':
      return { text: bridge.link === 'unknown' ? 'Starting' : 'Not linked', ok: false }
    case 'scan':
    case 'expired':
      return { text: 'Not linked', ok: false }
    default:
      return { text: 'Stopped', ok: false }
  }
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

/** A row of Settings, or the import line: what it says now. */
export interface StatusText {
  /** Short, next to the title. */
  status: string
  /** A sentence that says what happened and what to do; null when the status says it all. */
  detail: string | null
  /** The row is fine (green dot). */
  ok: boolean
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

/** The import line in Settings. Counts only. */
export function importText(state: ImportState, counts: ImportCounts): StatusText {
  switch (state) {
    case 'reading':
      return { status: 'Reading', detail: `${plural(counts.messages, 'message', 'messages')} from ${plural(counts.chats, 'chat', 'chats')} so far.`, ok: false }
    case 'done':
      return { status: `${plural(counts.stored, 'chat', 'chats')}, ${IMPORT_DAYS} days`, detail: null, ok: true }
    case 'stuck':
      return {
        status: 'Stuck',
        detail: `${plural(counts.refused, 'message', 'messages')} could not be stored, so reading stopped there. Tresso keeps trying; WhatsApp on this Mac keeps every message meanwhile.`,
        ok: false,
      }
    default:
      return { status: 'Waiting', detail: null, ok: false }
  }
}

/** The shell's rejection codes (platform/whatsapp.ts) in plain words; a sentence the shell wrote is kept as it is. */
const SHELL_ERRORS: Record<string, string> = {
  unsupported: 'WhatsApp works in Tresso for Mac only.',
  no_store: 'WhatsApp has not stored any messages on this Mac yet.',
  bridge_stopped: 'WhatsApp is not running on this Mac.',
  busy: 'WhatsApp is busy on this Mac. Try again in a moment.',
  failed: 'WhatsApp did not answer. Try again in a moment.',
  refused: 'WhatsApp refused the request.',
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

// ---- Where the chats live ("Only this Mac" or "All my devices") ------------------------------------------------------

/** The two places, as the connect dialog offers them; "Only this Mac" first and preselected (owner decision D3). */
export const PLACE_LOCAL_NOTE = 'Chats never leave this computer. Web and mobile do not show WhatsApp.'
export const PLACE_ALL_NOTE = 'This Mac passes your chats to your Tresso server, so web and mobile show them too.'
/** Settings' note under "Where messages live" (the SettingsWhatsApp board). */
export const MODE_NOTE = 'All my devices: this Mac copies chats to your Tresso server so web and mobile show them. Only this Mac: chats never leave this computer.'

/** The connect dialog's question when "All my devices" is picked (buttons Copy, Cancel). */
export const ASK_COPY_TITLE = 'Copy your WhatsApp chats to your Tresso server?'
export const ASK_COPY_BODY = 'Web and mobile will show them. Choosing Only this Mac again removes them from the server.'
/** The confirmation of the switch to "All my devices" in Settings (buttons Copy, Cancel). */
export const COPY_TITLE = 'Copy your WhatsApp chats to your Tresso server? Web and mobile will show them.'
export const COPY_BODY =
  'This Mac copies the WhatsApp chats Tresso brings in to your Tresso server, where they are stored sealed with your account, and sends the replies you write on any device. Choosing Only this Mac again, or disconnecting WhatsApp, removes them from the server and from your other devices.'
/** The confirmation of the switch to "Only this Mac" (buttons Remove, Cancel). */
export const REMOVE_TITLE = 'Remove your WhatsApp chats from your Tresso server? Web and mobile will stop showing them.'
export const REMOVE_BODY =
  'Tresso deletes your WhatsApp chats from your Tresso server and from your other devices, with the replies still waiting there, and brings the chats in again on this Mac. WhatsApp on this Mac keeps everything.'

/** In the Copy confirmation and the left-out list in "All my devices": what the server keeps of a chat left out. */
export const LEFT_OUT_KEPT = 'Chats you left out stay out on every device: Tresso keeps only their WhatsApp address on your server, sealed, to recognise them.'
/** In a takeover's confirmation when this Mac leaves groups out and the account does not. */
export const GROUPS_WOULD_GO = 'Group chats will be removed from your Tresso server, because this Mac leaves groups out.'

/** What a switch under way says (the copy keeps it until it is done, also through a restart). */
export function switchText(to: 'all' | 'local', removed: boolean): string {
  if (to === 'all') {
    return 'Moving your WhatsApp chats to your Tresso server.'
  }
  return removed ? 'Your WhatsApp chats were removed from your Tresso server. They come in again on this Mac once its mail has caught up.' : 'Removing your WhatsApp chats from your Tresso server.'
}

/** A device name as another device named itself; `your Mac` when nothing of it can be shown. */
export function deviceLabel(name: string | null): string {
  return nameText(name) || 'your Mac'
}

/** The "Relaying Mac" row when another Mac relays: `Kim's MacBook Pro, online now`, or when it was last heard from. */
export function otherRelayText(relay: { name: string; online: boolean; offlineSince: string | null }, now: number): string {
  const name = deviceLabel(relay.name)
  if (relay.online) {
    return `${name}, online now`
  }
  return relay.offlineSince === null ? `${name}, offline` : `${name}, offline, last heard from ${relativeTime(relay.offlineSince, now)}`
}

/** Messages the server would not take and the relay passed over ("All my devices"); null when none. */
export function serverRefusedText(count: number): string | null {
  return count === 0 ? null : `${count.toLocaleString('en')} ${count === 1 ? 'message' : 'messages'} could not be copied to your Tresso server; ${count === 1 ? 'it stays' : 'they stay'} on this Mac only.`
}

/** Replies that waited here at the switch: still to go to the server's queue. Null when none waits. */
export function carriedText(waiting: number): string | null {
  return waiting === 0
    ? null
    : `${waiting.toLocaleString('en')} ${waiting === 1 ? 'reply' : 'replies'} written on this Mac before the switch ${waiting === 1 ? 'goes' : 'go'} to your Tresso server once ${waiting === 1 ? 'its chat is' : 'their chats are'} there.`
}

function replies(count: number): string {
  return `${count.toLocaleString('en')} ${count === 1 ? 'reply' : 'replies'}`
}

/** What became of the replies of a switch that did not reach the server's queue, by why; null when nothing. */
export function carryCountsText(counts: { lost: number; cancelled: number; unsure: number; notSent: number }): string | null {
  const parts: string[] = []
  if (counts.notSent > 0) {
    parts.push(`${replies(counts.notSent)} that ${counts.notSent === 1 ? 'was' : 'were'} not sent on this Mac ${counts.notSent === 1 ? 'was' : 'were'} not carried over.`)
  }
  if (counts.lost > 0) {
    parts.push(`${replies(counts.lost)} could not be carried over, because ${counts.lost === 1 ? 'its chat' : 'their chats'} did not come in or ${counts.lost === 1 ? 'was' : 'were'} left out. Write ${counts.lost === 1 ? 'it' : 'them'} again if needed.`)
  }
  if (counts.cancelled > 0) {
    parts.push(`${replies(counts.cancelled)} ${counts.cancelled === 1 ? 'was' : 'were'} cancelled on another device and ${counts.cancelled === 1 ? 'was' : 'were'} not sent.`)
  }
  if (counts.unsure > 0) {
    parts.push(`${replies(counts.unsure)} may already have been queued or cancelled before; Tresso did not send ${counts.unsure === 1 ? 'it' : 'them'} again. Check the chat, and write ${counts.unsure === 1 ? 'it' : 'them'} again if needed.`)
  }
  return parts.length === 0 ? null : parts.join(' ')
}

/** In the switch's confirmation: the replies on this Mac that were not sent, which are not carried over. */
export function notCarriedText(count: number): string | null {
  return count === 0 ? null : `${replies(count)} on this Mac that ${count === 1 ? 'was' : 'were'} not sent ${count === 1 ? 'is' : 'are'} not carried over: ${count === 1 ? 'it goes' : 'they go'} with the chats on this Mac.`
}

/** Why the relay paused, when the server asked it to wait (429, 403): how long, in plain words. */
export function pauseText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return ms < 60_000
    ? 'Your Tresso server asked Tresso to wait a moment before it sends more messages.'
    : `Your Tresso server asked Tresso to wait; it tries again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
}
