import type { AppliedAction, MessageAction } from '../actions'
import type { SyncedCalendar, SyncedCalendarEvent } from '../calendar/types'
import type { Verdict } from '../domain'
import type { ConversationSummary, ListScope } from '../sync/conversation'
import type { SyncStore } from '../sync/engine'
import type { Address, DraftAttachment, SyncedDailyBrief, SyncedFolder, SyncedHandOver, SyncedMailAccount, SyncedMessage, SyncedOutgoingMessage, SyncedSignature, SyncedSmartInbox, SyncedThread, SyncedTodo, SyncedUnsubscription } from '../sync/types'

/** Someone the user exchanged mail with, for recipient suggestions. */
export interface Contact {
  /** Lower-cased address. */
  key: string
  address: string
  name: string | null
  /** Epoch ms of the newest message with them. */
  lastSeen: number
  messages: number
}

/**
 * A message being written: the synced draft plus what only this device knows. Edits are saved here first
 * (`pendingSave`) and then uploaded; `version` is the server version they build on, 0 while the draft has not
 * reached the server.
 */
export interface Draft {
  id: string
  mailAccountId: string | null
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  /** What the user writes, without signature and quote. */
  html: string
  /** The signature added below the text; null for none. */
  signatureId: string | null
  /** The original a reply or forward quotes, kept apart from the text. */
  quoteHtml: string
  inReplyToMessageId: string | null
  kind: 'new' | 'reply' | 'replyAll' | 'forward'
  version: number
  /** Edits on this device that have not reached the server yet. */
  pendingSave: boolean
  /** Set when another device saved a newer version while this one had unsaved edits: the version waiting there. */
  remoteVersion: number | null
  /** Set once sent: the draft stays until the message is confirmed sent, so a failure can be edited and resent. */
  outgoingId: string | null
  /** The outgoing status the user was last told about, so each outcome is announced once. */
  noticedStatus: string | null
  updatedAt: number
  /** The files on the server's copy, as last heard of; they change through the attachment endpoints. */
  attachments: DraftAttachment[]
}

/** The copy is being closed (a sign-out or another user), so it takes no more writes. */
export class CopyClosingError extends Error {
  constructor() {
    super('The mail copy is closing.')
    this.name = 'CopyClosingError'
  }
}

/**
 * The signed-in user's mail kept on the device, whatever holds it: IndexedDB in the browser, SQLite on the desktop and
 * the phone. Screens read from it only; the sync engine writes the delta into it.
 */
export interface MailStore extends SyncStore {
  /**
   * Makes an action show at once, before the server confirms it, the way the server will make it (see actionResult).
   *
   * @throws MissingFolderError when an account has nothing to archive or trash into; nothing changes then
   */
  applyAction(messageIds: string[], action: MessageAction, folderId?: string, fromFolderId?: string): Promise<AppliedAction>
  /**
   * Puts back what {@link applyAction} changed, part by part (read, flagged, folders; see revertedMessage): a part goes
   * back only while it still shows what the action made of it, so a second action on the same messages, or a change
   * the delta brought, is kept. It is only given messages whose request the server did not take.
   */
  revertAction(applied: AppliedAction): Promise<void>
  /**
   * Every hand-over in "Waiting on" order (see `compareHandOvers`), each with the conversation its message is in
   * now; null when that message is not in the copy.
   */
  handOvers(): Promise<SyncedHandOver[]>
  /** By display name, then address. */
  mailAccounts(): Promise<SyncedMailAccount[]>
  folders(): Promise<SyncedFolder[]>
  /** By name. */
  signatures(): Promise<SyncedSignature[]>
  /** In sidebar order. */
  smartInboxes(): Promise<SyncedSmartInbox[]>
  /** The daily briefs, newest first (see compareBriefs). */
  dailyBriefs(): Promise<SyncedDailyBrief[]>
  /** The summaries of these threads that exist, in the order asked for; each thread once. */
  conversations(threadIds: string[]): Promise<ConversationSummary[]>
  /** In the user's order (see sortCalendars). */
  calendars(): Promise<SyncedCalendar[]>
  /**
   * The stored rows a range of instants needs for expanding its occurrences: every row of each series that may touch
   * the range (the series, its overrides and exceptions), and single events in it. May return more; never less.
   */
  calendarEvents(from: number, to: number): Promise<SyncedCalendarEvent[]>
  calendarEvent(id: string): Promise<SyncedCalendarEvent | null>
  /** Raised whenever applied pages changed calendars or events, so views expand again only then. */
  calendarChanges(): number
  /** Inbox threads, newest first; of one account, or of all accounts (the Unified Inbox). */
  inbox(mailAccountId: string | null, limit: number): Promise<ConversationSummary[]>
  /**
   * The threads of a list, newest first: an inbox or a smart inbox (neither lists a conversation that waits for a
   * batch), or the batches (newest batch first, newest conversation first within a batch).
   */
  list(scope: ListScope, limit: number): Promise<ConversationSummary[]>
  /**
   * Threads of a list matching a test, newest first, however many there are (or the first `limit`, which stops the
   * scan there): for selecting beyond the part of the list that is loaded.
   */
  listThreadIds(scope: ListScope, matches: (conversation: ConversationSummary) => boolean, limit?: number): Promise<string[]>
  /** The stored summaries of these threads, whatever list they are in; threads without one are left out. */
  summaries(threadIds: string[]): Promise<ConversationSummary[]>
  /**
   * What a selection of threads holds now: the ones still in the list on screen, and their accounts and senders
   * (lower-case addresses).
   */
  describeThreads(scope: ListScope, threadIds: string[]): Promise<{ present: string[]; accounts: string[]; senders: string[] }>
  /** The messages of these threads, for acting on whole conversations. */
  messageIdsOfThreads(threadIds: string[]): Promise<string[]>
  /** The messages of each thread. */
  messagesByThread(threadIds: string[]): Promise<Map<string, string[]>>
  /** Inbox threads with unread mail, per account; every account is listed, with 0 when it has none. */
  unreadInboxCounts(): Promise<Map<string, number>>
  /** Threads with unread mail per smart inbox, among those it lists; every smart inbox is listed. */
  unreadSmartInboxCounts(): Promise<Map<string, number>>
  /**
   * Shows the user's choice at once, before the server confirms it: the thread moves to the smart inbox with the
   * verdict. Returns the thread as it was, for {@link restoreThread} when the server refuses; null when it is gone.
   */
  classifyThread(threadId: string, smartInboxId: string, verdict: Verdict): Promise<SyncedThread | null>
  /**
   * Puts a thread back as it was before {@link classifyThread}, unless the delta brought the server's version since,
   * even one with the same placement (the request went through and only its answer was lost). When the thread was
   * classified again before this one was refused, it goes back only once the last of those is refused too, to how it
   * was before the first (see OpenClassifications).
   */
  restoreThread(previous: SyncedThread): Promise<void>
  /** The user's unsubscribe requests, of every account. */
  unsubscriptions(): Promise<SyncedUnsubscription[]>
  /**
   * Stores the server's answer to an unsubscribe request at once, so the button goes before the delta brings it; a
   * copy the delta brought for the same request is kept (see `newerUnsubscription`).
   */
  noteUnsubscription(unsubscription: SyncedUnsubscription): Promise<void>
  /** Outgoing mail that is not settled: scheduled, on its way, or failed. Newest first. */
  outbox(): Promise<SyncedOutgoingMessage[]>
  outgoing(id: string): Promise<SyncedOutgoingMessage | null>
  /** Contacts whose address or a word of whose name starts with the query, most recent first. */
  suggestContacts(query: string, limit: number): Promise<Contact[]>
  saveDraft(draft: Draft): Promise<void>
  /**
   * Changes a draft as one step: nothing else written to it in between (a sync, another save). `change` gets the
   * draft as stored (null when there is none) and returns what to store, or null to leave it as it is; it must not
   * wait for anything. Returns what is stored afterwards.
   */
  changeDraft(id: string, change: (stored: Draft | null) => Draft | null): Promise<Draft | null>
  /** Most recently changed first. */
  drafts(): Promise<Draft[]>
  draft(id: string): Promise<Draft | null>
  deleteDraft(id: string): Promise<void>
  /** A thread with its messages oldest first, or null when it no longer exists. */
  thread(threadId: string): Promise<{ thread: SyncedThread; messages: SyncedMessage[] } | null>
  /** The messages with these ids that this device has, in the order asked for. */
  messages(ids: string[]): Promise<SyncedMessage[]>
  /** Open todos in the user's order, then done ones, most recently done first (see `compareTodos`). */
  todos(): Promise<SyncedTodo[]>
  todo(id: string): Promise<SyncedTodo | null>
  /** The todos made from the emails of a thread, in list order. */
  todosOfThread(threadId: string): Promise<SyncedTodo[]>
  /** Finishes the writes under way and closes the copy; it takes no more writes. */
  close(): Promise<void>
}
