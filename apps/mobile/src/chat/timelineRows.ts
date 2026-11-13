import { chatMessageKey, labelText, timeline, type SyncedChatMessage, type SyncedChatOutgoing, type TimelineEntry } from '@tresso/core'
import { clockTime, MEDIA_ON_MAC, mediaTitle, replyView, senderLabel, senderTone, type ReplyView } from '@/chat/texts'
import { dayLabel } from '@/mail/format'

/** A bubble of a chat screen. */
export interface BubbleRow {
  kind: 'bubble'
  key: string
  /** Sent from the user's account: a reply from Tresso, or a message typed on their phone. */
  mine: boolean
  /** As written, line breaks kept; empty for a file without text. */
  text: string
  /** The message, when it carries a file (shown as its kind and size only). */
  media: SyncedChatMessage | null
  /** A group sender's name above the first of their bubbles in a row, with its colour (an index into the theme's). */
  sender: { label: string; tone: number } | null
  /** Under the text: `09:58`, `10:31, waiting for your Mac`, `Not sent, tap to retry`. */
  meta: string
  /** A reply's state; `none` for a message from WhatsApp. */
  state: 'none' | ReplyView['state']
  /** Why a reply was not sent; null otherwise. */
  reason: string | null
  /** The reply, for Cancel, Delete and Try again; null for a message. */
  reply: SyncedChatOutgoing | null
  /** What a screen reader says: who, when, the state, then the text or the file. */
  label: string
  /** Follows a bubble of the same sender on the same day: closer to it, without the name again. */
  grouped: boolean
}

export interface DayRow {
  kind: 'day'
  key: string
  label: string
}

export type TimelineRow = BubbleRow | DayRow

/**
 * The replies a window of a chat shows (the desktop's rule): all of them once the oldest message is read. Else a sent
 * reply only from the window's first message on (with a minute to spare, so one whose stored copy is just above the
 * window does not show twice meanwhile); a reply that waits, is being sent or was not sent always shows.
 */
export function windowReplies(messages: readonly SyncedChatMessage[], outgoing: readonly SyncedChatOutgoing[], hasOlder: boolean): SyncedChatOutgoing[] {
  const first = messages[0]
  if (!hasOlder || first === undefined) {
    return [...outgoing]
  }
  const from = chatMessageKey(first).sentAt + 60_000
  return outgoing.filter((reply) => {
    if (reply.status !== 'sent') {
      return true
    }
    const at = Date.parse(reply.sentAt ?? reply.createdAt)
    return Number.isNaN(at) || at >= from
  })
}

/**
 * The rows of a chat screen, oldest first: core's timeline (messages and replies in order, a reply the bridge stored
 * too shown once), with a day row before the first bubble of each day. `name` is the chat's (chatName); `relayOnline`
 * decides between `waiting for your Mac` and `sending`.
 */
export function timelineRows(
  messages: readonly SyncedChatMessage[],
  outgoing: readonly SyncedChatOutgoing[],
  options: { group: boolean; name: string; relayOnline: boolean; now?: Date },
): TimelineRow[] {
  const rows: TimelineRow[] = []
  let day: string | null = null
  let previous: { mine: boolean; sender: string | null; day: string | null } | null = null
  for (const entry of timeline(messages, outgoing)) {
    const label = Number.isFinite(entry.at) ? dayLabel(entry.at, options.now) : null
    if (label !== null && label !== day) {
      day = label
      rows.push({ kind: 'day', key: `day-${entry.at}`, label })
    }
    const bubble = bubbleOf(entry, options)
    if (bubble === null) {
      continue
    }
    const sender = entry.kind === 'message' ? (entry.message.sender?.id ?? null) : null
    bubble.grouped = previous !== null && previous.mine === bubble.mine && previous.sender === sender && previous.day === day
    if (bubble.grouped) {
      bubble.sender = null
    }
    previous = { mine: bubble.mine, sender, day }
    rows.push(bubble)
  }
  return rows
}

function bubbleOf(entry: TimelineEntry, options: { group: boolean; name: string; relayOnline: boolean }): BubbleRow | null {
  const time = Number.isFinite(entry.at) ? clockTime(entry.at) : ''
  if (entry.kind === 'message') {
    const message = entry.message
    const media = message.mediaKind === null ? null : message
    const who = message.fromMe ? 'You' : options.group ? senderLabel(message) : options.name
    const said = [labelText(message.text), media === null ? '' : `${mediaTitle(media)}. ${MEDIA_ON_MAC}`].filter((part) => part !== '').join('. ')
    return {
      kind: 'bubble',
      key: message.id,
      mine: message.fromMe,
      text: message.text,
      media,
      sender: options.group && !message.fromMe ? { label: senderLabel(message), tone: senderTone(message.sender?.id ?? '') } : null,
      meta: time,
      state: 'none',
      reason: null,
      reply: null,
      label: [who, time, said].filter((part) => part !== '').join(', '),
      grouped: false,
    }
  }
  const reply = entry.outgoing
  const view = replyView(reply, time, options.relayOnline)
  if (view === null) {
    return null
  }
  return {
    kind: 'bubble',
    key: reply.id,
    mine: true,
    text: reply.text,
    media: null,
    sender: null,
    meta: view.meta,
    state: view.state,
    reason: view.reason,
    reply,
    label: ['You', time, view.spoken, labelText(reply.text)].filter((part) => part !== '').join(', '),
    grouped: false,
  }
}
