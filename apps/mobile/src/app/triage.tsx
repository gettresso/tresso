import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Stack, useFocusEffect, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { classificationReasonText, type SyncedSmartInbox, type TriageDecision } from '@tresso/core'
import { MessageBodyView } from '@/components/MessageBodyView'
import { useNotices } from '@/components/Notices'
import { useMail } from '@/mail/MailProvider'
import { useTriage } from '@/mail/useTriage'
import { initials, senderName, shortTime } from '@/mail/format'
import { useTheme, type Theme } from '@/theme'
import { LoadingLine, LogoLoader } from '@/components/LogoLoader'

/** The decision buttons' height above the safe area, kept clear of notices. */
const BAR_HEIGHT = 128

const DECISIONS: { decision: TriageDecision; label: string; hint: string }[] = [
  { decision: 'do', label: 'Do it myself', hint: 'Makes a todo' },
  { decision: 'delegate', label: 'Hand over', hint: 'Forwards it with a note and a due date' },
  { decision: 'know', label: 'Just know', hint: 'Marks read, archives' },
]

/** Triage: the waiting mail one conversation at a time, each decided as do, hand over or know. */
export default function TriageScreen() {
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const notices = useNotices()
  const mail = useMail()
  const triage = useTriage()
  const { current, conversation, progress, canUndo, saving, more } = triage
  /** Earlier messages of the conversation that are open; the newest always is. */
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const [smartInboxes, setSmartInboxes] = useState<SyncedSmartInbox[]>([])
  const { smartInboxes: loadSmartInboxes, version } = mail

  useEffect(() => {
    let current = true
    void loadSmartInboxes().then((list) => current && setSmartInboxes(list))
    return () => {
      current = false
    }
  }, [loadSmartInboxes, version])

  useFocusEffect(
    useCallback(() => {
      notices.setBottomInset(conversation === null ? 0 : BAR_HEIGHT)
      return () => notices.setBottomInset(0)
    }, [notices, conversation]),
  )

  const newest = conversation?.messages[conversation.messages.length - 1] ?? null
  const earlier = conversation?.messages.slice(0, -1) ?? []
  // Another conversation starts with its earlier messages folded.
  const [openedFor, setOpenedFor] = useState<string | null>(null)
  if ((conversation?.thread.id ?? null) !== openedFor) {
    setOpenedFor(conversation?.thread.id ?? null)
    setOpened(new Set())
  }

  function toggle(messageId: string) {
    setOpened((open) => {
      const next = new Set(open)
      if (!next.delete(messageId)) {
        next.add(messageId)
      }
      return next
    })
  }
  const smartInbox = smartInboxes.find((candidate) => candidate.id === conversation?.thread.smartInboxId) ?? null
  const reason = classificationReasonText(conversation?.thread.classificationReason ?? null)
  const color: Record<TriageDecision, { ink: string; soft: string }> = {
    do: { ink: theme.do, soft: theme.doSoft },
    delegate: { ink: theme.delegate, soft: theme.delegateSoft },
    know: { ink: theme.know, soft: theme.knowSoft },
  }

  function leave() {
    if (router.canGoBack()) {
      router.back()
    } else {
      router.replace('/')
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Triage', headerBackTitle: 'Inbox' }} />
      <View style={styles.screen}>
        {progress !== null && progress.total > 0 && (
          <View style={styles.top}>
            <View style={styles.progressRow}>
              <View
                style={styles.bar}
                accessibilityRole="progressbar"
                accessibilityLabel="Triage progress"
                accessibilityValue={{ min: 0, max: progress.total, now: conversation === null ? progress.total : progress.shown - 1 }}
              >
                <View style={[styles.fill, { width: `${Math.round(((conversation === null ? progress.total : progress.shown - 1) / progress.total) * 100)}%` }]} />
              </View>
              <Text style={styles.position}>{`${conversation === null ? progress.total : progress.shown} of ${progress.total}`}</Text>
            </View>
            <View style={styles.countsRow}>
              <Text style={styles.counts}>
                <Text style={[styles.count, { color: theme.do }]}>{progress.counts.do}</Text> do{'   '}
                <Text style={[styles.count, { color: theme.delegate }]}>{progress.counts.delegate}</Text> handed over{'   '}
                <Text style={[styles.count, { color: theme.know }]}>{progress.counts.know}</Text> noted
              </Text>
              {saving && <LoadingLine text="Saving…" size={14} textStyle={styles.counts} />}
            </View>
          </View>
        )}

        {progress === null && <LogoLoader size={32} style={styles.loading} accessibilityLabel="Loading your mail" />}

        {progress !== null && current === null && (
          <View style={styles.done}>
            <Text style={styles.doneTitle} accessibilityRole="header">
              {progress.total === 0 ? 'Nothing to triage' : more ? 'Round done' : 'All triaged'}
            </Text>
            <Text style={styles.doneText}>
              {progress.total === 0
                ? 'Every email in your inboxes already has a place.'
                : `${progress.counts.do} to do, ${progress.counts.delegate} handed over, ${progress.counts.know} noted.${more ? ' More mail waits for the next round.' : ''}`}
            </Text>
            {more && (
              <Pressable style={({ pressed }) => [styles.primary, pressed && styles.pressed]} onPress={triage.nextRound} accessibilityRole="button">
                <Text style={styles.primaryLabel}>Start the next round</Text>
              </Pressable>
            )}
            <Pressable style={({ pressed }) => [more ? styles.link : styles.primary, pressed && styles.pressed]} onPress={leave} accessibilityRole="button">
              <Text style={more ? styles.linkLabel : styles.primaryLabel}>Back to the inbox</Text>
            </Pressable>
            {canUndo && (
              <Pressable style={({ pressed }) => [styles.link, pressed && styles.pressed]} onPress={triage.undo} accessibilityRole="button">
                <Text style={styles.linkLabel}>Undo the last one</Text>
              </Pressable>
            )}
          </View>
        )}

        {progress !== null && current !== null && (conversation === null || newest === null) && (
          <LogoLoader size={32} style={styles.loading} accessibilityLabel="Loading the next email" />
        )}

        {conversation !== null && newest !== null && progress !== null && (
          <>
            <ScrollView style={styles.cardScroll} contentContainerStyle={styles.card} accessibilityLabel={`Email ${progress.shown} of ${progress.total}`}>
              <View style={styles.who}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initials(newest.from)}</Text>
                </View>
                <View style={styles.from}>
                  <Text style={styles.name} numberOfLines={1}>
                    {senderName(newest.from)}
                  </Text>
                  <Text style={styles.muted} numberOfLines={1}>
                    {shortTime(Date.parse(newest.receivedAt))}
                  </Text>
                </View>
                {smartInbox !== null && <Text style={styles.chip}>{smartInbox.name}</Text>}
              </View>
              <Text style={styles.subject} accessibilityRole="header">
                {conversation.thread.subject || '(no subject)'}
              </Text>
              {reason !== null && <Text style={styles.muted}>{reason}</Text>}
              {earlier.length > 0 && (
                <Text style={styles.muted}>{earlier.length === 1 ? 'One earlier message, tap to read it.' : `${earlier.length} earlier messages, tap one to read it.`}</Text>
              )}
              {earlier.map((message) => {
                const open = opened.has(message.id)
                return (
                  <View key={message.id} style={styles.earlier}>
                    <Pressable style={styles.earlierHead} onPress={() => toggle(message.id)} accessibilityRole="button" accessibilityState={{ expanded: open }}>
                      <Text style={styles.earlierFrom} numberOfLines={1}>
                        {senderName(message.from)}
                      </Text>
                      <Text style={styles.muted} numberOfLines={open ? undefined : 1}>
                        {open ? shortTime(Date.parse(message.receivedAt)) : message.snippet}
                      </Text>
                    </Pressable>
                    {open && <MessageBodyView messageId={message.id} />}
                  </View>
                )
              })}
              <MessageBodyView key={newest.id} messageId={newest.id} />
            </ScrollView>

            <View style={[styles.actions, { paddingBottom: insets.bottom + 8 }]}>
              <View style={styles.decisions} accessibilityRole="toolbar" accessibilityLabel="Decide on this email">
                {DECISIONS.map((item) => (
                  <Pressable
                    key={item.decision}
                    style={({ pressed }) => [styles.decision, { borderColor: color[item.decision].ink }, pressed && { backgroundColor: color[item.decision].soft }]}
                    onPress={() => triage.decide(item.decision)}
                    accessibilityRole="button"
                    accessibilityHint={item.hint}
                  >
                    <Text style={[styles.decisionLabel, { color: color[item.decision].ink }]}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.more}>
                <Pressable style={({ pressed }) => [styles.link, pressed && styles.pressed]} onPress={triage.skip} accessibilityRole="button">
                  <Text style={styles.linkLabel}>Skip</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.link, pressed && styles.pressed]}
                  onPress={triage.undo}
                  disabled={!canUndo}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canUndo }}
                >
                  <Text style={[styles.linkLabel, !canUndo && styles.disabled]}>Undo</Text>
                </Pressable>
              </View>
            </View>
          </>
        )}
      </View>
    </>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.ground },
    top: { paddingHorizontal: 20, paddingTop: 12, gap: 8 },
    progressRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    bar: { flex: 1, height: 6, borderRadius: 999, backgroundColor: theme.line, overflow: 'hidden' },
    fill: { height: '100%', backgroundColor: theme.ink },
    position: { color: theme.ink2, fontSize: 13, fontWeight: '600' },
    countsRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    counts: { color: theme.ink2, fontSize: 13 },
    count: { fontWeight: '600' },
    loading: { marginTop: 48, alignSelf: 'center' },
    cardScroll: { flex: 1 },
    card: { margin: 16, padding: 20, gap: 12, borderRadius: 14, backgroundColor: theme.surface },
    who: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.ground },
    avatarText: { color: theme.ink, fontSize: 14, fontWeight: '600' },
    from: { flex: 1, gap: 2 },
    name: { color: theme.ink, fontSize: 16, fontWeight: '600' },
    chip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: theme.ground, color: theme.ink2, fontSize: 12, fontWeight: '500', overflow: 'hidden' },
    subject: { color: theme.ink, fontSize: 22, lineHeight: 28, fontWeight: '700' },
    muted: { color: theme.ink2, fontSize: 13 },
    earlier: { gap: 8, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line },
    earlierHead: { minHeight: 44, justifyContent: 'center', gap: 2 },
    earlierFrom: { color: theme.ink, fontSize: 15, fontWeight: '500' },
    actions: { paddingHorizontal: 16, paddingTop: 8, gap: 4, backgroundColor: theme.ground },
    decisions: { flexDirection: 'row', gap: 8 },
    decision: { flex: 1, minHeight: 64, borderWidth: 1.5, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, backgroundColor: theme.surface },
    decisionLabel: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
    more: { flexDirection: 'row', justifyContent: 'center', gap: 24 },
    link: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
    linkLabel: { color: theme.accent, fontSize: 15, fontWeight: '600' },
    disabled: { color: theme.ink2, opacity: 0.6 },
    pressed: { opacity: 0.6 },
    done: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
    doneTitle: { color: theme.ink, fontSize: 24, fontWeight: '700' },
    doneText: { color: theme.ink2, fontSize: 16, textAlign: 'center' },
    primary: { minHeight: 48, paddingHorizontal: 28, borderRadius: 6, justifyContent: 'center', backgroundColor: theme.accent },
    primaryLabel: { color: theme.onAccent, fontSize: 16, fontWeight: '600' },
  })
}
