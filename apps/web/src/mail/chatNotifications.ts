import { chatSubtitle, nameText, previewLine, type ChatSummary, type SyncedChatMessage } from '@tresso/core'
import { FRESHNESS_MS, type MailNotification } from '@/mail/mailNotifications'

/** The longest notification text: the start of the message, never all of a long one. */
export const CHAT_NOTIFICATION_BODY_MAX = 120

/** What decides which chats notify in a round (the WhatsApp plan's WP6, desktop notifications). */
export interface ChatNotificationRound {
  /** Chats as the copy holds them now (left-out chats are never among them). */
  summaries: readonly ChatSummary[]
  /** The newest message id per chat as the previous round saw it; a chat that is not in it is new to this session. */
  seen: ReadonlyMap<string, string | null>
  /** Epoch ms now. */
  now: number
  /** The user's Notify me (off by default). */
  notify: boolean
  /**
   * While the store is read in as history: messages sent up to this moment (epoch ms) are no news. Infinity during the
   * first import after connecting (all of it is history), the moment of the reset during a re-read (a chat taken back
   * in, groups turned on: what came in since is news), null once reading in ended.
   */
  historyThrough: number | null
  /** The chat open in a window that has the focus; it notifies nothing (the user sees it come in). */
  focusedChatId: string | null
  /** A message with its sender's name as this session knows it (a name learned after it was stored). */
  named?: (message: SyncedChatMessage) => SyncedChatMessage
}

/** Where a click on a chat's notification leads: the chat in the Unified Inbox. */
export function chatNotificationPath(chatId: string): string {
  return `/chats/${encodeURIComponent(chatId)}`
}

/** The chat's name for a notification: its name, else its number, else `WhatsApp`. */
function chatTitle(summary: ChatSummary): string {
  return nameText(summary.chat.name) || chatSubtitle(summary.chat) || 'WhatsApp'
}

/** The start of a preview, cut on a character (not inside an emoji's surrogate pair) with an ellipsis. */
function cut(text: string, max: number): string {
  const characters = [...text]
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join('').trimEnd()}…`
}

/**
 * The notifications of one round, at most one per chat, and what the round saw. A chat notifies when its newest message
 * is new since the last round, from someone else, unread, younger than FRESHNESS_MS, and the chat is not the one the
 * user looks at. Nothing while Notify me is off, nor for history being read in (`historyThrough`); the round still notes
 * what it saw, so turning it on later does not announce old messages. The text is the start of the preview (D5: the chat name and the
 * start of the text on the desktop; a phone push says the name only).
 */
export function chatNotifications(round: ChatNotificationRound): { notifications: MailNotification[]; seen: Map<string, string | null> } {
  const seen = new Map<string, string | null>()
  const notifications: MailNotification[] = []
  for (const summary of round.summaries) {
    const newest = summary.newest
    seen.set(summary.chat.id, newest?.id ?? null)
    const before = round.seen.get(summary.chat.id)
    if (
      !round.notify ||
      newest === null ||
      before === newest.id ||
      newest.fromMe ||
      summary.unread === 0 ||
      summary.chat.id === round.focusedChatId
    ) {
      continue
    }
    const sentAt = Date.parse(newest.sentAt)
    if (Number.isNaN(sentAt) || round.now - sentAt > FRESHNESS_MS || (round.historyThrough !== null && sentAt <= round.historyThrough)) {
      continue
    }
    const message = round.named?.(newest) ?? newest
    notifications.push({
      title: chatTitle(summary),
      body: cut(previewLine(summary.chat, message), CHAT_NOTIFICATION_BODY_MAX),
      path: chatNotificationPath(summary.chat.id),
      silent: false,
    })
  }
  return { notifications, seen }
}
