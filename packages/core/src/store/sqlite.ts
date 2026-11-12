import { actionResult, OpenActions, type AppliedAction, type MessageAction } from '../actions'
import { compareBriefs } from '../brief'
import type { Verdict } from '../domain'
import { compareHandOvers } from '../handOvers'
import { sortCalendars, touchesCalendars } from '../calendar/calendars'
import { eventSpan } from '../calendar/occurrences'
import type { SyncedCalendar, SyncedCalendarEvent } from '../calendar/types'
import { sortSmartInboxes } from '../smartInboxes'
import { compareTodos } from '../todos'
import { inList, summarizeConversation, type ConversationSummary, type ListFolders, type ListScope } from '../sync/conversation'
import type { ChangePage, SyncedDailyBrief, SyncedFolder, SyncedHandOver, SyncedMailAccount, SyncedMessage, SyncedOutgoingMessage, SyncedSignature, SyncedSmartInbox, SyncedThread, SyncedTodo, SyncedUnsubscription } from '../sync/types'
import { CopyClosingError, type Contact, type Draft, type MailStore } from './mailStore'
import { classifiedByUser, contactMatches, deletedDraft, draftOnlyHere, mergeContact, newerUnsubscription, OpenClassifications, peopleOn, storedDraft, syncedDraft } from './rules'
import type { Sql, SqlValue } from './sql'

/**
 * Raised whenever the copy changes shape. A copy made by an older version is brought up to date in place when every
 * step from its version to this one is in {@link MIGRATIONS}; otherwise (and for a copy of a newer version) it is
 * emptied and synced again from the start, so nothing it skipped stays missing; drafts that exist only on this device
 * are carried over.
 */
export const SCHEMA_VERSION = 9

/**
 * A step that brings a copy of one version to the next, in place. Its statements run in the transaction of all steps.
 * `resync` says the new shape holds data the old copy never stored (a new kind of entity, a field it did not keep): the
 * copy then syncs again from the start, while what it holds stays on screen and is overwritten page by page. A step
 * that only adds what can be filled from the stored rows (an index, a column read out of `json`) sets it false.
 */
export interface SchemaMigration {
  sql: string
  resync: boolean
}

/**
 * The in-place steps, by the version they start from: `MIGRATIONS[8]` would bring a copy of version 8 to 9. Every
 * raise of SCHEMA_VERSION adds the step from the version before when the change can be made in place (new tables and
 * indexes with CREATE IF NOT EXISTS as in SCHEMA, new columns with ALTER TABLE), so an update does not empty the copy.
 * A version without a step is rebuilt. None exist yet: the shapes before 9 are older than any release.
 */
export const MIGRATIONS: Readonly<Record<number, SchemaMigration>> = {}

/**
 * What opening did to a copy of an older version: nothing to say (`none`: the same version, a new copy, or steps that
 * needed no new sync), brought up in place and syncing again from the start (`migrated`), or emptied (`rebuilt`).
 */
export type CopyUpgrade = 'none' | 'migrated' | 'rebuilt'

/** Rows a filtered list scan reads at a time. */
const LIST_PAGE = 500

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail_accounts (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY NOT NULL, mail_account_id TEXT NOT NULL, role TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY NOT NULL, mail_account_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL, mail_account_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (thread_id);
CREATE INDEX IF NOT EXISTS messages_by_account ON messages (mail_account_id);
CREATE TABLE IF NOT EXISTS message_folders (message_id TEXT NOT NULL, folder_id TEXT NOT NULL, PRIMARY KEY (message_id, folder_id));
CREATE INDEX IF NOT EXISTS message_folders_by_folder ON message_folders (folder_id);
CREATE TABLE IF NOT EXISTS conversations (
  thread_id TEXT PRIMARY KEY NOT NULL,
  mail_account_id TEXT NOT NULL,
  inbox INTEGER NOT NULL,
  unread INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  smart_inbox_id TEXT,
  active INTEGER NOT NULL,
  batched_at INTEGER,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_by_inbox ON conversations (inbox, last_message_at);
CREATE INDEX IF NOT EXISTS conversations_by_account_inbox ON conversations (mail_account_id, inbox, last_message_at);
CREATE INDEX IF NOT EXISTS conversations_by_smart_inbox ON conversations (smart_inbox_id, active, last_message_at);
CREATE INDEX IF NOT EXISTS conversations_by_batch ON conversations (inbox, batched_at, last_message_at);
CREATE TABLE IF NOT EXISTS smart_inboxes (id TEXT PRIMARY KEY NOT NULL, builtin TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outgoing (id TEXT PRIMARY KEY NOT NULL, mail_account_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS outgoing_by_account ON outgoing (mail_account_id);
CREATE TABLE IF NOT EXISTS contacts (key TEXT PRIMARY KEY NOT NULL, last_seen INTEGER NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS contacts_by_last_seen ON contacts (last_seen);
CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY NOT NULL, mail_account_id TEXT, updated_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS drafts_by_updated_at ON drafts (updated_at);
CREATE TABLE IF NOT EXISTS signatures (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY NOT NULL, message_id TEXT, thread_id TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS todos_by_message ON todos (message_id);
CREATE INDEX IF NOT EXISTS todos_by_thread ON todos (thread_id);
CREATE TABLE IF NOT EXISTS unsubscriptions (id TEXT PRIMARY KEY NOT NULL, mail_account_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hand_overs (id TEXT PRIMARY KEY NOT NULL, mail_account_id TEXT NOT NULL, message_id TEXT, thread_id TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS hand_overs_by_account ON hand_overs (mail_account_id);
CREATE TABLE IF NOT EXISTS daily_briefs (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calendars (id TEXT PRIMARY KEY NOT NULL, mail_account_id TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY NOT NULL,
  calendar_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  series_starts_at INTEGER NOT NULL,
  series_ends_at INTEGER,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calendar_events_by_series ON calendar_events (calendar_id, uid);
CREATE INDEX IF NOT EXISTS calendar_events_by_series_start ON calendar_events (series_starts_at);
CREATE INDEX IF NOT EXISTS calendar_events_by_series_end ON calendar_events (series_ends_at);
`

/** Every table any version made, so a rebuild leaves none of an old shape behind. */
const TABLES = ['mail_accounts', 'folders', 'threads', 'messages', 'message_folders', 'conversations', 'outgoing', 'contacts', 'drafts', 'signatures', 'smart_inboxes', 'todos', 'unsubscriptions', 'hand_overs', 'daily_briefs', 'calendars', 'calendar_events', 'meta']

type JsonRow = { json: string }

function parse<T>(row: JsonRow): T {
  return JSON.parse(row.json) as T
}

/**
 * The signed-in user's mail in SQLite: everything the delta brings, a summary per thread for the lists, the people the
 * user exchanged mail with, and drafts. Used on the phone and on the desktop.
 */
export class SqliteMailStore implements MailStore {
  /** Set once the copy is being closed: pages that arrive later are refused. */
  private shutting = false
  /** Writes under way or queued, which closing waits for. */
  private readonly writing = new Set<Promise<void>>()
  /** Reads under way, which closing waits for too: on the desktop a running read keeps the file open. */
  private readonly reading = new Set<Promise<void>>()
  /** Where screens read from: the same database, with every read tracked for closing. */
  private readonly reader: Pick<Sql, 'all' | 'first'> = {
    all: (source, params) => this.track(this.sql.all(source, params)),
    first: (source, params) => this.track(this.sql.first(source, params)),
  }
  /**
   * The last write queued. Writes run one after another: on a device each exclusive transaction may open its own
   * connection without a busy timeout, so a second write while one is open would fail with "database is locked".
   */
  private queue: Promise<void> = Promise.resolve()
  /** Threads classified on this device whose server version has not arrived yet; see {@link restoreThread}. */
  private readonly unconfirmed = new OpenClassifications()
  /** Message actions of this device the server has not answered for yet; see {@link revertAction}. */
  private readonly openActions = new OpenActions()
  /** Set while the copy must sync from the start (see resyncFromStart); kept in the database too, so it holds after a restart. */
  private resyncing: boolean
  /** Raised by every page that changed calendars or events; see calendarChanges. */
  private calendarRevision = 0
  /** Counts the resyncs asked for, so one asked for while a pull from the start is finishing is not lost. */
  private resyncsAsked = 0
  /** Which resync the pull under way began from the start for, if it did; only then may its pages move the cursor. */
  private pullFromStartFor: number | null = null

  private constructor(
    private readonly sql: Sql,
    resyncing: boolean,
    /** What opening did to a copy of another version; see afterUpdate. */
    readonly upgrade: CopyUpgrade,
  ) {
    this.resyncing = resyncing
  }

  /**
   * Opens a copy, bringing one of another version to this one: in place with the steps in `migrations` (MIGRATIONS;
   * tests give their own, with the version they bring a copy to), else by a rebuild.
   */
  static async open(sql: Sql, options: { migrations?: Readonly<Record<number, SchemaMigration>>; version?: number } = {}): Promise<SqliteMailStore> {
    const target = options.version ?? SCHEMA_VERSION
    await sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)')
    const version = await sql.first<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema'])
    let upgrade: CopyUpgrade = 'none'
    if (version === null) {
      // A new copy (or one from before the version was kept): built from nothing, which is no update.
      await rebuild(sql, target)
    } else if (Number(version.value) !== target) {
      const steps = stepsBetween(Number(version.value), target, options.migrations ?? MIGRATIONS)
      if (steps === null) {
        await rebuild(sql, target)
        upgrade = 'rebuilt'
      } else {
        upgrade = (await migrate(sql, steps, target)) ? 'migrated' : 'none'
      }
    }
    const resync = await sql.first<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['resync'])
    return new SqliteMailStore(sql, resync !== null, upgrade)
  }

  /** An update changed the copy's shape when it was opened, and it syncs again from the start (see MailStore). */
  get afterUpdate(): boolean {
    return this.upgrade !== 'none'
  }

  async syncedAt(): Promise<number | null> {
    const row = await this.reader.first<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['syncedAt'])
    const at = row === null ? NaN : Number(row.value)
    return Number.isFinite(at) ? at : null
  }

  markSynced(at: number): Promise<void> {
    return this.write(async () => {
      await this.sql.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['syncedAt', String(at)])
    })
  }

  /** Refuses further writes and resolves once the ones under way are in, so the database can be closed. */
  async shut(): Promise<void> {
    this.shutting = true
    await Promise.allSettled([...this.writing])
  }

  async close(options: { waitMs?: number } = {}): Promise<void> {
    const finish = async (): Promise<void> => {
      await this.shut()
      // Reads that start while others finish (the next query of a thread, a screen still loading) are waited for too.
      // Between the last check and closing nothing is awaited, so no read can slip in to hold the file open.
      while (this.reading.size > 0) {
        await Promise.allSettled([...this.reading])
      }
    }
    if (options.waitMs === undefined) {
      await finish()
      await this.sql.close()
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), options.waitMs)
    })
    try {
      if ((await Promise.race([finish().then(() => 'done' as const), late])) === 'done') {
        await this.sql.close()
        return
      }
    } finally {
      clearTimeout(timer)
    }
    // A write or read that never answers (storage that hangs): closed anyway, without waiting for that either.
    console.error(`The mail copy's writes and reads did not finish within ${options.waitMs / 1000} seconds; it is closed anyway`)
    this.shutting = true
    void this.sql.close().catch((error: unknown) => console.error('Closing the mail copy failed', error))
  }

  private track<T>(read: Promise<T>): Promise<T> {
    const settled = read.then(
      () => undefined,
      () => undefined,
    )
    this.reading.add(settled)
    void settled.then(() => this.reading.delete(settled))
    return read
  }

  /**
   * Makes the next pull fetch everything again, so the copy is put right where it may differ from the server (a
   * change that could not be put back after the server refused it).
   */
  resyncFromStart(): Promise<void> {
    return this.write(async () => {
      // A pull already under way keeps the cursor it began from: its later pages are stored, but they no longer move
      // the cursor, so the next pull still begins from the start.
      this.resyncing = true
      this.resyncsAsked += 1
      await this.sql.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['resync', '1'])
    })
  }

  /** Where the next pull begins. The sync engine reads it once per pull, which is how a resync knows its pull began. */
  async cursor(): Promise<number> {
    if (this.resyncing) {
      this.pullFromStartFor = this.resyncsAsked
      return 0
    }
    const row = await this.reader.first<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['cursor'])
    return row === null ? 0 : Number(row.value)
  }

  apply(page: ChangePage): Promise<void> {
    return this.write(() => this.store(page))
  }

  /**
   * Every write goes through here: one at a time, refused once the copy is closing, and waited for when it closes. A
   * task must not call write() itself: it would wait behind its own turn forever.
   */
  private async write<T>(task: () => Promise<T>): Promise<T> {
    if (this.shutting) {
      throw new CopyClosingError()
    }
    const writing = this.queue.then(task)
    const settled = writing.then(
      () => undefined,
      () => undefined,
    )
    this.queue = settled
    this.writing.add(settled)
    try {
      return await writing
    } finally {
      this.writing.delete(settled)
    }
  }

  private async store(page: ChangePage): Promise<void> {
    let finished: number | null = null
    await this.sql.transaction(async (tx) => {
      const affected = new Set<string>()

      for (const deleted of page.deleted) {
        switch (deleted.type) {
          case 'mailAccount':
            await deleteAccount(tx, deleted.id)
            break
          case 'folder':
            for (const threadId of await threadsInFolder(tx, deleted.id)) {
              affected.add(threadId)
            }
            await tx.run('DELETE FROM message_folders WHERE folder_id = ?', [deleted.id])
            await tx.run('DELETE FROM folders WHERE id = ?', [deleted.id])
            break
          case 'thread':
            await tx.run('DELETE FROM threads WHERE id = ?', [deleted.id])
            affected.add(deleted.id)
            break
          case 'message': {
            const row = await tx.first<{ thread_id: string }>('SELECT thread_id FROM messages WHERE id = ?', [deleted.id])
            if (row !== null) {
              affected.add(row.thread_id)
              await tx.run('DELETE FROM message_folders WHERE message_id = ?', [deleted.id])
              await tx.run('DELETE FROM messages WHERE id = ?', [deleted.id])
            }
            break
          }
          case 'outgoingMessage':
            await tx.run('DELETE FROM outgoing WHERE id = ?', [deleted.id])
            break
          case 'signature':
            await tx.run('DELETE FROM signatures WHERE id = ?', [deleted.id])
            break
          case 'smartInbox':
            await tx.run('DELETE FROM smart_inboxes WHERE id = ?', [deleted.id])
            break
          case 'todo':
            await tx.run('DELETE FROM todos WHERE id = ?', [deleted.id])
            break
          case 'handOver':
            await tx.run('DELETE FROM hand_overs WHERE id = ?', [deleted.id])
            break
          case 'dailyBrief':
            await tx.run('DELETE FROM daily_briefs WHERE id = ?', [deleted.id])
            break
          case 'calendar':
            await deleteCalendar(tx, deleted.id)
            break
          case 'calendarEvent':
            await deleteCalendarEvent(tx, deleted.id)
            break
          case 'draft': {
            const local = await readDraft(tx, deleted.id)
            if (local !== null) {
              const kept = deletedDraft(local)
              await (kept === null ? tx.run('DELETE FROM drafts WHERE id = ?', [deleted.id]) : writeDraft(tx, kept))
            }
            break
          }
        }
      }

      for (const account of page.mailAccounts) {
        await tx.run('INSERT OR REPLACE INTO mail_accounts (id, json) VALUES (?, ?)', [account.id, JSON.stringify(account)])
      }
      for (const folder of page.folders) {
        const previous = await tx.first<{ role: string }>('SELECT role FROM folders WHERE id = ?', [folder.id])
        await tx.run('INSERT OR REPLACE INTO folders (id, mail_account_id, role, json) VALUES (?, ?, ?, ?)', [folder.id, folder.mailAccountId, folder.role, JSON.stringify(folder)])
        if (previous !== null && previous.role !== folder.role) {
          for (const threadId of await threadsInFolder(tx, folder.id)) {
            affected.add(threadId)
          }
        }
      }
      for (const signature of page.signatures) {
        await tx.run('INSERT OR REPLACE INTO signatures (id, json) VALUES (?, ?)', [signature.id, JSON.stringify(signature)])
      }
      for (const smartInbox of page.smartInboxes) {
        const known = await tx.first<{ id: string }>('SELECT id FROM smart_inboxes WHERE id = ?', [smartInbox.id])
        await tx.run('INSERT OR REPLACE INTO smart_inboxes (id, builtin, json) VALUES (?, ?, ?)', [smartInbox.id, smartInbox.builtin, JSON.stringify(smartInbox)])
        if (known === null && smartInbox.builtin === 'spam') {
          // The Spam smart inbox decides which conversations the inboxes leave out.
          for (const row of await tx.all<{ thread_id: string }>('SELECT thread_id FROM conversations')) {
            affected.add(row.thread_id)
          }
        }
      }
      for (const brief of page.dailyBriefs ?? []) {
        await tx.run('INSERT OR REPLACE INTO daily_briefs (id, json) VALUES (?, ?)', [brief.id, JSON.stringify(brief)])
      }
      for (const calendar of page.calendars) {
        await tx.run('INSERT OR REPLACE INTO calendars (id, mail_account_id, json) VALUES (?, ?, ?)', [calendar.id, calendar.mailAccountId, JSON.stringify(calendar)])
      }
      for (const event of page.calendarEvents) {
        await writeCalendarEvent(tx, event)
      }
      for (const thread of page.threads) {
        await writeThread(tx, thread)
        affected.add(thread.id)
        this.unconfirmed.confirmed(thread.id)
      }
      for (const message of page.messages) {
        const row = await tx.first<JsonRow>('SELECT json FROM messages WHERE id = ?', [message.id])
        const previous = row === null ? null : parse<SyncedMessage>(row)
        if (previous !== null && previous.threadId !== message.threadId) {
          affected.add(previous.threadId)
        }
        this.openActions.confirmed(message.id)
        await writeMessage(tx, message)
        affected.add(message.threadId)
        if (previous === null) {
          await rememberContacts(tx, message)
        }
      }
      for (const unsubscription of page.unsubscriptions ?? []) {
        await writeUnsubscription(tx, unsubscription)
      }
      for (const outgoing of page.outgoingMessages) {
        await tx.run('INSERT OR REPLACE INTO outgoing (id, mail_account_id, json) VALUES (?, ?, ?)', [outgoing.id, outgoing.mailAccountId, JSON.stringify(outgoing)])
      }
      for (const draft of page.drafts) {
        const next = syncedDraft(await readDraft(tx, draft.id), draft)
        if (next !== null) {
          await writeDraft(tx, next)
        }
      }
      for (const todo of page.todos) {
        await tx.run('INSERT OR REPLACE INTO todos (id, message_id, thread_id, json) VALUES (?, ?, ?, ?)', [todo.id, todo.messageId, todo.threadId, JSON.stringify(todo)])
      }
      for (const handOver of page.handOvers) {
        await tx.run('INSERT OR REPLACE INTO hand_overs (id, mail_account_id, message_id, thread_id, json) VALUES (?, ?, ?, ?, ?)', [handOver.id, handOver.mailAccountId, handOver.messageId, handOver.threadId, JSON.stringify(handOver)])
      }

      const lists = await listFoldersOf(tx)
      for (const threadId of affected) {
        await refreshConversation(tx, threadId, lists)
      }
      if (!this.resyncing) {
        await tx.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['cursor', String(page.cursor)])
      } else if (this.pullFromStartFor === this.resyncsAsked) {
        await tx.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['cursor', String(page.cursor)])
        await tx.run('DELETE FROM meta WHERE key = ?', ['resync'])
        finished = this.resyncsAsked
      }
    })
    if (touchesCalendars(page)) {
      this.calendarRevision += 1
    }
    // A resync asked for while this page was being stored still stands: the next pull begins from the start again.
    if (finished !== null && finished === this.resyncsAsked) {
      this.resyncing = false
      this.pullFromStartFor = null
    }
  }

  applyAction(messageIds: string[], action: MessageAction, folderId?: string, fromFolderId?: string): Promise<AppliedAction> {
    return this.write(async () => {
      let applied: AppliedAction = { before: [], after: [] }
      await this.sql.transaction(async (tx) => {
        const folders = (await tx.all<JsonRow>('SELECT json FROM folders')).map((row) => parse<SyncedFolder>(row))
        const accounts = (await tx.all<JsonRow>('SELECT json FROM mail_accounts')).map((row) => parse<SyncedMailAccount>(row))
        const before: SyncedMessage[] = []
        for (const id of messageIds) {
          const row = await tx.first<JsonRow>('SELECT json FROM messages WHERE id = ?', [id])
          if (row !== null) {
            before.push(parse<SyncedMessage>(row))
          }
        }
        const after = actionResult(before, action, { folders, accounts, folderId, fromFolderId })
        await rewrite(tx, after)
        applied = { before, after }
      })
      // Noted once written: a transaction that failed leaves nothing open.
      return { ...applied, id: this.openActions.applied(applied.before, applied.after) }
    })
  }

  acceptAction(applied: AppliedAction): void {
    const id = applied.id
    if (id !== undefined) {
      applied.before.forEach((message, index) => this.openActions.accepted(id, message, applied.after[index]!))
    }
  }

  revertAction(applied: AppliedAction): Promise<void> {
    return this.write(() =>
      this.sql.transaction(async (tx) => {
        const restore: SyncedMessage[] = []
        for (const [index, previous] of applied.before.entries()) {
          const row = await tx.first<JsonRow>('SELECT json FROM messages WHERE id = ?', [previous.id])
          const after = applied.after[index]
          const reverted = row === null || after === undefined || applied.id === undefined ? null : this.openActions.refused(applied.id, parse<SyncedMessage>(row), previous, after)
          if (reverted !== null) {
            restore.push(reverted)
          }
        }
        await rewrite(tx, restore)
      }),
    )
  }

  async handOvers(): Promise<SyncedHandOver[]> {
    // The conversation its message is in now; once that message is gone, the one the server keeps, if it is here.
    const rows = await this.reader.all<JsonRow & { thread_id: string | null }>(
      'SELECT h.json, COALESCE(m.thread_id, t.id) AS thread_id FROM hand_overs h LEFT JOIN messages m ON m.id = h.message_id LEFT JOIN threads t ON t.id = h.thread_id',
    )
    return rows.map((row) => ({ ...parse<SyncedHandOver>(row), threadId: row.thread_id })).sort(compareHandOvers)
  }

  async mailAccounts(): Promise<SyncedMailAccount[]> {
    const accounts = (await this.reader.all<JsonRow>('SELECT json FROM mail_accounts')).map((row) => parse<SyncedMailAccount>(row))
    return accounts.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.emailAddress.localeCompare(b.emailAddress))
  }

  async folders(): Promise<SyncedFolder[]> {
    return (await this.reader.all<JsonRow>('SELECT json FROM folders')).map((row) => parse<SyncedFolder>(row))
  }

  async signatures(): Promise<SyncedSignature[]> {
    const signatures = (await this.reader.all<JsonRow>('SELECT json FROM signatures')).map((row) => parse<SyncedSignature>(row))
    return signatures.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  async calendars(): Promise<SyncedCalendar[]> {
    return sortCalendars((await this.reader.all<JsonRow>('SELECT json FROM calendars')).map((row) => parse<SyncedCalendar>(row)))
  }

  async calendarEvents(from: number, to: number): Promise<SyncedCalendarEvent[]> {
    // Every row carries the span of its whole series, so one query finds the series that touch the range with all
    // their rows: an override moved out of the range still takes its occurrence away.
    const rows = await this.reader.all<JsonRow>('SELECT json FROM calendar_events WHERE series_starts_at < ? AND (series_ends_at IS NULL OR series_ends_at > ?)', [to, from])
    return rows.map((row) => parse<SyncedCalendarEvent>(row))
  }

  calendarChanges(): number {
    return this.calendarRevision
  }

  async calendarEvent(id: string): Promise<SyncedCalendarEvent | null> {
    const row = await this.reader.first<JsonRow>('SELECT json FROM calendar_events WHERE id = ?', [id])
    return row === null ? null : parse<SyncedCalendarEvent>(row)
  }

  async smartInboxes(): Promise<SyncedSmartInbox[]> {
    return sortSmartInboxes((await this.reader.all<JsonRow>('SELECT json FROM smart_inboxes')).map((row) => parse<SyncedSmartInbox>(row)))
  }

  async dailyBriefs(): Promise<SyncedDailyBrief[]> {
    return (await this.reader.all<JsonRow>('SELECT json FROM daily_briefs')).map((row) => parse<SyncedDailyBrief>(row)).sort(compareBriefs)
  }

  async conversations(threadIds: string[]): Promise<ConversationSummary[]> {
    const found = new Map<string, ConversationSummary>()
    const unique = [...new Set(threadIds)]
    for (const chunk of chunks(unique)) {
      for (const row of await this.reader.all<JsonRow>(`SELECT json FROM conversations WHERE thread_id IN (${placeholders(chunk)})`, chunk)) {
        const conversation = parse<ConversationSummary>(row)
        found.set(conversation.threadId, conversation)
      }
    }
    return unique.flatMap((threadId) => found.get(threadId) ?? [])
  }

  inbox(mailAccountId: string | null, limit: number): Promise<ConversationSummary[]> {
    return this.list({ kind: 'inbox', mailAccountId }, limit)
  }

  async list(scope: ListScope, limit: number): Promise<ConversationSummary[]> {
    const [where, params] = listWhere(scope)
    const rows = await this.reader.all<JsonRow>(`SELECT json FROM conversations WHERE ${where} ORDER BY ${listOrder(scope)} LIMIT ?`, [...params, limit])
    return rows.map((row) => parse<ConversationSummary>(row))
  }

  async listThreadIds(scope: ListScope, matches: (conversation: ConversationSummary) => boolean, limit?: number): Promise<string[]> {
    const [where, params] = listWhere(scope)
    const ids: string[] = []
    // In pages, so a limit stops the scan early.
    for (let offset = 0; limit === undefined || ids.length < limit; offset += LIST_PAGE) {
      const rows = await this.reader.all<JsonRow>(
        `SELECT json FROM conversations WHERE ${where} ORDER BY ${listOrder(scope)} LIMIT ? OFFSET ?`,
        [...params, LIST_PAGE, offset],
      )
      for (const row of rows) {
        const conversation = parse<ConversationSummary>(row)
        if (matches(conversation) && (limit === undefined || ids.length < limit)) {
          ids.push(conversation.threadId)
        }
      }
      if (rows.length < LIST_PAGE) {
        break
      }
    }
    return ids
  }

  async summaries(threadIds: string[]): Promise<ConversationSummary[]> {
    const found: ConversationSummary[] = []
    for (const chunk of chunks(threadIds)) {
      for (const row of await this.reader.all<JsonRow>(`SELECT json FROM conversations WHERE thread_id IN (${placeholders(chunk)})`, chunk)) {
        found.push(parse<ConversationSummary>(row))
      }
    }
    return found
  }

  async describeThreads(scope: ListScope, threadIds: string[]): Promise<{ present: string[]; accounts: string[]; senders: string[] }> {
    const found = new Map<string, ConversationSummary>()
    for (const chunk of chunks(threadIds)) {
      for (const row of await this.reader.all<JsonRow>(`SELECT json FROM conversations WHERE thread_id IN (${placeholders(chunk)})`, chunk)) {
        const conversation = parse<ConversationSummary>(row)
        found.set(conversation.threadId, conversation)
      }
    }
    const present: string[] = []
    const accounts = new Set<string>()
    const senders = new Set<string>()
    for (const threadId of threadIds) {
      const conversation = found.get(threadId)
      if (conversation === undefined || !inList(conversation, scope)) {
        continue
      }
      present.push(threadId)
      accounts.add(conversation.mailAccountId)
      for (const sender of conversation.senders) {
        senders.add(sender.address.toLowerCase())
      }
    }
    return { present, accounts: [...accounts], senders: [...senders] }
  }

  async messageIdsOfThreads(threadIds: string[]): Promise<string[]> {
    return [...(await this.messagesByThread(threadIds)).values()].flat()
  }

  async messagesByThread(threadIds: string[]): Promise<Map<string, string[]>> {
    const byThread = new Map<string, string[]>(threadIds.map((threadId) => [threadId, []]))
    // Each thread once, however often it is asked for, so no message is listed twice.
    for (const chunk of chunks([...byThread.keys()])) {
      for (const row of await this.reader.all<{ id: string; thread_id: string }>(`SELECT id, thread_id FROM messages WHERE thread_id IN (${placeholders(chunk)}) ORDER BY id`, chunk)) {
        byThread.get(row.thread_id)?.push(row.id)
      }
    }
    return byThread
  }

  async unreadInboxCounts(): Promise<Map<string, number>> {
    const rows = await this.reader.all<{ id: string; count: number }>(
      'SELECT a.id, COUNT(c.thread_id) AS count FROM mail_accounts a LEFT JOIN conversations c ON c.mail_account_id = a.id AND c.inbox = 1 AND c.unread = 1 GROUP BY a.id',
    )
    return new Map(rows.map((row) => [row.id, Number(row.count)]))
  }

  async unreadSmartInboxCounts(): Promise<Map<string, number>> {
    const rows = await this.reader.all<{ id: string; count: number }>(
      'SELECT s.id, COUNT(c.thread_id) AS count FROM smart_inboxes s LEFT JOIN conversations c ON c.smart_inbox_id = s.id AND c.active = 1 AND c.unread = 1 GROUP BY s.id',
    )
    return new Map(rows.map((row) => [row.id, Number(row.count)]))
  }

  classifyThread(threadId: string, smartInboxId: string, verdict: Verdict): Promise<SyncedThread | null> {
    return this.write(async () => {
      let previous: SyncedThread | null = null
      await this.sql.transaction(async (tx) => {
        const row = await tx.first<JsonRow>('SELECT json FROM threads WHERE id = ?', [threadId])
        if (row === null) {
          return
        }
        previous = parse<SyncedThread>(row)
        await writeThread(tx, classifiedByUser(previous, smartInboxId, verdict))
        this.unconfirmed.opened(previous, { smartInboxId, verdict })
        await refreshConversation(tx, threadId, await listFoldersOf(tx))
      })
      return previous
    })
  }

  restoreThread(previous: SyncedThread): Promise<void> {
    return this.write(() =>
      this.sql.transaction(async (tx) => {
        const row = await tx.first<JsonRow>('SELECT json FROM threads WHERE id = ?', [previous.id])
        // Once the server's version arrived it stays, also when it is the same placement: the request went through.
        const restore = this.unconfirmed.failed(previous.id, row === null ? null : parse<SyncedThread>(row))
        if (restore !== null) {
          await writeThread(tx, restore)
          await refreshConversation(tx, restore.id, await listFoldersOf(tx))
        }
      }),
    )
  }

  async unsubscriptions(): Promise<SyncedUnsubscription[]> {
    return (await this.reader.all<JsonRow>('SELECT json FROM unsubscriptions ORDER BY id')).map((row) => parse<SyncedUnsubscription>(row))
  }

  noteUnsubscription(unsubscription: SyncedUnsubscription): Promise<void> {
    return this.write(async () => {
      const row = await this.sql.first<JsonRow>('SELECT json FROM unsubscriptions WHERE id = ?', [unsubscription.id])
      if (newerUnsubscription(row === null ? null : parse<SyncedUnsubscription>(row), unsubscription)) {
        await writeUnsubscription(this.sql, unsubscription)
      }
    })
  }

  async outbox(): Promise<SyncedOutgoingMessage[]> {
    const all = (await this.reader.all<JsonRow>('SELECT json FROM outgoing')).map((row) => parse<SyncedOutgoingMessage>(row))
    return all.filter((message) => message.status !== 'sent' && message.status !== 'cancelled').sort((a, b) => b.sendAt.localeCompare(a.sendAt))
  }

  async outgoing(id: string): Promise<SyncedOutgoingMessage | null> {
    const row = await this.reader.first<JsonRow>('SELECT json FROM outgoing WHERE id = ?', [id])
    return row === null ? null : parse<SyncedOutgoingMessage>(row)
  }

  async suggestContacts(query: string, limit: number): Promise<Contact[]> {
    const result: Contact[] = []
    for (const row of await this.reader.all<JsonRow>('SELECT json FROM contacts ORDER BY last_seen DESC, key DESC')) {
      if (result.length >= limit) {
        break
      }
      const contact = parse<Contact>(row)
      if (contactMatches(contact, query)) {
        result.push(contact)
      }
    }
    return result
  }

  saveDraft(draft: Draft): Promise<void> {
    return this.write(() => writeDraft(this.sql, draft))
  }

  changeDraft(id: string, change: (stored: Draft | null) => Draft | null): Promise<Draft | null> {
    return this.write(async () => {
      const stored = await readDraft(this.sql, id)
      const next = change(stored)
      if (next === null) {
        return stored
      }
      await writeDraft(this.sql, next)
      return next
    })
  }

  async drafts(): Promise<Draft[]> {
    return (await this.reader.all<JsonRow>('SELECT json FROM drafts ORDER BY updated_at DESC, id DESC')).map((row) => storedDraft(parse<Draft>(row)))
  }

  draft(id: string): Promise<Draft | null> {
    return readDraft(this.reader, id)
  }

  deleteDraft(id: string): Promise<void> {
    return this.write(() => this.sql.run('DELETE FROM drafts WHERE id = ?', [id]))
  }

  async thread(threadId: string): Promise<{ thread: SyncedThread; messages: SyncedMessage[] } | null> {
    const row = await this.reader.first<JsonRow>('SELECT json FROM threads WHERE id = ?', [threadId])
    if (row === null) {
      return null
    }
    const messages = (await this.reader.all<JsonRow>('SELECT json FROM messages WHERE thread_id = ?', [threadId])).map((m) => parse<SyncedMessage>(m))
    messages.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
    return { thread: parse<SyncedThread>(row), messages }
  }

  async messages(ids: string[]): Promise<SyncedMessage[]> {
    const found = new Map<string, SyncedMessage>()
    for (const chunk of chunks([...new Set(ids)])) {
      for (const row of await this.reader.all<JsonRow>(`SELECT json FROM messages WHERE id IN (${placeholders(chunk)})`, chunk)) {
        const message = parse<SyncedMessage>(row)
        found.set(message.id, message)
      }
    }
    return ids.flatMap((id) => found.get(id) ?? [])
  }

  async todos(): Promise<SyncedTodo[]> {
    return (await this.reader.all<JsonRow>('SELECT json FROM todos')).map((row) => parse<SyncedTodo>(row)).sort(compareTodos)
  }

  async todo(id: string): Promise<SyncedTodo | null> {
    const row = await this.reader.first<JsonRow>('SELECT json FROM todos WHERE id = ?', [id])
    return row === null ? null : parse<SyncedTodo>(row)
  }

  async todosOfThread(threadId: string): Promise<SyncedTodo[]> {
    // A message can move to another thread after its todo was made: the thread of the message on this device wins.
    const rows = await this.reader.all<{ json: string; message_thread_id: string | null }>(
      'SELECT t.json, m.thread_id AS message_thread_id FROM todos t LEFT JOIN messages m ON m.id = t.message_id WHERE t.thread_id = ? OR m.thread_id = ?',
      [threadId, threadId],
    )
    return rows
      .filter((row) => (row.message_thread_id ?? parse<SyncedTodo>(row).threadId) === threadId)
      .map((row) => parse<SyncedTodo>(row))
      .sort(compareTodos)
  }
}

/** The steps from one version to a later one, in order; null when one is missing or the copy is of a newer version. */
function stepsBetween(from: number, to: number, migrations: Readonly<Record<number, SchemaMigration>>): SchemaMigration[] | null {
  if (!Number.isSafeInteger(from) || from > to) {
    return null
  }
  const steps: SchemaMigration[] = []
  for (let version = from; version < to; version++) {
    const step = migrations[version]
    if (step === undefined) {
      return null
    }
    steps.push(step)
  }
  return steps
}

/**
 * Runs the steps in one transaction and marks the copy for a sync from the start when one of them asks for it, which it
 * returns. Kept rows stay; a failed step leaves the copy as it was.
 */
async function migrate(sql: Sql, steps: SchemaMigration[], target: number): Promise<boolean> {
  const resync = steps.some((step) => step.resync)
  await sql.transaction(async (tx) => {
    for (const step of steps) {
      await tx.exec(step.sql)
    }
    await tx.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['schema', String(target)])
    if (resync) {
      await tx.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['resync', '1'])
    }
  })
  return resync
}

/** Drops every table and builds the current shape in one go, keeping the drafts that exist only on this device. */
async function rebuild(sql: Sql, version: number = SCHEMA_VERSION): Promise<void> {
  await sql.transaction(async (tx) => {
    const hasDrafts = (await tx.first('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['table', 'drafts'])) !== null
    const kept = hasDrafts ? (await tx.all<JsonRow>('SELECT json FROM drafts')).map((row) => parse<Draft>(row)).filter(draftOnlyHere) : []
    for (const table of TABLES) {
      await tx.exec(`DROP TABLE IF EXISTS ${table}`)
    }
    await tx.exec(SCHEMA)
    await tx.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['schema', String(version)])
    for (const draft of kept) {
      // The server version they built on may be gone with the old copy; uploading starts from scratch.
      await writeDraft(tx, { ...draft, version: 0, remoteVersion: null })
    }
  })
}

/** SQLite takes at most 999 parameters in older builds; lists are queried in parts below that. */
const CHUNK = 500

function chunks(values: string[]): string[][] {
  const parts: string[][] = []
  for (let start = 0; start < values.length; start += CHUNK) {
    parts.push(values.slice(start, start + CHUNK))
  }
  return parts
}

function placeholders(values: SqlValue[]): string {
  return values.map(() => '?').join(', ')
}

async function writeMessage(tx: Sql, message: SyncedMessage): Promise<void> {
  await tx.run('INSERT OR REPLACE INTO messages (id, thread_id, mail_account_id, json) VALUES (?, ?, ?, ?)', [message.id, message.threadId, message.mailAccountId, JSON.stringify(message)])
  await tx.run('DELETE FROM message_folders WHERE message_id = ?', [message.id])
  for (const folderId of new Set(message.folderIds)) {
    await tx.run('INSERT INTO message_folders (message_id, folder_id) VALUES (?, ?)', [message.id, folderId])
  }
}

async function writeUnsubscription(tx: Sql, unsubscription: SyncedUnsubscription): Promise<void> {
  await tx.run('INSERT OR REPLACE INTO unsubscriptions (id, mail_account_id, json) VALUES (?, ?, ?)', [unsubscription.id, unsubscription.mailAccountId, JSON.stringify(unsubscription)])
}

async function writeThread(tx: Sql, thread: SyncedThread): Promise<void> {
  await tx.run('INSERT OR REPLACE INTO threads (id, mail_account_id, json) VALUES (?, ?, ?)', [thread.id, thread.mailAccountId, JSON.stringify(thread)])
}

async function rewrite(tx: Sql, messages: SyncedMessage[]): Promise<void> {
  const affected = new Set<string>()
  for (const message of messages) {
    await writeMessage(tx, message)
    affected.add(message.threadId)
  }
  const lists = await listFoldersOf(tx)
  for (const threadId of affected) {
    await refreshConversation(tx, threadId, lists)
  }
}

async function readDraft(sql: Pick<Sql, 'first'>, id: string): Promise<Draft | null> {
  const row = await sql.first<JsonRow>('SELECT json FROM drafts WHERE id = ?', [id])
  return row === null ? null : storedDraft(parse<Draft>(row))
}

async function writeDraft(sql: Sql, draft: Draft): Promise<void> {
  await sql.run('INSERT OR REPLACE INTO drafts (id, mail_account_id, updated_at, json) VALUES (?, ?, ?, ?)', [draft.id, draft.mailAccountId, draft.updatedAt, JSON.stringify(draft)])
}

async function rememberContacts(tx: Sql, message: SyncedMessage): Promise<void> {
  const at = Date.parse(message.receivedAt)
  for (const { key, person } of peopleOn(message)) {
    const row = await tx.first<JsonRow>('SELECT json FROM contacts WHERE key = ?', [key])
    const contact = mergeContact(row === null ? null : parse<Contact>(row), key, person, at)
    await tx.run('INSERT OR REPLACE INTO contacts (key, last_seen, json) VALUES (?, ?, ?)', [key, contact.lastSeen, JSON.stringify(contact)])
  }
}

async function threadsInFolder(tx: Sql, folderId: string): Promise<string[]> {
  const rows = await tx.all<{ thread_id: string }>('SELECT DISTINCT m.thread_id FROM messages m JOIN message_folders f ON f.message_id = m.id WHERE f.folder_id = ?', [folderId])
  return rows.map((row) => row.thread_id)
}

async function inboxFolderIds(tx: Sql): Promise<Set<string>> {
  return new Set((await tx.all<{ id: string }>("SELECT id FROM folders WHERE role = 'inbox'")).map((row) => row.id))
}

async function listFoldersOf(tx: Sql): Promise<ListFolders> {
  const spam = await tx.first<{ id: string }>("SELECT id FROM smart_inboxes WHERE builtin = 'spam'")
  return {
    inboxFolderIds: await inboxFolderIds(tx),
    spamFolderIds: new Set((await tx.all<{ id: string }>("SELECT id FROM folders WHERE role = 'spam'")).map((row) => row.id)),
    spamSmartInboxId: spam?.id ?? null,
  }
}

/** The WHERE clause of a list and its parameters; the indexes on conversations cover each. */
function listWhere(scope: ListScope): [string, SqlValue[]] {
  if (scope.kind === 'smartInbox') {
    return ['smart_inbox_id = ? AND active = 1', [scope.smartInboxId]]
  }
  if (scope.kind === 'batch') {
    return ['inbox = 1 AND batched_at IS NOT NULL', []]
  }
  return scope.mailAccountId === null ? ['inbox = 1', []] : ['mail_account_id = ? AND inbox = 1', [scope.mailAccountId]]
}

/** Newest first; the batches by batch first. */
function listOrder(scope: ListScope): string {
  return scope.kind === 'batch' ? 'batched_at DESC, last_message_at DESC, thread_id DESC' : 'last_message_at DESC, thread_id DESC'
}

async function deleteAccount(tx: Sql, accountId: string): Promise<void> {
  // Drafts outlive the account they were written from; they keep their text and need a new one to send.
  for (const row of await tx.all<JsonRow>('SELECT json FROM drafts WHERE mail_account_id = ?', [accountId])) {
    await writeDraft(tx, { ...parse<Draft>(row), mailAccountId: null })
  }
  await tx.run('DELETE FROM message_folders WHERE message_id IN (SELECT id FROM messages WHERE mail_account_id = ?)', [accountId])
  for (const table of ['messages', 'threads', 'folders', 'conversations', 'outgoing', 'unsubscriptions', 'hand_overs']) {
    await tx.run(`DELETE FROM ${table} WHERE mail_account_id = ?`, [accountId])
  }
  // The account's calendars go with it.
  for (const row of await tx.all<{ id: string }>('SELECT id FROM calendars WHERE mail_account_id = ?', [accountId])) {
    await deleteCalendar(tx, row.id)
  }
  await tx.run('DELETE FROM mail_accounts WHERE id = ?', [accountId])
}

async function writeCalendarEvent(tx: Sql, event: SyncedCalendarEvent): Promise<void> {
  const previous = await tx.first<{ calendar_id: string; uid: string }>('SELECT calendar_id, uid FROM calendar_events WHERE id = ?', [event.id])
  const span = eventSpan(event)
  await tx.run('INSERT OR REPLACE INTO calendar_events (id, calendar_id, uid, starts_at, ends_at, series_starts_at, series_ends_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    event.id,
    event.calendarId,
    event.uid,
    span.startsAt,
    span.endsAt,
    span.startsAt,
    span.endsAt,
    JSON.stringify(event),
  ])
  await spanSeries(tx, event.calendarId, event.uid)
  if (previous !== null && (previous.calendar_id !== event.calendarId || previous.uid !== event.uid)) {
    await spanSeries(tx, previous.calendar_id, previous.uid)
  }
}

async function deleteCalendarEvent(tx: Sql, id: string): Promise<void> {
  const row = await tx.first<{ calendar_id: string; uid: string }>('SELECT calendar_id, uid FROM calendar_events WHERE id = ?', [id])
  await tx.run('DELETE FROM calendar_events WHERE id = ?', [id])
  if (row !== null) {
    await spanSeries(tx, row.calendar_id, row.uid)
  }
}

/** Gives every row of a series the span of the whole series: from its earliest start to its latest end, if any. */
async function spanSeries(tx: Sql, calendarId: string, uid: string): Promise<void> {
  const rows = await tx.all<{ starts_at: number; ends_at: number | null }>('SELECT starts_at, ends_at FROM calendar_events WHERE calendar_id = ? AND uid = ?', [calendarId, uid])
  if (rows.length === 0) {
    return
  }
  const startsAt = Math.min(...rows.map((row) => row.starts_at))
  const endsAt = rows.some((row) => row.ends_at === null) ? null : Math.max(...rows.map((row) => row.ends_at as number))
  await tx.run('UPDATE calendar_events SET series_starts_at = ?, series_ends_at = ? WHERE calendar_id = ? AND uid = ?', [startsAt, endsAt, calendarId, uid])
}

async function deleteCalendar(tx: Sql, calendarId: string): Promise<void> {
  await tx.run('DELETE FROM calendar_events WHERE calendar_id = ?', [calendarId])
  await tx.run('DELETE FROM calendars WHERE id = ?', [calendarId])
}

async function refreshConversation(tx: Sql, threadId: string, lists: ListFolders): Promise<void> {
  const thread = await tx.first<JsonRow>('SELECT json FROM threads WHERE id = ?', [threadId])
  const messages = thread === null ? [] : (await tx.all<JsonRow>('SELECT json FROM messages WHERE thread_id = ?', [threadId])).map((row) => parse<SyncedMessage>(row))
  const summary = thread === null ? null : summarizeConversation(parse<SyncedThread>(thread), messages, lists)
  if (summary === null) {
    await tx.run('DELETE FROM conversations WHERE thread_id = ?', [threadId])
    return
  }
  await tx.run(
    'INSERT OR REPLACE INTO conversations (thread_id, mail_account_id, inbox, unread, last_message_at, smart_inbox_id, active, batched_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [threadId, summary.mailAccountId, summary.inbox ? 1 : 0, summary.unreadCount > 0 ? 1 : 0, summary.lastMessageAt, summary.smartInboxId, summary.active ? 1 : 0, summary.batchedAt, JSON.stringify(summary)],
  )
}
