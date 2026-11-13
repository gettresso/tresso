import {
  chatSubtitle,
  fileSize,
  nameText,
  replyErrorText,
  SENDER_COLORS,
  senderColor,
  type ChatMediaKind,
  type ChatOutgoingError,
  type SyncedChat,
  type SyncedChatMessage,
} from '@tresso/core'
import type { BridgeState } from '@/platform/whatsapp'
import type { AttachState, MediaFailure, MediaState } from '@/stores/chats'

/**
 * What the chat screens say (the WhatsAppInbox and WhatsAppStates boards, with the corrections of the WhatsApp plan,
 * section 6). Every name and text from WhatsApp goes through core's nameText or labelText first. Pure, so every state
 * is tested without a screen.
 */

/** Under the composer on the Mac that sends (the relaying Mac). */
export const COMPOSER_NOTE = 'Sent on WhatsApp from this Mac. No signature, no subject.'
/** The confirmation of "Leave this chat out". */
export const LEAVE_OUT_TITLE = 'Leave this chat out?'
export const LEAVE_OUT_BODY = 'Tresso removes its copy and stops reading it. The chat stays in WhatsApp.'
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
    case 'failed':
      return state.error === 'unconfirmed' ? `${state.name}: ${replyErrorText('unconfirmed')}` : `${state.name || 'The file'} was not sent. ${replyErrorText(state.error)}`
    default:
      return null
  }
}

/** What a reply's state change says to a screen reader (the composer's live region). */
export function replyAnnouncement(status: 'waiting' | 'sending' | 'sent' | 'failed', error: ChatOutgoingError | null, relayOnline: boolean): string {
  switch (status) {
    case 'sending':
      return 'Sending.'
    case 'sent':
      return 'Sent.'
    case 'waiting':
      return relayOnline ? 'Sending.' : 'Waiting for your Mac.'
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

export const NOTICES: Record<ChatNoticeKind, { title: string; body: string; action: string }> = {
  unlinked: { title: 'WhatsApp is not linked.', body: 'Until it is linked again nothing comes in or goes out.', action: 'Show how' },
  stopped: { title: 'The bridge is not running.', body: 'New messages are not picked up until it runs.', action: 'Start again' },
}
