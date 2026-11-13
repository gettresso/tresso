import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  cancelLocalReply,
  chatOnlyHere,
  inInbox,
  LOCAL_CHAT_ACCOUNT,
  LocalChatError,
  nameText,
  queueLocalReply,
  recordLocalAttachment,
  retryLocalReply,
  setLocalChatState,
  uuidV7,
  type ChatMessageKey,
  type ChatOutgoingError,
  type ChatPage,
  type ChatSummary,
  type MailStore,
  type SyncedChat,
  type SyncedChatAccount,
  type SyncedChatMessage,
  type SyncedChatOutgoing,
} from '@tresso/core'
import { chatNotifications } from '@/mail/chatNotifications'
import { notifier } from '@/platform/notifier'
import { whatsAppShell } from '@/platform/whatsapp'
import { errorName } from '@/components/chat/whatsappTexts'
import { useMailStore } from '@/stores/mail'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'

/** Which chats and mail the Unified Inbox shows (its `Channels` tabs). */
export type InboxChannel = 'all' | 'mail' | 'whatsapp'

/** A file of a message on this Mac: not asked for, coming, here (Tresso's own copy, which it may open), or refused. */
export type MediaState =
  | { state: 'idle' }
  | { state: 'downloading' }
  | { state: 'done'; path: string }
  | { state: 'failed'; reason: MediaFailure }

/**
 * Why a file is not here: `failed` (the bridge could not fetch it, often the phone that sent it is offline), `stopped`
 * (the bridge is not running), `mismatch` (the bridge gave another file than the message's), `unverified` (the store
 * holds no hash to check it against), `refused` (a name or place Tresso does not trust), `too_large`, `open` (opening
 * the downloaded file failed).
 */
export type MediaFailure = 'failed' | 'stopped' | 'mismatch' | 'unverified' | 'refused' | 'too_large' | 'open'

/** A file attached from the composer: on its way, or why it did not go. */
export type AttachState = { state: 'idle' } | { state: 'sending'; name: string } | { state: 'sent'; name: string } | { state: 'failed'; name: string; error: ChatOutgoingError }

/** How often a chat screen reads its replies again while one waits or is being sent (the relay sends in its rounds). */
const REPLY_POLL_MS = 3_000

const IDLE: MediaState = { state: 'idle' }

/** The file name of a path the native picker returned, for `File: <name>`. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== '').pop() ?? path
}

/**
 * Chats on screen (the WhatsApp plan's WP6): the list rows, the chat pane's windows of a chat, and what the user does
 * in a chat. Only the desktop app on macOS with WhatsApp connected "Only this Mac" has any: everywhere else `enabled`
 * is false and nothing is read. Every write goes through the "Only this Mac" actions of packages/core/src/chat
 * (queueLocalReply and its siblings), after which the relay is asked for a round (whatsappRelay.pollNow).
 *
 * Nothing of a chat (names, numbers, text) is ever logged: errors are logged by name only.
 */
export const useChatsStore = defineStore('chats', () => {
  const mail = useMailStore()
  const wa = useWhatsAppRelayStore()
  const commands = whatsAppShell()

  /** Chats can show: WhatsApp is on here and connected in the "Only this Mac" mode. */
  const enabled = computed(() => wa.available && wa.connected && wa.config?.mode === 'local')
  /** A reply can be written: the bridge runs and is linked (else the pane says why, ChatNotice). */
  const canReply = computed(() => enabled.value && wa.linked)
  const account = shallowRef<SyncedChatAccount | null>(null)
  /** Every chat of this Mac that is not left out, newest first. */
  const summaries = shallowRef<ChatSummary[]>([])
  /** The chats the Unified Inbox shows: not archived through their last message. */
  const inboxSummaries = computed(() => summaries.value.filter((summary) => inInbox(summary.chat)))
  /** Chats in the Unified Inbox with unread messages: the WhatsApp row's count, and part of the Unified Inbox's. */
  const unread = computed(() => inboxSummaries.value.filter((summary) => summary.unread > 0).length)
  /** The chats the user left out, as the copy keeps them (for taking one back in). */
  const leftOut = shallowRef<SyncedChat[]>([])
  /** The Unified Inbox's channel tab; kept while the app runs. */
  const channel = ref<InboxChannel>('all')
  /** Read again after every change of the chats; a chat pane reloads its window on it. */
  const version = ref(0)
  /** The chat a pane shows now, for notifications (none for the chat the user looks at). */
  const openChatId = ref<string | null>(null)
  const media = shallowRef<ReadonlyMap<string, MediaState>>(new Map())
  const attaching = shallowRef<AttachState>({ state: 'idle' })

  let refreshing: Promise<void> | null = null
  let again = false
  let seen = new Map<string, string | null>()
  /** The first read of a session only notes what is there: it is no news. */
  let primed = false

  function store(): MailStore | null {
    return enabled.value ? mail.currentStore() : null
  }

  /** Reads the chats again (once more after one under way, never two at once). */
  function refresh(): Promise<void> {
    if (refreshing !== null) {
      again = true
      return refreshing
    }
    refreshing = (async () => {
      try {
        do {
          again = false
          await read()
        } while (again)
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  async function read(): Promise<void> {
    const copy = store()
    if (copy === null) {
      account.value = null
      summaries.value = []
      leftOut.value = []
      seen = new Map()
      primed = false
      return
    }
    try {
      const [accounts, all] = await Promise.all([copy.chatAccounts(), copy.chats()])
      const local = all.filter((summary) => chatOnlyHere(summary.chat.chatAccountId))
      account.value = accounts.find((row) => row.id === LOCAL_CHAT_ACCOUNT) ?? null
      summaries.value = local
      leftOut.value = (await Promise.all((wa.config?.leftOut ?? []).map((jid) => copy.chatByJid(LOCAL_CHAT_ACCOUNT, jid)))).filter((chat): chat is SyncedChat => chat !== null)
      version.value++
      notify(local)
    } catch (cause) {
      console.error('Reading the chats failed', errorName(cause))
    }
  }

  /** Desktop notifications for messages that came in since the last read (chatNotifications). */
  function notify(local: ChatSummary[]): void {
    const focused = typeof document !== 'undefined' && document.hasFocus() ? openChatId.value : null
    const round = chatNotifications({
      summaries: local,
      seen,
      now: Date.now(),
      notify: primed && wa.config?.notify === true,
      firstImport: wa.importState !== 'done',
      focusedChatId: focused,
      named,
    })
    seen = round.seen
    primed = true
    if (round.notifications.length > 0 && notifier !== null) {
      notifier.show(round.notifications).catch((cause: unknown) => console.error('Showing chat notifications failed', errorName(cause)))
    }
  }

  /** A message with its sender's name as this session knows it, when it was stored without one. */
  function named(message: SyncedChatMessage): SyncedChatMessage {
    const sender = message.sender
    if (sender === null || nameText(sender.name) !== '') {
      return message
    }
    const known = wa.senderNames.get(sender.id)
    return known === undefined ? message : { ...message, sender: { ...sender, name: known } }
  }

  watch([enabled, () => wa.revision, () => mail.synced, () => mail.ready, () => wa.config?.leftOut], () => void refresh(), { immediate: true })

  /** A window of a chat (MailStore.chatPage); null when it is not on this Mac. */
  async function page(chatId: string, options: { limit: number; before?: ChatMessageKey | null; from?: ChatMessageKey | null }): Promise<ChatPage | null> {
    const copy = store()
    return copy === null ? null : copy.chatPage(chatId, options)
  }

  /** Tresso's own state of a chat, then the lists read again. */
  async function setState(chatId: string, change: Parameters<typeof setLocalChatState>[2]): Promise<void> {
    const copy = store()
    if (copy === null) {
      return
    }
    await setLocalChatState(copy, chatId, change)
    await refresh()
  }

  /** The chat was read in Tresso up to its last message (never in WhatsApp: the phone keeps its own unread state). */
  async function markRead(chat: SyncedChat): Promise<void> {
    if (chat.readThrough !== null && Date.parse(chat.readThrough) >= Date.parse(chat.lastMessageAt)) {
      return
    }
    await setState(chat.id, { readThrough: chat.lastMessageAt })
  }

  /** Noted: read and out of the Unified Inbox until a message comes in after. */
  function noted(chat: SyncedChat): Promise<void> {
    return setState(chat.id, { readThrough: chat.lastMessageAt, archivedThrough: chat.lastMessageAt })
  }

  /** Archive: out of the Unified Inbox until a message comes in after; it stays in the WhatsApp list. */
  function archive(chat: SyncedChat): Promise<void> {
    return setState(chat.id, { archivedThrough: chat.lastMessageAt })
  }

  /** After a reply changed: the lists, then a relay round, then the lists again (the reply's state moved). */
  async function afterReply(): Promise<void> {
    version.value++
    await refresh()
    await wa.pollNow()
    await refresh()
  }

  /**
   * Queues a reply (checked and trimmed by replyText) and asks the relay to send it now.
   *
   * @throws LocalChatError when the text cannot be sent or the chat is not here
   */
  async function send(chatId: string, text: string): Promise<SyncedChatOutgoing> {
    const copy = store()
    if (copy === null) {
      throw new LocalChatError('no_chat')
    }
    const row = await queueLocalReply(copy, chatId, text, uuidV7(), Date.now())
    void afterReply()
    return row
  }

  /** Cancels a reply that waits or was not sent; one being sent cannot be (LocalChatError `already_going_out`). */
  async function cancel(chatId: string, id: string): Promise<void> {
    const copy = store()
    if (copy !== null) {
      await cancelLocalReply(copy, chatId, id)
      version.value++
      await refresh()
    }
  }

  /** The user's Try again: the only way a reply that was not sent, or whose sending is unconfirmed, goes out again. */
  async function retry(chatId: string, id: string): Promise<void> {
    const copy = store()
    if (copy !== null) {
      await retryLocalReply(copy, chatId, id)
      void afterReply()
    }
  }

  /** Leaves the chat out: Tresso removes its copy and stops reading it; WhatsApp keeps it. */
  async function leaveChatOut(chat: SyncedChat): Promise<boolean> {
    const done = await wa.leaveOut(chat.jid)
    await refresh()
    return done
  }

  /** Takes a chat that was left out back in; its messages come back as the relay reads the store again. */
  async function takeBackIn(jid: string): Promise<boolean> {
    const done = await wa.takeBackIn(jid)
    await refresh()
    return done
  }

  function mediaOf(messageId: string): MediaState {
    return media.value.get(messageId) ?? IDLE
  }

  function setMedia(messageId: string, state: MediaState): void {
    media.value = new Map(media.value).set(messageId, state)
  }

  /** The shell's download refusal as a reason the media row can say. */
  function downloadFailure(cause: unknown): MediaFailure {
    switch (cause) {
      case 'mismatch':
        return 'mismatch'
      case 'refused':
        return 'refused'
      case 'too_large':
        return 'too_large'
      case 'bridge_stopped':
        return 'stopped'
      default:
        return 'failed'
    }
  }

  /**
   * Downloads a message's file into Tresso's own folder (the shell checks it against the hash the store holds). A file
   * the store has no hash for is kept from opening, as one that did not match is.
   */
  async function download(chat: SyncedChat, message: SyncedChatMessage): Promise<void> {
    const folder = wa.config?.folder ?? null
    const state = mediaOf(message.id).state
    if (folder === null || message.mediaKind === null || state === 'downloading' || state === 'done') {
      return
    }
    setMedia(message.id, { state: 'downloading' })
    try {
      const file = await commands.download(folder, message.waId, chat.jid)
      setMedia(message.id, file.verified ? { state: 'done', path: file.path } : { state: 'failed', reason: 'unverified' })
    } catch (cause) {
      console.error('Downloading a WhatsApp file failed', errorName(cause))
      setMedia(message.id, { state: 'failed', reason: downloadFailure(cause) })
    }
  }

  /** Opens a file Tresso downloaded and checked, with its default app; nothing else is ever opened. */
  async function openFile(message: SyncedChatMessage): Promise<void> {
    const current = mediaOf(message.id)
    if (current.state !== 'done') {
      return
    }
    try {
      await commands.openFile(current.path)
    } catch (cause) {
      console.error('Opening a WhatsApp file failed', errorName(cause))
      setMedia(message.id, { state: 'failed', reason: 'open' })
    }
  }

  /**
   * Attach: a file from the native picker goes to the bridge at once (files from other devices come later), and once it
   * went out it is recorded as a sent reply, `File: <name>`. A file that did not go, or whose sending could not be
   * confirmed, is not recorded: the composer says why, and only attaching it again sends it again.
   */
  async function attach(chat: SyncedChat): Promise<void> {
    const copy = store()
    if (copy === null || !canReply.value || attaching.value.state === 'sending') {
      return
    }
    let path: string | null
    try {
      path = await commands.chooseFile()
    } catch (cause) {
      console.error('Choosing a file to attach failed', errorName(cause))
      attaching.value = { state: 'failed', name: '', error: 'refused' }
      return
    }
    if (path === null) {
      return
    }
    const name = baseName(path)
    attaching.value = { state: 'sending', name }
    let error: ChatOutgoingError | null = null
    try {
      const result = await commands.send(chat.jid, '', path)
      error = result.ok ? null : result.message
    } catch (cause) {
      // The shell refused the request before the bridge saw it: nothing went out.
      console.error('Sending a WhatsApp file failed', errorName(cause))
      error = 'refused'
    }
    if (error !== null) {
      attaching.value = { state: 'failed', name, error }
      return
    }
    try {
      await recordLocalAttachment(copy, chat.id, name, uuidV7(), Date.now())
    } catch (cause) {
      console.error('Recording a sent WhatsApp file failed', errorName(cause))
    }
    attaching.value = { state: 'sent', name }
    version.value++
    await refresh()
  }

  /** The composer's attach line was read; it goes. */
  function clearAttach(): void {
    if (attaching.value.state !== 'sending') {
      attaching.value = { state: 'idle' }
    }
  }

  /** Replies of a chat are on their way: the pane reads them again on this interval (the relay sends in its rounds). */
  function needsPolling(outgoing: readonly SyncedChatOutgoing[]): boolean {
    return outgoing.some((row) => row.status === 'waiting' || row.status === 'sending')
  }

  return {
    enabled,
    canReply,
    account,
    summaries,
    inboxSummaries,
    unread,
    leftOut,
    channel,
    version,
    openChatId,
    media,
    attaching,
    refresh,
    page,
    named,
    markRead,
    noted,
    archive,
    send,
    cancel,
    retry,
    leaveChatOut,
    takeBackIn,
    mediaOf,
    download,
    openFile,
    attach,
    clearAttach,
    needsPolling,
    REPLY_POLL_MS,
  }
})
