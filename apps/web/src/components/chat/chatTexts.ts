import {
  chatSubtitle,
  fileSize,
  nameText,
  replyErrorText,
  SENDER_COLORS,
  senderColor,
  type ChatMediaError,
  type ChatMediaKind,
  type ChatOutgoingError,
  type ReplyLabel,
  type SyncedChat,
  type SyncedChatAccount,
  type SyncedChatMessage,
} from '@tresso/core'
import { shortTime } from '@/mail/format'
import type { BridgeState } from '@/platform/whatsapp'
import type { AttachState, MediaFailure, MediaState } from '@/stores/chats'

/**
 * A reply's label on this Mac, which relays itself ("Only this Mac"): a reply waits for the bridge, not for a Mac that is
 * offline, and is retried with a click. Core's replyLabel keeps the board's words for the other devices (server mode).
 */
export type LocalReplyLabel = 'Sending' | 'Sent' | 'Waiting for the bridge' | 'Not sent, click to retry'

/**
 * A reply's label on the desktop: on the Mac that sends it (localReplyLabel), or on another Mac in "All my devices",
 * where a waiting reply waits for the relaying Mac (core's `Waiting for your Mac`) and a failed one is still clicked.
 */
export type DesktopReplyLabel = LocalReplyLabel | 'Waiting for your Mac'

export function desktopReplyLabel(label: ReplyLabel | null, relaysHere: boolean): DesktopReplyLabel | null {
  if (relaysHere) {
    return localReplyLabel(label)
  }
  return label === 'Not sent, tap to retry' ? 'Not sent, click to retry' : label
}

export function localReplyLabel(label: ReplyLabel | null): LocalReplyLabel | null {
  switch (label) {
    case 'Waiting for your Mac':
      return 'Waiting for the bridge'
    case 'Not sent, tap to retry':
      return 'Not sent, click to retry'
    default:
      return label
  }
}

/** `10:02`, `10:02, sent`, `10:02, waiting for the bridge`; the failed label stands alone (as core's bubbleMeta). */
export function localBubbleMeta(time: string, label: DesktopReplyLabel | null): string {
  if (label === null) {
    return time
  }
  if (label === 'Not sent, click to retry') {
    return label
  }
  return `${time}, ${label.charAt(0).toLowerCase()}${label.slice(1)}`
}

/**
 * What the chat screens say (the WhatsAppInbox and WhatsAppStates boards, with the corrections of the WhatsApp plan,
 * section 6). Every name and text from WhatsApp goes through core's nameText or labelText first. Pure, so every state
 * is tested without a screen.
 */

/** Under the composer on the Mac that sends (the relaying Mac). */
export const COMPOSER_NOTE = 'Sent on WhatsApp from this Mac. No signature, no subject.'

/** Under the composer: from this Mac, or (another Mac in "All my devices") by the relaying one, named as it named itself. */
export function composerNote(relaysHere: boolean, relayName: string | null): string {
  if (relaysHere) {
    return COMPOSER_NOTE
  }
  const name = nameText(relayName)
  return `Sent on WhatsApp by ${name === '' ? 'your Mac' : name}. No signature, no subject.`
}
/** The confirmation of "Leave this chat out". */
export const LEAVE_OUT_TITLE = 'Leave this chat out?'
export const LEAVE_OUT_BODY = 'Tresso removes its copy and stops reading it. The chat stays in WhatsApp.'
/** The same where the chats are on the server ("All my devices", and the browser): the removal reaches every device. */
export const LEAVE_OUT_BODY_SERVER = "Tresso removes this chat's messages from your Tresso server and from every device, and stops reading it. The chat stays in WhatsApp."
/** Next to "Leave this chat out": WhatsApp may keep one contact as two chats. */
export const LEAVE_OUT_TWO_CHATS = 'A contact can appear as two chats in WhatsApp (by number and by hidden number). Leave both out to keep the contact out.'
/** From which length the composer shows how many characters are left. */
export const COUNTER_FROM = 3_900

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

const FAILURES: Record<MediaFailure, string> = {
  failed: 'Could not download. The phone that sent it may be offline.',
  stopped: 'Could not download. The bridge is not running.',
  mismatch: "WhatsApp gave another file than this message's. It was not opened.",
  unverified: "Tresso could not check that this is the message's file. It was not opened.",
  refused: 'WhatsApp named this file in a way Tresso does not trust. It was not downloaded.',
  too_large: 'This file is too large to download in Tresso.',
  open: 'Tresso could not open this file.',
}

/**
 * Failures worth a Try again (a new download): the phone or the bridge may be back, or a copy that would not open is
 * fetched again. A refused or mismatched file stays refused.
 */
export function mediaRetry(reason: MediaFailure): boolean {
  return reason === 'failed' || reason === 'stopped' || reason === 'open'
}

/** The second line of a file row in each state. */
export function mediaStateText(message: Pick<SyncedChatMessage, 'mediaKind'>, state: MediaState): string {
  switch (state.state) {
    case 'downloading':
      return 'Downloading'
    case 'done':
      return 'Downloaded'
    case 'failed':
      return FAILURES[state.reason]
    default:
      return `${mediaKindLabel(message.mediaKind ?? 'document')}, not downloaded`
  }
}

/** The composer's line about a file it sends, or null when there is none. */
export function attachText(state: AttachState): string | null {
  switch (state.state) {
    case 'sending':
      return `Sending ${state.name}…`
    case 'sent':
      return `${state.name} was sent.`
    case 'queued':
      return `${state.name} is queued for your Mac.`
    case 'failed':
      if (state.error === 'not_queued') {
        return `${state.name} was not sent. ${state.detail ?? ''}`.trim()
      }
      if (state.error === 'too_large') {
        return `${state.name} was not sent. It is larger than 100 MB, the most Tresso sends for now.`
      }
      return state.error === 'unconfirmed' ? `${state.name}: ${replyErrorText('unconfirmed')}` : `${state.name || 'The file'} was not sent. ${replyErrorText(state.error)}`
    default:
      return null
  }
}

/** What a reply's state change says to a screen reader (the composer's live region). */
export function replyAnnouncement(status: 'waiting' | 'sending' | 'sent' | 'failed', error: ChatOutgoingError | null, relayOnline: boolean, relaysHere = true): string {
  switch (status) {
    case 'sending':
      return 'Sending.'
    case 'sent':
      return 'Sent.'
    case 'waiting':
      return relayOnline ? 'Sending.' : relaysHere ? 'Waiting for the bridge.' : 'Waiting for your Mac.'
    default:
      return error === 'unconfirmed' ? replyErrorText('unconfirmed') : `Not sent. ${error === null ? '' : replyErrorText(error)}`.trim()
  }
}

/** The notice at the top of a chat (ChatNotice), first that applies; null when the bridge runs and is linked. */
export type ChatNoticeKind = 'unlinked' | 'stopped'

/** Which notice the bridge's state calls for on this Mac. */
export function chatNoticeKind(bridge: BridgeState): ChatNoticeKind | null {
  if (bridge.process === 'owned') {
    return bridge.link === 'unlinked' || bridge.link === 'waiting_for_scan' ? 'unlinked' : null
  }
  // A code nobody scanned for three minutes stopped the bridge: what is missing is the link.
  return bridge.link === 'unlinked' && bridge.error === null ? 'unlinked' : 'stopped'
}

/** A notice without an action: what the relaying Mac's state means for the chats here (relayNotice). */
export interface RelayNotice {
  title: string
  body: string
}

/**
 * In the browser, above a chat and the WhatsApp list: what keeps the relaying Mac from bringing messages in or sending
 * replies, from the chat account's row (the WhatsAppStates board's banner when the Mac is offline; the phone's words
 * for a bridge that stopped or a link that went). Null while it relays and WhatsApp works. The time the Mac went
 * offline is shown as `shortTime` shows times: the time today, else the date.
 */
export function relayNotice(account: Pick<SyncedChatAccount, 'relayOnline' | 'relayOfflineSince' | 'bridge' | 'link'> | null, now = new Date()): RelayNotice | null {
  if (account === null) {
    return null
  }
  if (!account.relayOnline) {
    const since = account.relayOfflineSince === null ? Number.NaN : Date.parse(account.relayOfflineSince)
    return {
      title: Number.isNaN(since) ? 'Your Mac is offline.' : `Your Mac is offline since ${shortTime(since, now)}.`,
      body: 'New WhatsApp messages show up here once it is back. Replies wait until then.',
    }
  }
  if (account.link === 'unlinked') {
    return { title: 'WhatsApp is not linked on your Mac.', body: 'Nothing comes in or goes out until it is linked again there.' }
  }
  if (account.bridge === 'stopped') {
    return { title: 'The bridge on your Mac is not running.', body: 'New messages are not picked up, and replies wait until it runs again.' }
  }
  return null
}

const SERVER_FAILURES: Record<ChatMediaError, string> = {
  not_found: 'Your Mac could not find this file in WhatsApp.',
  mismatch: "WhatsApp gave your Mac another file than this message's. It was not passed on.",
  unverified: "Your Mac could not check that this is the message's file. It was not passed on.",
  too_large: 'This file is larger than 100 MB, the most Tresso passes on.',
  unavailable: 'Your Mac could not get this file from WhatsApp. WhatsApp may no longer have it.',
}

/** What a file row says and offers for a file that goes through the server ("All my devices", not the relaying Mac). */
export interface ServerMediaView {
  line: string
  action: 'download' | 'retry' | 'open' | 'confirm' | null
  /** The action shows but cannot be pressed yet (asked for, being checked). */
  pending: string | null
  failed: boolean
}

/**
 * A file on the server, from its message's state (the delta's `mediaState`, `mediaError`, `mediaAccess`): on the Mac
 * (Download asks for it), asked for (waiting for the Mac while it is offline), being checked for malware, ready (Open),
 * not checked (Download anyway, after a warning), blocked, or not brought (Try again, but not for a file too large).
 */
export function serverMediaView(message: Pick<SyncedChatMessage, 'mediaKind' | 'mediaState' | 'mediaError' | 'mediaAccess'>, relayOnline: boolean): ServerMediaView {
  const kind = mediaKindLabel(message.mediaKind ?? 'document')
  switch (message.mediaState ?? 'remote') {
    case 'requested':
      return { line: relayOnline ? 'Your Mac is bringing this file.' : 'Waiting for your Mac.', action: null, pending: relayOnline ? 'Downloading' : 'Waiting', failed: false }
    case 'failed': {
      const error = message.mediaError ?? 'unavailable'
      return { line: SERVER_FAILURES[error], action: error === 'too_large' ? null : 'retry', pending: null, failed: true }
    }
    case 'stored':
      switch (message.mediaAccess ?? 'blocked') {
        case 'allowed':
          return { line: 'Ready to open.', action: 'open', pending: null, failed: false }
        case 'scanning':
          return { line: 'Checking for malware.', action: null, pending: 'Checking', failed: false }
        case 'confirm':
          return { line: 'This file could not be checked for malware.', action: 'confirm', pending: null, failed: false }
        default:
          return { line: 'This file is blocked: it contains malware, or this server only opens checked files.', action: null, pending: null, failed: true }
      }
    default:
      return { line: `${kind}, on your Mac`, action: 'download', pending: null, failed: false }
  }
}

/** The warning before a file that could not be checked opens. */
export const UNSCANNED_WARNING = 'This file could not be checked for malware. Open it only if you trust the sender.'

/** A chat left out, opened in the browser: only the Mac that relays reads the bridge again to take it back in. */
export const LEFT_OUT_HERE = 'You left this chat out. Take it back in on the Mac that relays WhatsApp, under Settings, WhatsApp.'
/** Next to "Leave this chat out" in the browser. */
export const LEAVE_OUT_RELAY_ONLY = 'Only the Mac that relays WhatsApp can take it back in.'

export const NOTICES: Record<ChatNoticeKind, { title: string; body: string; action: string }> = {
  unlinked: { title: 'WhatsApp is not linked.', body: 'Until it is linked again nothing comes in or goes out.', action: 'Show how' },
  stopped: { title: 'The bridge is not running.', body: 'New messages are not picked up until it runs.', action: 'Start again' },
}
