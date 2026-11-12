import {
  appliedFor,
  backfillChats,
  MAX_MESSAGES_PER_ACTION,
  PartialActionError,
  RealtimeClient,
  SyncEngine,
  type AppliedAction,
  type ChangePage,
  type MessageAction,
  type MessageActionRequest,
  type RealtimeAccess,
  type Sql,
  type SyncedHandOver,
  deliveredNotices,
  noticeKey,
  type ThreadClassification,
  type ThreadClassificationRequest,
  type Verdict,
  CopyClosingError,
  DraftSync,
  SqliteMailStore,
  SyncStatusMachine,
  type SyncStatus,
  unsubscribeOffer,
  type DraftApi,
  type SyncedUnsubscription,
  type UnsubscribeOffer,
  type UnsubscribeRequest,
} from '@tresso/core'

const PAGE_SIZE = 500
/** Lists every user's copy that exists on the device, so a copy left behind is found and removed later. */
const INDEX = 'tresso-mail-index.db'

export type SyncState = 'idle' | 'syncing' | 'error'

export interface MailState {
  userId: string | null
  ready: boolean
  /**
   * The first pull after opening the copy is over (done, or failed while offline): the copy holds what the server had,
   * not only what was stored before. Screens that decide over all mail (triage) wait for it.
   */
  synced: boolean
  /** Goes up whenever the local copy changed, so screens read it again. */
  version: number
  syncState: SyncState
  syncError: string | null
  /** The realtime connection is up, so changes arrive as they happen. */
  live: boolean
  /** What the inbox says about the sync (see describeSync): getting the mail, catching up, up to date, reconnecting. */
  status: SyncStatus
  /**
   * Pulls of the delta that completed: a screen opened from a notification waits for one after it opened before it
   * says a conversation is not there (it may not have reached the copy yet).
   */
  pulls: number
}

export interface MailSessionDeps {
  openSql(name: string): Promise<Sql & { close(): Promise<void> }>
  deleteSql(name: string): Promise<void>
  fetchPage(since: number, limit: number): Promise<ChangePage>
  /** GET /api/v1/chat-accounts, for the one check of a copy updated to keep chats (see backfillChats). */
  fetchChatAccounts(): Promise<readonly unknown[]>
  /** GET /api/v1/realtime/token; `signal` aborts when the stream stops (a sign-out), so nothing waits for it. */
  fetchAccess(signal: AbortSignal): Promise<RealtimeAccess>
  /** The time on the server's clock (epoch ms), which hub tokens expire by; the device's by default. */
  serverNow?(): number
  /** POST /api/v1/message-actions */
  postAction(request: MessageActionRequest): Promise<void>
  /** POST /api/v1/unsubscriptions */
  postUnsubscribe(request: UnsubscribeRequest): Promise<SyncedUnsubscription>
  /** PUT /api/v1/threads/{id}/classification */
  classify(threadId: string, request: ThreadClassificationRequest): Promise<ThreadClassification>
  /**
   * DELETE /api/v1/threads/{id}/classification?placementId=: 'moved' when the server refuses because the conversation
   * was placed again since (409).
   */
  release(threadId: string, placementId: string): Promise<'released' | 'moved'>
  /** /api/v1/drafts */
  drafts: DraftApi
  fetch?: typeof fetch
  onState(state: MailState): void
  /**
   * Overdue notices the server delivered for hand-overs (see `deliveredNotices`), for the app to tell the user about,
   * each once. Those the first pull of a copy brings are old news (the device was away), so they are left out.
   */
  onOverdue?(handOvers: SyncedHandOver[]): void
  /** Whether the app is in front when the session starts (it can be launched in the background). */
  foreground?: boolean
}

interface Open {
  userId: string
  sql: Sql & { close(): Promise<void> }
  database: SqliteMailStore
  engine: SyncEngine
  realtime: RealtimeClient
  /** When the first pull completed: from then on, overdue notices the server delivers are news. */
  tellingSince: number | null
  /** The overdue notices told about (see `noticeKey`). */
  told: Set<string>
}

/** The status while no copy is open. */
export const NO_STATUS: SyncStatus = { kind: 'closed', text: '', fraction: null, remaining: null, notice: null, problem: null, announcement: '' }

export function databaseName(userId: string): string {
  return `mail-${userId}.db`
}

/**
 * The lifecycle of the mail copies on the device: which user's copy is open, kept current, and closed again; the
 * copies of everyone else are removed. Switches run one after another and every step is awaited, so a copy is only
 * deleted once it is closed and a sign-out during opening leaves nothing behind.
 */
export class MailSession {
  private state: MailState = { userId: null, ready: false, synced: false, version: 0, syncState: 'idle', syncError: null, live: false, pulls: 0, status: NO_STATUS }
  /** The facts of the sync of the open copy, told as one status (shared with the web and desktop clients). */
  private readonly status = new SyncStatusMachine({ onChange: (status) => this.update({ status }) })
  private queue: Promise<void> = Promise.resolve()
  /** Goes up with every switch asked for: a switch that a newer one replaced stops where it is. */
  private wanted = 0
  private open: Open | null = null
  private foreground: boolean
  /** Brings drafts written on the phone to the server, for whichever copy is open. */
  readonly drafts: DraftSync

  constructor(private readonly deps: MailSessionDeps) {
    this.foreground = deps.foreground ?? true
    this.drafts = new DraftSync(() => this.database, deps.drafts, () => this.changed())
  }

  get database(): SqliteMailStore | null {
    return this.open?.database ?? null
  }

  /** Opens this user's copy (null: the user signed out) and removes everyone else's. */
  switchTo(userId: string | null): Promise<void> {
    const switchId = ++this.wanted
    return this.enqueue(() => this.apply(userId, switchId))
  }

  /**
   * Closes the open copy and keeps it on the device: the sign-in ended without the user signing out (it expired, or
   * it could not be read), so the drafts in it are still there when the user signs in again. Copies an earlier
   * sign-out or switch could not remove are removed now.
   */
  closeCopy(): Promise<void> {
    ++this.wanted
    return this.enqueue(async () => {
      await this.close()
      await this.removeMarkedCopies()
    })
  }

  /** The app came to the front (listen and catch up) or went to the background (the connection rests). */
  setForeground(active: boolean): void {
    this.foreground = active
    const open = this.open
    if (open === null) {
      return
    }
    if (active) {
      open.realtime.start()
      void this.pull(open, () => open.engine.sync())
    } else {
      this.update({ live: false })
      this.status.streamStopped()
      void open.realtime.stop()
    }
  }

  /**
   * Reads, flags, archives, trashes or moves messages: the change shows at once and is undone for the messages the
   * server did not take. Large selections go in batches; when a later batch fails, a PartialActionError carries what
   * went through. Returns the messages before and after, for an undo.
   */
  async act(messageIds: string[], action: MessageAction, target: { folderId?: string; fromFolderId?: string } = {}): Promise<AppliedAction> {
    if (messageIds.length === 0) {
      return { before: [], after: [] }
    }
    const database = this.database
    if (database === null) {
      throw new Error('Your mail is not open on this phone yet.')
    }
    const applied = await database.applyAction(messageIds, action, target.folderId, target.fromFolderId)
    this.changed()
    let accepted = 0
    try {
      for (let start = 0; start < messageIds.length; start += MAX_MESSAGES_PER_ACTION) {
        const request: MessageActionRequest = { messageIds: messageIds.slice(start, start + MAX_MESSAGES_PER_ACTION), action, ...target }
        await this.deps.postAction(request)
        database.acceptAction(appliedFor(applied, new Set(request.messageIds)))
        accepted = start + request.messageIds.length
      }
    } catch (error) {
      // Earlier batches went through; only the rest goes back. A copy closing meanwhile is about to be removed, so
      // there is nothing to put back; either way the user hears why the action failed, not why the undo did.
      let resyncing = false
      try {
        await database.revertAction(appliedFor(applied, new Set(messageIds.slice(accepted))))
      } catch (revertError) {
        if (!(revertError instanceof CopyClosingError)) {
          // The phone still shows a change the server never made, and no page of the delta would mention those
          // messages: the copy syncs from the start, which puts them right. If even that cannot be asked for, the
          // user hears only why the action failed.
          resyncing = await database.resyncFromStart().then(
            () => true,
            () => false,
          )
        }
      }
      const failure = resyncing ? new Error(`${message(error)} This phone shows the change until it has synced your mail again.`) : error
      this.changed()
      void this.syncNow()
      if (accepted > 0) {
        throw new PartialActionError(failure, appliedFor(applied, new Set(messageIds.slice(0, accepted))), messageIds.length - accepted)
      }
      throw failure
    }
    void this.syncNow()
    return applied
  }

  /**
   * What a conversation offers for one-click unsubscribe (see `unsubscribeOffer`); nothing for spam, which is never
   * answered.
   */
  async unsubscribeOffer(threadId: string): Promise<UnsubscribeOffer | null> {
    const database = this.database
    const found = await database?.thread(threadId)
    if (!database || !found) {
      return null
    }
    const spam = (await database.smartInboxes()).find((smartInbox) => smartInbox.builtin === 'spam')
    if (spam !== undefined && found.thread.smartInboxId === spam.id) {
      return null
    }
    return unsubscribeOffer(found.messages, await database.unsubscriptions())
  }

  /**
   * Unsubscribes the account that received a message from its sender. The request shows at once (the button goes);
   * its outcome arrives with the delta.
   */
  async unsubscribe(messageId: string): Promise<SyncedUnsubscription> {
    const database = this.database
    if (database === null) {
      throw new Error('Your mail is not open on this phone yet.')
    }
    const unsubscription = await this.deps.postUnsubscribe({ messageId })
    await database.noteUnsubscription(unsubscription)
    this.changed()
    void this.syncNow()
    return unsubscription
  }

  /**
   * Puts a conversation where the user says, with this verdict: shown at once, put back when the server refuses (unless
   * the delta brought its version since). With `remember` false only this conversation moves (triage).
   */
  async classifyThread(threadId: string, smartInboxId: string, verdict: Verdict, remember: boolean): Promise<ThreadClassification> {
    const database = this.database
    if (database === null) {
      throw new Error('Your mail is not open on this phone yet.')
    }
    const previous = await database.classifyThread(threadId, smartInboxId, verdict)
    this.changed()
    try {
      const result = await this.deps.classify(threadId, remember ? { smartInboxId, verdict } : { smartInboxId, verdict, remember: false })
      void this.syncNow()
      return result
    } catch (error) {
      if (previous !== null) {
        await database.restoreThread(previous)
        this.changed()
      }
      void this.syncNow()
      throw error
    }
  }

  /**
   * Takes back the user's placement `placementId` of a conversation; the server's rules place it again, which the pull
   * right after brings. 'moved' when it was placed again since, and that choice stays.
   */
  async releaseThread(threadId: string, placementId: string): Promise<'released' | 'moved'> {
    const outcome = await this.deps.release(threadId, placementId)
    if (outcome === 'released') {
      await this.syncNow()
    }
    return outcome
  }

  /** The copy changed outside a pull (an action shown before the server confirms it): screens read it again. */
  changed(): void {
    this.update({ version: this.state.version + 1 })
  }

  syncNow(): Promise<void> {
    const open = this.open
    return open === null ? Promise.resolve() : this.pull(open, () => open.engine.sync())
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(step).catch((error: unknown) => this.update({ syncState: 'error', syncError: message(error) }))
    return this.queue
  }

  private async apply(userId: string | null, switchId: number): Promise<void> {
    if (this.open?.userId === userId && userId !== null) {
      return
    }
    await this.close()
    await this.removeCopiesExcept(userId === null ? null : databaseName(userId))
    if (userId === null || switchId !== this.wanted) {
      return
    }

    const name = databaseName(userId)
    const index = await this.deps.openSql(INDEX)
    try {
      await createIndex(index)
      await index.run('INSERT OR IGNORE INTO copies (name) VALUES (?)', [name])
    } finally {
      await index.close()
    }
    this.status.opening()
    let sql: Sql & { close(): Promise<void> }
    try {
      sql = await this.deps.openSql(name)
    } catch (error) {
      // No copy is open: the status says the sync stopped and why, as the error does.
      this.status.openFailed(message(error))
      throw error
    }
    let database: SqliteMailStore
    let lastSyncedAt: number | null
    try {
      database = await SqliteMailStore.open(sql)
      lastSyncedAt = await database.syncedAt()
    } catch (error) {
      this.status.openFailed(message(error))
      await sql.close()
      throw error
    }
    if (switchId !== this.wanted) {
      this.status.closed()
      await sql.close()
      return
    }

    const engine = new SyncEngine({
      store: database,
      pageSize: PAGE_SIZE,
      fetchPage: (since, limit) => this.deps.fetchPage(since, limit),
      // A failed pull is tried again by the engine, shown as any other pull.
      retry: (run) => {
        if (this.open?.engine === engine) {
          void this.pull(this.open, run)
        }
      },
      onProgress: (progress) => {
        if (this.open?.engine === engine) {
          this.status.progress(progress)
        }
      },
      onApplied: (page) => {
        if (this.open?.database === database) {
          this.update({ version: this.state.version + 1 })
          const { tellingSince, told } = this.open
          if (tellingSince !== null) {
            const due = deliveredNotices(page.handOvers, tellingSince, told)
            due.forEach((handOver) => told.add(noticeKey(handOver)))
            if (due.length > 0) {
              this.deps.onOverdue?.(due)
            }
          }
        }
      },
    })
    // The callbacks only act for the copy that is open when they come.
    let open: Open | null = null
    const realtime = new RealtimeClient({
      fetchAccess: (signal) => this.deps.fetchAccess(signal),
      now: () => this.deps.serverNow?.() ?? Date.now(),
      fetch: this.deps.fetch,
      onCursor: (cursor) => {
        if (open !== null) {
          void this.pull(open, () => engine.notify(cursor))
        }
      },
      onConnecting: () => {
        if (open !== null && this.open === open) {
          this.status.streamConnecting()
        }
      },
      onConnected: () => {
        if (open !== null && this.open === open) {
          this.update({ live: true })
          this.status.streamLive()
          void this.pull(open, () => engine.sync())
        }
      },
      onError: () => {
        if (open !== null && this.open === open) {
          this.update({ live: false })
          this.status.streamRetrying()
        }
      },
    })
    open = { userId, sql, database, engine, realtime, tellingSince: null, told: new Set() }
    const opened = open
    this.open = opened
    this.update({ userId, ready: true, synced: false, version: this.state.version + 1, syncError: null })
    this.status.opened({ confirmed: true, afterUpdate: database.afterUpdate, lastSyncedAt })
    // Not awaited: the copy on the device shows right away, and a switch (a sign-out) does not wait for the pull. Before
    // the first pull, a copy updated to keep chats checks once whether it must fetch them from the start.
    void this.pull(opened, async () => {
      await this.backfillChats(opened)
      return engine.sync()
    }).then(() => {
      if (this.open === opened) {
        this.update({ synced: true })
      }
    })
    // Drafts written while offline (or before the app was closed) go up now.
    void this.drafts.uploadPending()
    if (this.foreground) {
      opened.realtime.start()
    }
  }

  /** The one check of a copy updated to keep chats (see backfillChats); a failure leaves it for the next start. */
  private async backfillChats(open: Open): Promise<void> {
    try {
      await backfillChats(open.database, () => this.deps.fetchChatAccounts())
    } catch (error) {
      if (this.open === open) {
        console.error('Checking the server for chats failed; the next start asks again', error)
      }
    }
  }

  private async close(): Promise<void> {
    const open = this.open
    this.open = null
    if (open === null) {
      return
    }
    this.update({ userId: null, ready: false, synced: false, live: false, syncState: 'idle' })
    this.status.closed()
    open.engine.stop()
    await open.realtime.stop()
    // Waits for a page being stored, not for one on its way over the network: that one is refused when it arrives.
    await open.database.close()
  }

  /**
   * Deletes every listed copy except this one. Each is marked for removal first, so one that cannot go now is
   * removed the next time, also when that is a {@link closeCopy} that keeps the other copies.
   */
  private async removeCopiesExcept(keep: string | null): Promise<void> {
    const index = await this.deps.openSql(INDEX)
    try {
      await createIndex(index)
      if (keep !== null) {
        await index.run('DELETE FROM removals WHERE name = ?', [keep])
      }
      for (const { name } of await index.all<{ name: string }>('SELECT name FROM copies')) {
        if (name !== keep) {
          await index.run('INSERT OR IGNORE INTO removals (name) VALUES (?)', [name])
        }
      }
      await this.removeMarked(index)
    } finally {
      await index.close()
    }
  }

  private async removeMarkedCopies(): Promise<void> {
    const index = await this.deps.openSql(INDEX)
    try {
      await createIndex(index)
      await this.removeMarked(index)
    } finally {
      await index.close()
    }
  }

  private async removeMarked(index: Sql): Promise<void> {
    for (const { name } of await index.all<{ name: string }>('SELECT name FROM removals')) {
      try {
        await this.deps.deleteSql(name)
        await index.run('DELETE FROM copies WHERE name = ?', [name])
        await index.run('DELETE FROM removals WHERE name = ?', [name])
      } catch (error) {
        this.update({ syncError: `A copy of mail on this device could not be removed yet: ${message(error)}` })
      }
    }
  }

  private async pull(open: Open, run: () => Promise<unknown>): Promise<void> {
    if (this.open !== open) {
      return
    }
    const before = this.state.syncState
    this.update({ syncState: 'syncing' })
    try {
      // A notification at or below the stored cursor pulls nothing (`false`): that proves nothing, so a failure stays
      // and the copy is not noted as synced.
      if ((await run()) === false) {
        if (this.open === open) {
          this.update({ syncState: before })
        }
        return
      }
      if (this.open === open) {
        open.tellingSince ??= Date.now()
        this.status.synced()
        this.update({ syncState: 'idle', syncError: null, pulls: this.state.pulls + 1 })
      }
    } catch (error) {
      if (this.open === open) {
        this.status.failed(message(error))
        this.update({ syncState: 'error', syncError: message(error) })
      }
    }
  }

  private update(change: Partial<MailState>): void {
    this.state = { ...this.state, ...change }
    this.deps.onState(this.state)
  }
}

/** The copies on the device, and those marked for removal (by a sign-out or a switch) that are not gone yet. */
async function createIndex(index: Sql): Promise<void> {
  await index.exec('CREATE TABLE IF NOT EXISTS copies (name TEXT PRIMARY KEY NOT NULL)')
  await index.exec('CREATE TABLE IF NOT EXISTS removals (name TEXT PRIMARY KEY NOT NULL)')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
