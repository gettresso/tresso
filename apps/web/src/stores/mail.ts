import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import {
  backfillChats,
  RealtimeClient,
  SyncEngine,
  SyncStatusMachine,
  type SyncStatus,
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
import { copiesOnDevice, deleteMailStore, mailCopyName, openMailStore } from '@/mail/store'
import { forgetCopy, keptCopies, listFoundCopies, markForRemoval, rememberCopy } from '@/mail/copies'
import type { ClosedElsewhere } from '@/mail/db'
import { forTheDesktop, mailNotifications, overdueNotifications } from '@/mail/mailNotifications'
import { notifier } from '@/platform/notifier'
import { useAuthStore } from '@/stores/auth'

const PAGE_SIZE = 500

const LIST_STEP = 100

/** Why nothing is sent for a copy whose user the server has not confirmed yet. */
export const STILL_CHECKING = 'Tresso is still checking who is signed in. Try again once it is connected.'

/** How long the draft on screen gets to be written into a kept copy before it closes at the end of a session. */
export const KEPT_SAVE_LIMIT_MS = 3_000

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
   * What the footer (and the notice above the lists) says about the sync, from the shared status model: opening,
   * read only, getting the mail, catching up, up to date, reconnecting, offline, stopped.
   */
  const syncStatus = shallowRef<SyncStatus>({ kind: 'closed', text: '', fraction: null, remaining: null, notice: null, problem: null, announcement: '' })
  const status = new SyncStatusMachine({
    onChange: (next) => {
      syncStatus.value = next
    },
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
  })
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
  /**
   * The user of the last confirmed start, kept apart from the claim (`userId`): a start whose open or first read failed
   * gives the claim back so it can be tried again, but a sign-out must still remove that user's copy. A copy only
   * opened unconfirmed is noted apart (`openedUnconfirmed`).
   */
  let lastUser: string | null = null
  /**
   * The user of a copy opened unconfirmed: the id came from the same stored entry as the tokens, so a sign-out before
   * the server answered removes that copy too. Cleared once a confirmed start takes over.
   */
  let openedUnconfirmed: string | null = null
  let engine: SyncEngine | null = null
  let realtime: RealtimeClient | null = null
  // A pull that failed and waits to be tried again goes at once when the network may be back.
  window.addEventListener('online', () => {
    status.online(true)
    engine?.wake()
  })
  window.addEventListener('offline', () => status.online(false))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      engine?.wake()
    }
  })
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
  /** The open and first read of the copy claimed now, settled either way; a confirmed start of the same user waits for it. */
  let openPhase: Promise<void> = Promise.resolve()
  /** The open copy is kept current (its user was confirmed): pulls, uploads and the realtime stream run. */
  let syncing = false
  /**
   * The mail of a user who signed out could not be removed from this device (the desktop refuses while a read still
   * uses the copy, the browser's storage failed). The sign-in screen says so; the copy is marked and removed at the
   * next start. Null when nothing was left behind.
   */
  const removalError = ref<string | null>(null)
  /**
   * What has to be written into the copy before it closes when a session ends without a sign-out (expired, or ended
   * in another tab): the draft on screen, so typing since the last autosave is kept with the copy.
   */
  const beforeKeptClose = new Set<{ write: () => Promise<void>; letGo: () => void }>()
  /** The close of a kept copy under way (closeKept); a start waits for it, so none meets the copy half closed. */
  let closingKept: Promise<void> | null = null

  /**
   * Opens the user's copy and, once the server confirmed the user, keeps it current. A start that is not `confirmed`
   * (the user the tokens were last confirmed for, before `/me` answered in this page load) only opens and reads the
   * copy: no pull, no upload, no realtime stream, no message sent. A sign-out meanwhile removes it, as it does a
   * confirmed one: the id belongs to the tokens being signed out. Starting the same user again with `confirmed` then
   * begins the sync on the copy already open.
   */
  async function start(forUserId: string, options: { confirmed?: boolean } = {}): Promise<void> {
    const confirmed = options.confirmed !== false
    if (closingKept !== null) {
      // The previous session's copy is still taking its last draft: it closes first, then this start opens it (or
      // another user's) afresh. A sign-out meanwhile ended the session this start was for.
      await closingKept
      if (!auth.isAuthenticated) {
        return
      }
    }
    if (userId === forUserId) {
      if (!confirmed || syncing) {
        return
      }
      // The copy of this user is open (or opening) unconfirmed: once it is, the sync begins on it.
      const mine = generation
      await openPhase
      if (mine === generation && userId === forUserId && db.value !== null && !syncing) {
        lastUser = forUserId
        openedUnconfirmed = null
        await beginSync(mine, db.value)
      }
      return
    }
    // Claimed before anything is awaited, so a sign-out (or another start) while the old copy closes overtakes it.
    const mine = ++generation
    if (confirmed) {
      lastUser = forUserId
      openedUnconfirmed = null
    } else {
      openedUnconfirmed = forUserId
    }
    await teardown()
    if (mine !== generation) {
      return
    }
    userId = forUserId
    const phase = openAndRead(mine, forUserId, confirmed)
    openPhase = phase.then(
      () => undefined,
      () => undefined,
    )
    const database = await phase
    if (database === null || !confirmed) {
      return
    }
    await beginSync(mine, database)
  }

  /** Opens the copy and reads it onto the screens; null when a sign-out or another start overtook it meanwhile. */
  async function openAndRead(mine: number, forUserId: string, confirmed: boolean): Promise<MailStore | null> {
    let opened!: () => void
    const opening = new Promise<void>((resolve) => {
      opened = resolve
    })
    openings.add(opening)
    status.opening()
    let database: MailStore
    try {
      database = await openMailStore(forUserId, (reason) => void closedElsewhere(mine, forUserId, reason, confirmed))
      if (mine !== generation) {
        await database.close()
        return null
      }
      db.value = database
      rememberCopy({ userId: forUserId, name: mailCopyName(forUserId) })
    } catch (error) {
      if (mine !== generation) {
        // Overtaken anyway (a sign-out, another user): its failure is no longer anyone's concern.
        return null
      }
      // Not claimed after all, so starting the same user again (the app retries) opens the copy anew.
      userId = null
      status.closed()
      throw error
    } finally {
      openings.delete(opening)
      opened()
    }
    let syncedAt: number | null
    try {
      await refresh()
      syncedAt = await database.syncedAt()
    } catch (error) {
      if (mine === generation) {
        // Reading the copy failed: close it again, so a retry of the same user starts from the beginning.
        await stop()
      }
      throw error
    }
    if (mine !== generation) {
      return null
    }
    ready.value = true
    status.opened({ confirmed, afterUpdate: database.afterUpdate, lastSyncedAt: syncedAt })
    return database
  }

  /**
   * Keeps the open copy current: the first pull, pending drafts, and the realtime stream for what comes next. The
   * stream opens together with the first pull, not after it: it only carries cursors, which make the engine pull again
   * once the pull under way is done (pulls never overlap, and a notification during one makes it go round once more),
   * so nothing is lost or stored twice, and the status can say "Up to date" the moment the pull is.
   */
  async function beginSync(mine: number, database: MailStore): Promise<void> {
    syncing = true
    status.confirmed()
    // Before the first pull, a copy updated to keep chats checks once whether it must fetch them from the start.
    await backfillChats(database, () => auth.api<unknown[]>('/api/v1/chat-accounts')).catch((error: unknown) => {
      if (mine === generation) {
        console.error('Checking the server for chats failed; the next start asks again', error)
      }
    })
    if (mine !== generation) {
      return
    }
    const current = new SyncEngine({
      store: database,
      pageSize: PAGE_SIZE,
      fetchPage: (since, limit) => auth.api<ChangePage>(`/api/v1/sync/changes?since=${since}&limit=${limit}`),
      // A failed pull is tried again by the engine, shown as any other pull ("Sync stopped" until one works).
      retry: (run) => void pull(run),
      onProgress: (progress) => {
        if (engine === current) {
          status.progress(progress)
        }
      },
      onApplied: (page) => {
        delivered.push(...page.mailNotifications)
        deliveredHandOvers.push(...page.handOvers)
        void refresh()
        void notifyMail()
        void notifyOverdue()
      },
    })
    engine = current
    const stream = new RealtimeClient({
      // Aborted when the stream stops, so a sign-out does not wait for a token request that hangs.
      fetchAccess: (signal) => auth.api<RealtimeAccess>('/api/v1/realtime/token', { signal }),
      now: () => auth.serverNow(),
      onCursor: (cursor) => {
        if (realtime === stream) {
          void pull(() => engine?.notify(cursor))
        }
      },
      onConnecting: () => {
        if (realtime === stream) {
          status.streamConnecting()
        }
      },
      onConnected: () => {
        if (realtime !== stream) {
          return
        }
        live.value = true
        status.streamLive()
        // Back online: drafts whose upload failed meanwhile go up after the pull, not only at the next start.
        void pull(() => engine?.sync(), { uploadDrafts: true })
      },
      onError: () => {
        if (realtime !== stream) {
          return
        }
        live.value = false
        status.streamRetrying()
      },
    })
    realtime = stream
    stream.start()
    await pull(() => engine?.sync())
    if (mine !== generation) {
      return
    }
    await refresh()
    synced.value = true
    void uploadPendingDrafts()
  }

  /**
   * Runs a pull of the delta. Once it worked, drafts whose upload failed go up when asked (`uploadDrafts`, after a
   * reconnect) or when the pull before had failed: the server is reachable again.
   */
  async function pull(run: () => Promise<unknown> | undefined, options: { uploadDrafts?: boolean } = {}): Promise<void> {
    const before = syncState.value
    const failedBefore = before === 'error'
    const mine = generation
    syncState.value = 'syncing'
    try {
      // A notification at or below the stored cursor pulls nothing (`false`): that proves nothing, so a failure stays
      // and the copy is not noted as synced.
      if ((await run()) === false) {
        syncState.value = before
        return
      }
      syncState.value = 'idle'
      syncError.value = null
      if (mine === generation) {
        status.synced()
      }
      pulls.value += 1
      if (failedBefore || options.uploadDrafts === true) {
        void uploadPendingDrafts()
      }
      if (notifyingSince === null) {
        delivered = []
        deliveredHandOvers = []
        notifyingSince = Date.now()
      }
    } catch (error) {
      if (error instanceof CopyClosingError) {
        // A page that arrived while the copy closed (a sign-out or another user): nothing is wrong.
        syncState.value = 'idle'
        if (mine === generation) {
          status.cleared()
        }
        return
      }
      syncState.value = 'error'
      syncError.value = error instanceof Error ? error.message : String(error)
      if (mine === generation) {
        status.failed(syncError.value)
      }
    }
  }

  /** Pulls changes now, e.g. right after a write or when the user asks, instead of waiting for realtime. */
  async function syncNow(): Promise<void> {
    // No copy is syncing yet (it is still opening, say): its own start pulls, and a pull of nothing proves nothing.
    if (engine === null) {
      return
    }
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
  async function closedElsewhere(opened: number, forUserId: string, reason: ClosedElsewhere, confirmed: boolean): Promise<void> {
    if (opened !== generation) {
      return
    }
    await stop()
    if (!auth.isAuthenticated || auth.followSignOutElsewhere()) {
      // Removed by a sign-out in another tab (whose storage event may not have arrived yet): this tab follows that
      // sign-out, it does not start a new copy.
      return
    }
    if (reason === 'upgraded') {
      updatedElsewhere.value = 'Tresso was updated in another tab. Reload this tab to keep using it.'
      return
    }
    try {
      // Opened again as it was: kept current only when its user was confirmed (or has been since).
      await start(forUserId, { confirmed: confirmed || lastUser === forUserId })
    } catch (error) {
      syncState.value = 'error'
      syncError.value = `The mail on this device was removed elsewhere and could not be opened again: ${error instanceof Error ? error.message : String(error)}`
      // The banner says it, from the status as every other failure.
      status.openFailed(syncError.value)
    }
  }

  /** Stops syncing and closes the copy; a start still under way gives up. */
  /** `closeWaitMs` bounds how long the close waits for writes and reads under way (see MailStore.close). */
  async function stop(options: { closeWaitMs?: number } = {}): Promise<void> {
    generation += 1
    await teardown(options)
  }

  /** Everything is cleared before the first wait, so a start that runs meanwhile begins from a clean state. */
  async function teardown(options: { closeWaitMs?: number } = {}): Promise<void> {
    const stopping = realtime
    const database = db.value
    realtime = null
    engine?.stop()
    engine = null
    notifyingSince = null
    delivered = []
    shown.clear()
    deliveredHandOvers = []
    shownNotices.clear()
    db.value = null
    userId = null
    live.value = false
    status.closed()
    ready.value = false
    synced.value = false
    syncing = false
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
    await database?.close(options.closeWaitMs === undefined ? undefined : { waitMs: options.closeWaitMs })
  }

  /** Stops syncing and removes the local copy, so nothing stays behind on a shared computer. */
  async function forget(): Promise<void> {
    // The copy of the user the server confirmed, also when its start failed to open or read it (see lastUser), or else
    // the copy opened before the server answered, whose id came with the tokens being signed out.
    const forUserId = lastUser ?? openedUnconfirmed
    lastUser = null
    openedUnconfirmed = null
    // Named now: by the time the copy is closed, the user may be signed in to another server under the same id.
    const name = forUserId === null ? null : mailCopyName(forUserId)
    await stop()
    // A copy still opening (at launch, say) is closed by its start once it sees it was overtaken; only then can it go.
    await Promise.allSettled(openings)
    if (forUserId !== null && name !== null) {
      try {
        await deleteMailStore(forUserId, name)
      } catch (error) {
        // Left on the device: marked, so the next start removes it, and said on the sign-in screen.
        markForRemoval({ userId: forUserId, name })
        removalError.value = leftBehind(error)
        throw error
      }
      forgetCopy(name)
      removalError.value = null
    }
  }

  function leftBehind(error: unknown): string {
    return `Your mail could not be removed from this device (${error instanceof Error ? error.message : String(error)}). Tresso removes it the next time it starts.`
  }

  /**
   * At the start of the signed-out app: removes the copies whose removal failed when their user signed out. Copies
   * kept on purpose (an expired session) stay. One that still cannot go stays marked and is said again.
   */
  async function removeLeftCopies(): Promise<void> {
    let failure: unknown = null
    const stillMarked = (name: string) => keptCopies().some((kept) => kept.name === name && kept.remove === true)
    for (const copy of keptCopies().filter((kept) => kept.remove === true)) {
      // Looked at again before each removal: its user may have signed in meanwhile and opened it (which unmarks it).
      if (!stillMarked(copy.name) || (userId !== null && mailCopyName(userId) === copy.name)) {
        continue
      }
      try {
        await deleteMailStore(copy.userId, copy.name)
        // Only the mark goes: an entry its user wrote again meanwhile (rememberCopy) is theirs.
        if (stillMarked(copy.name)) {
          forgetCopy(copy.name)
        }
      } catch (error) {
        console.error('Removing the mail a signed-out user left on this device failed', error)
        failure = error
      }
    }
    removalError.value = failure === null ? null : leftBehind(failure)
  }

  /** Lists the copies on this device that the list does not know yet (left by an earlier release), except the user's own. */
  async function listUnknownCopies(confirmedUserId: string): Promise<void> {
    try {
      listFoundCopies((await copiesOnDevice()).filter((copy) => copy.userId !== confirmedUserId))
    } catch (error) {
      // Only copies of an earlier release are missed; the next start looks again.
      console.error('Looking for mail copies on this device failed', error)
    }
  }

  /**
   * Removes the copies other users left here when their session expired: once someone else signs in, they are no
   * longer theirs to come back to. Only for a user the server confirmed (/me), never for an id remembered from before:
   * a stale id would otherwise remove the copy, and the unsent drafts, of the user who is signed in. The copy open now
   * stays too; it is removed once it is closed, at a later call. A copy that cannot be removed now stays listed and is
   * tried again the next time.
   */
  async function removeOtherUsersCopies(confirmedUserId: string): Promise<void> {
    await listUnknownCopies(confirmedUserId)
    const keep = mailCopyName(confirmedUserId)
    const open = userId === null ? null : mailCopyName(userId)
    for (const copy of keptCopies()) {
      if (copy.name === keep || copy.name === open) {
        continue
      }
      try {
        await deleteMailStore(copy.userId, copy.name)
        forgetCopy(copy.name)
      } catch (error) {
        console.error('Removing the mail copy another user left on this device failed', error)
      }
    }
    // What a sign-out left behind is gone now, or no longer the signed-in user's concern.
    removalError.value = null
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
        await database.restoreThread(previous)
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
        database.acceptAction(appliedFor(applied, new Set(request.messageIds)))
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
    return confirmedOnly(() => auth.send<SyncedOutgoingMessage>('POST', '/api/v1/outgoing-messages', request))
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

  /**
   * Runs a request that writes for the user of the open copy, once the server confirmed that user in this page load;
   * until then it fails as if the server could not be reached.
   */
  function confirmedOnly<T>(request: () => Promise<T>): Promise<T> {
    return syncing ? request() : Promise.reject(new Error(STILL_CHECKING))
  }

  // Drafts are kept in the copy as always, but reach the server only once its user was confirmed: until then every
  // request fails as if offline, which every caller already handles (kept with pendingSave, said when it matters).
  const draftSync = new DraftSync(
    () => db.value,
    {
      create: (id, request) => confirmedOnly(() => auth.send<SyncedDraft>('POST', '/api/v1/drafts', { ...request, draftId: id })),
      update: (id, request, expectedVersion) => confirmedOnly(() => auth.send<SyncedDraft>('PUT', `/api/v1/drafts/${encodeURIComponent(id)}`, { ...request, expectedVersion })),
      get: (id) => confirmedOnly(() => auth.api<SyncedDraft & { attachments: DraftAttachmentLink[] }>(`/api/v1/drafts/${encodeURIComponent(id)}`)),
      remove: (id) => confirmedOnly(() => auth.send<void>('DELETE', `/api/v1/drafts/${encodeURIComponent(id)}`)),
      attach: (id, file) =>
        confirmedOnly(() => {
          // The browser sets the multipart boundary itself.
          const form = new FormData()
          form.append('file', file.body as Blob, file.name)
          return auth.api<DraftAttachmentLink>(`/api/v1/drafts/${encodeURIComponent(id)}/attachments`, { method: 'POST', body: form })
        }),
      forward: (id, attachmentId) => confirmedOnly(() => auth.send<DraftAttachmentLink>('POST', `/api/v1/drafts/${encodeURIComponent(id)}/forwarded-attachments`, { attachmentId })),
      detach: (id, attachmentId) => confirmedOnly(() => auth.send<{ draftVersion: number }>('DELETE', `/api/v1/drafts/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`)),
      unscannedLink: (attachmentId) => confirmedOnly(() => auth.send<{ url: string }>('POST', `/api/v1/draft-attachments/${encodeURIComponent(attachmentId)}/unscanned-link`, { confirmed: true })),
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

  /**
   * Drafts with edits that never reached the server (written offline, say) in the copy a sign-out would delete. When
   * that copy is not open (its start could not open or read it, another tab upgraded it, it is still opening), it is
   * opened to look, so the question is asked whenever drafts would be lost. Throws when it cannot be read.
   */
  async function unsavedDrafts(): Promise<Draft[]> {
    // A copy still opening is either open afterwards or closed again by its start.
    await Promise.allSettled(openings)
    const pending = (all: Draft[]) => all.filter((draft) => draft.pendingSave)
    const database = db.value
    if (database !== null) {
      return pending(await database.drafts())
    }
    const forUserId = lastUser ?? openedUnconfirmed
    if (forUserId === null) {
      return []
    }
    const copy = await openMailStore(forUserId)
    try {
      return pending(await copy.drafts())
    } finally {
      await copy.close()
    }
  }

  /**
   * Tries to bring the drafts that never reached the server up, for at most `ms`; the upload goes on after that, its
   * outcome no longer awaited. Returns the drafts still not on the server.
   */
  async function saveUnsavedDrafts(ms: number): Promise<Draft[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    })
    try {
      await Promise.race([uploadPendingDrafts().catch(() => undefined), late])
    } finally {
      clearTimeout(timer)
    }
    return unsavedDrafts()
  }

  async function draft(id: string): Promise<Draft | null> {
    return (await db.value?.draft(id)) ?? null
  }

  async function deleteDraft(id: string): Promise<void> {
    await db.value?.deleteDraft(id)
  }

  /**
   * Registers what is written into the copy before it closes at the end of a session that keeps it (expired, or
   * ended in another tab), and what lets go of it on screen: `letGo` runs once the write is done or its time is up,
   * before the copy closes, so nothing of the session that ended can reach the next one's copy. Returns the function
   * that removes both again.
   */
  function beforeKeptCopyCloses(write: () => Promise<void>, letGo: () => void): () => void {
    const hook = { write, letGo }
    beforeKeptClose.add(hook)
    return () => beforeKeptClose.delete(hook)
  }

  /**
   * A session ended without a sign-out: what is still being written goes into the copy first, while it is open, and
   * then it closes. The writes get {@link KEPT_SAVE_LIMIT_MS}, and so does the close itself; a write that does not
   * settle by then (storage that hangs) does not keep the copy open, and what was on screen is let go either way. The users of this session are no longer the ones a later sign-out removes the
   * copy of: that is whoever starts next (a sign-out before the next start must not remove this copy for someone else).
   */
  function closeKept(): Promise<void> {
    const closing = (async () => {
      lastUser = null
      openedUnconfirmed = null
      // No pull starts while the draft is written: the session is over.
      engine?.stop()
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), KEPT_SAVE_LIMIT_MS)
      })
      const hooks = [...beforeKeptClose]
      const writes = Promise.allSettled(hooks.map(async (hook) => hook.write())).then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error('Saving what was being written before the mail copy closed failed', result.reason)
          }
        }
        return 'done' as const
      })
      try {
        if ((await Promise.race([writes, late])) === 'late') {
          console.error(`Saving what was being written did not finish within ${KEPT_SAVE_LIMIT_MS / 1000} seconds; the mail copy closes anyway`)
        }
      } finally {
        clearTimeout(timer)
        // Done or not: what is on screen goes now, so a write that is still under way cannot carry it into the copy
        // of whoever starts next.
        for (const hook of hooks) {
          try {
            hook.letGo()
          } catch (error) {
            console.error('Letting go of what was being written failed', error)
          }
        }
      }
      // The close is bounded too: on the desktop it waits for the writes under way, which may never answer.
      await stop({ closeWaitMs: KEPT_SAVE_LIMIT_MS })
    })()
    const settled = closing.finally(() => {
      if (closingKept === settled) {
        closingKept = null
      }
    })
    closingKept = settled
    return settled
  }

  // Only the user's own sign-out removes the copy. A session that expired, or that ended in another tab (which removes
  // the copy itself when the user signed out there), only closes it: it may hold drafts that never reached the server,
  // and they upload when the same user signs in again.
  auth.onSessionEnd((reason) => (reason === 'signedOut' ? forget() : closeKept()))

  return {
    removeOtherUsersCopies,
    removeLeftCopies,
    removalError,
    beforeKeptCopyCloses,
    unsavedDrafts,
    saveUnsavedDrafts,
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
    syncStatus,
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
