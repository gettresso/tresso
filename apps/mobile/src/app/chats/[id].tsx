import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Alert, AppState, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { attachHeldText, CHAT_MAX_FILE_BYTES, replyText, TODO_TITLE_MAX_LENGTH, type ChatPage, type SyncedChatMessage, type SyncedChatOutgoing } from '@tresso/core'
import { FileNotSent, outcomeUnknown, ReplyCancelled, type FileUpload } from '@/chat/chatActions'
import { fileSizeOf, removeCachedCopy } from '@/chat/fileUpload'
import { useChats } from '@/chat/ChatProvider'
import { CHAT_MISSING, cancelFailureText, chatInitials, chatName, COUNTER_FROM, counterText, relayBanner, replyProblemText, retryFailureText, sendFailureText, FILE_NOT_OPENED, fileFailureText, mediaTitle, mediaView, UNSCANNED_WARNING } from '@/chat/texts'
import { timelineRows, windowReplies, type BubbleRow, type TimelineRow } from '@/chat/timelineRows'
import { useChatWindow } from '@/chat/useChatWindow'
import { ChatBubble } from '@/components/ChatBubble'
import { ChoiceSheet } from '@/components/ChoiceSheet'
import { Icon } from '@/components/Icon'
import { LogoLoader } from '@/components/LogoLoader'
import { useNotices } from '@/components/Notices'
import { absentConversation } from '@/mail/openedConversation'
import { useMail } from '@/mail/MailProvider'
import { useTheme, type Theme } from '@/theme'

/** What a reply's change of state says to a screen reader. */
function stateAnnouncement(bubble: BubbleRow): string | null {
  switch (bubble.state) {
    case 'sending':
      return 'Sending.'
    case 'sent':
      return 'Sent.'
    case 'waiting':
      return 'Waiting for your Mac.'
    case 'failed':
      return `Not sent. ${bubble.reason ?? ''}`.trim()
    case 'unconfirmed':
      return bubble.reason
    default:
      return null
  }
}

/**
 * A WhatsApp chat on the phone (the MobileWhatsAppChat board, with the WhatsApp plan's corrections): the header with
 * Back, the chat's name, `WhatsApp` and Make todo; a banner while the Mac that relays is offline or cannot send; the
 * messages in windows (newest first, older ones as the list reaches its top, day rows between days); and the reply box
 * with Attach a file. A reply (and a file, uploaded first) goes through the server's queue and waits there for the Mac.
 * A message's file is asked for from the Mac only on Download, and opened by the system from a fresh signed link once
 * the server checked it. Opening the chat while the app is in front reads
 * it in Tresso (never in WhatsApp).
 */
export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const chats = useChats()
  const mail = useMail()
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const notices = useNotices()
  const { actions, account, revision } = chats
  const settle = useCallback((page: ChatPage) => actions.settle(id, page.outgoing), [actions, id])
  const win = useChatWindow(id, chats.page, mail.version, settle)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // A chat opened from a notification before the delta brought it: loading until a pull after it opened completed.
  const { pulls, syncState, syncNow } = mail
  const [opened, setOpened] = useState({ id, pulls })
  if (opened.id !== id) {
    setOpened({ id, pulls })
  }
  const pulledFor = useRef<string | null>(null)
  const chat = win.chat !== null && account !== null && win.chat.chatAccountId === account.id && !win.chat.leftOut ? win.chat : null
  // Until the copy was read for the account (a cold start from a notification), nothing is known yet. A chat the copy
  // has but the phone does not show (left out, or no WhatsApp on the server) is not coming either.
  const absent = !win.loaded || !chats.accountRead || chat !== null ? null : win.chat !== null ? 'missing' : absentConversation(pulls, opened.pulls, syncState)
  const loading = !win.loaded || !chats.accountRead || absent === 'loading'
  useEffect(() => {
    if (win.loaded && win.chat === null && pulledFor.current !== id) {
      pulledFor.current = id
      void syncNow()
    }
  }, [win.loaded, win.chat, id, syncNow])

  const name = chat === null ? '' : chatName(chat)
  const relayOnline = account?.relayOnline ?? false
  const banner = relayBanner(account)
  const replies = useMemo(
    () => actions.shown(id, windowReplies(win.messages, win.outgoing, win.hasOlder)),
    // `revision` changes whenever the replies under way do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actions, id, win.messages, win.outgoing, win.hasOlder, revision],
  )
  // Files on their way from this phone, by reply id (`revision` changes with their progress).
  const uploads = useMemo(() => {
    const found = new Map<string, FileUpload>()
    for (const reply of replies) {
      const upload = actions.uploadOf(reply.id)
      if (upload !== null) {
        found.set(reply.id, upload)
      }
    }
    return found
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, replies, revision])
  const rows = useMemo(
    () => (chat === null ? [] : timelineRows(win.messages, replies, { group: chat.kind === 'group', name, relayOnline, uploads })),
    [chat, win.messages, replies, name, relayOnline, uploads],
  )
  // Newest first: the list is inverted, so it opens at the newest message and grows upwards with older ones.
  const newestFirst = useMemo(() => [...rows].reverse(), [rows])

  // Each reply's change of state is said once (one that was there when the chat opened says nothing).
  const states = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    states.current = null
  }, [id])
  useEffect(() => {
    if (!win.loaded) {
      return
    }
    const next = new Map<string, string>()
    let said: string | null = null
    for (const row of rows) {
      if (row.kind === 'bubble' && row.reply !== null && row.state !== 'uploading') {
        next.set(row.key, row.state)
        if (states.current !== null && states.current.get(row.key) !== row.state) {
          said = stateAnnouncement(row)
        }
      }
      // A file's state too (asked for, checked, ready, not brought), once it changes.
      if (row.kind === 'bubble' && row.media !== null) {
        const line = mediaView(row.media, relayOnline).line
        const key = `file-${row.key}`
        next.set(key, line)
        if (states.current !== null && states.current.has(key) && states.current.get(key) !== line) {
          said = `${mediaTitle(row.media)}: ${line}`
        }
      }
    }
    states.current = next
    if (said !== null) {
      AccessibilityInfo.announceForAccessibility(said)
    }
  }, [rows, win.loaded, relayOnline])

  // Read in Tresso while the chat is on screen and the app in front: on opening, on coming back, on new messages.
  const [active, setActive] = useState(AppState.currentState === 'active')
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => setActive(next === 'active'))
    return () => subscription.remove()
  }, [])
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, []),
  )
  // Looked at again: a read the server refused may be asked once more (ChatActions.lookedAt). Before the read below.
  useEffect(() => {
    if (active && focused) {
      actions.lookedAt(id)
    }
  }, [active, focused, id, actions])
  useEffect(() => {
    if (chat !== null && active && focused) {
      void actions.markRead(chat)
    }
  }, [chat, active, focused, actions])

  // The reply box.
  const [text, setText] = useState(() => chats.draftOf(id))
  const [shownFor, setShownFor] = useState(id)
  if (shownFor !== id) {
    setShownFor(id)
    setText(chats.draftOf(id))
  }
  const [sendError, setSendError] = useState<string | null>(null)
  const sending = useRef(false)
  const [busySending, setBusySending] = useState(false)
  /** The chat on screen now, so a failed send of another one never fills this box. */
  const onScreen = useRef(id)
  useEffect(() => {
    onScreen.current = id
  }, [id])
  const checked = replyText(text)
  const length = [...text.trim()].length
  const problem = checked.ok ? null : replyProblemText(checked.problem)
  const canSend = chat !== null && checked.ok && !busySending

  function onChange(next: string) {
    setText(next)
    chats.setDraft(id, next)
    setSendError(null)
  }

  async function send() {
    // One at a time: a second tap while the first is under way does nothing. Return in the box never sends, so the
    // Return that confirms an input method's composition cannot either.
    if (sending.current || chat === null || !replyText(text).ok) {
      return
    }
    sending.current = true
    setBusySending(true)
    const typed = text
    const forChat = id
    setText('')
    chats.setDraft(id, '')
    setSendError(null)
    try {
      await actions.send(chat, typed)
    } catch (error) {
      if (error instanceof ReplyCancelled) {
        // The user cancelled it while it was being queued, and the server kept that: nothing to say or put back.
        return
      }
      // The text goes back in the box (or its draft, when another chat is on screen now), before anything typed meanwhile.
      const draft = chats.draftOf(forChat)
      chats.setDraft(forChat, draft === '' ? typed : `${typed}\n${draft}`)
      if (mounted.current && onScreen.current === forChat) {
        setText(chats.draftOf(forChat))
        setSendError(sendFailureText(error, outcomeUnknown(error)))
      }
    } finally {
      sending.current = false
      if (mounted.current) {
        setBusySending(false)
      }
    }
  }

  /** Attach a file: one picked from the device, uploaded and queued for the Mac. */
  const [attachingFile, setAttachingFile] = useState(false)
  // After the server said too many files, Attach waits until its Retry-After (`revision` changes when that starts).
  const [heldTick, setHeldTick] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const heldFor = useMemo(() => actions.attachHeld(), [actions, revision, heldTick])
  useEffect(() => {
    if (heldFor === null) {
      return
    }
    const timer = setTimeout(() => setHeldTick((tick) => tick + 1), heldFor)
    return () => clearTimeout(timer)
  }, [heldFor])
  const attachHeld = heldFor !== null
  async function attach() {
    if (chat === null || attachingFile || actions.attachHeld() !== null) {
      return
    }
    const forChat = chat
    let picked: DocumentPicker.DocumentPickerResult
    try {
      picked = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true })
    } catch (error) {
      console.error('Choosing a file to attach failed', error instanceof Error ? error.name : typeof error)
      return
    }
    const asset = picked.canceled ? null : (picked.assets[0] ?? null)
    if (asset === null) {
      return
    }
    setAttachingFile(true)
    setSendError(null)
    try {
      // The picker does not always say the size: it is read from the file then, and a file whose size is not known is
      // not sent (it could be larger than what Tresso sends).
      const size = typeof asset.size === 'number' && asset.size > 0 ? asset.size : await fileSizeOf(asset.uri)
      if (size === null) {
        setSendError(`${asset.name} was not sent. Tresso could not tell how large it is.`)
        return
      }
      if (size > CHAT_MAX_FILE_BYTES) {
        setSendError(`${asset.name} is larger than 100 MB, the most Tresso sends.`)
        return
      }
      await actions.sendFile(forChat, { uri: asset.uri, name: asset.name, size, lastModified: asset.lastModified ?? null })
    } catch (error) {
      if (mounted.current && onScreen.current === forChat.id) {
        setSendError(error instanceof FileNotSent ? fileFailureText(asset.name, error.phase, error.reason, error.unsure, error.cancelled, error.maybeSent) : `${asset.name} was not sent.`)
      }
    } finally {
      // The picker's copy in the cache goes, whatever came of it: a new pick makes a new one.
      await removeCachedCopy(asset.uri)
      if (mounted.current) {
        setAttachingFile(false)
      }
    }
  }

  // Leaving the chat, or the app going to the background, stops a file on its way: nothing more is queued.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        actions.abandonUploads()
      }
    })
    return () => {
      subscription.remove()
      actions.abandonUploads(id)
    }
  }, [actions, id])
  const onCancelUpload = useCallback((reply: SyncedChatOutgoing) => void actions.cancel(reply), [actions])

  /** What the last action on a file said, by message (a refusal, a link that could not open), also to a screen reader. */
  const [mediaNote, setMediaNote] = useState<{ messageId: string; text: string } | null>(null)
  const noteMedia = useCallback((messageId: string, text: string) => {
    setMediaNote({ messageId, text })
    AccessibilityInfo.announceForAccessibility(text)
  }, [])
  const onMedia = useCallback(
    (message: SyncedChatMessage, action: 'download' | 'open' | 'confirm') => {
      const open = async (acceptUnscanned: boolean) => {
        const link = await actions.fileLink(message.id, acceptUnscanned)
        if (link === null) {
          noteMedia(message.id, 'This file cannot be opened yet.')
          return
        }
        try {
          await Linking.openURL(link)
        } catch (error) {
          console.error('Handing a WhatsApp file to an app failed', error instanceof Error ? error.name : typeof error)
          if (mounted.current) {
            noteMedia(message.id, FILE_NOT_OPENED)
          }
        }
      }
      const fail = (error: unknown) => {
        console.error('A WhatsApp file action failed', error instanceof Error ? error.name : typeof error)
        if (mounted.current) {
          noteMedia(message.id, outcomeUnknown(error) ? 'Tresso could not reach your Tresso server. Try again.' : 'Your Tresso server did not take this.')
        }
      }
      setMediaNote(null)
      if (action === 'download') {
        actions
          .requestFile(message.id)
          .then(() => syncNow())
          .catch(fail)
      } else if (action === 'open') {
        open(false).catch(fail)
      } else {
        Alert.alert('Not checked for malware', UNSCANNED_WARNING, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open anyway', style: 'destructive', onPress: () => void open(true).catch(fail) },
        ])
      }
    },
    [actions, syncNow, noteMedia],
  )

  // Cancel, Delete and Try again, one at a time per reply.
  const [busyReply, setBusyReply] = useState<string | null>(null)
  const busyNow = useRef<string | null>(null)
  const [menuFor, setMenuFor] = useState<SyncedChatOutgoing | null>(null)
  const onReply = useCallback(
    async (reply: SyncedChatOutgoing, what: 'retry' | 'cancel') => {
      if (busyNow.current !== null) {
        return
      }
      busyNow.current = reply.id
      setBusyReply(reply.id)
      try {
        await (what === 'retry' ? actions.retry(reply) : actions.cancel(reply))
      } catch (error) {
        notices.notify({ text: what === 'retry' ? retryFailureText(error) : cancelFailureText(error), tone: 'error' })
      } finally {
        busyNow.current = null
        if (mounted.current) {
          setBusyReply(null)
        }
      }
    },
    [actions, notices],
  )
  const onRetry = useCallback((reply: SyncedChatOutgoing) => void onReply(reply, 'retry'), [onReply])

  // Make todo: `Reply to <name>`, which the user sees and may change first; nothing else of the chat goes in.
  const [todoTitle, setTodoTitle] = useState<string | null>(null)
  const [addingTodo, setAddingTodo] = useState(false)
  async function addTodo() {
    const title = todoTitle?.trim() ?? ''
    if (title === '' || addingTodo) {
      return
    }
    setAddingTodo(true)
    try {
      await chats.createTodo(title)
      if (mounted.current) {
        setTodoTitle(null)
      }
      notices.notify({ text: 'Added to your todos.', tone: 'info', action: { label: 'View', run: () => router.push('/todos') } })
    } catch (error) {
      notices.notify({ text: error instanceof Error ? error.message : String(error), tone: 'error' })
    } finally {
      if (mounted.current) {
        setAddingTodo(false)
      }
    }
  }

  function leave() {
    if (router.canGoBack()) {
      router.back()
    } else {
      router.replace('/')
    }
  }

  // Stable, so typing in the reply box does not draw the bubbles again (ChatBubble is memoised).
  const renderRow = useCallback(
    ({ item }: { item: TimelineRow }) => {
      if (item.kind === 'day') {
        return (
          <View style={styles.dayRow}>
            <Text style={styles.day} accessibilityRole="header">
              {item.label}
            </Text>
          </View>
        )
      }
      return (
        <ChatBubble
          bubble={item}
          busy={item.reply !== null && busyReply === item.reply.id}
          onRetry={onRetry}
          onMenu={setMenuFor}
          relayOnline={relayOnline}
          mediaNote={item.media !== null && mediaNote?.messageId === item.media.id ? mediaNote.text : null}
          onMedia={onMedia}
          onCancelUpload={onCancelUpload}
        />
      )
    },
    [styles, busyReply, onRetry, relayOnline, mediaNote, onMedia, onCancelUpload],
  )

  const menuWaiting = menuFor?.status === 'waiting'
  const menuTitle = menuWaiting ? 'This reply waits for your Mac.' : menuFor?.error === 'unconfirmed' ? 'This reply may have been sent.' : 'This reply was not sent.'

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView style={[styles.screen, { paddingTop: insets.top }]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.header}>
          <Pressable style={({ pressed }) => [styles.round, pressed && styles.pressed]} onPress={leave} accessibilityRole="button" accessibilityLabel="Back" hitSlop={4}>
            <Icon name="back" size={22} color={theme.ink} />
          </Pressable>
          {chat !== null && (
            <>
              <View style={styles.avatar} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Text style={styles.avatarText}>{chatInitials(name)}</Text>
              </View>
              <View style={styles.who}>
                <Text style={styles.name} numberOfLines={1} accessibilityRole="header">
                  {name}
                </Text>
                <Text style={styles.channel}>WhatsApp</Text>
              </View>
              <Pressable
                style={({ pressed }) => [styles.round, styles.todoButton, pressed && styles.pressed]}
                onPress={() => setTodoTitle(`Reply to ${name}`.slice(0, TODO_TITLE_MAX_LENGTH))}
                accessibilityRole="button"
                accessibilityLabel="Make todo"
              >
                <Icon name="todo" size={20} color={theme.ink} />
              </Pressable>
            </>
          )}
        </View>
        {chat !== null && banner !== null && (
          <View style={styles.banner} accessibilityLiveRegion="polite" accessibilityRole="summary">
            <Text style={styles.bannerText}>{banner}</Text>
          </View>
        )}
        {chat !== null && todoTitle !== null && (
          <View style={styles.todo}>
            <TextInput
              style={styles.todoField}
              value={todoTitle}
              onChangeText={setTodoTitle}
              maxLength={TODO_TITLE_MAX_LENGTH}
              accessibilityLabel="Todo"
              autoFocus
              selectTextOnFocus
            />
            <Pressable
              style={({ pressed }) => [styles.small, styles.primary, (pressed || addingTodo || todoTitle.trim() === '') && styles.pressed]}
              onPress={() => void addTodo()}
              disabled={addingTodo || todoTitle.trim() === ''}
              accessibilityRole="button"
              accessibilityState={{ disabled: addingTodo || todoTitle.trim() === '', busy: addingTodo }}
            >
              <Text style={styles.primaryLabel}>Add</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [styles.small, pressed && styles.pressed]} onPress={() => setTodoTitle(null)} accessibilityRole="button">
              <Text style={styles.smallLabel}>Cancel</Text>
            </Pressable>
          </View>
        )}
        {loading ? (
          <LogoLoader size={32} style={styles.loading} accessibilityLabel="Loading the chat" />
        ) : chat === null ? (
          <View style={styles.missing}>
            {absent === 'unreachable' ? (
              <View accessibilityRole="alert">
                <Text style={styles.muted}>This chat could not be loaded: {mail.syncError}. It opens once Tresso can sync again.</Text>
                <Pressable onPress={() => void syncNow()} accessibilityRole="button" style={({ pressed }) => [styles.small, pressed && styles.pressed]}>
                  <Text style={styles.smallLabel}>Try again</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={styles.muted}>{CHAT_MISSING}</Text>
            )}
          </View>
        ) : (
          <FlatList
            style={styles.timeline}
            contentContainerStyle={styles.timelineContent}
            data={newestFirst}
            inverted
            keyExtractor={(row) => row.key}
            renderItem={renderRow}
            onEndReached={() => win.loadOlder()}
            onEndReachedThreshold={0.5}
            keyboardShouldPersistTaps="handled"
            accessibilityLabel="Messages"
            ListEmptyComponent={<Text style={[styles.muted, styles.empty]}>No messages in this chat yet.</Text>}
            ListFooterComponent={
              win.hasOlder ? (
                <Pressable style={({ pressed }) => [styles.older, pressed && styles.pressed]} onPress={() => win.loadOlder()} disabled={win.loadingOlder} accessibilityRole="button" accessibilityState={{ busy: win.loadingOlder, disabled: win.loadingOlder }}>
                  <Text style={styles.smallLabel}>{win.loadingOlder ? 'Loading older messages…' : 'Show older messages'}</Text>
                </Pressable>
              ) : undefined
            }
          />
        )}
        {chat !== null && (
          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            {length >= COUNTER_FROM && <Text style={[styles.note, !checked.ok && checked.problem === 'too_long' && styles.problem]}>{counterText(length)}</Text>}
            {problem !== null && <Text style={[styles.note, styles.problem]}>{problem}</Text>}
            {heldFor !== null && <Text style={styles.note}>{attachHeldText(heldFor)}</Text>}
            {sendError !== null && (
              <Text style={[styles.note, styles.problem]} accessibilityRole="alert" accessibilityLiveRegion="assertive">
                {sendError}
              </Text>
            )}
            <View style={styles.composerRow}>
              <Pressable
                style={({ pressed }) => [styles.attach, (pressed || attachingFile || attachHeld) && styles.pressed]}
                onPress={() => void attach()}
                disabled={attachingFile || attachHeld}
                accessibilityRole="button"
                accessibilityLabel="Attach a file"
                accessibilityHint={heldFor !== null ? attachHeldText(heldFor) : undefined}
                accessibilityState={{ disabled: attachingFile || attachHeld, busy: attachingFile }}
              >
                <Icon name="attach" size={20} color={theme.ink} />
              </Pressable>
              <TextInput
                style={styles.field}
                value={text}
                onChangeText={onChange}
                placeholder="Message"
                placeholderTextColor={theme.ink2}
                multiline
                accessibilityLabel={`Reply to ${name}`}
                submitBehavior="newline"
              />
              <Pressable
                style={({ pressed }) => [styles.send, (pressed || !canSend) && styles.pressed]}
                onPress={() => void send()}
                disabled={!canSend}
                accessibilityRole="button"
                accessibilityLabel="Send"
                accessibilityState={{ disabled: !canSend, busy: busySending }}
              >
                <Icon name="send" size={18} color={theme.surface} />
              </Pressable>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
      <ChoiceSheet<'cancel'>
        visible={menuFor !== null}
        title={menuTitle}
        choices={[{ key: 'cancel', label: menuWaiting ? 'Cancel this reply' : 'Delete this reply', tone: 'danger' }]}
        onChoose={() => {
          const reply = menuFor
          setMenuFor(null)
          if (reply !== null) {
            void onReply(reply, 'cancel')
          }
        }}
        onClose={() => setMenuFor(null)}
      />
    </>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.surface },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
    round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    todoButton: { backgroundColor: theme.ground },
    pressed: { opacity: 0.5 },
    avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.delegateSoft },
    avatarText: { color: theme.delegate, fontSize: 13, fontWeight: '700' },
    who: { flex: 1, minWidth: 0 },
    name: { color: theme.ink, fontSize: 16, fontWeight: '600' },
    channel: { color: theme.know, fontSize: 12, fontWeight: '600' },
    banner: { paddingVertical: 10, paddingHorizontal: 16, backgroundColor: theme.delegateSoft },
    bannerText: { color: theme.ink, fontSize: 13, lineHeight: 18 },
    todo: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
    todoField: { flex: 1, minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: theme.lineStrong, borderRadius: 8, color: theme.ink, fontSize: 15 },
    small: { minHeight: 44, paddingHorizontal: 14, borderRadius: 8, justifyContent: 'center', alignSelf: 'flex-start' },
    smallLabel: { color: theme.accent, fontSize: 15, fontWeight: '600' },
    primary: { backgroundColor: theme.accent },
    primaryLabel: { color: theme.onAccent, fontSize: 15, fontWeight: '600' },
    loading: { marginTop: 32, alignSelf: 'center' },
    missing: { flex: 1, padding: 20, gap: 12 },
    muted: { color: theme.ink2, fontSize: 15, lineHeight: 21 },
    empty: { padding: 20, textAlign: 'center', transform: [{ scaleY: -1 }] },
    timeline: { flex: 1, backgroundColor: theme.ground },
    timelineContent: { padding: 16 },
    dayRow: { alignItems: 'center', marginVertical: 10 },
    day: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, overflow: 'hidden', backgroundColor: theme.surface, color: theme.ink2, fontSize: 12, fontWeight: '600' },
    older: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 14 },
    composer: { gap: 6, paddingTop: 10, paddingHorizontal: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line, backgroundColor: theme.surface },
    composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
    attach: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    field: { flex: 1, minHeight: 44, maxHeight: 140, paddingHorizontal: 14, paddingTop: 11, paddingBottom: 11, borderWidth: 1, borderColor: theme.lineStrong, borderRadius: 22, color: theme.ink, fontSize: 15 },
    send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.ink },
    note: { color: theme.ink2, fontSize: 12 },
    problem: { color: theme.danger },
  })
}
