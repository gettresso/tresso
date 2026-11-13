import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  CHAT_BACKFILL,
  chatApiFailure,
  inInbox,
  LOCAL_CHAT_ACCOUNT,
  LocalChatError,
  nameText,
  recordLocalAttachment,
  replyText,
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
import { chatsFromServer, whatsAppShell, type ChosenFile } from '@/platform/whatsapp'
import { errorName } from '@/components/chat/whatsappTexts'
import { useChatApi } from '@/api/chats'
import { ChatActionError, chatActionError, localChatActions, serverChatActions, type ChatActions, type ChatStateChange } from '@/stores/chatActions'
import { useAuthStore } from '@/stores/auth'
import { useMailStore } from '@/stores/mail'
import { RELAY_ONLY, useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import { serverAccountIn } from '@/stores/whatsappServer'

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

/** Why an attached file did not go: a reply's error, or `too_large` (over 100 MB, refused before the bridge reads it). */
export type AttachError = ChatOutgoingError | 'too_large'

/** A file attached from the composer of a chat: on its way, or why it did not go. */
export type AttachState =
  | { state: 'idle' }
  | { state: 'sending'; chatId: string; name: string }
  | { state: 'sent'; chatId: string; name: string }
  | { state: 'failed'; chatId: string; name: string; error: AttachError }

/** The chat value keeping replies whose outcome was not known, by chat (see the store's `unsure`). */
export const UNSURE_REPLIES = 'unsure-replies'

/** How often a chat screen reads its replies again while one waits or is being sent (the relay sends in its rounds). */
const REPLY_POLL_MS = 3_000
/** While the store is read in, the chats are read again at most this often (the relay stores a page at a time). */
const IMPORT_REFRESH_MS = 1_000
/** How long a WhatsApp address waits in the browser for the copy to say whether the server holds chats (serverChats). */
export const SERVER_CHECK_MS = 10_000

/** Whether the server's chats show here: known yes, known no, or not known yet (the copy is still opening). */
export type ServerChats = 'shown' | 'none' | 'unknown'

const IDLE: MediaState = { state: 'idle' }

/** The file name of a path the native picker returned, for `File: <name>`. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== '').pop() ?? path
}

/**
 * Chats on screen (the WhatsApp plan's WP6, WP10 and WP11): the list rows, the chat pane's windows of a chat, and what
 * the user does in a chat. `enabled` is the one flag every chat screen reads; while it is false nothing is read and
 * nothing of WhatsApp shows. Which chats and which actions (ChatActions):
 * - The desktop app (macOS, WhatsApp turned on and connected there):
 *   - "Only this Mac": the `wa:` chats, written through core's local actions (queueLocalReply and its siblings), after
 *     which the relay is asked for a round (whatsappRelay.pollNow).
 *   - "All my devices": the server account's chats, which come through the delta (read again on every page that
 *     carries chat rows, mail.chatChanges), written through the server's actions (chatActions.ts): shown at once, put
 *     back when the server refuses. On the relaying Mac a queued reply is sent by its relay; on another Mac it waits for
 *     that one.
 * - The browser (`serverOnly`, platform/whatsapp chatsFromServer): no bridge and nothing of the relay. Chats show
 *   exactly while the copy holds the server's WhatsApp account (the user chose "All my devices" on a Mac), with no
 *   switch; they come through the delta and are written through the server's actions, as on a Mac that does not relay.
 *   Replies wait in the server's queue for the relaying Mac; files stay on that Mac for now.
 *
 * Nothing of a chat (names, numbers, text) is ever logged: errors are logged by name only.
 */
export const useChatsStore = defineStore('chats', () => {
  const mail = useMailStore()
  const wa = useWhatsAppRelayStore()
  const commands = whatsAppShell()
  const auth = useAuthStore()
  const api = useChatApi()

  /** The browser: the chats are those the server holds, relayed by a Mac; nothing of WhatsApp runs here. */
  const serverOnly = chatsFromServer
  /** In the browser: the server's WhatsApp account as the open copy holds it; null when it holds none. */
  const serverAccount = shallowRef<SyncedChatAccount | null>(null)
  /** In the browser: the open copy was read for that account (false while no copy is open or it is still opening). */
  const serverChecked = ref(false)

  /**
   * Chats can show. In the browser: the copy holds the server's account. On the desktop: WhatsApp is on here and
   * connected, and in "All my devices" the server's account is in the copy.
   */
  const enabled = computed(() =>
    serverOnly ? serverAccount.value !== null : wa.available && wa.connected && (wa.config?.mode === 'local' || (wa.config?.mode === 'all' && wa.serverAccount !== null)),
  )
  /** The chat account whose chats show: `wa:account`, or the server's. */
  const accountId = computed(() => {
    if (!enabled.value) {
      return null
    }
    if (serverOnly) {
      return serverAccount.value?.id ?? null
    }
    return wa.config?.mode === 'all' ? (wa.serverAccount?.id ?? null) : LOCAL_CHAT_ACCOUNT
  })
  /** This device sends the replies itself: "Only this Mac", or it relays the server's account. Never the browser. */
  const relaysHere = computed(() => !serverOnly && enabled.value && (wa.config?.mode === 'local' || wa.relaysHere))
  /**
   * Writes to the server's chats wait until the server confirmed the open copy's user in this page load, as mail's do
   * (mail.confirmed, the mail store's confirmedOnly): until then the chats can be read, not written, and no read is
   * marked by itself. "Only this Mac" writes only to this Mac's copy and is not held.
   */
  const writesHeld = computed(() => (serverOnly || wa.config?.mode === 'all') && mail.confirmed !== true)

  /** @throws ChatActionError `checking` while writes are held (writesHeld) */
  function checkWritable(): void {
    if (writesHeld.value) {
      throw new ChatActionError('checking')
    }
  }
  /**
   * A reply can be written: on the Mac that sends, while its bridge runs and is linked (else the pane says why,
   * ChatNotice); on another Mac in "All my devices" always (it waits in the server's queue for the relaying Mac).
   */
  const canReply = computed(() => enabled.value && !writesHeld.value && (relaysHere.value ? wa.linked : true))
  /** Attach is offered (disabled while replies cannot be written). */
  const canAttach = computed(() => enabled.value)
  /** This Mac is bringing its chats in (a switch under way, or the first import of the Mac that relays). */
  const bringingIn = computed(
    () =>
      wa.available &&
      wa.connected &&
      (wa.modeSwitch !== null || (wa.config?.mode === 'all' && wa.serverAccount === null) || (relaysHere.value && (wa.importState === 'waiting' || wa.importState === 'reading'))),
  )
  /** Why Attach is off: files go through the server only with a later package. */
  const attachNote = computed(() => {
    if (!enabled.value) {
      return null
    }
    if (serverOnly) {
      return 'Files are sent from the relaying Mac for now.'
    }
    return wa.config?.mode === 'all' ? 'Files are sent in Only this Mac for now.' : null
  })
  const localActions = localChatActions(() => mail.currentStore())
  const serverActions = serverChatActions({ api, store: () => mail.currentStore(), now: () => auth.serverNow(), pulled: () => void mail.syncNow() })
  /**
   * Per chat, a reply whose sending ended without knowing whether the server took it (ChatActionError `unsure`): its
   * trimmed text and id. Sending the same text again reuses the id, so it is queued once. Kept in the copy's chat values
   * (UNSURE_REPLIES), so a reload reuses it too; gone once it is sent or refused, once the delta brings that id, or once
   * the server's id window (10 minutes) has passed.
   */
  let unsure = new Map<string, { text: string; id: string }>()
  /** The side every write goes to now. */
  const actions = computed<ChatActions>(() => (serverOnly || wa.config?.mode === 'all' ? serverActions : localActions))
  /**
   * Reads of a chat the server refused or did not answer, by chat (the phone's rule): taking one back changes the copy,
   * which reads the chat again, so it is not asked again for the same last message until the chat is looked at again
   * (lookedAt), and never before the server's Retry-After.
   */
  const refusedReads = new Map<string, { lastMessageAt: string; notBefore: number; held: boolean }>()
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
  /**
   * Messages sent at or before this moment (epoch ms) are history being read in, not news: everything while the first
   * import runs, those before the re-read began while one runs (the relay store's `liveFrom`), none once the import is
   * done. Notifications and the open chat's live region say nothing for history.
   */
  const historyThrough = computed(() => {
    if (!relaysHere.value) {
      // Another Mac reads the store in: its history arrives read and old, which notifies nothing anyway.
      return null
    }
    return wa.importState === 'done' && wa.liveFrom === null ? null : (wa.liveFrom ?? Number.POSITIVE_INFINITY)
  })
  /** Read again after every change of the chats; a chat pane reloads its window on it. */
  const version = ref(0)
  /** The chat a pane shows now, for notifications (none for the chat the user looks at). */
  const openChatId = ref<string | null>(null)
  const media = shallowRef<ReadonlyMap<string, MediaState>>(new Map())
  const attaching = shallowRef<AttachState>({ state: 'idle' })
  /** What the user typed and did not send yet, per chat: kept while they look at another chat, in memory only. */
  const drafts = new Map<string, string>()

  let refreshing: Promise<void> | null = null
  let again = false
  let seen = new Map<string, string | null>()
  /** The first read of a session only notes what is there: it is no news. */
  let primed = false

  function store(): MailStore | null {
    return enabled.value ? mail.currentStore() : null
  }

  /** JIDs left out on this Mac that the server has no chat row for yet ("All my devices"); see read. */
  const leftOutHere = shallowRef<string[]>([])

  /**
   * A reply whose outcome was not known came in through the delta: it was queued, so it counts as sent. Raised with
   * its chat, so the pane takes back what it said (the error) and the composer is emptied when it still holds that text.
   */
  const unsureArrived = shallowRef<{ chatId: string; n: number } | null>(null)

  async function keepUnsure(copy: MailStore, chatId: string, entry: { text: string; id: string } | null): Promise<void> {
    const next = new Map(unsure)
    if (entry === null) {
      next.delete(chatId)
    } else {
      next.set(chatId, entry)
    }
    unsure = next
    await copy.setChatMeta(UNSURE_REPLIES, next.size === 0 ? null : JSON.stringify([...next]))
  }

  /**
   * Reads the unsure replies from the copy, and lets go of those the delta brought: they were queued, so they are sent as
   * far as the user is concerned (the draft that still holds the text goes). Never let go for age: an old id sent again
   * is safe (the server answers a queued one with it, a cancelled one with 409, and an id too old to queue with a 422,
   * which ends as `maybe_queued`).
   */
  async function settleUnsure(copy: MailStore): Promise<void> {
    const raw = await copy.chatMeta(UNSURE_REPLIES)
    let read = new Map<string, { text: string; id: string }>()
    try {
      const parsed = raw === null ? [] : (JSON.parse(raw) as unknown)
      if (Array.isArray(parsed)) {
        read = new Map(
          parsed.filter(
            (entry): entry is [string, { text: string; id: string }] =>
              Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1]?.text === 'string' && typeof entry[1]?.id === 'string',
          ),
        )
      }
    } catch {
      // Unreadable: nothing to reuse.
    }
    unsure = read
    for (const [chatId, entry] of read) {
      const arrived = (await copy.chatPage(chatId, { limit: 1 }))?.outgoing.some((row) => row.id === entry.id && row.status !== 'cancelled') ?? false
      if (arrived) {
        await keepUnsure(copy, chatId, null)
        const draft = drafts.get(chatId)
        const typed = draft === undefined ? null : replyText(draft)
        if (typed !== null && typed.ok && typed.text === entry.text) {
          drafts.delete(chatId)
        }
        unsureArrived.value = { chatId, n: (unsureArrived.value?.n ?? 0) + 1 }
      }
    }
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
      // Signed out, disconnected or switched off: nothing typed into a chat stays behind.
      drafts.clear()
      refusedReads.clear()
      media.value = new Map()
      attaching.value = { state: 'idle' }
      return
    }
    try {
      const shownAccount = accountId.value
      const [accounts, all] = await Promise.all([copy.chatAccounts(), copy.chats()])
      const local = all.filter((summary) => summary.chat.chatAccountId === shownAccount)
      account.value = accounts.find((row) => row.id === shownAccount) ?? null
      summaries.value = local
      // A chat that went (left out, removed with groups or the account) takes what was typed into it along.
      const shown = new Set(local.map((summary) => summary.chat.id))
      for (const chatId of drafts.keys()) {
        if (!shown.has(chatId)) {
          drafts.delete(chatId)
        }
      }
      leftOut.value =
        shownAccount === LOCAL_CHAT_ACCOUNT || shownAccount === null
          ? (await Promise.all((wa.config?.leftOut ?? []).map((jid) => copy.chatByJid(LOCAL_CHAT_ACCOUNT, jid)))).filter((chat): chat is SyncedChat => chat !== null)
          : // Left out on any device: the server's rows say it.
            await copy.leftOutChats(shownAccount)
      if (shownAccount !== null && shownAccount !== LOCAL_CHAT_ACCOUNT) {
        // Left out on this Mac with no server chat to say so (left out before the switch): still left out.
        const listed = new Set(leftOut.value.map((chat) => chat.jid))
        const kept: string[] = []
        for (const jid of wa.config?.leftOut ?? []) {
          if (!listed.has(jid) && (await copy.chatByJid(shownAccount, jid))?.leftOut !== false) {
            kept.push(jid)
          }
        }
        leftOutHere.value = kept
      } else {
        leftOutHere.value = []
      }
      await settleUnsure(copy)
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
      historyThrough: historyThrough.value,
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

  /** Account reads in the browser, so an older one that lands late never overwrites a newer one. */
  let accountReads = 0

  /**
   * The browser: whether the open copy holds the server's WhatsApp account (it comes with the delta, and goes with its
   * tombstone or the copy). Read when the copy opens and on every page of the delta that carries chat rows.
   */
  async function readServerAccount(): Promise<void> {
    const mine = ++accountReads
    const copy = mail.ready ? mail.currentStore() : null
    if (copy === null) {
      serverAccount.value = null
      serverChecked.value = false
      return
    }
    let found: SyncedChatAccount | null
    let known: boolean
    try {
      found = await serverAccountIn(copy)
      // No account is an answer only once the copy holds what the server has: after a pull in this session, or a copy
      // that synced before and has no backfill of its chats still to do. A fresh copy says nothing until then, so an
      // address opened right after signing in on a new browser waits for the account instead of leaving.
      known = found !== null || mail.synced || ((await copy.syncedAt()) !== null && (await copy.chatMeta(CHAT_BACKFILL)) === null)
    } catch (cause) {
      // The copy closed meanwhile, or could not be read: the next page with chat rows reads it again.
      console.error('Reading the WhatsApp account failed', errorName(cause))
      return
    }
    if (mine !== accountReads) {
      return
    }
    if (JSON.stringify(found) !== JSON.stringify(serverAccount.value)) {
      serverAccount.value = found
    }
    serverChecked.value = known
  }

  if (serverOnly) {
    watch([() => mail.currentStore(), () => mail.ready, () => mail.chatChanges, () => mail.synced], () => void readServerAccount(), { immediate: true })
  }

  /**
   * Whether the server's chats show here, for a WhatsApp address opened in the browser: once the copy said so, or after
   * `timeoutMs` without an answer (`unknown`: the screens then follow the copy once it opened). Signed out: `none`.
   * On the desktop it is known at once.
   */
  function serverChats(timeoutMs = SERVER_CHECK_MS): Promise<ServerChats> {
    const now = (): ServerChats | null => {
      if (!serverOnly || serverChecked.value) {
        return enabled.value ? 'shown' : 'none'
      }
      return auth.isAuthenticated ? null : 'none'
    }
    const known = now()
    if (known !== null) {
      return Promise.resolve(known)
    }
    return new Promise((resolve) => {
      let stop: (() => void) | null = null
      const finish = (answer: ServerChats) => {
        clearTimeout(timer)
        stop?.()
        stop = null
        resolve(answer)
      }
      const timer = setTimeout(() => finish('unknown'), timeoutMs)
      stop = watch([serverChecked, enabled, () => auth.isAuthenticated], () => {
        const answer = now()
        if (answer !== null) {
          finish(answer)
        }
      })
    })
  }

  watch([enabled, accountId, () => mail.synced, () => mail.ready, () => wa.config?.leftOut], () => void refresh(), { immediate: true })

  /*
   * The relay stored something or reported a reply, or a page of the delta carried chat rows (every chat row of "All my
   * devices" comes that way). While the store is read in it stores a page at a time, so the chats are read again at
   * most once a second then (the last change always gets its read).
   */
  let lastRead = 0
  let pending: ReturnType<typeof setTimeout> | null = null
  function changed(): void {
    if (wa.importState === 'done' || !relaysHere.value) {
      lastRead = Date.now()
      void refresh()
      return
    }
    if (pending !== null) {
      return
    }
    const wait = Math.max(0, lastRead + IMPORT_REFRESH_MS - Date.now())
    pending = setTimeout(() => {
      pending = null
      lastRead = Date.now()
      void refresh()
    }, wait)
  }
  watch(() => wa.revision, changed)
  watch(
    () => mail.chatChanges,
    () => {
      if (serverOnly || wa.config?.mode === 'all') {
        changed()
      }
    },
  )

  /** What was typed into a chat and not sent; '' when nothing. */
  function draftOf(chatId: string): string {
    return drafts.get(chatId) ?? ''
  }

  function setDraft(chatId: string, text: string): void {
    if (text === '') {
      drafts.delete(chatId)
    } else {
      drafts.set(chatId, text)
    }
  }

  /** A window of a chat (MailStore.chatPage); null when it is not on this Mac. */
  async function page(chatId: string, options: { limit: number; before?: ChatMessageKey | null; from?: ChatMessageKey | null }): Promise<ChatPage | null> {
    const copy = store()
    return copy === null ? null : copy.chatPage(chatId, options)
  }

  /** Tresso's own state of a chat, then the lists read again (also after the server refused it and it was put back). */
  async function setState(chatId: string, change: ChatStateChange): Promise<void> {
    if (store() === null) {
      return
    }
    checkWritable()
    try {
      await actions.value.setState(chatId, change)
    } finally {
      await refresh()
    }
  }

  /**
   * The chat was read in Tresso up to its last message (never in WhatsApp: the phone keeps its own unread state). A read
   * that did not happen is logged by name, put back in the copy (setState) and held (refusedReads): not asked again for
   * the same last message until the chat is looked at again, and never before the server's Retry-After (on the server's
   * clock), also not for a newer message. While writes are held (writesHeld) nothing is asked.
   */
  async function markRead(chat: SyncedChat): Promise<void> {
    if (chat.readThrough !== null && Date.parse(chat.readThrough) >= Date.parse(chat.lastMessageAt)) {
      return
    }
    if (writesHeld.value) {
      return
    }
    const refused = refusedReads.get(chat.id)
    if (refused !== undefined) {
      if (auth.serverNow() < refused.notBefore || (refused.lastMessageAt === chat.lastMessageAt && refused.held)) {
        return
      }
      // A newer message came, or the chat is looked at again after its wait.
      refusedReads.delete(chat.id)
    }
    try {
      await setState(chat.id, { readThrough: chat.lastMessageAt })
    } catch (cause) {
      console.error('Reading a chat failed', errorName(cause))
      const wait = cause instanceof ChatActionError ? cause.retryAfterMs : (chatApiFailure(cause)?.retryAfterMs ?? null)
      refusedReads.set(chat.id, { lastMessageAt: chat.lastMessageAt, notBefore: auth.serverNow() + (wait ?? 0), held: true })
    }
  }

  /** The chat is looked at again (opened, or its window got the focus): a held read may be asked again once its wait passed. */
  function lookedAt(chatId: string): void {
    const refused = refusedReads.get(chatId)
    if (refused !== undefined) {
      refusedReads.set(chatId, { ...refused, held: false })
    }
  }

  /** Noted: read and out of the Unified Inbox until a message comes in after. */
  function noted(chat: SyncedChat): Promise<void> {
    return setState(chat.id, { readThrough: chat.lastMessageAt, archivedThrough: chat.lastMessageAt })
  }

  /** Archive: out of the Unified Inbox until a message comes in after; it stays in the WhatsApp list. */
  function archive(chat: SyncedChat): Promise<void> {
    return setState(chat.id, { archivedThrough: chat.lastMessageAt })
  }

  /**
   * After a reply changed: the lists, then a relay round when this Mac sends (the server's queue reaches the relay through
   * the delta, so "All my devices" pulls first), then the lists again (the reply's state moved).
   */
  async function afterReply(): Promise<void> {
    version.value++
    await refresh()
    if (relaysHere.value) {
      if (wa.config?.mode === 'all') {
        await mail.syncNow()
      }
      await wa.pollNow()
      await refresh()
    }
  }

  /**
   * Queues a reply (checked and trimmed by replyText) and asks the relay to send it now.
   *
   * @throws LocalChatError or ChatActionError when the text cannot be sent, the chat is not here, or the server refused
   *   it (the composer keeps the text then)
   */
  async function send(chatId: string, text: string): Promise<SyncedChatOutgoing> {
    const copy = store()
    if (copy === null) {
      throw new LocalChatError('no_chat')
    }
    checkWritable()
    const checked = replyText(text)
    const earlier = unsure.get(chatId)
    // The same text after an unsure try is that reply again; any other text is a new one.
    const again = earlier !== undefined && checked.ok && checked.text === earlier.text ? earlier.id : undefined
    let row: SyncedChatOutgoing
    try {
      row = await actions.value.send(chatId, text, again)
    } catch (cause) {
      if (cause instanceof ChatActionError && cause.code === 'unsure' && cause.replyId !== null && checked.ok) {
        await keepUnsure(copy, chatId, { text: checked.text, id: cause.replyId })
      } else if (earlier !== undefined && checked.ok && checked.text === earlier.text) {
        // Refused, or too old to tell: never sent again under that id.
        await keepUnsure(copy, chatId, null)
      }
      // A reply shown at once and put back: the pane shows the chat as it is again.
      version.value++
      throw cause
    }
    if (earlier !== undefined) {
      await keepUnsure(copy, chatId, null)
    }
    drafts.delete(chatId)
    void afterReply()
    return row
  }

  /** Cancels a reply that waits or was not sent; one being sent cannot be (`already_going_out`). */
  async function cancel(chatId: string, id: string): Promise<void> {
    if (store() !== null) {
      checkWritable()
      try {
        await actions.value.cancel(chatId, id)
      } finally {
        version.value++
        await refresh()
      }
    }
  }

  /** The user's Try again: the only way a reply that was not sent, or whose sending is unconfirmed, goes out again. */
  async function retry(chatId: string, id: string): Promise<void> {
    if (store() !== null) {
      checkWritable()
      try {
        await actions.value.retry(chatId, id)
      } catch (cause) {
        version.value++
        await refresh()
        throw cause
      }
      void afterReply()
    }
  }

  /**
   * Leaves the chat out: Tresso removes its copy and stops reading it; WhatsApp keeps it. In the browser the server's
   * chat is left out (the server removes its messages and replies and takes nothing more of it, and the relaying Mac
   * reads the chat's row in its copy and sends nothing of it).
   *
   * @throws ChatActionError in the browser when the server did not take it (the chat stays as it was)
   */
  async function leaveChatOut(chat: SyncedChat): Promise<boolean> {
    checkWritable()
    if (serverOnly) {
      if (store() === null) {
        return false
      }
      try {
        await actions.value.setState(chat.id, { leftOut: true })
        drafts.delete(chat.id)
        return true
      } finally {
        await refresh()
      }
    }
    const done = await wa.leaveOut(chat.jid)
    if (done) {
      drafts.delete(chat.id)
    }
    await refresh()
    return done
  }

  /**
   * Takes a chat that was left out back in; its messages come back as the relay reads the store again. Only the Mac
   * that relays can: the browser cannot read the bridge again.
   *
   * @throws Error in the browser (RELAY_ONLY)
   */
  async function takeBackIn(jid: string): Promise<boolean> {
    if (serverOnly) {
      throw new Error(RELAY_ONLY)
    }
    checkWritable()
    const done = await wa.takeBackIn(jid)
    await refresh()
    return done
  }

  /**
   * The browser's Notify me: the server's account setting (pushes to the phone, and the relaying Mac's notifications,
   * whose config follows the account), shown at once once the server answered.
   *
   * @throws ChatActionError when the server did not take it
   */
  async function setNotify(notify: boolean): Promise<void> {
    const copy = store()
    const shown = serverAccount.value
    if (!serverOnly || copy === null || shown === null || shown.notify === notify) {
      return
    }
    checkWritable()
    let answered: SyncedChatAccount
    try {
      answered = await api.updateAccount(shown.id, { notify })
    } catch (cause) {
      throw chatActionError(cause, 'change')
    }
    await copy.putChatAccount(answered)
    await readServerAccount()
    await refresh()
    void mail.syncNow()
  }

  /**
   * The browser's "Remove WhatsApp from your Tresso server": deletes the server's chat account with every chat, message
   * and reply under it (waiting replies are never sent), for every device. The relaying Mac finds the account gone at
   * its next call or pull and disconnects WhatsApp in Tresso; WhatsApp itself and the bridge's store stay. An account
   * already gone (404) counts as removed. The pull after it brings the tombstone, which turns the chat screens off.
   *
   * @throws ChatActionError when the server did not remove it
   */
  async function removeFromServer(): Promise<void> {
    const shown = serverAccount.value
    if (!serverOnly || shown === null) {
      return
    }
    checkWritable()
    try {
      await api.removeAccount(shown.id)
    } catch (cause) {
      if (chatApiFailure(cause)?.status !== 404) {
        throw chatActionError(cause, 'change')
      }
    }
    await mail.syncNow()
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
    if (copy === null || !canAttach.value || attachNote.value !== null || !canReply.value || attaching.value.state === 'sending') {
      return
    }
    let picked: ChosenFile | null
    try {
      picked = await commands.chooseFile()
    } catch (cause) {
      console.error('Choosing a file to attach failed', errorName(cause))
      attaching.value = { state: 'failed', chatId: chat.id, name: '', error: 'refused' }
      return
    }
    if (picked === null) {
      return
    }
    const { path, size } = picked
    const name = baseName(path)
    attaching.value = { state: 'sending', chatId: chat.id, name }
    let error: AttachError | null = null
    try {
      const result = await commands.send(chat.jid, '', path)
      error = result.ok ? null : result.message
    } catch (cause) {
      // The shell refused the request before the bridge saw it: nothing went out. A file over what Attach sends is said
      // as such; the bridge's own refusal of a large file cannot be told apart from any other (it logs the reason only).
      console.error('Sending a WhatsApp file failed', errorName(cause))
      error = cause === 'too_large' ? 'too_large' : 'refused'
    }
    if (error !== null) {
      attaching.value = { state: 'failed', chatId: chat.id, name, error }
      return
    }
    try {
      await recordLocalAttachment(copy, chat.id, { name, size }, uuidV7(), Date.now())
    } catch (cause) {
      console.error('Recording a sent WhatsApp file failed', errorName(cause))
    }
    attaching.value = { state: 'sent', chatId: chat.id, name }
    version.value++
    await refresh()
  }

  /** The composer's attach line was read (in `chatId`'s chat, or any): it goes, unless a file is still on its way. */
  function clearAttach(chatId: string | null = null): void {
    const state = attaching.value
    if (state.state !== 'idle' && state.state !== 'sending' && (chatId === null || state.chatId === chatId)) {
      attaching.value = { state: 'idle' }
    }
  }

  /** Replies of a chat are on their way: the pane reads them again on this interval (the relay sends in its rounds). */
  function needsPolling(outgoing: readonly SyncedChatOutgoing[]): boolean {
    return outgoing.some((row) => row.status === 'waiting' || row.status === 'sending')
  }

  return {
    serverOnly,
    serverAccount,
    serverChecked,
    serverChats,
    setNotify,
    removeFromServer,
    writesHeld,
    lookedAt,
    draftOf,
    setDraft,
    enabled,
    leftOutHere,
    unsureArrived,
    accountId,
    relaysHere,
    canReply,
    canAttach,
    attachNote,
    bringingIn,
    account,
    summaries,
    inboxSummaries,
    unread,
    leftOut,
    channel,
    version,
    historyThrough,
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
