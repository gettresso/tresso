import {
  CHAT_REPLY_MAX,
  chatApiFailure,
  chatSubtitle,
  fileSize,
  nameText,
  replyErrorText,
  replyLabel,
  SENDER_COLORS,
  senderColor,
  type ChatMediaError,
  type ChatMediaKind,
  type ReplyTextProblem,
  type SyncedChat,
  type SyncedChatAccount,
  type SyncedChatMessage,
  type SyncedChatOutgoing,
} from '@tresso/core'

/*
 * What the phone's chat screens say: the MobileWhatsAppChat board, the desktop's chat texts
 * (apps/web/src/components/chat/chatTexts.ts) for what that board does not show, and the corrections of the WhatsApp
 * plan, section 6. Every name and text from WhatsApp goes through core's nameText or labelText where it is one line.
 * Pure, so every state is tested without a screen.
 */

/** A chat's name: its WhatsApp name, else its number, else what it is (as the desktop's chatName). */
export function chatName(chat: Pick<SyncedChat, 'name' | 'jid' | 'kind'>): string {
  return nameText(chat.name) || chatSubtitle(chat) || (chat.kind === 'group' ? 'Group' : 'WhatsApp chat')
}

/** Up to two letters for a chat's avatar: the first of its first and last word (a number's first two digits). */
export function chatInitials(name: string): string {
  const words = name.replace(/^\+/, '').split(/\s+/).filter((word) => /^[\p{L}\p{N}]/u.test(word))
  const first = [...(words[0] ?? '?')][0] ?? '?'
  if (/^\p{N}/u.test(first)) {
    return [...(words[0] ?? '')].slice(0, 2).join('')
  }
  const last = words.length > 1 ? ([...words[words.length - 1]!][0] ?? '') : ''
  return (first + last).toUpperCase()
}

/** A group sender's name as known, else `Unknown sender` (plan 5.1). */
export function senderLabel(message: Pick<SyncedChatMessage, 'sender'>): string {
  return nameText(message.sender?.name ?? null) || 'Unknown sender'
}

/** Which of the theme's six sender colours a sender's name is drawn in (core's senderColor, as an index). */
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
 * The first line of a file row (plan 6.7): the kind and the size (`Photo, 180 KB`); a document keeps its name instead of
 * the kind (`plan.pdf, 180 KB`), since the bridge invents the names of the other kinds.
 */
export function mediaTitle(message: Pick<SyncedChatMessage, 'mediaKind' | 'mediaName' | 'mediaSize'>): string {
  const kind = message.mediaKind ?? 'document'
  const label = kind === 'document' ? nameText(message.mediaName) || 'File' : mediaKindLabel(kind)
  return message.mediaSize === null ? label : `${label}, ${fileSize(message.mediaSize)}`
}

/** What a file row says and offers on the phone (the file is asked for from the relaying Mac, then opened from the server). */
export interface MediaView {
  line: string
  action: 'download' | 'retry' | 'open' | 'confirm' | null
  failed: boolean
}

const MEDIA_FAILURES: Record<ChatMediaError, string> = {
  not_found: 'Your Mac could not find this file in WhatsApp.',
  mismatch: "WhatsApp gave your Mac another file than this message's. It was not passed on.",
  unverified: "Your Mac could not check that this is the message's file. It was not passed on.",
  too_large: 'This file is larger than 100 MB, the most Tresso passes on.',
  unavailable: 'Your Mac could not get this file from WhatsApp. WhatsApp may no longer have it.',
}

/**
 * A file's row from its message (the delta's `mediaState`, `mediaError`, `mediaAccess`): on the Mac (Download asks for
 * it), asked for, being checked for malware, ready (Open), not checked (Open anyway, after a warning), blocked, or not
 * brought (Try again, but not for a file too large).
 */
export function mediaView(message: Pick<SyncedChatMessage, 'mediaKind' | 'mediaState' | 'mediaError' | 'mediaAccess'>, relayOnline: boolean): MediaView {
  switch (message.mediaState ?? 'remote') {
    case 'requested':
      return { line: relayOnline ? 'Your Mac is bringing this file.' : 'Waiting for your Mac.', action: null, failed: false }
    case 'failed': {
      const error = message.mediaError ?? 'unavailable'
      return { line: MEDIA_FAILURES[error], action: error === 'too_large' ? null : 'retry', failed: true }
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

/** A file on its way from the phone: `Uploading, 40%`, or `Queueing for your Mac` once it is up. */
export function uploadText(upload: { phase: 'uploading' | 'queueing'; progress: number | null }): string {
  if (upload.phase === 'queueing') {
    return 'Queueing for your Mac'
  }
  return upload.progress === null ? 'Uploading' : `Uploading, ${Math.round(upload.progress * 100)}%`
}

/**
 * The line under the reply box after a file did not go (FileNotSent): nothing queued when it failed before the reply was
 * (reading or uploading the file, or a refusal), maybe queued when the queueing got no answer (the same file again goes
 * as the same reply), and nothing at all when the user cancelled it.
 */
export function fileFailureText(name: string, phase: 'upload' | 'queue', reason: unknown, unsure: boolean, cancelled: boolean, maybeSent = false): string {
  if (cancelled) {
    // A cancel the server did not confirm: the reply may be queued, and then it goes (the chat shows it).
    return maybeSent ? `${name} may still be sent. Check the chat.` : `${name} was not sent.`
  }
  if (unsure) {
    return `${name} may have been queued. ${requestFailure(reason)} Attaching the same file again in the next minutes sends it once.`
  }
  return `${name} was not sent. ${phase === 'upload' && chatApiFailure(reason) === null && reason instanceof Error && reason.name !== 'TypeError' ? reason.message : requestFailure(reason)}`
}

/** A link to a file that the phone could not hand to an app. */
export const FILE_NOT_OPENED = 'This phone could not open the file.'

/** The warning before a file that could not be checked opens. */
export const UNSCANNED_WARNING = 'This file could not be checked for malware. Open it only if you trust the sender.'

/** What the banner above a chat says about the relaying Mac, or null when it relays and WhatsApp works. */
export function relayBanner(account: Pick<SyncedChatAccount, 'relayOnline' | 'bridge' | 'link'> | null): string | null {
  if (account === null) {
    return null
  }
  if (!account.relayOnline) {
    // The MobileWhatsAppChat board.
    return 'Your Mac is offline. Replies go out once it is back.'
  }
  if (account.link === 'unlinked') {
    return 'WhatsApp is not linked on your Mac. Nothing comes in or goes out until it is linked again.'
  }
  if (account.bridge === 'stopped') {
    return 'The bridge on your Mac is not running. Replies go out once it runs again.'
  }
  return null
}

/** A reply as its bubble shows it. */
export interface ReplyView {
  /** Under the text: `10:31, waiting for your Mac`, `10:02, sent`, `Not sent, tap to retry`, `10:31, not confirmed`. */
  meta: string
  state: 'waiting' | 'sending' | 'sent' | 'failed' | 'unconfirmed'
  /** Why it was not sent, under the bubble; null otherwise. */
  reason: string | null
  /** What a screen reader says after `You, <time>`. */
  spoken: string
}

/**
 * A reply's state on the phone (the MobileWhatsAppChat and WhatsAppStates boards, core's replyLabel): `waiting for your
 * Mac` while the relaying Mac is offline, `sending` while it is online or has claimed it, `sent`, `Not sent, tap to
 * retry` with the reason under it, and for a send the Mac could not confirm `not confirmed` with the warning that it may
 * have gone out: that one is never sent again by a tap on the bubble, only by its own Try again. Null for a cancelled
 * reply, which is not shown.
 */
export function replyView(reply: Pick<SyncedChatOutgoing, 'status' | 'error'>, time: string, relayOnline: boolean): ReplyView | null {
  if (reply.status === 'failed' && reply.error === 'unconfirmed') {
    return { meta: time === '' ? 'Not confirmed' : `${time}, not confirmed`, state: 'unconfirmed', reason: replyErrorText('unconfirmed'), spoken: 'not confirmed' }
  }
  const label = replyLabel(reply, relayOnline)
  if (label === null) {
    return null
  }
  if (label === 'Not sent, tap to retry') {
    return { meta: label, state: 'failed', reason: reply.error === null ? null : replyErrorText(reply.error), spoken: 'not sent' }
  }
  const lower = `${label.charAt(0).toLowerCase()}${label.slice(1)}`
  const state = label === 'Waiting for your Mac' ? 'waiting' : label === 'Sent' ? 'sent' : 'sending'
  return { meta: time === '' ? label : `${time}, ${lower}`, state, reason: null, spoken: lower }
}

/** From which length the reply box says how many characters are used (as on the desktop). */
export const COUNTER_FROM = 3_900

/** `3,950 of 4,096 characters`. */
export function counterText(length: number): string {
  return `${length.toLocaleString('en')} of ${CHAT_REPLY_MAX.toLocaleString('en')} characters`
}

/** Why the text in the reply box cannot be sent; null for an empty box, which only keeps Send off. */
export function replyProblemText(problem: ReplyTextProblem): string | null {
  switch (problem) {
    case 'too_long':
      return `A reply can have at most ${CHAT_REPLY_MAX.toLocaleString('en')} characters.`
    case 'control':
      return 'The reply cannot contain control characters.'
    default:
      return null
  }
}

/** What a failed request says: the server's own words (they never quote a chat), or that it could not be reached. */
function requestFailure(error: unknown): string {
  const failure = chatApiFailure(error)
  if (failure === null) {
    return 'The server could not be reached. Check your connection.'
  }
  const detail = error instanceof Error ? error.message.trim() : ''
  if (detail === '') {
    return `The server answered ${failure.status}.`
  }
  return /[.!?]$/.test(detail) ? detail : `${detail}.`
}

/**
 * The line under the reply box after queueing a reply failed; the text is back in the box. When the server may have taken
 * it (no answer, a timeout, a server error: see outcomeUnknown) it says so: Send with the same text goes as the same
 * reply, never a second one.
 */
export function sendFailureText(error: unknown, unknown: boolean): string {
  return unknown
    ? `This reply may have been sent. ${requestFailure(error)} Check the chat before you send it again.`
    : `Not sent. ${requestFailure(error)}`
}

/** After Cancel or Delete failed. */
export function cancelFailureText(error: unknown): string {
  const failure = chatApiFailure(error)
  if (failure?.status === 409 && failure.code === 'already_going_out') {
    return 'This reply is being sent already and can no longer be cancelled.'
  }
  return `Not cancelled. ${requestFailure(error)}`
}

/** After Try again failed. */
export function retryFailureText(error: unknown): string {
  const failure = chatApiFailure(error)
  if (failure?.status === 409 && failure.code === 'not_failed') {
    return 'This reply is on its way again already.'
  }
  return `Not sent again. ${requestFailure(error)}`
}

/** A chat that is not on the phone (removed, left out on the Mac, or WhatsApp is not passed to the server). */
export const CHAT_MISSING = 'This chat is not on this phone. WhatsApp shows here only while your Mac passes your chats to your Tresso server.'
