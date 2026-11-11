import { deleteDB, openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb'
import {
  actionResult,
  CopyClosingError,
  classifiedByUser,
  compareTodos,
  compareHandOvers,
  compareBriefs,
  contactMatches,
  deletedDraft,
  inList,
  listFolders,
  mergeContact,
  newerUnsubscription,
  OpenClassifications,
  peopleOn,
  OpenActions,
  eventSpan,
  sortCalendars,
  touchesCalendars,
  sortSmartInboxes,
  storedDraft,
  summarizeConversation,
  syncedDraft,
  type AppliedAction,
  type ChangePage,
  type Contact,
  type ConversationSummary,
  type Draft,
  type ListFolders,
  type ListScope,
  type MailStore,
  type SyncedHandOver,
  type MessageAction,
  type SyncedCalendar,
  type SyncedCalendarEvent,
  type SyncedFolder,
  type SyncedMailAccount,
  type SyncedMessage,
  type SyncedOutgoingMessage,
  type SyncedSignature,
  type SyncedDailyBrief,
  type SyncedDraft,
  type SyncedSmartInbox,
  type SyncedThread,
  type SyncedTodo,
  type SyncedUnsubscription,
  type Verdict,
} from '@tresso/core'

export type { Contact, Draft, ListScope } from '@tresso/core'

/** What a thread looks like in a mailbox list. */
export type Conversation = ConversationSummary

/**
 * A conversation as IndexedDB keeps it: booleans and null cannot be index keys, so the list flags are numbers and a
 * missing smart inbox is '', which the lists read through indexes and so stay fast however much mail is stored.
 */
interface StoredConversation extends Omit<ConversationSummary, 'inbox' | 'active' | 'smartInboxId' | 'batchedAt'> {
  /** 1 when the inboxes list the thread (see ConversationSummary.inbox). */
  inbox: 0 | 1
  /** 1 when that thread is in an inbox and has unread mail. */
  unreadInbox: 0 | 1
  /** 1 when its smart inbox lists the thread (see ConversationSummary.active). */
  active: 0 | 1
  /** 1 when that thread is listed by its smart inbox and has unread mail. */
  unreadActive: 0 | 1
  /** '' when the thread has no smart inbox (yet). */
  smartInboxId: string
  /** 0 when no batch delivered the thread. */
  batchedAt: number
}

function toSummary(stored: StoredConversation): ConversationSummary {
  return {
    threadId: stored.threadId,
    mailAccountId: stored.mailAccountId,
    subject: stored.subject,
    snippet: stored.snippet,
    lastMessageAt: stored.lastMessageAt,
    messageCount: stored.messageCount,
    unreadCount: stored.unreadCount,
    flagged: stored.flagged,
    hasAttachments: stored.hasAttachments,
    attachmentsBlocked: stored.attachmentsBlocked,
    senders: stored.senders,
    inbox: stored.inbox === 1,
    active: stored.active === 1,
    smartInboxId: stored.smartInboxId === '' ? null : stored.smartInboxId,
    heldUntil: stored.heldUntil ?? null,
    batchedAt: stored.batchedAt === 0 ? null : stored.batchedAt,
    verdict: stored.verdict,
    classificationReason: stored.classificationReason,
  }
}

interface MailSchema extends DBSchema {
  meta: { key: string; value: number }
  mailAccounts: { key: string; value: SyncedMailAccount }
  folders: { key: string; value: SyncedFolder; indexes: { byAccount: string } }
  threads: { key: string; value: SyncedThread; indexes: { byAccount: string } }
  messages: {
    key: string
    value: SyncedMessage
    indexes: { byThread: string; byAccount: string; byFolder: string }
  }
  outgoing: { key: string; value: SyncedOutgoingMessage; indexes: { byAccount: string; bySendAt: string } }
  contacts: { key: string; value: Contact; indexes: { byLastSeen: number } }
  drafts: { key: string; value: Draft; indexes: { byUpdatedAt: number } }
  conversations: {
    key: string
    value: StoredConversation
    indexes: {
      byAccount: string
      byInboxDate: [number, number]
      byAccountInboxDate: [string, number, number]
      byAccountUnreadInbox: [string, number]
      bySmartInboxDate: [string, number, number]
      bySmartInboxUnread: [string, number]
      byInboxBatchDate: [number, number, number]
    }
  }
  signatures: { key: string; value: SyncedSignature }
  smartInboxes: { key: string; value: SyncedSmartInbox }
  todos: { key: string; value: SyncedTodo; indexes: { byMessage: string; byThread: string } }
  unsubscriptions: { key: string; value: SyncedUnsubscription; indexes: { byAccount: string } }
  handOvers: { key: string; value: SyncedHandOver; indexes: { byAccount: string } }
  dailyBriefs: { key: string; value: SyncedDailyBrief }
  calendars: { key: string; value: SyncedCalendar; indexes: { byAccount: string } }
  calendarEvents: { key: string; value: StoredCalendarEvent; indexes: { bySeries: [string, string]; byCalendar: string; bySeriesStart: number; bySeriesEnd: number } }
}

/**
 * An event with the instants it can touch, and those its whole series can touch, for finding every row of the series
 * a range needs in one read. A series without an end has Infinity, which is a valid key where null is not.
 */
interface StoredCalendarEvent {
  id: string
  calendarId: string
  uid: string
  startsAt: number
  endsAt: number
  seriesStartsAt: number
  seriesEndsAt: number
  event: SyncedCalendarEvent
}

type Stores = StoreNames<MailSchema>[]
type WriteTx = IDBPTransaction<MailSchema, Stores, 'readwrite'>

const ALL_STORES: Stores = ['meta', 'mailAccounts', 'folders', 'threads', 'messages', 'conversations', 'outgoing', 'contacts', 'signatures', 'drafts', 'smartInboxes', 'todos', 'unsubscriptions', 'handOvers', 'dailyBriefs', 'calendars', 'calendarEvents']
const VERSION = 11

export function databaseName(userId: string): string {
  return `tresso-mail-${userId}`
}

/** Removes everything stored for a user, e.g. on sign-out. */
export function deleteMailDatabase(userId: string): Promise<void> {
  return deleteDB(databaseName(userId))
}

/** Why the copy closed under a tab: upgraded by a newer Tresso, deleted by a sign-out, or closed by the browser. */
export type ClosedElsewhere = 'upgraded' | 'deleted' | 'terminated'

/** The signed-in user's mail in the browser's IndexedDB. The desktop app keeps it in SQLite instead (SqliteMailStore). */
export class IndexedDbMailStore implements MailStore {
  /** Threads classified on this device whose server version has not arrived yet; see {@link restoreThread}. */
  private readonly unconfirmed = new OpenClassifications()
  /** Message actions of this device the server has not answered for yet; see {@link revertAction}. */
  private readonly openActions = new OpenActions()
  /** Raised by every page that changed calendars or events; see calendarChanges. */
  private calendarRevision = 0

  /** Why the connection closed under this tab, if it did; every call then says the copy is closing. */
  private closedElsewhere: ClosedElsewhere | null = null

  private constructor(private readonly connection: IDBPDatabase<MailSchema>) {}

  private get db(): IDBPDatabase<MailSchema> {
    if (this.closedElsewhere !== null) {
      throw new CopyClosingError()
    }
    return this.connection
  }

  /**
   * Opens the user's copy. `onClosedElsewhere` hears when the copy closes under this tab: another tab upgraded it (a
   * newer Tresso), deleted it (a sign-out there), or the browser closed it (site data cleared).
   */
  static async open(userId: string, onClosedElsewhere: (reason: ClosedElsewhere) => void = () => {}): Promise<IndexedDbMailStore> {
    let store: IndexedDbMailStore | null = null
    const closed = (reason: ClosedElsewhere) => {
      if (store !== null) {
        store.closedElsewhere = reason
      }
      onClosedElsewhere(reason)
    }
    const db = await openDB<MailSchema>(databaseName(userId), VERSION, {
      // Another connection wants the copy gone or upgraded (a sign-out or a newer version in another tab, or a
      // copy that was never closed here): this one closes, or the delete or upgrade would wait for it forever.
      blocking(_currentVersion, blockedVersion, event) {
        const connection = event.target as IDBDatabase
        connection.close()
        closed(blockedVersion === null ? 'deleted' : 'upgraded')
      },
      terminated() {
        closed('terminated')
      },
      async upgrade(database, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          createVersion1(database)
        }
        if (oldVersion < 2) {
          const outgoing = database.createObjectStore('outgoing', { keyPath: 'id' })
          outgoing.createIndex('byAccount', 'mailAccountId')
          outgoing.createIndex('bySendAt', 'sendAt')
          database.createObjectStore('contacts', { keyPath: 'key' }).createIndex('byLastSeen', 'lastSeen')
          database.createObjectStore('drafts', { keyPath: 'id' }).createIndex('byUpdatedAt', 'updatedAt')
        }
        if (oldVersion < 3) {
          database.createObjectStore('signatures', { keyPath: 'id' })
          // Accounts stored before signatures existed have no default; the server gave every account null.
          const accounts = transaction.objectStore('mailAccounts')
          for (let cursor = await accounts.openCursor(); cursor !== null; cursor = await cursor.continue()) {
            await cursor.update({ ...cursor.value, defaultSignatureId: cursor.value.defaultSignatureId ?? null })
          }
        }
        if (oldVersion >= 2 && oldVersion < 4) {
          // Drafts used to stay on the device; they are uploaded now, so nothing written before is lost.
          const drafts = transaction.objectStore('drafts')
          for (let cursor = await drafts.openCursor(); cursor !== null; cursor = await cursor.continue()) {
            await cursor.update({ ...cursor.value, version: 0, pendingSave: cursor.value.outgoingId === null, remoteVersion: null })
          }
        }
        if (oldVersion < 5) {
          database.createObjectStore('smartInboxes', { keyPath: 'id' })
          const conversations = transaction.objectStore('conversations')
          conversations.createIndex('bySmartInboxDate', ['smartInboxId', 'active', 'lastMessageAt'])
          conversations.createIndex('bySmartInboxUnread', ['smartInboxId', 'unreadActive'])
          if (oldVersion >= 1) {
            // Stored before classification reached clients: nothing is classified yet. The sync from the start below
            // brings it; until then the inboxes keep working.
            const threads = transaction.objectStore('threads')
            for (let cursor = await threads.openCursor(); cursor !== null; cursor = await cursor.continue()) {
              await cursor.update({ ...cursor.value, smartInboxId: null, verdict: null, classificationReason: null })
            }
            for (let cursor = await conversations.openCursor(); cursor !== null; cursor = await cursor.continue()) {
              const old = cursor.value
              await cursor.update({ ...old, smartInboxId: '', verdict: null, classificationReason: null, active: old.inbox, unreadActive: old.unreadInbox })
            }
          }
        }
        if (oldVersion < 6) {
          // Smart inboxes stored before carry no autoCreateTodo; the sync from the start below brings it.
          const todos = database.createObjectStore('todos', { keyPath: 'id' })
          todos.createIndex('byMessage', 'messageId')
          todos.createIndex('byThread', 'threadId')
        }
        if (oldVersion < 7) {
          database.createObjectStore('unsubscriptions', { keyPath: 'id' }).createIndex('byAccount', 'mailAccountId')
          const conversations = transaction.objectStore('conversations')
          conversations.createIndex('byInboxBatchDate', ['inbox', 'batchedAt', 'lastMessageAt'])
          if (oldVersion >= 1) {
            // Stored before batched delivery: nothing was held or batched. The sync from the start below brings it.
            for (let cursor = await conversations.openCursor(); cursor !== null; cursor = await cursor.continue()) {
              await cursor.update({ ...cursor.value, heldUntil: null, batchedAt: 0 })
            }
          }
        }
        if (oldVersion < 8) {
          database.createObjectStore('handOvers', { keyPath: 'id' }).createIndex('byAccount', 'mailAccountId')
        }
        if (oldVersion < 9) {
          database.createObjectStore('dailyBriefs', { keyPath: 'id' })
        }
        if (oldVersion < 10) {
          database.createObjectStore('calendars', { keyPath: 'id' }).createIndex('byAccount', 'mailAccountId')
          const events = database.createObjectStore('calendarEvents', { keyPath: 'id' })
          events.createIndex('bySeries', ['calendarId', 'uid'])
          events.createIndex('byCalendar', 'calendarId')
          events.createIndex('bySeriesStart', 'seriesStartsAt')
          events.createIndex('bySeriesEnd', 'seriesEndsAt')
        }
        if (oldVersion >= 6 && oldVersion < 11) {
          // Todos stored before todos were planned in the calendar hold no time; the sync from the start below brings it.
          const todos = transaction.objectStore('todos')
          for (let cursor = await todos.openCursor(); cursor !== null; cursor = await cursor.continue()) {
            await cursor.update({ ...cursor.value, plannedStart: null, plannedEnd: null, planState: null })
          }
        }
        // Outgoing mail, contacts, signatures, drafts, smart inboxes, todos, unsubscriptions, hand-overs, daily briefs and
        // calendars come from the delta: an existing copy syncs again from the start.
        if (oldVersion >= 1) {
          await transaction.objectStore('meta').delete('cursor')
        }
      },
    })

    store = new IndexedDbMailStore(db)
    return store
  }

  async close(): Promise<void> {
    this.connection.close()
  }

  async cursor(): Promise<number> {
    return (await this.db.get('meta', 'cursor')) ?? 0
  }

  async apply(page: ChangePage): Promise<void> {
    const tx = this.db.transaction(ALL_STORES, 'readwrite')
    const affected = new Set<string>()

    for (const deleted of page.deleted) {
      switch (deleted.type) {
        case 'mailAccount':
          await deleteAccount(tx, deleted.id)
          break
        case 'folder':
          for (const message of await tx.objectStore('messages').index('byFolder').getAll(deleted.id)) {
            affected.add(message.threadId)
          }
          await tx.objectStore('folders').delete(deleted.id)
          break
        case 'thread':
          await tx.objectStore('threads').delete(deleted.id)
          affected.add(deleted.id)
          break
        case 'message': {
          const message = await tx.objectStore('messages').get(deleted.id)
          if (message !== undefined) {
            affected.add(message.threadId)
            await tx.objectStore('messages').delete(deleted.id)
          }
          break
        }
        case 'outgoingMessage':
          await tx.objectStore('outgoing').delete(deleted.id)
          break
        case 'handOver':
          await tx.objectStore('handOvers').delete(deleted.id)
          break
        case 'signature':
          await tx.objectStore('signatures').delete(deleted.id)
          break
        case 'smartInbox':
          await tx.objectStore('smartInboxes').delete(deleted.id)
          break
        case 'todo':
          await tx.objectStore('todos').delete(deleted.id)
          break
        case 'dailyBrief':
          await tx.objectStore('dailyBriefs').delete(deleted.id)
          break
        case 'calendar':
          await deleteCalendar(tx, deleted.id)
          break
        case 'calendarEvent':
          await deleteCalendarEvent(tx, deleted.id)
          break
        case 'draft': {
          const local = await tx.objectStore('drafts').get(deleted.id)
          if (local !== undefined) {
            const kept = deletedDraft(storedDraft(local))
            await (kept === null ? tx.objectStore('drafts').delete(deleted.id) : tx.objectStore('drafts').put(kept))
          }
          break
        }
      }
    }

    for (const account of page.mailAccounts) {
      await tx.objectStore('mailAccounts').put(account)
    }
    for (const folder of page.folders) {
      const previous = await tx.objectStore('folders').get(folder.id)
      await tx.objectStore('folders').put(folder)
      if (previous !== undefined && previous.role !== folder.role) {
        for (const message of await tx.objectStore('messages').index('byFolder').getAll(folder.id)) {
          affected.add(message.threadId)
        }
      }
    }
    for (const signature of page.signatures) {
      await tx.objectStore('signatures').put(signature)
    }
    for (const smartInbox of page.smartInboxes) {
      const known = await tx.objectStore('smartInboxes').get(smartInbox.id)
      await tx.objectStore('smartInboxes').put(smartInbox)
      if (known === undefined && smartInbox.builtin === 'spam') {
        // The Spam smart inbox decides which conversations the inboxes leave out.
        for (const threadId of await tx.objectStore('conversations').getAllKeys()) {
          affected.add(threadId)
        }
      }
    }
    for (const brief of page.dailyBriefs ?? []) {
      await tx.objectStore('dailyBriefs').put(brief)
    }
    for (const calendar of page.calendars) {
      await tx.objectStore('calendars').put(calendar)
    }
    for (const event of page.calendarEvents) {
      await writeCalendarEvent(tx, event)
    }
    for (const thread of page.threads) {
      await tx.objectStore('threads').put(thread)
      affected.add(thread.id)
      this.unconfirmed.confirmed(thread.id)
    }
    for (const message of page.messages) {
      this.openActions.confirmed(message.id)
      const previous = await tx.objectStore('messages').get(message.id)
      if (previous !== undefined && previous.threadId !== message.threadId) {
        affected.add(previous.threadId)
      }
      await tx.objectStore('messages').put(message)
      affected.add(message.threadId)
      if (previous === undefined) {
        await rememberContacts(tx, message)
      }
    }
    for (const outgoing of page.outgoingMessages) {
      await tx.objectStore('outgoing').put(outgoing)
    }
    for (const unsubscription of page.unsubscriptions ?? []) {
      await tx.objectStore('unsubscriptions').put(unsubscription)
    }
    for (const draft of page.drafts) {
      await applyDraft(tx, draft)
    }
    for (const todo of page.todos) {
      await tx.objectStore('todos').put(todo)
    }
    for (const handOver of page.handOvers) {
      await tx.objectStore('handOvers').put(handOver)
    }

    const lists = await listFoldersOf(tx)
    for (const threadId of affected) {
      await refreshConversation(tx, threadId, lists)
    }

    await tx.objectStore('meta').put(page.cursor, 'cursor')
    await tx.done
    if (touchesCalendars(page)) {
      this.calendarRevision += 1
    }
  }

  /**
   * Makes an action show at once, before the server confirms it: flags change, and archived, trashed or moved
   * messages change folders (archiving takes them out of the inbox into Archive, or All Mail where there is none).
   * The delta brings the server's version right after.
   *
   * @throws MissingFolderError when an account has nothing to archive or trash into; nothing changes then
   */
  async applyAction(messageIds: string[], action: MessageAction, folderId?: string, fromFolderId?: string): Promise<AppliedAction> {
    const tx = this.db.transaction(ALL_STORES, 'readwrite')
    const folders = await tx.objectStore('folders').getAll()
    const accounts = await tx.objectStore('mailAccounts').getAll()

    const before: SyncedMessage[] = []
    for (const id of messageIds) {
      const message = await tx.objectStore('messages').get(id)
      if (message !== undefined) {
        before.push(message)
      }
    }
    const after = actionResult(before, action, { folders, accounts, folderId, fromFolderId })

    before.forEach((message, index) => this.openActions.applied(message, after[index]!))
    const affected = new Set<string>()
    for (const message of after) {
      await tx.objectStore('messages').put(message)
      affected.add(message.threadId)
    }
    const lists = await listFoldersOf(tx)
    for (const threadId of affected) {
      await refreshConversation(tx, threadId, lists)
    }
    await tx.done

    return { before, after }
  }

  /** Puts back what {@link applyAction} changed, part by part (see MailStore.revertAction). */
  async revertAction(applied: AppliedAction): Promise<void> {
    const tx = this.db.transaction(ALL_STORES, 'readwrite')
    const affected = new Set<string>()
    for (const [index, previous] of applied.before.entries()) {
      const current = await tx.objectStore('messages').get(previous.id)
      const after = applied.after[index]
      const reverted = current === undefined || after === undefined ? null : this.openActions.refused(current, previous, after)
      if (reverted !== null) {
        await tx.objectStore('messages').put(reverted)
        affected.add(reverted.threadId)
      }
    }
    const lists = await listFoldersOf(tx)
    for (const threadId of affected) {
      await refreshConversation(tx, threadId, lists)
    }
    await tx.done
  }

  async handOvers(): Promise<SyncedHandOver[]> {
    const tx = this.db.transaction(['handOvers', 'messages', 'threads'])
    const handOvers = await tx.objectStore('handOvers').getAll()
    // The conversation its message is in now; once that message is gone, the one the server keeps, if it is here.
    const resolved = await Promise.all(
      handOvers.map(async (handOver) => {
        const message = handOver.messageId === null ? undefined : await tx.objectStore('messages').get(handOver.messageId)
        const kept = message === undefined && handOver.threadId !== null ? await tx.objectStore('threads').get(handOver.threadId) : undefined
        return { ...handOver, threadId: message?.threadId ?? kept?.id ?? null }
      }),
    )
    return resolved.sort(compareHandOvers)
  }

  async mailAccounts(): Promise<SyncedMailAccount[]> {
    const accounts = await this.db.getAll('mailAccounts')

    return accounts.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.emailAddress.localeCompare(b.emailAddress))
  }

  async folders(): Promise<SyncedFolder[]> {
    return this.db.getAll('folders')
  }

  async signatures(): Promise<SyncedSignature[]> {
    const signatures = await this.db.getAll('signatures')

    return signatures.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  /** In sidebar order. */
  async smartInboxes(): Promise<SyncedSmartInbox[]> {
    return sortSmartInboxes(await this.db.getAll('smartInboxes'))
  }

  /** The daily briefs, newest first. */
  async dailyBriefs(): Promise<SyncedDailyBrief[]> {
    return (await this.db.getAll('dailyBriefs')).sort(compareBriefs)
  }

  /** The summaries of these threads that exist, in the order asked for; each thread once. */
  async conversations(threadIds: string[]): Promise<ConversationSummary[]> {
    const tx = this.db.transaction('conversations')
    const conversations: ConversationSummary[] = []
    for (const threadId of new Set(threadIds)) {
      const stored = await tx.store.get(threadId)
      if (stored !== undefined) {
        conversations.push(toSummary(stored))
      }
    }
    await tx.done

    return conversations
  }

  async calendars(): Promise<SyncedCalendar[]> {
    return sortCalendars(await this.db.getAll('calendars'))
  }

  async calendarEvents(from: number, to: number): Promise<SyncedCalendarEvent[]> {
    const tx = this.db.transaction('calendarEvents')
    const starts = tx.store.index('bySeriesStart')
    const ends = tx.store.index('bySeriesEnd')
    // Every row carries the span of its whole series. Of the series starting before the range ends and those ending
    // after it begins, the smaller set is read and the other bound checked on it.
    const before = IDBKeyRange.upperBound(to, true)
    const after = IDBKeyRange.lowerBound(from, true)
    const [startCount, endCount] = await Promise.all([starts.count(before), ends.count(after)])
    const rows = startCount <= endCount ? (await starts.getAll(before)).filter((row) => row.seriesEndsAt > from) : (await ends.getAll(after)).filter((row) => row.seriesStartsAt < to)
    await tx.done
    return rows.map((row) => row.event)
  }

  calendarChanges(): number {
    return this.calendarRevision
  }

  async calendarEvent(id: string): Promise<SyncedCalendarEvent | null> {
    return (await this.db.get('calendarEvents', id))?.event ?? null
  }

  /** Inbox threads, newest first; of one account, or of all accounts (the Unified Inbox). */
  inbox(mailAccountId: string | null, limit: number): Promise<ConversationSummary[]> {
    return this.list({ kind: 'inbox', mailAccountId }, limit)
  }

  /** The threads of a list, newest first; the batches by batch first (see MailStore.list). */
  async list(scope: ListScope, limit: number): Promise<ConversationSummary[]> {
    const tx = this.db.transaction('conversations')
    const conversations: ConversationSummary[] = []
    for (let cursor = await openList(tx.store, scope); cursor !== null && conversations.length < limit; cursor = await cursor.continue()) {
      conversations.push(toSummary(cursor.value))
    }

    return conversations
  }

  /**
   * Threads of a list matching a test, newest first, however many there are: for selecting beyond the part of the list
   * that is loaded.
   */
  async listThreadIds(scope: ListScope, matches: (conversation: ConversationSummary) => boolean, limit?: number): Promise<string[]> {
    const tx = this.db.transaction('conversations')
    const ids: string[] = []
    for (let cursor = await openList(tx.store, scope); cursor !== null && (limit === undefined || ids.length < limit); cursor = await cursor.continue()) {
      if (matches(toSummary(cursor.value))) {
        ids.push(cursor.value.threadId)
      }
    }

    return ids
  }

  async summaries(threadIds: string[]): Promise<ConversationSummary[]> {
    const tx = this.db.transaction('conversations')
    const found: ConversationSummary[] = []
    for (const threadId of threadIds) {
      const stored = await tx.store.get(threadId)
      if (stored !== undefined) {
        found.push(toSummary(stored))
      }
    }

    return found
  }

  /**
   * What a selection of threads holds now: the ones still in the list on screen, and their accounts and senders
   * (lower-case addresses).
   */
  async describeThreads(scope: ListScope, threadIds: string[]): Promise<{ present: string[]; accounts: string[]; senders: string[] }> {
    const tx = this.db.transaction('conversations')
    const present: string[] = []
    const accounts = new Set<string>()
    const senders = new Set<string>()
    for (const threadId of threadIds) {
      const stored = await tx.store.get(threadId)
      if (stored === undefined || !inList(toSummary(stored), scope)) {
        continue
      }
      present.push(threadId)
      accounts.add(stored.mailAccountId)
      for (const sender of stored.senders) {
        senders.add(sender.address.toLowerCase())
      }
    }

    return { present, accounts: [...accounts], senders: [...senders] }
  }

  /** The messages of these threads, for acting on whole conversations. */
  async messageIdsOfThreads(threadIds: string[]): Promise<string[]> {
    return [...(await this.messagesByThread(threadIds)).values()].flat()
  }

  /** The messages of each thread, read in one transaction however many threads there are. */
  async messagesByThread(threadIds: string[]): Promise<Map<string, string[]>> {
    const tx = this.db.transaction('messages')
    const byThread = new Map<string, string[]>()
    for (const threadId of threadIds) {
      byThread.set(threadId, await tx.store.index('byThread').getAllKeys(threadId))
    }
    await tx.done

    return byThread
  }

  /** Inbox threads with unread mail, per account. */
  async unreadInboxCounts(): Promise<Map<string, number>> {
    const tx = this.db.transaction(['mailAccounts', 'conversations'])
    const counts = new Map<string, number>()
    for (const accountId of await tx.objectStore('mailAccounts').getAllKeys()) {
      counts.set(accountId, await tx.objectStore('conversations').index('byAccountUnreadInbox').count([accountId, 1]))
    }

    return counts
  }

  /** Threads with unread mail per smart inbox, among those it lists. */
  async unreadSmartInboxCounts(): Promise<Map<string, number>> {
    const tx = this.db.transaction(['smartInboxes', 'conversations'])
    const counts = new Map<string, number>()
    for (const id of await tx.objectStore('smartInboxes').getAllKeys()) {
      counts.set(id, await tx.objectStore('conversations').index('bySmartInboxUnread').count([id, 1]))
    }

    return counts
  }

  /**
   * Shows the user's choice at once, before the server confirms it: the thread moves to the smart inbox with the
   * verdict. Returns the thread as it was, for {@link restoreThread} when the server refuses.
   */
  async classifyThread(threadId: string, smartInboxId: string, verdict: Verdict): Promise<SyncedThread | null> {
    const tx = this.db.transaction(ALL_STORES, 'readwrite')
    const previous = await tx.objectStore('threads').get(threadId)
    if (previous !== undefined) {
      await tx.objectStore('threads').put(classifiedByUser(previous, smartInboxId, verdict))
      this.unconfirmed.opened(previous, { smartInboxId, verdict })
      await refreshConversation(tx, threadId, await listFoldersOf(tx))
    }
    await tx.done

    return previous ?? null
  }

  /** Puts a thread back as it was, unless the delta changed it since. */
  async restoreThread(previous: SyncedThread): Promise<void> {
    const tx = this.db.transaction(ALL_STORES, 'readwrite')
    // Once the server's version arrived it stays, also when it is the same placement: the request went through.
    const restore = this.unconfirmed.failed(previous.id, await tx.objectStore('threads').get(previous.id))
    if (restore !== null) {
      await tx.objectStore('threads').put(restore)
      await refreshConversation(tx, restore.id, await listFoldersOf(tx))
    }
    await tx.done
  }

  /** Outgoing mail that is not settled: scheduled, on its way, or failed. Newest first. */
  async unsubscriptions(): Promise<SyncedUnsubscription[]> {
    return this.db.getAll('unsubscriptions')
  }

  async noteUnsubscription(unsubscription: SyncedUnsubscription): Promise<void> {
    const tx = this.db.transaction('unsubscriptions', 'readwrite')
    if (newerUnsubscription(await tx.store.get(unsubscription.id), unsubscription)) {
      await tx.store.put(unsubscription)
    }
    await tx.done
  }

  async outbox(): Promise<SyncedOutgoingMessage[]> {
    const all = await this.db.getAll('outgoing')

    return all.filter((message) => message.status !== 'sent' && message.status !== 'cancelled').sort((a, b) => b.sendAt.localeCompare(a.sendAt))
  }

  async outgoing(id: string): Promise<SyncedOutgoingMessage | null> {
    return (await this.db.get('outgoing', id)) ?? null
  }

  /** Contacts matching the start of a name or address, most recent first. */
  async suggestContacts(query: string, limit: number): Promise<Contact[]> {
    const result: Contact[] = []
    const index = this.db.transaction('contacts').store.index('byLastSeen')
    for (let cursor = await index.openCursor(null, 'prev'); cursor !== null && result.length < limit; cursor = await cursor.continue()) {
      if (contactMatches(cursor.value, query)) {
        result.push(cursor.value)
      }
    }

    return result
  }

  async saveDraft(draft: Draft): Promise<void> {
    await this.db.put('drafts', draft)
  }

  async changeDraft(id: string, change: (stored: Draft | null) => Draft | null): Promise<Draft | null> {
    const tx = this.db.transaction('drafts', 'readwrite')
    const found = await tx.store.get(id)
    const stored = found === undefined ? null : storedDraft(found)
    let next: Draft | null
    try {
      next = change(stored)
      if (next !== null) {
        await tx.store.put(next)
      }
    } catch (error) {
      // Nothing of it is kept; the transaction's own failure is the same one and needs no handling of its own.
      try {
        tx.abort()
      } catch {
        // Aborted already, by the failed write.
      }
      await tx.done.catch(() => undefined)
      throw error
    }
    await tx.done
    return next ?? stored
  }

  async drafts(): Promise<Draft[]> {
    return (await this.db.getAllFromIndex('drafts', 'byUpdatedAt')).reverse().map(storedDraft)
  }

  async draft(id: string): Promise<Draft | null> {
    const draft = await this.db.get('drafts', id)
    return draft === undefined ? null : storedDraft(draft)
  }

  async deleteDraft(id: string): Promise<void> {
    await this.db.delete('drafts', id)
  }

  async thread(threadId: string): Promise<{ thread: SyncedThread; messages: SyncedMessage[] } | null> {
    const tx = this.db.transaction(['threads', 'messages'])
    const thread = await tx.objectStore('threads').get(threadId)
    if (thread === undefined) {
      return null
    }
    const messages = await tx.objectStore('messages').index('byThread').getAll(threadId)
    messages.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))

    return { thread, messages }
  }

  async messages(ids: string[]): Promise<SyncedMessage[]> {
    const store = this.db.transaction('messages').objectStore('messages')
    const found = await Promise.all(ids.map((id) => store.get(id)))
    return found.filter((message) => message !== undefined)
  }

  async todos(): Promise<SyncedTodo[]> {
    return (await this.db.getAll('todos')).sort(compareTodos)
  }

  async todo(id: string): Promise<SyncedTodo | null> {
    return (await this.db.get('todos', id)) ?? null
  }

  async todosOfThread(threadId: string): Promise<SyncedTodo[]> {
    const tx = this.db.transaction(['todos', 'messages'])
    const messageIds = await tx.objectStore('messages').index('byThread').getAllKeys(threadId)
    const candidates = new Map<string, SyncedTodo>()
    for (const todo of await tx.objectStore('todos').index('byThread').getAll(threadId)) {
      candidates.set(todo.id, todo)
    }
    for (const messageId of messageIds) {
      for (const todo of await tx.objectStore('todos').index('byMessage').getAll(messageId)) {
        candidates.set(todo.id, todo)
      }
    }
    // A message can move to another thread after its todo was made: the thread of the message on this device wins.
    const own = new Set(messageIds)
    const kept: SyncedTodo[] = []
    for (const todo of candidates.values()) {
      if (todo.messageId !== null && own.has(todo.messageId)) {
        kept.push(todo)
        continue
      }
      const elsewhere = todo.messageId === null ? undefined : await tx.objectStore('messages').get(todo.messageId)
      if (elsewhere === undefined && todo.threadId === threadId) {
        kept.push(todo)
      }
    }
    return kept.sort(compareTodos)
  }
}

type ConversationStore = ReturnType<IDBPTransaction<MailSchema, ['conversations'], 'readonly'>['objectStore']>

/** A cursor over the threads of a list, newest first, through the index that covers it. */
function openList(store: ConversationStore, scope: ListScope) {
  if (scope.kind === 'batch') {
    // batchedAt is 0 for conversations no batch delivered.
    return store.index('byInboxBatchDate').openCursor(IDBKeyRange.bound([1, 1, -Infinity], [1, Infinity, Infinity]), 'prev')
  }
  if (scope.kind === 'smartInbox') {
    return store.index('bySmartInboxDate').openCursor(IDBKeyRange.bound([scope.smartInboxId, 1, -Infinity], [scope.smartInboxId, 1, Infinity]), 'prev')
  }
  if (scope.mailAccountId === null) {
    return store.index('byInboxDate').openCursor(IDBKeyRange.bound([1, -Infinity], [1, Infinity]), 'prev')
  }

  return store.index('byAccountInboxDate').openCursor(IDBKeyRange.bound([scope.mailAccountId, 1, -Infinity], [scope.mailAccountId, 1, Infinity]), 'prev')
}

async function listFoldersOf(tx: WriteTx): Promise<ListFolders> {
  return listFolders(await tx.objectStore('folders').getAll(), await tx.objectStore('smartInboxes').getAll())
}

function createVersion1(database: IDBPDatabase<MailSchema>): void {
  database.createObjectStore('meta')
  database.createObjectStore('mailAccounts', { keyPath: 'id' })
  database.createObjectStore('folders', { keyPath: 'id' }).createIndex('byAccount', 'mailAccountId')
  database.createObjectStore('threads', { keyPath: 'id' }).createIndex('byAccount', 'mailAccountId')
  const messages = database.createObjectStore('messages', { keyPath: 'id' })
  messages.createIndex('byThread', 'threadId')
  messages.createIndex('byAccount', 'mailAccountId')
  messages.createIndex('byFolder', 'folderIds', { multiEntry: true })
  const conversations = database.createObjectStore('conversations', { keyPath: 'threadId' })
  conversations.createIndex('byAccount', 'mailAccountId')
  conversations.createIndex('byInboxDate', ['inbox', 'lastMessageAt'])
  conversations.createIndex('byAccountInboxDate', ['mailAccountId', 'inbox', 'lastMessageAt'])
  conversations.createIndex('byAccountUnreadInbox', ['mailAccountId', 'unreadInbox'])
}

async function deleteAccount(tx: WriteTx, accountId: string): Promise<void> {
  await tx.objectStore('mailAccounts').delete(accountId)
  // Drafts outlive the account they were written from; they keep their text and need a new one to send.
  for (const draft of await tx.objectStore('drafts').getAll()) {
    if (draft.mailAccountId === accountId) {
      await tx.objectStore('drafts').put({ ...draft, mailAccountId: null })
    }
  }
  for (const store of ['folders', 'threads', 'messages', 'conversations', 'outgoing', 'unsubscriptions', 'handOvers'] as const) {
    const index = tx.objectStore(store).index('byAccount')
    for (let cursor = await index.openCursor(accountId); cursor !== null; cursor = await cursor.continue()) {
      await cursor.delete()
    }
  }
  // The account's calendars go with it.
  for (const calendarId of await tx.objectStore('calendars').index('byAccount').getAllKeys(accountId)) {
    await deleteCalendar(tx, calendarId)
  }
}

async function writeCalendarEvent(tx: WriteTx, event: SyncedCalendarEvent): Promise<void> {
  const store = tx.objectStore('calendarEvents')
  const previous = await store.get(event.id)
  const span = eventSpan(event)
  const endsAt = span.endsAt ?? Infinity
  await store.put({ id: event.id, calendarId: event.calendarId, uid: event.uid, startsAt: span.startsAt, endsAt, seriesStartsAt: span.startsAt, seriesEndsAt: endsAt, event })
  await spanSeries(tx, event.calendarId, event.uid)
  if (previous !== undefined && (previous.calendarId !== event.calendarId || previous.uid !== event.uid)) {
    await spanSeries(tx, previous.calendarId, previous.uid)
  }
}

async function deleteCalendarEvent(tx: WriteTx, id: string): Promise<void> {
  const store = tx.objectStore('calendarEvents')
  const previous = await store.get(id)
  await store.delete(id)
  if (previous !== undefined) {
    await spanSeries(tx, previous.calendarId, previous.uid)
  }
}

/** Gives every row of a series the span of the whole series: from its earliest start to its latest end. */
async function spanSeries(tx: WriteTx, calendarId: string, uid: string): Promise<void> {
  const store = tx.objectStore('calendarEvents')
  const rows = await store.index('bySeries').getAll([calendarId, uid])
  if (rows.length === 0) {
    return
  }
  const seriesStartsAt = Math.min(...rows.map((row) => row.startsAt))
  const seriesEndsAt = Math.max(...rows.map((row) => row.endsAt))
  for (const row of rows) {
    if (row.seriesStartsAt !== seriesStartsAt || row.seriesEndsAt !== seriesEndsAt) {
      await store.put({ ...row, seriesStartsAt, seriesEndsAt })
    }
  }
}

async function deleteCalendar(tx: WriteTx, calendarId: string): Promise<void> {
  const index = tx.objectStore('calendarEvents').index('byCalendar')
  for (let cursor = await index.openCursor(calendarId); cursor !== null; cursor = await cursor.continue()) {
    await cursor.delete()
  }
  await tx.objectStore('calendars').delete(calendarId)
}

async function applyDraft(tx: WriteTx, draft: SyncedDraft): Promise<void> {
  const local = await tx.objectStore('drafts').get(draft.id)
  const next = syncedDraft(local === undefined ? undefined : storedDraft(local), draft)
  if (next !== null) {
    await tx.objectStore('drafts').put(next)
  }
}

async function rememberContacts(tx: WriteTx, message: SyncedMessage): Promise<void> {
  const at = Date.parse(message.receivedAt)
  for (const { key, person } of peopleOn(message)) {
    await tx.objectStore('contacts').put(mergeContact(await tx.objectStore('contacts').get(key), key, person, at))
  }
}

async function refreshConversation(tx: WriteTx, threadId: string, lists: ListFolders): Promise<void> {
  const thread = await tx.objectStore('threads').get(threadId)
  const messages = thread === undefined ? [] : await tx.objectStore('messages').index('byThread').getAll(threadId)
  const summary = thread === undefined ? null : summarizeConversation(thread, messages, lists)
  if (summary === null) {
    await tx.objectStore('conversations').delete(threadId)
    return
  }

  await tx.objectStore('conversations').put({
    ...summary,
    smartInboxId: summary.smartInboxId ?? '',
    batchedAt: summary.batchedAt ?? 0,
    inbox: summary.inbox ? 1 : 0,
    unreadInbox: summary.inbox && summary.unreadCount > 0 ? 1 : 0,
    active: summary.active ? 1 : 0,
    unreadActive: summary.active && summary.unreadCount > 0 ? 1 : 0,
  })
}
