import { useMemo } from 'react'
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { briefProgress, briefSender, type BriefEntry } from '@tresso/core'
import { useLatestBrief, useNoted } from '@/brief/useDailyBrief'
import { shortTime } from '@/mail/format'
import { useTheme, type Theme } from '@/theme'
import { LoadingLine } from '@/components/LogoLoader'

function senderLabel(entry: BriefEntry): string {
  const sender = briefSender(entry.conversation)
  return sender === null ? 'Unknown sender' : sender.name?.trim() || sender.address
}

/** The newest daily brief: mail that is good to know, per smart inbox, noted with one tap. */
export default function BriefScreen() {
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const router = useRouter()
  const { view, groups, loaded } = useLatestBrief()
  const { busy, note, noteAll } = useNoted()
  const progress = briefProgress(view?.entries ?? [])
  const made = view === null ? null : new Date(view.brief.createdAt)

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Daily brief', headerBackTitle: 'Inbox' }} />
      <SectionList
        style={styles.screen}
        sections={groups.map((group) => ({ key: group.key, title: group.label, data: group.entries }))}
        keyExtractor={(entry) => entry.conversation.threadId}
        ListHeaderComponent={
          view === null ? undefined : (
            <View style={styles.header}>
              <Text style={styles.muted}>
                {made?.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}, made at {made?.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              </Text>
              <Text style={styles.muted}>Nothing here asks anything of you. Noted mail is read and archived.</Text>
              <View style={styles.headerRow}>
                <Text style={styles.progress} accessibilityLiveRegion="polite">
                  {progress.noted === progress.total ? `All ${progress.total} noted` : `${progress.noted} of ${progress.total} noted`}
                </Text>
                <Pressable
                  style={({ pressed }) => [styles.primary, (pressed || busy) && styles.pressed]}
                  disabled={busy || progress.noted === progress.total}
                  onPress={() => void noteAll(view)}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryLabel}>Mark all noted</Text>
                </Pressable>
              </View>
            </View>
          )
        }
        ListEmptyComponent={
          !loaded ? (
            <LoadingLine text="Loading…" style={styles.loading} textStyle={styles.loadingText} />
          ) : (
            <Text style={styles.empty}>
              {view === null ? 'No brief yet. Once a day, mail that is good to know but asks nothing of you comes together here.' : 'Everything in this brief is gone from this phone.'}
            </Text>
          )
        }
        renderSectionHeader={({ section }) => <Text style={styles.section}>{section.title}</Text>}
        renderItem={({ item }) => (
          <View style={[styles.row, (item.noted || item.moved) && styles.done]}>
            <Pressable style={styles.texts} onPress={() => router.push(`/thread/${item.conversation.threadId}`)} accessibilityRole="button" accessibilityLabel={`${item.conversation.subject || '(no subject)'}, from ${senderLabel(item)}`}>
              <Text style={[styles.subject, (item.noted || item.moved) && styles.mutedSubject]} numberOfLines={1}>
                {item.conversation.subject || '(no subject)'}
              </Text>
              {item.conversation.snippet !== '' && (
                <Text style={styles.snippet} numberOfLines={2}>
                  {item.conversation.snippet}
                </Text>
              )}
              <Text style={styles.muted}>
                {senderLabel(item)} · {shortTime(item.conversation.lastMessageAt)}
              </Text>
            </Pressable>
            {item.moved ? (
              <Text style={styles.moved}>Moved</Text>
            ) : item.noted ? (
              <Text style={styles.noted}>Noted</Text>
            ) : (
              <Pressable style={({ pressed }) => [styles.note, pressed && styles.pressed]} disabled={busy} onPress={() => void note([item.conversation.threadId])} accessibilityRole="button" accessibilityLabel={`Noted: ${item.conversation.subject}`}>
                <Text style={styles.noteLabel}>Noted</Text>
              </Pressable>
            )}
          </View>
        )}
      />
    </>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.surface },
    header: { gap: 6, padding: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
    headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 6 },
    progress: { fontSize: 14, color: theme.ink2 },
    primary: { minHeight: 44, paddingHorizontal: 16, borderRadius: 6, justifyContent: 'center', backgroundColor: theme.ink },
    primaryLabel: { fontSize: 15, fontWeight: '600', color: theme.surface },
    pressed: { opacity: 0.6 },
    section: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 6, fontSize: 13, fontWeight: '600', color: theme.ink2, backgroundColor: theme.surface },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
    done: { backgroundColor: theme.ground },
    texts: { flex: 1, gap: 2 },
    subject: { fontSize: 16, fontWeight: '600', color: theme.ink },
    mutedSubject: { color: theme.ink2, fontWeight: '500' },
    snippet: { fontSize: 14, color: theme.ink },
    muted: { fontSize: 13, color: theme.ink2 },
    note: { minHeight: 44, paddingHorizontal: 14, borderRadius: 6, justifyContent: 'center', borderWidth: 1.5, borderColor: theme.know },
    noteLabel: { fontSize: 14, fontWeight: '600', color: theme.know },
    noted: { fontSize: 13, fontWeight: '600', color: theme.know },
    moved: { fontSize: 13, fontWeight: '600', color: theme.accent },
    empty: { padding: 20, fontSize: 15, color: theme.ink2 },
    loading: { padding: 20 },
    loadingText: { fontSize: 15, color: theme.ink2 },
  })
}
