import { memo, useMemo } from 'react'
import { Pressable, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native'
import type { SyncedChatMessage, SyncedChatOutgoing } from '@tresso/core'
import type { BubbleRow } from '@/chat/timelineRows'
import { mediaTitle, mediaView } from '@/chat/texts'
import { useTheme, type Theme } from '@/theme'

interface Props {
  bubble: BubbleRow
  /** A change of this reply is under way: its actions wait. */
  busy: boolean
  /** Try again: a tap on a reply that was not sent, or the button under one that could not be confirmed. */
  onRetry(reply: SyncedChatOutgoing): void
  /** Long press on a reply that waits (Cancel) or was not sent (Delete): asks first. */
  onMenu(reply: SyncedChatOutgoing): void
  /** The relaying Mac is online: a file asked for is on its way rather than waiting. */
  relayOnline: boolean
  /** What the last action on this message's file said (a refusal); null for nothing. */
  mediaNote: string | null
  /** The file's action: Download and Try again ask the Mac, Open opens a checked file, Open anyway one not checked. */
  onMedia(message: SyncedChatMessage, action: 'download' | 'open' | 'confirm'): void
  /** Cancel on a file still on its way from this phone: the upload stops and nothing is queued. */
  onCancelUpload(reply: SyncedChatOutgoing): void
}

/**
 * A bubble of a chat (the MobileWhatsAppChat board): someone else's on the left (white, with an edge), the user's on the
 * right (green), a group sender's name above in their colour, the time and a reply's state under the text. A file shows
 * its kind and size, where it stands and what can be done: it is asked for from the relaying Mac only on Download, and
 * opened from the server once it was checked for malware (one that could not be checked only after a warning). A reply that waits can be cancelled with a long press, one
 * that was not sent is sent again with a tap (or deleted with a long press); one whose sending the Mac could not confirm
 * is sent again only by its own Try again, never by a tap on the bubble. Screen readers get the same as actions.
 */
export const ChatBubble = memo(function ChatBubble({ bubble, busy, onRetry: retryReply, onMenu: openMenu, relayOnline, mediaNote, onMedia, onCancelUpload: cancelUpload }: Props) {
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const waiting = bubble.state === 'waiting'
  const failed = bubble.state === 'failed'
  const unconfirmed = bubble.state === 'unconfirmed'
  const reply = bubble.reply
  const onRetry = () => {
    if (reply !== null) {
      retryReply(reply)
    }
  }
  const onMenu = () => {
    if (reply !== null) {
      openMenu(reply)
    }
  }

  const uploading = bubble.state === 'uploading'
  const fileAction = bubble.media === null ? null : mediaView(bubble.media, relayOnline).action
  const actions = bubbleActions(bubble, relayOnline)
  const onAction = (event: AccessibilityActionEvent) => {
    const name = event.nativeEvent.actionName
    if (name === 'file' && bubble.media !== null && fileAction !== null) {
      onMedia(bubble.media, fileAction === 'retry' ? 'download' : fileAction)
      return
    }
    if (name === 'cancelUpload') {
      onCancelUpload()
      return
    }
    if (busy) {
      return
    }
    if (name === 'activate') {
      onRetry()
    } else if (name === 'longpress') {
      onMenu()
    }
  }
  const onCancelUpload = () => {
    if (reply !== null) {
      cancelUpload(reply)
    }
  }

  return (
    <View style={[styles.item, bubble.mine && styles.mine, bubble.grouped && styles.grouped]}>
      <Pressable
        style={({ pressed }) => [styles.bubble, bubble.mine ? styles.bubbleMine : styles.bubbleTheirs, pressed && (failed || waiting || unconfirmed) && styles.pressed]}
        onPress={failed && !busy ? onRetry : undefined}
        onLongPress={(waiting || failed || unconfirmed) && !busy ? onMenu : undefined}
        disabled={busy && (failed || waiting || unconfirmed)}
        accessible
        accessibilityLabel={bubble.label}
        accessibilityHint={failed ? 'Tap to send it again.' : waiting ? 'Long press to cancel it.' : undefined}
        accessibilityActions={actions.length > 0 ? actions : undefined}
        onAccessibilityAction={actions.length > 0 ? onAction : undefined}
        accessibilityState={busy ? { busy: true } : undefined}
      >
        {bubble.sender !== null && <Text style={[styles.sender, { color: theme.senders[bubble.sender.tone] ?? theme.ink2 }]}>{bubble.sender.label}</Text>}
        {bubble.media !== null && (
          <MediaRow message={bubble.media} relayOnline={relayOnline} note={mediaNote} onMedia={onMedia} styles={styles} />
        )}
        {bubble.text !== '' && <Text style={styles.text}>{bubble.text}</Text>}
        <Text style={[styles.meta, waiting && styles.waiting, (failed || unconfirmed) && styles.failed]}>{bubble.meta}</Text>
      </Pressable>
      {(failed || unconfirmed) && bubble.reason !== null && <Text style={[styles.reason, bubble.mine && styles.reasonMine]}>{bubble.reason}</Text>}
      {uploading && (
        <Pressable style={({ pressed }) => [styles.retry, pressed && styles.pressed]} onPress={onCancelUpload} accessibilityRole="button">
          <Text style={styles.retryLabel}>Cancel</Text>
        </Pressable>
      )}
      {unconfirmed && (
        <Pressable style={({ pressed }) => [styles.retry, pressed && styles.pressed]} onPress={onRetry} disabled={busy} accessibilityRole="button" accessibilityState={{ disabled: busy }}>
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      )}
    </View>
  )
})

const ACTION_LABELS = { download: 'Download', retry: 'Try again', open: 'Open', confirm: 'Open anyway' } as const

/**
 * What a screen reader may do with a bubble, which it reads as one element: Try again, Cancel (a reply that waits, or a
 * file still uploading), Delete, and the file's own action (Download, Try again, Open, Open anyway), whose button sits
 * inside the bubble and could not be reached otherwise.
 */
export function bubbleActions(bubble: BubbleRow, relayOnline: boolean): { name: string; label: string }[] {
  const fileAction = bubble.media === null ? null : mediaView(bubble.media, relayOnline).action
  return [
    ...(bubble.state === 'failed' ? [{ name: 'activate', label: 'Try again' }] : []),
    ...(bubble.state === 'waiting' ? [{ name: 'longpress', label: 'Cancel' }] : []),
    ...(bubble.state === 'uploading' ? [{ name: 'cancelUpload', label: 'Cancel' }] : []),
    ...(bubble.state === 'failed' || bubble.state === 'unconfirmed' ? [{ name: 'longpress', label: 'Delete' }] : []),
    ...(fileAction === null ? [] : [{ name: 'file', label: ACTION_LABELS[fileAction] }]),
  ]
}

function MediaRow({ message, relayOnline, note, onMedia, styles }: { message: SyncedChatMessage; relayOnline: boolean; note: string | null; onMedia: Props['onMedia']; styles: ReturnType<typeof makeStyles> }) {
  const view = mediaView(message, relayOnline)
  const action = view.action
  return (
    <View style={styles.media}>
      <Text style={styles.mediaTitle} numberOfLines={1}>
        {mediaTitle(message)}
      </Text>
      <Text style={[styles.mediaLine, (view.failed || note !== null) && styles.mediaFailed]}>{note ?? view.line}</Text>
      {action !== null && (
        <Pressable
          style={({ pressed }) => [styles.mediaAction, pressed && styles.pressed]}
          onPress={() => onMedia(message, action === 'retry' ? 'download' : action)}
          accessibilityRole="button"
          accessibilityLabel={`${ACTION_LABELS[action]}, ${mediaTitle(message)}`}
        >
          <Text style={styles.mediaActionLabel}>{ACTION_LABELS[action]}</Text>
        </Pressable>
      )}
    </View>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    item: { alignItems: 'flex-start', marginTop: 8 },
    mine: { alignItems: 'flex-end' },
    grouped: { marginTop: 3 },
    bubble: { maxWidth: '78%', gap: 4, paddingVertical: 9, paddingHorizontal: 12 },
    bubbleTheirs: { backgroundColor: theme.bubbleTheirs, borderWidth: 1, borderColor: theme.bubbleTheirsEdge, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderBottomRightRadius: 16, borderBottomLeftRadius: 4 },
    bubbleMine: { backgroundColor: theme.bubbleMine, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderBottomLeftRadius: 16, borderBottomRightRadius: 4 },
    pressed: { opacity: 0.7 },
    sender: { fontSize: 12, fontWeight: '700' },
    media: { gap: 2, padding: 10, borderRadius: 8, backgroundColor: theme.ground },
    mediaTitle: { color: theme.ink, fontSize: 13, fontWeight: '600' },
    mediaLine: { color: theme.bubbleMeta, fontSize: 12 },
    mediaFailed: { color: theme.danger },
    mediaAction: { alignSelf: 'flex-start', marginTop: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.ink2 },
    mediaActionLabel: { color: theme.ink, fontSize: 12, fontWeight: '600' },
    text: { color: theme.ink, fontSize: 15, lineHeight: 21 },
    meta: { alignSelf: 'flex-end', color: theme.bubbleMeta, fontSize: 11 },
    waiting: { color: theme.delegate, fontWeight: '600' },
    failed: { color: theme.danger, fontWeight: '600' },
    reason: { maxWidth: '78%', marginTop: 4, color: theme.danger, fontSize: 12 },
    reasonMine: { textAlign: 'right' },
    retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
    retryLabel: { color: theme.accent, fontSize: 14, fontWeight: '600' },
  })
}
