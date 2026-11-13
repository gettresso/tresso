import { fileSize } from '../files'
import { chatSubtitle, nameText, SENDER_COLORS, senderColor } from './format'
import type { ChatMediaError, ChatMediaKind, SyncedChat, SyncedChatMessage } from './types'

/*
 * Chat texts the web app and the phone say alike: names, a file's kind and size, a file on the server, and the wait
 * after the server said too many files. Pure, so every state is tested here once.
 */

/** A chat's name: its WhatsApp name, else its number, else what it is. */
export function chatName(chat: Pick<SyncedChat, 'name' | 'jid' | 'kind'>): string {
  return nameText(chat.name) || chatSubtitle(chat) || (chat.kind === 'group' ? 'Group' : 'WhatsApp chat')
}

/** A group sender's name as known (a name, else the number the relay put there), else `Unknown sender` (plan 5.1). */
export function senderLabel(message: Pick<SyncedChatMessage, 'sender'>): string {
  return nameText(message.sender?.name ?? null) || 'Unknown sender'
}

/** Which of the six sender colours (SENDER_COLORS) a sender's name is drawn in, as an index for the theme's tokens. */
export function senderTone(id: string): number {
  return SENDER_COLORS.indexOf(senderColor(id))
}

/** `10:02`, the time of day of a message. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

const KIND_LABELS: Record<ChatMediaKind, string> = { image: 'Photo', video: 'Video', audio: 'Voice message', document: 'File' }

/** `Photo`, `Video`, `Voice message`, `File`. */
export function mediaKindLabel(kind: ChatMediaKind): string {
  return KIND_LABELS[kind] ?? 'File'
}

/**
 * The first line of a file row (plan 6.7): the kind and the size (`Photo, 180 KB`); a document keeps its name instead
 * of the kind (`plan.pdf, 180 KB`), since the bridge invents the names of the other kinds.
 */
export function mediaTitle(message: Pick<SyncedChatMessage, 'mediaKind' | 'mediaName' | 'mediaSize'>): string {
  const kind = message.mediaKind ?? 'document'
  const label = kind === 'document' ? nameText(message.mediaName) || 'File' : mediaKindLabel(kind)
  return message.mediaSize === null ? label : `${label}, ${fileSize(message.mediaSize)}`
}

/** From which length the reply box says how many characters are used. */
export const COUNTER_FROM = 3_900

/** The warning before a file that could not be checked opens. */
export const UNSCANNED_WARNING = 'This file could not be checked for malware. Open it only if you trust the sender.'

/** What a file row says and offers for a file that goes through the server (asked for from the relaying Mac). */
export interface ServerFileView {
  line: string
  action: 'download' | 'retry' | 'open' | 'confirm' | null
  failed: boolean
}

const SERVER_FILE_FAILURES: Record<ChatMediaError, string> = {
  not_found: 'Your Mac could not find this file in WhatsApp.',
  mismatch: "WhatsApp gave your Mac another file than this message's. It was not passed on.",
  unverified: "Your Mac could not check that this is the message's file. It was not passed on.",
  too_large: 'This file is larger than 100 MB, the most Tresso passes on.',
  unavailable: 'Your Mac could not get this file from WhatsApp. WhatsApp may no longer have it.',
}

/**
 * A file on the server, from its message's state (the delta's `mediaState`, `mediaError`, `mediaAccess`): on the Mac
 * (Download asks for it), asked for (waiting for the Mac while it is offline), being checked for malware, ready (Open),
 * not checked (after a warning), blocked, or not brought (Try again, but not for a file too large).
 */
export function serverFileView(message: Pick<SyncedChatMessage, 'mediaKind' | 'mediaState' | 'mediaError' | 'mediaAccess'>, relayOnline: boolean): ServerFileView {
  switch (message.mediaState ?? 'remote') {
    case 'requested':
      return { line: relayOnline ? 'Your Mac is bringing this file.' : 'Waiting for your Mac.', action: null, failed: false }
    case 'failed': {
      const error = message.mediaError ?? 'unavailable'
      return { line: SERVER_FILE_FAILURES[error], action: error === 'too_large' ? null : 'retry', failed: true }
    }
    case 'stored':
      switch (message.mediaAccess ?? 'blocked') {
        case 'allowed':
          return { line: 'Ready to open.', action: 'open', failed: false }
        case 'scanning':
          return { line: 'Checking for malware.', action: null, failed: false }
        case 'confirm':
          return { line: 'This file could not be checked for malware.', action: 'confirm', failed: false }
        default:
          return { line: 'This file is blocked: it contains malware, or this server only opens checked files.', action: null, failed: true }
      }
    default:
      return { line: `${mediaKindLabel(message.mediaKind ?? 'document')}, on your Mac`, action: 'download', failed: false }
  }
}

/**
 * `a minute`, `4 minutes`, `2 hours`: a wait the server asked for (Retry-After), rounded up, so the user never tries
 * again too early. No wait, a negative one or one that is not a number is `a minute`.
 */
export function waitText(ms: number): string {
  // A wait that is not a number (a missing or broken Retry-After) is said as the shortest.
  const minutes = Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 60_000)) : 1
  if (minutes === 1) {
    return 'a minute'
  }
  if (minutes < 60) {
    return `${minutes} minutes`
  }
  const hours = Math.ceil(minutes / 60)
  return hours === 1 ? 'an hour' : `${hours} hours`
}

/** What Attach says while the server asked to wait after too many files (a 429 on an upload), with the real wait. */
export function attachHeldText(waitMs: number): string {
  return `Too many files sent at once. Wait ${waitText(waitMs)}, then attach it again.`
}
