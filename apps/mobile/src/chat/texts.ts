import {
  attachHeldText,
  CHAT_REPLY_MAX,
  chatApiFailure,
  replyErrorText,
  replyLabel,
  serverFileView,
  type ReplyTextProblem,
  type ServerFileView,
  type SyncedChatAccount,
  type SyncedChatOutgoing,
} from '@tresso/core'

// Shared with the web app (core's chat texts); kept importable from here for the phone's screens.
export { chatName, clockTime, COUNTER_FROM, mediaKindLabel, mediaTitle, senderLabel, senderTone, UNSCANNED_WARNING } from '@tresso/core'

/** What a file row says and offers on the phone (the file is asked for from the relaying Mac, then opened from the server). */
export type MediaView = ServerFileView

/** A file's row from its message: core's serverFileView, as the web app shows it. */
export const mediaView = serverFileView

/*
 * What the phone's chat screens say: the MobileWhatsAppChat board, the desktop's chat texts
 * (apps/web/src/components/chat/chatTexts.ts) for what that board does not show, and the corrections of the WhatsApp
 * plan, section 6. Every name and text from WhatsApp goes through core's nameText or labelText where it is one line.
 * Pure, so every state is tested without a screen.
 */

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

/** A file on its way from the phone: `Uploading, 40%`, or `Queueing for your Mac` once it is up. */
export function uploadText(upload: { phase: 'uploading' | 'queueing'; progress: number | null }): string {
  if (upload.phase === 'queueing') {
    return 'Queueing for your Mac'
  }
  return upload.progress === null ? 'Uploading' : `Uploading, ${Math.round(upload.progress * 100)}%`
}

/** Attach waits: the server said too many files or replies at once; says how long (its Retry-After, rounded up). */
export class AttachHeld extends Error {
  constructor(readonly waitMs: number) {
    super(attachHeldText(waitMs))
    this.name = 'AttachHeld'
  }
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
  if (reason instanceof AttachHeld) {
    return `${name} was not sent. ${reason.message}`
  }
  if (unsure) {
    return `${name} may have been queued. ${requestFailure(reason)} Attaching the same file again in the next minutes sends it once.`
  }
  return `${name} was not sent. ${phase === 'upload' && chatApiFailure(reason) === null && reason instanceof Error && reason.name !== 'TypeError' ? reason.message : requestFailure(reason)}`
}

/** A link to a file that the phone could not hand to an app. */
export const FILE_NOT_OPENED = 'This phone could not open the file.'

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
