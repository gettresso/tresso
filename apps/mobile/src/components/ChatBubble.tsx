import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native'
import type { BubbleRow } from '@/chat/timelineRows'
import { MEDIA_ON_MAC, mediaTitle } from '@/chat/texts'
import { useTheme, type Theme } from '@/theme'

interface Props {
  bubble: BubbleRow
  /** A change of this reply is under way: its actions wait. */
  busy: boolean
  /** Try again: a tap on a reply that was not sent, or the button under one that could not be confirmed. */
  onRetry(): void
  /** Long press on a reply that waits (Cancel) or was not sent (Delete): asks first. */
  onMenu(): void
}

/**
 * A bubble of a chat (the MobileWhatsAppChat board): someone else's on the left (white, with an edge), the user's on the
 * right (green), a group sender's name above in their colour, the time and a reply's state under the text. A file shows
 * its kind and size only; the phone does not download it. A reply that waits can be cancelled with a long press, one
 * that was not sent is sent again with a tap (or deleted with a long press); one whose sending the Mac could not confirm
 * is sent again only by its own Try again, never by a tap on the bubble. Screen readers get the same as actions.
 */
export function ChatBubble({ bubble, busy, onRetry, onMenu }: Props) {
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const waiting = bubble.state === 'waiting'
  const failed = bubble.state === 'failed'
  const unconfirmed = bubble.state === 'unconfirmed'

  const actions = [
    ...(failed ? [{ name: 'activate', label: 'Try again' }] : []),
    ...(waiting ? [{ name: 'longpress', label: 'Cancel' }] : []),
    ...(failed || unconfirmed ? [{ name: 'longpress', label: 'Delete' }] : []),
  ]
  const onAction = (event: AccessibilityActionEvent) => {
    if (busy) {
      return
    }
    if (event.nativeEvent.actionName === 'activate') {
      onRetry()
    } else if (event.nativeEvent.actionName === 'longpress') {
      onMenu()
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
          <View style={styles.media}>
            <Text style={styles.mediaTitle} numberOfLines={1}>
              {mediaTitle(bubble.media)}
            </Text>
            <Text style={styles.mediaLine}>{MEDIA_ON_MAC}</Text>
          </View>
        )}
        {bubble.text !== '' && <Text style={styles.text}>{bubble.text}</Text>}
        <Text style={[styles.meta, waiting && styles.waiting, (failed || unconfirmed) && styles.failed]}>{bubble.meta}</Text>
      </Pressable>
      {(failed || unconfirmed) && bubble.reason !== null && <Text style={[styles.reason, bubble.mine && styles.reasonMine]}>{bubble.reason}</Text>}
      {unconfirmed && (
        <Pressable style={({ pressed }) => [styles.retry, pressed && styles.pressed]} onPress={onRetry} disabled={busy} accessibilityRole="button" accessibilityState={{ disabled: busy }}>
          <Text style={styles.retryLabel}>Try again</Text>
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
