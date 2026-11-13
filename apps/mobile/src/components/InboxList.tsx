import { useEffect, useMemo, useState } from 'react'
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { mergeInbox, type ChatSummary, type ConversationSummary } from '@tresso/core'
import { useChats } from '@/chat/ChatProvider'
import { ChatRow } from '@/components/ChatRow'
import { useMail } from '@/mail/MailProvider'
import { dayLabel, senderName, shortTime } from '@/mail/format'
import { useTheme, type Theme } from '@/theme'
import { LoadingLine } from '@/components/LogoLoader'

/** The most rows the list shows: as many as the copy lists of mail (MailProvider's LIST_LIMIT). */
const ROWS = 200

type Row = { kind: 'mail'; lastMessageAt: number; conversation: ConversationSummary } | { kind: 'chat'; lastMessageAt: number; summary: ChatSummary }

/**
 * The Unified Inbox: conversations newest first, grouped by day, read from the copy on the device; with WhatsApp on the
 * server ("All my devices"), its chats among them by the time of their last message.
 */
export function InboxList({ header }: { header: React.ReactElement }) {
  const mail = useMail()
  const chats = useChats()
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const router = useRouter()
  const [conversations, setConversations] = useState<ConversationSummary[]>([])

  const { inbox, version } = mail
  useEffect(() => {
    let current = true
    void inbox(null).then((list) => current && setConversations(list))
    return () => {
      current = false
    }
  }, [inbox, version])

  const sections = useMemo(() => {
    const rows = mergeInbox<Row, Row>(
      conversations.map((conversation) => ({ kind: 'mail', lastMessageAt: conversation.lastMessageAt, conversation })),
      chats.inbox.map((summary) => ({ kind: 'chat', lastMessageAt: summary.lastMessageAt, summary })),
      ROWS,
    )
    const groups: { title: string; data: Row[] }[] = []
    for (const row of rows) {
      const title = dayLabel(row.lastMessageAt)
      const last = groups[groups.length - 1]
      if (last?.title === title) {
        last.data.push(row)
      } else {
        groups.push({ title, data: [row] })
      }
    }
    return groups
  }, [conversations, chats.inbox])

  return (
    <SectionList
      sections={sections}
      keyExtractor={(row) => (row.kind === 'mail' ? `thread:${row.conversation.threadId}` : `chat:${row.summary.chat.id}`)}
      ListHeaderComponent={header}
      refreshControl={<RefreshControl refreshing={mail.syncState === 'syncing'} onRefresh={() => void mail.syncNow()} />}
      renderSectionHeader={({ section }) => (
        <Text style={styles.day} accessibilityRole="header">
          {section.title}
        </Text>
      )}
      stickySectionHeadersEnabled={false}
      ListEmptyComponent={
        mail.ready ? (
          <Text style={styles.empty}>{mail.syncError ?? 'Nothing in your inbox.'}</Text>
        ) : (
          <LoadingLine text="Loading your mail…" style={styles.loading} textStyle={styles.loadingText} />
        )
      }
      renderItem={({ item: row }) => {
        if (row.kind === 'chat') {
          return <ChatRow summary={row.summary} onPress={() => router.push({ pathname: '/chats/[id]', params: { id: row.summary.chat.id } })} />
        }
        const item = row.conversation
        const unread = item.unreadCount > 0
        return (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            onPress={() => router.push({ pathname: '/thread/[id]', params: { id: item.threadId } })}
            accessibilityRole="button"
            accessibilityLabel={`${unread ? 'Unread. ' : ''}${item.senders.map(senderName).join(', ')}. ${item.subject || '(no subject)'}. ${shortTime(item.lastMessageAt)}`}
          >
            <View style={[styles.dot, unread && styles.dotUnread]} />
            <View style={styles.body}>
              <View style={styles.top}>
                <Text style={[styles.senders, unread && styles.bold]} numberOfLines={1}>
                  {item.senders.map(senderName).join(', ')}
                </Text>
                {item.messageCount > 1 && <Text style={styles.meta}>{item.messageCount}</Text>}
                <Text style={styles.meta}>{shortTime(item.lastMessageAt)}</Text>
              </View>
              <Text style={[styles.subject, unread && styles.bold]} numberOfLines={1}>
                {item.subject || '(no subject)'}
              </Text>
              <Text style={styles.snippet} numberOfLines={1}>
                {item.snippet}
              </Text>
            </View>
          </Pressable>
        )
      }}
    />
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    day: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6, color: theme.ink2, fontSize: 13, fontWeight: '600' },
    row: { flexDirection: 'row', gap: 10, paddingVertical: 12, paddingRight: 20, paddingLeft: 12, minHeight: 72 },
    pressed: { backgroundColor: theme.ground },
    dot: { width: 8, height: 8, marginTop: 8, borderRadius: 4 },
    dotUnread: { backgroundColor: theme.accent },
    body: { flex: 1, gap: 2 },
    top: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
    senders: { flex: 1, color: theme.ink, fontSize: 16 },
    bold: { fontWeight: '600' },
    meta: { color: theme.ink2, fontSize: 12 },
    subject: { color: theme.ink, fontSize: 15 },
    snippet: { color: theme.ink2, fontSize: 14 },
    empty: { padding: 32, color: theme.ink2, textAlign: 'center' },
    loading: { padding: 32, justifyContent: 'center' },
    loadingText: { color: theme.ink2 },
  })
}
