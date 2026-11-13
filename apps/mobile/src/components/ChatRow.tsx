import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { previewLine, type ChatSummary } from '@tresso/core'
import { chatInitials, chatName } from '@/chat/texts'
import { shortTime } from '@/mail/format'
import { useTheme, type Theme } from '@/theme'

/**
 * A WhatsApp chat among the mail of the Unified Inbox (the WhatsAppInbox board's chat row): unread dot, avatar with the
 * initials and a small WhatsApp badge, the name, the time and the newest message on one line (core's previewLine: a
 * group's sender first).
 */
export function ChatRow({ summary, onPress }: { summary: ChatSummary; onPress: () => void }) {
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const name = chatName(summary.chat)
  const preview = previewLine(summary.chat, summary.newest)
  const time = shortTime(summary.lastMessageAt)
  const unread = summary.unread > 0

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${unread ? 'Unread. ' : ''}${name}, WhatsApp, ${time}${preview === '' ? '' : `. ${preview}`}`}
    >
      <View style={[styles.dot, unread && styles.dotUnread]} />
      <View style={styles.avatar}>
        <Text style={styles.initials}>{chatInitials(name)}</Text>
        <View style={styles.badge}>
          <Svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke={theme.onWhatsapp} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M4 20l1.4-4.2A8 8 0 1112 20a8 8 0 01-3.8-1z" />
          </Svg>
        </View>
      </View>
      <View style={styles.body}>
        <View style={styles.top}>
          <Text style={[styles.name, unread && styles.bold]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.meta}>{time}</Text>
        </View>
        <Text style={styles.preview} numberOfLines={1}>
          {preview}
        </Text>
      </View>
    </Pressable>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 12, paddingRight: 20, paddingLeft: 12, minHeight: 72 },
    pressed: { backgroundColor: theme.ground },
    dot: { width: 8, height: 8, marginTop: 16, borderRadius: 4 },
    dotUnread: { backgroundColor: theme.accent },
    avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.ground },
    initials: { color: theme.ink, fontSize: 14, fontWeight: '600' },
    badge: {
      position: 'absolute',
      right: -3,
      bottom: -3,
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 2,
      borderColor: theme.surface,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.whatsapp,
    },
    body: { flex: 1, gap: 2 },
    top: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
    name: { flex: 1, color: theme.ink, fontSize: 16 },
    bold: { fontWeight: '600' },
    meta: { color: theme.ink2, fontSize: 12 },
    preview: { color: theme.ink2, fontSize: 14 },
  })
}
