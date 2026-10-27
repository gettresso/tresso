import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  RealtimeClient,
  SyncEngine,
  MAX_MESSAGES_PER_ACTION,
  appliedFor,
  briefView,
  CopyClosingError,
  deliveredNotices,
  noticeKey,
  DraftSync,
  PartialActionError,
  type AppliedAction,
  type BriefView,
  type ChangePage,
  type MessageAction,
  type MessageActionRequest,
  type MessageActionResult,
  type MessageBody,
  type RealtimeAccess,
  type MailStore,
  type SendMessageRequest,
  type SyncedDailyBrief,
  type SyncedDraft,
  type DraftAttachmentLink,
  type SyncedFolder,
  type SyncedHandOver,
  type SyncedMailAccount,
  type SyncedMailNotification,
  type SyncedMessage,
  type SyncedOutgoingMessage,
  type SyncedSignature,
  type SyncedCalendar,
  type SyncedSmartInbox,
  type SyncedThread,
  type SyncedTodo,
  type SyncedUnsubscription,
  type ThreadClassification,
  type ThreadClassificationRequest,
  type UnsubscribeRequest,
  type Unsubscription,
  type Verdict,
  needsTriage,
} from '@tresso/core'
import { ApiError } from '@/api/errors'
import type { Contact, Conversation, Draft, ListScope } from '@/mail/db'
import { deleteMailStore, mailCopyName, openMailStore } from '@/mail/store'
import type { ClosedElsewhere } from '@/mail/db'
import { forTheDesktop, mailNotifications, overdueNotifications } from '@/mail/mailNotifications'
import { notifier } from '@/platform/notifier'
import { useAuthStore } from '@/stores/auth'

const PAGE_SIZE = 500

const LIST_STEP = 100

const UNIFIED_INBOX: ListScope = { kind: 'inbox', mailAccountId: null }

export type SyncState = 'idle' | 'syncing' | 'error'

/**
 * The signed-in user's mail: a local IndexedDB copy kept current through the delta endpoint, with realtime
 * notifications from the hub triggering pulls. Screens read from the local copy only.
 */
export const useMailStore = defineStore('mail', () => {
  const auth = useAuthStore()

  const accounts = ref<SyncedMailAccount[]>([])
  /** Every folder of every account, kept with the rest, so screens know folder roles without waiting. */
  const allFolders = ref<SyncedFolder[]>([])
  const signatures = ref<SyncedSignature[]>([])
  const conversations = ref<Conversation[]>([])
  /** Which list `conversations` is: it changes in the same tick as the rows, so the screen can tell a new list from a changed one. */
  const listKey = ref('')
  const unreadCounts = ref<Map<string, number>>(new Map())
  /** Outgoing mail that is scheduled, on its way or failed. */
  const outbox = ref<SyncedOutgoingMessage[]>([])
  /** null: the Unified Inbox; otherwise one account's inbox. Ignored while a smart inbox or the batches are on screen. */
  const mailbox = ref<string | null>(null)
  /** The smart inbox on screen, or null for an inbox (see `mailbox`). */
  const smartInbox = ref<string | null>(null)
  /** Whether the batches are on screen: what the batches delivered that is still in an inbox. */
  const batches = ref(false)
  const smartInboxes = ref<SyncedSmartInbox[]>([])
  /** Threads with unread mail per smart inbox. */
  const smartInboxCounts = ref<Map<string, number>>(new Map())
  /** Every todo, open ones first in the user's order (see compareTodos). */
  const todos = ref<SyncedTodo[]>([])
  /** Every hand-over, in "Waiting on" order. */
  const handOvers = ref<SyncedHandOver[]>([])
  /** Overdue notices the server delivered, not yet taken by the screens (see takeOverdue). */
  const overdue = ref<SyncedHandOver[]>([])
  /** The daily briefs, newest first, and the newest one with its conversations as they are now. */
  const dailyBriefs = ref<SyncedDailyBrief[]>([])
  const latestBrief = ref<BriefView | null>(null)
  /** The user's unsubscribe requests, of every account. */
  const unsubscriptions = ref<SyncedUnsubscription[]>([])
  const scope = computed<ListScope>(() => {
    if (batches.value) {
      return { kind: 'batch' }
    }

    return smartInbox.value === null ? { kind: 'inbox', mailAccountId: mailbox.value } : { kind: 'smartInbox', smartInboxId: smartInbox.value }
  })
  const calendars = ref<SyncedCalendar[]>([])
  /** Raised whenever the copy's calendars or events changed, so the calendar views expand again only then. */
  const calendarRevision = ref(0)
  const listLimit = ref(LIST_STEP)
  const hasMore = ref(false)
  const syncState = ref<SyncState>('idle')
  const syncError = ref<string | null>(null)
  /**
   * Another tab upgraded the copy to a newer Tresso: this tab's code cannot open it, so it says to reload. Null while
   * nothing of the kind happened.
   */
  const updatedElsewhere = ref<string | null>(null)
  const live = ref(false)
  const ready = ref(false)
  /**
   * Pulls of the delta that completed: a conversation opened from a notification waits for one after it opened
   * before it says the conversation is not there (it may not have reached the copy yet).
   */
  const pulls = ref(0)

  /**
   * The first pull after opening the copy is over (done, or failed while offline): from then on the copy holds what
   * the server had, not only what was stored before. Screens that decide over all mail (triage) wait for it.
   */
  const synced = ref(false)

  const db = shallowRef<MailStore | null>(null)
  let userId: string | null = null
  let engine: SyncEngine | null = null
  let realtime: RealtimeClient | null = null
  /**
   * When notifications were switched on: after the first complete pull, so the mail that was already there (or that
   * arrived while the app was closed) does not pop up all at once. null until then.
   */
  let notifyingSince: number | null = null
  /** Mail notifications the server delivered, from the pages applied since they were last shown. */
  let delivered: SyncedMailNotification[] = []
  /** The mail notifications shown in this session, so a page that brings one again never shows it twice. */
  const shown = new Set<string>()
  /** Hand-overs from the pages applied since their overdue notices were last looked at. */
  let deliveredHandOvers: SyncedHandOver[] = []
  /** The overdue notices shown in this session (see noticeKey). */
  const shownNotices = new Set<string>()
  /**
   * Raised by every start and stop. A start overtaken while it waited (by a stop, or by another start) gives up, so it
   * never overwrites a newer session's state; the copy it opened is closed again.
   */
  let generation = 0
  /** Opens of a copy under way, with the close of one that was overtaken; removing a copy waits for them. */
  const openings = new Set<Promise<void>>()

  async function start(forUserId: string): Promise<void> {
    if (userId === forUserId) {
      return
    }
    // Claimed before anything is awaited, so a sign-out (or another start) while the old copy closes overtakes it.
    const mine = ++generation
    await teardown()
    if (mine !== generation) {
      return
    }
    userId = forUserId
    let opened!: () => void
    const opening = new Promise<void>((resolve) => {
      opened = resolve
    })
    openings.add(opening)
    let database: MailStore
    try {
      database = await openMailStore(forUserId, (reason) => void closedElsewhere(mine, forUserId, reason))
      if (mine !== generation) {
        await database.close()
        return
      }
      db.value = database
    } catch (error) {
      if (mine !== generation) {
        // Overtaken anyway (a sign-out, another user): its failure is no longer anyone's concern.
        return
      }
      throw error
    } finally {
      openings.delete(opening)
      opened()
    }
    await refresh()
    if (mine !== generation) {
      return
    }
    ready.value = true

    engine = new SyncEngine({
      store: database,
      pageSize: PAGE_SIZE,
      fetchPage: (since, limit) => auth.api<ChangePage>(`/api/v1/sync/changes?since=${since}&limit=${limit}`),
      onApplied: (page) => {
        delivered.push(...page.mailNotifications)
        deliveredHandOvers.push(...page.handOvers)
        void refresh()
        void notifyMail()
        void notifyOverdue()
      },
    })
    realtime = new RealtimeClient({
      fetchAccess: () => auth.api<RealtimeAccess>('/api/v1/realtime/token'),
      onCursor: (cursor) => void pull(() => engine?.notify(cursor)),
      onConnected: () => {
        live.value = true
        void pull(() => engine?.sync())
      },
      onError: () => {
        live.value = false
      },
    })
    await pull(() => engine?.sync())
    if (mine !== generation) {
      return
    }
    await refresh()
    synced.value = true
    void uploadPendingDrafts()
    realtime.start()
  }

  async function pull(run: () => Promise<void> | undefined): Promise<void> {
    syncState.value = 'syncing'
    try {
      await run()
      syncState.value = 'idle'
      syncError.value = null
      pulls.value += 1
      if (notifyingSince === null) {
        delivered = []
        deliveredHandOvers = []
        notifyingSince = Date.now()
      }
    } catch (error) {
      if (error instanceof CopyClosingError) {
        // A page that arrived while the copy closed (a sign-out or another user): nothing is wrong.
        syncState.value = 'idle'
        return
      }
      syncState.value = 'error'
      syncError.value = error instanceof Error ? error.message : String(error)
    }
  }

  /** Pulls changes now, e.g. right after a write or when the user asks, instead of waiting for realtime. */
  async function syncNow(): Promise<void> {
    await pull(() => engine?.sync())
    await refresh()
  }

  /**
   * Shows the mail notifications the server delivered to the desktop, unless the user is looking at Tresso already.
   * The server decided they are due (a new message judged `do` or `delegate`, unread in an inbox, outside a hold); the
   * phone and browsers got the same ones by push.
   */
  async function notifyMail(): Promise<void> {
    if (notifyingSince === null) {
      return
    }
    const due = forTheDesktop(delivered, notifyingSince, shown)
    delivered = []
    if (due.length === 0 || notifier === null || document.hasFocus()) {
      return
    }
    due.forEach((notification) => shown.add(notification.id))
    try {
      await notifier.show(mailNotifications(due))
    } catch (error) {
      console.error('Showing a notification failed', error)
    }
  }

  /**
   * Tells the user about hand-overs whose due date passed without a reply, as the server delivered them (it decided
   * when and how: channels, focus holds, quiet hours): in the app (see takeOverdue), and natively the ones sent to the
   * desktop, unless the user is looking at Tresso already. Each round is shown once.
   */
  async function notifyOverdue(): Promise<void> {
    if (notifyingSince === null) {
      return
    }
    const due = deliveredNotices(deliveredHandOvers, notifyingSince, shownNotices)
    deliveredHandOvers = []
    if (due.length === 0) {
      return
    }
    due.forEach((handOver) => shownNotices.add(noticeKey(handOver)))
    overdue.value = [...overdue.value, ...due]
    const desktop = due.filter((handOver) => handOver.notifiedChannels.includes('desktop'))
    if (desktop.length === 0 || notifier === null || document.hasFocus()) {
      return
    }
    try {
      await notifier.show(overdueNotifications(desktop))
    } catch (error) {
      console.error('Showing a notification failed', error)
    }
  }

  /** The hand-overs that became overdue since the last call, for the app to tell the user about. */
  function takeOverdue(): SyncedHandOver[] {
    const taken = overdue.value
    overdue.value = []
    return taken
  }

  /**
   * The copy closed under this tab. Upgraded by a newer Tresso in another tab: this tab stops and says to reload.
   * Deleted (a sign-out in another tab) or closed by the browser: this tab opens a fresh copy and syncs it again.
   */
  async function closedElsewhere(opened: number, forUserId: string, reason: ClosedElsewhere): Promise<void> {
    if (opened !== generation) {
      return
    }
    await stop()
    if (reason === 'upgraded') {
      updatedElsewhere.value = 'Tresso was updated in another tab. Reload this tab to keep using it.'
      return
    }
    try {
      await start(forUserId)
    } catch (error) {
      syncState.value = 'error'
      syncError.value = `The mail on this device was removed elsewhere and could not be opened again: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** Stops syncing and closes the copy; a start still under way gives up. */
  async function stop(): Promise<void> {
    generation += 1
    await teardown()
  }

  /** Everything is cleared before the first wait, so a start that runs meanwhile begins from a clean state. */
  async function teardown(): Promise<void> {
    const stopping = realtime
    const database = db.value
    realtime = null
    engine = null
    notifyingSince = null
    delivered = []
    shown.clear()
    deliveredHandOvers = []
    shownNotices.clear()
    db.value = null
    userId = null
    live.value = false
    ready.value = false
    synced.value = false
    accounts.value = []
    allFolders.value = []
    signatures.value = []
    conversations.value = []
    unreadCounts.value = new Map()
    smartInboxes.value = []
    calendars.value = []
    smartInboxCounts.value = new Map()
    todos.value = []
    unsubscriptions.value = []
    handOvers.value = []
    overdue.value = []
    dailyBriefs.value = []
    latestBrief.value = null
    outbox.value = []
    await stopping?.stop()
    await database?.close()
  }

  /** Stops syncing and removes the local copy, so nothing stays behind on a shared computer. */
  async function forget(): Promise<void> {
    const forUserId = userId
    // Named now: by the time the copy is closed, the user may be signed in to another server under the same id.
    const name = forUserId === null ? null : mailCopyName(forUserId)
    await stop()
    // A copy still opening (at launch, say) is closed by its start once it sees it was overtaken; only then can it go.
    await Promise.allSettled(openings)
    if (forUserId !== null && name !== null) {
      await deleteMailStore(forUserId, name)
    }
  }

  async function refresh(): Promise<void> {
    const database = db.value
    if (database === null) {
      return
    }
    const listed = JSON.stringify(scope.value)
    const [nextAccounts, nextFolders, nextSignatures, nextConversations, nextCounts, nextOutbox, nextSmartInboxes, nextSmartCounts, nextTodos, nextUnsubscriptions, nextHandOvers, nextBriefs, nextCalendars] = await Promise.all([
      database.mailAccounts(),
      database.folders(),
      database.signatures(),
      database.list(scope.value, listLimit.value + 1),
      database.unreadInboxCounts(),
      database.outbox(),
      database.smartInboxes(),
      database.unreadSmartInboxCounts(),
      database.todos(),
      database.unsubscriptions(),
      database.handOvers(),
      database.dailyBriefs(),
      database.calendars(),
    ])
    todos.value = nextTodos
    handOvers.value = nextHandOvers
    const newest = nextBriefs[0]
    latestBrief.value = newest === undefined ? null : briefView(newest, await database.conversations(newest.threadIds))
    dailyBriefs.value = nextBriefs
    calendars.value = nextCalendars
    calendarRevision.value = database.calendarChanges()
    smartInboxes.value = nextSmartInboxes
    smartInboxCounts.value = nextSmartCounts
    outbox.value = nextOutbox
    accounts.value = nextAccounts
    allFolders.value = nextFolders
    signatures.value = nextSignatures
    hasMore.value = nextConversations.length > listLimit.value
    conversations.value = nextConversations.slice(0, listLimit.value)
    listKey.value = listed
    unreadCounts.value = nextCounts
    unsubscriptions.value = nextUnsubscriptions
  }

  async function showMailbox(mailAccountId: string | null): Promise<void> {
    if (mailbox.value === mailAccountId && smartInbox.value === null && !batches.value) {
      return
    }
    mailbox.value = mailAccountId
    smartInbox.value = null
    batches.value = false
    listLimit.value = LIST_STEP
    await refresh()
  }

  async function showSmartInbox(smartInboxId: string): Promise<void> {
    if (smartInbox.value === smartInboxId && !batches.value) {
      return
    }
    smartInbox.value = smartInboxId
    mailbox.value = null
    batches.value = false
    listLimit.value = LIST_STEP
    await refresh()
  }

  async function showBatches(): Promise<void> {
    if (batches.value) {
      return
    }
    batches.value = true
    smartInbox.value = null
    mailbox.value = null
    listLimit.value = LIST_STEP
    await refresh()
  }

  /**
   * Puts a conversation where the user says it belongs, with the smart inbox's verdict unless one is given. It shows
   * at once; the server remembers the choice for the sender (not with `remember: false`, which moves only this
   * conversation), and the delta brings its version right after.
   */
  async function classifyThread(threadId: string, smartInboxId: string, verdict?: Verdict, options: { remember?: boolean } = {}): Promise<ThreadClassification> {
    const database = db.value
    const target = smartInboxes.value.find((candidate) => candidate.id === smartInboxId)
    const shown = verdict ?? target?.verdict
    const optimistic = shown === undefined ? null : { smartInboxId, verdict: shown }
    const previous = database !== null && optimistic !== null ? await database.classifyThread(threadId, smartInboxId, optimistic.verdict) : null
    await refresh()

    const request: ThreadClassificationRequest = verdict === undefined ? { smartInboxId } : { smartInboxId, verdict }
    if (options.remember === false) {
      request.remember = false
    }
    try {
      const result = await auth.send<ThreadClassification>('PUT', `/api/v1/threads/${encodeURIComponent(threadId)}/classification`, request)
      void syncNow()
      return result
    } catch (error) {
      if (previous !== null && optimistic !== null && database !== null) {
        // Put back what the server did not confirm; when the request went through after all and only the answer was
        // lost, the pull brings the server's version again.
        await database.restoreThread(previous, optimistic)
        await refresh()
        void syncNow()
      }
      throw error
    }
  }

  /**
   * Takes back the user's placement `placementId` of a conversation: the rules place it again (sender rules stay).
   * 'moved' when it was placed again since (another device), and that choice stays. Shown once the pull that follows
   * brings the server's version, since only the server knows where the rules put it.
   */
  async function releaseThread(threadId: string, placementId: string): Promise<'released' | 'moved'> {
    try {
      await auth.send<void>('DELETE', `/api/v1/threads/${encodeURIComponent(threadId)}/classification?${new URLSearchParams({ placementId }).toString()}`)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        return 'moved'
      }
      throw error
    }
    await syncNow()
    return 'released'
  }

  /** Up to `limit` conversations of the inboxes waiting for triage, newest first. */
  async function triageWaiting(limit: number): Promise<string[]> {
    return (await db.value?.listThreadIds(UNIFIED_INBOX, needsTriage, limit)) ?? []
  }

  /** The newest `limit` conversations of the inboxes. */
  async function newestInInbox(limit: number): Promise<Conversation[]> {
    return (await db.value?.list(UNIFIED_INBOX, limit)) ?? []
  }

  async function summaries(threadIds: string[]): Promise<Conversation[]> {
    return (await db.value?.summaries(threadIds)) ?? []
  }

  async function showMore(): Promise<void> {
    listLimit.value += LIST_STEP
    await refresh()
  }

  /** A brief with its conversations as they are now; null when it is gone. */
  async function dailyBrief(briefId: string): Promise<BriefView | null> {
    const database = db.value
    const brief = dailyBriefs.value.find((candidate) => candidate.id === briefId)
    if (database === null || brief === undefined) {
      return null
    }
    return briefView(brief, await database.conversations(brief.threadIds))
  }

  async function thread(threadId: string): Promise<{ thread: SyncedThread; messages: SyncedMessage[] } | null> {
    return (await db.value?.thread(threadId)) ?? null
  }

  async function todosOfThread(threadId: string): Promise<SyncedTodo[]> {
    return (await db.value?.todosOfThread(threadId)) ?? []
  }

  /** The messages with these ids this device has, e.g. the emails todos link to. */
  async function messages(ids: string[]): Promise<SyncedMessage[]> {
    return ids.length === 0 ? [] : ((await db.value?.messages(ids)) ?? [])
  }

  /** The messages of each of these threads (e.g. the conversations on screen), oldest first per thread. */
  async function threadMessages(threadIds: string[]): Promise<Map<string, SyncedMessage[]>> {
    const loaded = await Promise.all(threadIds.map(async (threadId) => [threadId, (await thread(threadId))?.messages ?? []] as const))

    return new Map(loaded)
  }

  /**
   * Asks the server to unsubscribe from the sender of this message (one-click or by mail). Its answer is stored at
   * once, so the button gives way to "pending" before the delta brings it. Throws when the server refuses, with its
   * reason.
   */
  async function unsubscribe(messageId: string): Promise<Unsubscription> {
    const request: UnsubscribeRequest = { messageId }
    const result = await auth.send<Unsubscription>('POST', '/api/v1/unsubscriptions', request)
    await db.value?.noteUnsubscription(result)
    await refresh()

    return result
  }

  /** Threads in the list on screen from any of these senders (lower-case addresses), loaded in the list or not. */
  async function threadsFrom(addresses: Set<string>): Promise<string[]> {
    return (await db.value?.listThreadIds(scope.value, (c) => c.senders.some((sender) => addresses.has(sender.address.toLowerCase())))) ?? []
  }

  /** Threads in the list on screen whose newest message is older than this moment (epoch ms). */
  async function threadsBefore(moment: number): Promise<string[]> {
    return (await db.value?.listThreadIds(scope.value, (c) => c.lastMessageAt < moment)) ?? []
  }

  /** Which selected threads are still in the list on screen, and their accounts and senders. */
  async function describeThreads(threadIds: string[]): Promise<{ present: string[]; accounts: string[]; senders: string[] }> {
    return (await db.value?.describeThreads(scope.value, threadIds)) ?? { present: [], accounts: [], senders: [] }
  }

  async function messageIdsOf(threadIds: string[]): Promise<string[]> {
    return (await db.value?.messageIdsOfThreads(threadIds)) ?? []
  }

  /** The messages of each thread, to tell which threads an action took completely. */
  async function messagesByThread(threadIds: string[]): Promise<Map<string, string[]>> {
    return (await db.value?.messagesByThread(threadIds)) ?? new Map()
  }

  async function folders(): Promise<SyncedFolder[]> {
    return (await db.value?.folders()) ?? []
  }

  /** A link to a received file that could not be scanned, once the user confirmed they accept that. */
  async function unscannedLink(attachmentId: string): Promise<string> {
    return (await auth.send<{ url: string }>('POST', `/api/v1/attachments/${encodeURIComponent(attachmentId)}/unscanned-link`, { confirmed: true })).url
  }

  function body(messageId: string, allowRemoteContent: boolean): Promise<MessageBody> {
    const query = allowRemoteContent ? '?remoteContent=allow' : ''

    return auth.api<MessageBody>(`/api/v1/messages/${encodeURIComponent(messageId)}/body${query}`)
  }

  /**
   * Reads, flags, archives, trashes or moves messages: the change shows at once and is undone here for the messages
   * the server did not take. Large selections go in batches of {@link MAX_MESSAGES_PER_ACTION}. Returns the messages
   * before and after, to build an undo from.
   */
  async function act(messageIds: string[], action: MessageAction, target: { folderId?: string; fromFolderId?: string } = {}): Promise<AppliedAction> {
    const database = db.value
    if (database === null || messageIds.length === 0) {
      return { before: [], after: [] }
    }
    const applied = await database.applyAction(messageIds, action, target.folderId, target.fromFolderId)
    await refresh()
    let accepted = 0
    try {
      for (let start = 0; start < messageIds.length; start += MAX_MESSAGES_PER_ACTION) {
        const request: MessageActionRequest = { messageIds: messageIds.slice(start, start + MAX_MESSAGES_PER_ACTION), action }
        if (target.folderId !== undefined) {
          request.folderId = target.folderId
        }
        if (target.fromFolderId !== undefined) {
          request.fromFolderId = target.fromFolderId
        }
        await auth.send<MessageActionResult>('POST', '/api/v1/message-actions', request)
        accepted = start + request.messageIds.length
      }
    } catch (error) {
      // Earlier batches went through; only the rest goes back.
      await database.revertAction(appliedFor(applied, new Set(messageIds.slice(accepted))))
      await refresh()
      void syncNow()
      if (accepted > 0) {
        throw new PartialActionError(error, appliedFor(applied, new Set(messageIds.slice(0, accepted))), messageIds.length - accepted)
      }
      throw error
    }
    void syncNow()
    return applied
  }

  function send(request: SendMessageRequest): Promise<SyncedOutgoingMessage> {
    return auth.send<SyncedOutgoingMessage>('POST', '/api/v1/outgoing-messages', request)
  }

  function cancelOutgoing(id: string): Promise<SyncedOutgoingMessage> {
    return auth.send<SyncedOutgoingMessage>('POST', `/api/v1/outgoing-messages/${encodeURIComponent(id)}/cancel`, {})
  }

  async function outgoing(id: string): Promise<SyncedOutgoingMessage | null> {
    return (await db.value?.outgoing(id)) ?? null
  }

  async function suggestContacts(query: string): Promise<Contact[]> {
    return (await db.value?.suggestContacts(query, 8)) ?? []
  }

  /** Saves on this device; the upload follows (see uploadDraft). */
  async function saveDraft(draft: Draft): Promise<void> {
    // Drafts come from reactive state; IndexedDB stores only plain data.
    await db.value?.saveDraft(JSON.parse(JSON.stringify(draft)) as Draft)
  }

  const draftSync = new DraftSync(
    () => db.value,
    {
      create: (id, request) => auth.send<SyncedDraft>('POST', '/api/v1/drafts', { ...request, draftId: id }),
      update: (id, request, expectedVersion) => auth.send<SyncedDraft>('PUT', `/api/v1/drafts/${encodeURIComponent(id)}`, { ...request, expectedVersion }),
      get: (id) => auth.api<SyncedDraft & { attachments: DraftAttachmentLink[] }>(`/api/v1/drafts/${encodeURIComponent(id)}`),
      remove: (id) => auth.send<void>('DELETE', `/api/v1/drafts/${encodeURIComponent(id)}`),
      attach: (id, file) => {
        // The browser sets the multipart boundary itself.
        const form = new FormData()
        form.append('file', file.body as Blob, file.name)
        return auth.api<DraftAttachmentLink>(`/api/v1/drafts/${encodeURIComponent(id)}/attachments`, { method: 'POST', body: form })
      },
      forward: (id, attachmentId) => auth.send<DraftAttachmentLink>('POST', `/api/v1/drafts/${encodeURIComponent(id)}/forwarded-attachments`, { attachmentId }),
      detach: (id, attachmentId) => auth.send<{ draftVersion: number }>('DELETE', `/api/v1/drafts/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`),
      unscannedLink: (attachmentId) => auth.send<{ url: string }>('POST', `/api/v1/draft-attachments/${encodeURIComponent(attachmentId)}/unscanned-link`, { confirmed: true }),
    },
    () => void refresh(),
  )

  /** The open copy, for the composer; null while nobody is signed in. */
  function currentStore(): MailStore | null {
    return db.value
  }

  /** Brings the draft's unsaved edits to the server (see DraftSync.upload). */
  function uploadDraft(id: string): Promise<void> {
    return draftSync.upload(id)
  }

  /** Uploads every draft with edits that did not reach the server yet, e.g. after starting offline. */
  function uploadPendingDrafts(): Promise<void> {
    return draftSync.uploadPending()
  }

  /** Settles a conflict: keep the edits made here (they overwrite the other version) or take the other version. */
  function resolveDraftConflict(id: string, keep: 'mine' | 'theirs'): Promise<Draft | null> {
    return draftSync.resolveConflict(id, keep)
  }

  /** Removes the draft here and on the server, and with it its copy in the Drafts folder. */
  function deleteDraftEverywhere(id: string): Promise<void> {
    return draftSync.deleteEverywhere(id)
  }

  async function drafts(): Promise<Draft[]> {
    return (await db.value?.drafts()) ?? []
  }

  async function draft(id: string): Promise<Draft | null> {
    return (await db.value?.draft(id)) ?? null
  }

  async function deleteDraft(id: string): Promise<void> {
    await db.value?.deleteDraft(id)
  }

  watch(
    () => auth.isAuthenticated,
    (authenticated) => {
      if (!authenticated) {
        void forget()
      }
    },
  )

  return {
    accounts,
    listKey,
    allFolders,
    signatures,
    conversations,
    unreadCounts,
    outbox,
    mailbox,
    smartInbox,
    batches,
    smartInboxes,
    smartInboxCounts,
    todos,
    unsubscriptions,
    handOvers,
    overdue,
    takeOverdue,
    dailyBriefs,
    latestBrief,
    calendars,
    calendarRevision,
    hasMore,
    syncState,
    pulls,
    syncError,
    updatedElsewhere,
    live,
    ready,
    synced,
    start,
    stop,
    syncNow,
    act,
    forget,
    refresh,
    showMailbox,
    showSmartInbox,
    showBatches,
    classifyThread,
    releaseThread,
    triageWaiting,
    newestInInbox,
    summaries,
    showMore,
    thread,
    todosOfThread,
    messages,
    threadMessages,
    unsubscribe,
    dailyBrief,
    threadsFrom,
    threadsBefore,
    describeThreads,
    messageIdsOf,
    messagesByThread,
    folders,
    body,
    unscannedLink,
    send,
    cancelOutgoing,
    outgoing,
    suggestContacts,
    saveDraft,
    drafts,
    draft,
    deleteDraft,
    uploadDraft,
    draftSync,
    currentStore,
    uploadPendingDrafts,
    resolveDraftConflict,
    deleteDraftEverywhere,
  }
})
