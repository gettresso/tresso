import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { dueLabel, handOverStatus, openHandOversOf, todoSourceMessage, type SyncedFolder, type SyncedHandOver, type SyncedMessage, type SyncedThread, type SyncedTodo } from '@tresso/core'
import { MessageBodyView } from '@/components/MessageBodyView'
import { PlaceScrollProvider, scrollToPlaceIn, type ScrollToPlace } from '@/components/placeScroll'
import { useComposer } from '@/compose/ComposerProvider'
import { useMail } from '@/mail/MailProvider'
import { useNotices } from '@/components/Notices'
import { useMessageActions } from '@/mail/useMessageActions'
import { absentConversation } from '@/mail/openedConversation'
import { initials, senderName, shortTime } from '@/mail/format'
import { shortDue } from '@/handOver/format'
import { useHandOvers } from '@/handOver/HandOverProvider'
import { useTheme, type Theme } from '@/theme'
import { LogoLoader } from '@/components/LogoLoader'

/** The action bar's height above the safe area. */
const BAR_HEIGHT = 56

/** A conversation: its messages oldest first; unread ones and the newest open, read history folded. */
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const mail = useMail()
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const [thread, setThread] = useState<SyncedThread | null>(null)
  const [messages, setMessages] = useState<SyncedMessage[]>([])
  const [notFound, setNotFound] = useState(false)
  const [expanded, setExpanded] = useState<Set<string> | null>(null)
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null)
  const scrollToPlace = useCallback<ScrollToPlace>((view, offset) => scrollToPlaceIn(scroll.current, view, offset), [])
  const [folders, setFolders] = useState<SyncedFolder[]>([])
  const [todos, setTodos] = useState<SyncedTodo[]>([])
  const [ownAddresses, setOwnAddresses] = useState<string[]>([])
  const [makingTodo, setMakingTodo] = useState(false)
  const { thread: load, folders: loadFolders, todosOfThread, mailAccounts, version, pulls, syncNow, syncState, syncError } = mail
  /**
   * The pulls done when this conversation opened. Until one more is done, a conversation that is not in the copy may
   * just not have arrived yet (a tapped notification can be quicker than the delta), so it shows as loading.
   */
  const [opened, setOpened] = useState({ id, pulls })
  if (opened.id !== id) {
    setOpened({ id, pulls })
  }
  const absent = notFound ? absentConversation(pulls, opened.pulls, syncState) : null
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const actions = useMessageActions()
  const { after, run, exclusive, relocate, busy } = actions
  /** The conversation that was read on open; another one (the screen reused for a link) is read again. */
  const read = useRef<string | null>(null)
  const mounted = useRef(true)
  /** The conversation a pull was asked for because it was not in the copy, so it is asked once. */
  const pulledFor = useRef<string | null>(null)
  const notices = useNotices()
  const { composer } = useComposer()
  const handOvers = useHandOvers()
  const [waitingOn, setWaitingOn] = useState<SyncedHandOver[]>([])
  const loadHandOvers = mail.handOvers

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // The action bar stays clear of notices while this screen is the one in front.
  useFocusEffect(
    useCallback(() => {
      notices.setBottomInset(BAR_HEIGHT)
      return () => notices.setBottomInset(0)
    }, [notices]),
  )

  useEffect(() => {
    let current = true
    void loadFolders().then((list) => current && setFolders(list))
    return () => {
      current = false
    }
  }, [loadFolders, version])

  useEffect(() => {
    let current = true
    void Promise.all([todosOfThread(id), mailAccounts()]).then(([list, accounts]) => {
      if (current) {
        setTodos(list)
        setOwnAddresses(accounts.map((account) => account.emailAddress))
      }
    })
    return () => {
      current = false
    }
  }, [todosOfThread, mailAccounts, id, version])

  /** Makes a todo of the conversation, titled after its subject; the email keeps one todo however often this runs. */
  async function makeTodo() {
    const source = todoSourceMessage(messages, ownAddresses)
    if (source === null || makingTodo) {
      return
    }
    setMakingTodo(true)
    try {
      await mail.makeTodo(source.id)
      notices.notify({ text: 'Added to your todos.', tone: 'info', action: { label: 'View', run: () => router.push('/todos') } })
    } catch (error) {
      notices.notify({ text: error instanceof Error ? error.message : String(error), tone: 'error' })
    } finally {
      if (mounted.current) {
        setMakingTodo(false)
      }
    }
  }

  // Another conversation in the same screen starts with its own folding.
  const [shownId, setShownId] = useState(id)
  if (shownId !== id) {
    setShownId(id)
    setExpanded(null)
  }

  /** Back to the list, if this screen is still the one on screen; from a link with no history, to the inbox. */
  function leave() {
    if (!mounted.current) {
      return
    }
    if (router.canGoBack()) {
      router.back()
    } else {
      router.replace('/')
    }
  }

  useEffect(() => {
    let current = true
    void load(id).then((result) => {
      if (!current) {
        return
      }
      setNotFound(result === null)
      if (result === null && pulledFor.current !== id) {
        // Not here (yet): pull now, so it either arrives or is known to be gone.
        pulledFor.current = id
        void syncNow()
      }
      setThread(result?.thread ?? null)
      setMessages(result?.messages ?? [])
      // Opening a conversation reads it, once; actions taken meanwhile wait for that.
      if (result !== null && read.current !== id) {
        read.current = id
        const unread = result.messages.filter((m) => !m.flags.seen).map((m) => m.id)
        if (unread.length > 0) {
          after(run(unread, 'markRead'))
        }
      }
      setExpanded((open) => {
        if (open !== null || result === null) {
          return open
        }
        const first = new Set(result.messages.filter((m) => !m.flags.seen).map((m) => m.id))
        const newest = result.messages[result.messages.length - 1]
        if (newest) {
          first.add(newest.id)
        }
        return first
      })
    })
    return () => {
      current = false
    }
  }, [load, id, version, after, run, syncNow])

  // Who this conversation is handed over to and still waited on.
  useEffect(() => {
    let current = true
    void loadHandOvers().then((list) => current && setWaitingOn(openHandOversOf(list, id)))
    return () => {
      current = false
    }
  }, [loadHandOvers, id, version])

  const flagged = messages.some((message) => message.flags.flagged)

  function relocateAll(action: 'archive' | 'trash') {
    void exclusive(async () => {
      if ((await relocate(messages.map((m) => m.id), action, folders)) !== null) {
        leave()
      }
    })
  }

  function markUnread() {
    void exclusive(async () => {
      const newest = messages[messages.length - 1]
      if (newest && (await run([newest.id], 'markUnread')) !== null) {
        leave()
      }
    })
  }

  function toggleFlag() {
    void exclusive(async () => {
      if (flagged) {
        await run(messages.filter((m) => m.flags.flagged).map((m) => m.id), 'unflag')
        return
      }
      const newest = messages[messages.length - 1]
      if (newest) {
        await run([newest.id], 'flag')
      }
    })
  }

  function toggle(messageId: string) {
    setExpanded((open) => {
      const next = new Set(open)
      if (!next.delete(messageId)) {
        next.add(messageId)
      }
      return next
    })
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: '', headerBackTitle: 'Inbox' }} />
      <PlaceScrollProvider value={scrollToPlace}>
        <ScrollView ref={scroll} style={styles.screen} contentContainerStyle={styles.content}>
          {absent === 'loading' && <LogoLoader size={32} style={styles.loading} accessibilityLabel="Loading the conversation" />}
          {absent === 'unreachable' && (
            <View accessibilityRole="alert">
              <Text style={styles.muted}>This conversation could not be loaded: {syncError}. It opens once Tresso can sync again.</Text>
              <Pressable onPress={() => void syncNow()} accessibilityRole="button" style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
                <Text style={styles.on}>Try again</Text>
              </Pressable>
            </View>
          )}
          {absent === 'missing' && <Text style={styles.muted}>This conversation no longer exists.</Text>}
          {thread !== null && (
            <>
              <Text style={styles.subject} accessibilityRole="header">
                {thread.subject || '(no subject)'}
              </Text>
              {waitingOn.map((handOver) => {
                const late = handOverStatus(handOver) === 'overdue'
                return (
                  <View key={handOver.id} style={[styles.handed, late && styles.handedLate]}>
                    <Text style={styles.handedText}>
                      Handed over to {senderName(handOver.delegate)}, {late ? 'was due' : 'due'} {shortDue(handOver.dueAt)}
                    </Text>
                    <View style={styles.replies}>
                      <ReplyButton label="Nudge" onPress={() => void handOvers.nudge(handOver)} styles={styles} />
                      <ReplyButton label="Mark done" onPress={() => void handOvers.markDone(handOver)} styles={styles} />
                    </View>
                  </View>
                )
              })}
              {todos.length === 0 ? (
                <Pressable
                  style={({ pressed }) => [styles.todoButton, (pressed || makingTodo) && styles.replyPressed]}
                  onPress={() => void makeTodo()}
                  disabled={makingTodo}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: makingTodo }}
                >
                  <Text style={styles.todoButtonLabel}>Make todo</Text>
                </Pressable>
              ) : (
                todos.map((todo) => (
                  <Pressable key={todo.id} style={styles.todo} onPress={() => router.push('/todos')} accessibilityRole="link">
                    <Text style={[styles.todoTitle, todo.completedAt !== null && styles.todoDone]} numberOfLines={1}>
                      {todo.title}
                    </Text>
                    <Text style={styles.muted}>{dueLabel(todo, new Date()) ?? 'Open'}</Text>
                  </Pressable>
                ))
              )}
              {messages.map((message) => {
                const open = expanded?.has(message.id) ?? false
                const to = [...message.recipients.to, ...message.recipients.cc].map(senderName).join(', ')
                return (
                  <View key={message.id} style={styles.message}>
                    <Pressable style={styles.head} onPress={() => toggle(message.id)} accessibilityRole="button" accessibilityState={{ expanded: open }}>
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>{initials(message.from)}</Text>
                      </View>
                      <View style={styles.who}>
                        <Text style={[styles.from, !message.flags.seen && styles.bold]} numberOfLines={1}>
                          {senderName(message.from)}
                        </Text>
                        <Text style={styles.muted} numberOfLines={1}>
                          {open ? (to === '' ? '' : `To ${to}`) : message.snippet}
                        </Text>
                      </View>
                      <Text style={styles.muted}>{shortTime(Date.parse(message.receivedAt))}</Text>
                    </Pressable>
                    {open && <MessageBodyView messageId={message.id} />}
                    {open && (
                      <View style={styles.replies} accessibilityRole="toolbar" accessibilityLabel={`Answer ${senderName(message.from)}`}>
                        <ReplyButton label="Reply" onPress={() => void composer.openReply(message, 'reply')} styles={styles} />
                        <ReplyButton label="Reply all" onPress={() => void composer.openReply(message, 'replyAll')} styles={styles} />
                        <ReplyButton label="Forward" onPress={() => void composer.openReply(message, 'forward')} styles={styles} />
                      </View>
                    )}
                  </View>
                )
              })}
            </>
          )}
        </ScrollView>
      </PlaceScrollProvider>
      {thread !== null && (
        <View style={[styles.bar, { height: BAR_HEIGHT + insets.bottom, paddingBottom: insets.bottom }]} accessibilityRole="toolbar">
          <BarButton label="Archive" busy={busy} styles={styles} onPress={() => relocateAll('archive')} />
          <BarButton label="Trash" busy={busy} styles={styles} onPress={() => relocateAll('trash')} />
          <BarButton label="Unread" busy={busy} styles={styles} onPress={() => markUnread()} />
          <BarButton label="Flag" busy={busy} styles={styles} checked={flagged} onPress={() => toggleFlag()} />
          <BarButton label="Hand over" busy={busy} styles={styles} onPress={() => router.push({ pathname: '/hand-over', params: { threadId: id } })} />
        </View>
      )}
    </>
  )
}

function ReplyButton({ label, styles, onPress }: { label: string; styles: ReturnType<typeof makeStyles>; onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.reply, pressed && styles.replyPressed]} onPress={onPress} accessibilityRole="button">
      <Text style={styles.replyLabel}>{label}</Text>
    </Pressable>
  )
}

function BarButton({ label, busy, checked, styles, onPress }: { label: string; busy: boolean; checked?: boolean; styles: ReturnType<typeof makeStyles>; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.action, (pressed || busy) && styles.pressed]}
      onPress={onPress}
      disabled={busy}
      accessibilityRole={checked === undefined ? 'button' : 'togglebutton'}
      accessibilityState={{ disabled: busy, checked }}
    >
      <Text style={[styles.actionLabel, checked === true && styles.on]}>{label}</Text>
    </Pressable>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.surface },
    content: { padding: 20, gap: 16 },
    loading: { marginTop: 32, alignSelf: 'center' },
    subject: { color: theme.ink, fontSize: 24, lineHeight: 30, fontWeight: '700' },
    replies: { flexDirection: 'row', gap: 8, paddingTop: 4 },
    todoButton: { alignSelf: 'flex-start', minHeight: 40, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: theme.accent, justifyContent: 'center' },
    todoButtonLabel: { color: theme.accent, fontSize: 15, fontWeight: '600' },
    todo: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: theme.line, backgroundColor: theme.ground },
    todoTitle: { flex: 1, color: theme.ink, fontSize: 15, fontWeight: '600' },
    todoDone: { color: theme.ink2, textDecorationLine: 'line-through' },
    reply: { minHeight: 40, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: theme.lineStrong, justifyContent: 'center' },
    replyPressed: { backgroundColor: theme.ground },
    replyLabel: { fontSize: 14, fontWeight: '600', color: theme.ink },
    message: { gap: 12, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
    head: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
    avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.ground },
    avatarText: { color: theme.ink, fontSize: 13, fontWeight: '600' },
    who: { flex: 1, gap: 2 },
    from: { color: theme.ink, fontSize: 16 },
    bold: { fontWeight: '600' },
    muted: { color: theme.ink2, fontSize: 13 },
    retry: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingVertical: 8 },
    on: { color: theme.ink },
    handed: { gap: 8, padding: 12, borderRadius: 8, backgroundColor: theme.ground },
    handedLate: { borderLeftWidth: 3, borderLeftColor: theme.danger },
    handedText: { color: theme.ink, fontSize: 14 },
    bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line, backgroundColor: theme.surface },
    action: { minWidth: 64, minHeight: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
    actionLabel: { color: theme.accent, fontSize: 15, fontWeight: '600' },
    pressed: { opacity: 0.5 },
  })
}
