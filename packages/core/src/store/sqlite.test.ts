import { beforeEach, describe, expect, it } from 'vitest'
import { chat, chatAccount, chatMessage, chatOutgoing, describeMailStore, draft, firstPage, message, page } from './contract'
import { CopyClosingError } from './mailStore'
import { memorySql } from './memorySql'
import type { Sql } from './sql'
import { MIGRATIONS, SCHEMA_VERSION, SqliteMailStore } from './sqlite'

describeMailStore(
  'SQLite',
  async () => SqliteMailStore.open(await memorySql()),
  (store) => store.close(),
)

describe('SqliteMailStore', () => {
  let sql: Sql & { closed(): boolean }
  let db: SqliteMailStore

  beforeEach(async () => {
    sql = await memorySql()
    db = await SqliteMailStore.open(sql)
    await db.apply(firstPage)
  })

  it('stores a page completely or not at all', async () => {
    const broken = page({
      cursor: 11,
      messages: [message('m9', 't1', 'work', ['work-inbox'], '2026-10-19T11:00:00+00:00', { verdict: 'do' }), { ...message('m10', 't1', 'work', [], 'x'), threadId: null as unknown as string }],
    })

    await expect(db.apply(broken)).rejects.toThrow()

    expect(await db.cursor()).toBe(10)
    expect((await db.thread('t1'))?.messages.map((m) => m.id)).toEqual(['m2', 'm1'])
  })

  it('refuses writes once closing, after finishing the one in progress, and then closes the database', async () => {
    const storing = db.apply(page({ cursor: 11, messages: [message('m5', 't1', 'work', ['work-inbox'], '2026-10-19T11:00:00+00:00')] }))
    const closing = db.close()
    await storing
    await closing

    expect(await db.cursor()).toBe(11)
    expect(sql.closed()).toBe(true)
    await expect(db.apply(page({ cursor: 12 }))).rejects.toBeInstanceOf(CopyClosingError)
    await expect(db.saveDraft(draft('d1'))).rejects.toBeInstanceOf(CopyClosingError)
  })

  it('closes only once the reads under way are done, so a desktop file is free to delete', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const slow: Sql & { closed(): boolean } = { ...sql, all: async (source, params) => (await held, sql.all(source, params)) }
    const store = await SqliteMailStore.open(slow)
    const reading = store.mailAccounts()

    const closing = store.close()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sql.closed()).toBe(false)

    release()
    await reading
    await closing
    expect(sql.closed()).toBe(true)
  })

  it('closes anyway after the time it is given when a write never answers, and says so', async () => {
    const logged: unknown[] = []
    const error = console.error
    console.error = (...args: unknown[]) => void logged.push(args[0])
    try {
      // Storage that never answers a write (a SQL call of the desktop shell that hangs).
      let hang = false
      const never = () => new Promise<never>(() => undefined)
      const hanging: Sql & { closed(): boolean } = {
        ...sql,
        transaction: (task) => (hang ? never() : sql.transaction(task)),
        run: (source, params) => (hang ? never() : sql.run(source, params)),
        exec: (source) => (hang ? never() : sql.exec(source)),
      }
      const store = await SqliteMailStore.open(hanging)
      hang = true
      void store.saveDraft(draft('d1')).catch(() => undefined)

      const started = Date.now()
      await store.close({ waitMs: 50 })

      expect(Date.now() - started).toBeGreaterThanOrEqual(45)
      expect(sql.closed()).toBe(true)
      expect(logged).toContain("The mail copy's writes and reads did not finish within 0.05 seconds; it is closed anyway")
      await expect(store.saveDraft(draft('d2'))).rejects.toBeInstanceOf(CopyClosingError)
    } finally {
      console.error = error
    }
  })

  it('closes at once with a time limit when nothing is under way', async () => {
    await db.close({ waitMs: 60_000 })

    expect(sql.closed()).toBe(true)
  })

  it('also waits for a read that starts while closing waits for another', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const first = new Promise<void>((resolve) => (releaseFirst = resolve))
    const second = new Promise<void>((resolve) => (releaseSecond = resolve))
    let calls = 0
    const slow: Sql & { closed(): boolean } = {
      ...sql,
      all: async (source, params) => {
        calls += 1
        await (calls === 1 ? first : second)
        return sql.all(source, params)
      },
    }
    const store = await SqliteMailStore.open(slow)
    const reading = store.mailAccounts()
    const closing = store.close()

    const late = store.folders()
    releaseFirst()
    await reading
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sql.closed()).toBe(false)

    releaseSecond()
    await late
    await closing
    expect(sql.closed()).toBe(true)
  })

  it('stores writes that arrive together one after the other, as a device allows one writer', async () => {
    await Promise.all([
      db.apply(page({ cursor: 11, messages: [message('m5', 't1', 'work', ['work-inbox'], '2026-10-19T11:00:00+00:00')] })),
      db.applyAction(['m4'], 'flag'),
      db.saveDraft(draft('d1')),
      db.resyncFromStart(),
    ])

    expect(await db.cursor()).toBe(0)
    expect((await db.thread('t1'))?.messages.map((m) => m.id)).toContain('m5')
    expect((await db.thread('t3'))?.messages[0]?.flags.flagged).toBe(true)
    expect(await db.draft('d1')).not.toBeNull()
  })

  it('lists each message once for a selection larger than one query takes, with threads repeated across its parts', async () => {
    const filler = Array.from({ length: 600 }, (_, index) => `none-${index}`)

    expect(await db.messageIdsOfThreads(['t1', ...filler, 't1', 't3'])).toEqual(['m1', 'm2', 'm4'])
  })

  it('syncs from the start after a resync, even when a pull under way stores a page meanwhile, and after a restart', async () => {
    // A pull that began from the stored cursor, before the resync was asked for.
    expect(await db.cursor()).toBe(10)
    await db.resyncFromStart()
    await db.apply(page({ cursor: 11 }))

    expect(await (await SqliteMailStore.open(sql)).cursor()).toBe(0)
    expect(await db.cursor()).toBe(0)
    await db.apply(page({ cursor: 11, hasMore: true }))
    expect(await db.cursor()).toBe(11)
    expect(await (await SqliteMailStore.open(sql)).cursor()).toBe(11)
  })

  it('keeps a resync asked for while a pull from the start stores its first page', async () => {
    await db.resyncFromStart()
    expect(await db.cursor()).toBe(0)

    await Promise.all([db.apply(page({ cursor: 11 })), db.resyncFromStart()])

    expect(await db.cursor()).toBe(0)
    expect(await (await SqliteMailStore.open(sql)).cursor()).toBe(0)
  })

  it('rebuilds a copy made by another version, so it syncs again from the start, keeping drafts that exist only here', async () => {
    await db.saveDraft(draft('unsent', { pendingSave: true, version: 3, remoteVersion: 4 }))
    await db.saveDraft(draft('sending', { outgoingId: 'o1' }))
    await db.saveDraft(draft('synced', { version: 2 }))
    await sql.run("UPDATE meta SET value = '1' WHERE key = 'schema'")
    // An older shape of a table.
    await sql.exec('DROP TABLE conversations; CREATE TABLE conversations (thread_id TEXT PRIMARY KEY NOT NULL)')

    const reopened = await SqliteMailStore.open(sql)

    expect(reopened.afterUpdate).toBe(true)
    expect(reopened.upgrade).toBe('rebuilt')
    expect(await reopened.cursor()).toBe(0)
    expect(await reopened.inbox(null, 10)).toEqual([])
    expect(await sql.first<{ value: string }>("SELECT value FROM meta WHERE key = 'schema'")).toEqual({ value: String(SCHEMA_VERSION) })
    expect((await reopened.drafts()).map((d) => d.id).sort()).toEqual(['sending', 'unsent'])
    expect(await reopened.draft('unsent')).toMatchObject({ pendingSave: true, version: 0, remoteVersion: null })
    await reopened.apply(firstPage)
    expect((await reopened.inbox(null, 10)).map((c) => c.threadId)).toEqual(['t1', 't3'])
  })

  it('rebuilds a copy from before drafts were kept', async () => {
    const old = await memorySql()
    await old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema', '1'), ('cursor', '7')")

    const reopened = await SqliteMailStore.open(old)

    expect(await reopened.cursor()).toBe(0)
    expect(await reopened.drafts()).toEqual([])
  })

  it('opens a copy of its own version as it is, which is no update', async () => {
    await db.markSynced(1_700_000_000_000)

    const reopened = await SqliteMailStore.open(sql)

    expect(reopened.afterUpdate).toBe(false)
    expect(await reopened.cursor()).toBe(10)
    expect(await reopened.syncedAt()).toBe(1_700_000_000_000)
  })

  it('brings a copy of the version before up to date in place, keeping its mail on screen while it syncs again', async () => {
    await db.saveDraft(draft('synced', { version: 2 }))
    const reopened = await SqliteMailStore.open(sql, {
      version: SCHEMA_VERSION + 1,
      migrations: { [SCHEMA_VERSION]: { sql: 'CREATE TABLE IF NOT EXISTS extra (id TEXT PRIMARY KEY NOT NULL)', resync: true } },
    })

    expect(reopened.afterUpdate).toBe(true)
    expect(reopened.upgrade).toBe('migrated')
    expect(await sql.first<{ value: string }>("SELECT value FROM meta WHERE key = 'schema'")).toEqual({ value: String(SCHEMA_VERSION + 1) })
    expect(await sql.first("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extra'")).not.toBeNull()
    // Kept: the lists, every draft with its server version.
    expect((await reopened.inbox(null, 10)).map((c) => c.threadId)).toEqual(['t1', 't3'])
    expect(await reopened.draft('synced')).toMatchObject({ version: 2 })
    // And synced again from the start, which a restart before it is done does not forget.
    expect(await reopened.cursor()).toBe(0)
    expect(await (await SqliteMailStore.open(sql, { version: SCHEMA_VERSION + 1 })).cursor()).toBe(0)
    await reopened.apply(page({ cursor: 12 }))
    expect(await reopened.cursor()).toBe(12)
  })

  it('takes a step that needs no new sync quietly', async () => {
    const reopened = await SqliteMailStore.open(sql, {
      version: SCHEMA_VERSION + 1,
      migrations: { [SCHEMA_VERSION]: { sql: 'CREATE INDEX IF NOT EXISTS threads_by_account ON threads (mail_account_id)', resync: false } },
    })

    expect(reopened.afterUpdate).toBe(false)
    expect(await reopened.cursor()).toBe(10)
  })

  it('rebuilds when a step on the way is missing', async () => {
    const rebuilt = await SqliteMailStore.open(sql, { version: SCHEMA_VERSION + 2, migrations: { [SCHEMA_VERSION]: { sql: 'SELECT 1', resync: false } } })

    expect(rebuilt.upgrade).toBe('rebuilt')
    expect(rebuilt.afterUpdate).toBe(true)
    expect(await rebuilt.cursor()).toBe(0)
    expect(await rebuilt.inbox(null, 10)).toEqual([])
  })

  it('rebuilds when a step fails, keeping the drafts that exist only here, so the copy still opens', async () => {
    await db.saveDraft(draft('unsent', { pendingSave: true, version: 3 }))
    const logged: unknown[] = []
    const error = console.error
    console.error = (...args: unknown[]) => void logged.push(args[0])
    try {
      const reopened = await SqliteMailStore.open(sql, { version: SCHEMA_VERSION + 1, migrations: { [SCHEMA_VERSION]: { sql: 'CREATE TABLE threads (id TEXT)', resync: true } } })

      expect(reopened.upgrade).toBe('rebuilt')
      expect(reopened.afterUpdate).toBe(true)
      expect(await sql.first<{ value: string }>("SELECT value FROM meta WHERE key = 'schema'")).toEqual({ value: String(SCHEMA_VERSION + 1) })
      expect(await reopened.cursor()).toBe(0)
      expect(await reopened.inbox(null, 10)).toEqual([])
      expect(await reopened.draft('unsent')).toMatchObject({ pendingSave: true, version: 0 })
      expect(logged).toEqual(['Bringing the mail copy up to date in place failed; it is rebuilt'])
      // And it opens again as it is now.
      expect((await SqliteMailStore.open(sql, { version: SCHEMA_VERSION + 1 })).upgrade).toBe('none')
    } finally {
      console.error = error
    }
  })

  it('rebuilds a copy of a newer version, which this one cannot read', async () => {
    await sql.run(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema'`)

    const reopened = await SqliteMailStore.open(sql)

    expect(reopened.upgrade).toBe('rebuilt')
    expect(await reopened.cursor()).toBe(0)
  })

  describe('chats', () => {
    const at = '2026-11-12T10:00:00+00:00'
    const localChat = 'wa:31655555555@s.whatsapp.net'

    /** A copy as version 9 left it: the same tables without the chat ones, which version 10 added. */
    async function makeVersion9(): Promise<void> {
      await sql.exec('DROP TABLE chat_accounts; DROP TABLE chats; DROP TABLE chat_messages; DROP TABLE chat_outgoing')
      await sql.run("UPDATE meta SET value = '9' WHERE key = 'schema'")
    }

    it('is at version 10, with a step from 9', () => {
      expect(SCHEMA_VERSION).toBe(10)
      expect(MIGRATIONS[9]?.resync).toBe(true)
    })

    it('brings a version 9 copy with mail to version 10 in place, keeping its rows, and fetches the chats it skipped', async () => {
      await db.saveDraft(draft('synced', { version: 2 }))
      await db.saveDraft(draft('unsent', { pendingSave: true, version: 3 }))
      await db.markSynced(1_700_000_000_000)
      await makeVersion9()

      const reopened = await SqliteMailStore.open(sql)

      expect(reopened.upgrade).toBe('migrated')
      expect(reopened.afterUpdate).toBe(true)
      expect(await sql.first<{ value: string }>("SELECT value FROM meta WHERE key = 'schema'")).toEqual({ value: '10' })
      // Kept: mail, lists, drafts with their server versions, when it last synced.
      expect((await reopened.inbox(null, 10)).map((c) => c.threadId)).toEqual(['t1', 't3'])
      expect((await reopened.thread('t1'))?.messages.map((m) => m.id)).toEqual(['m2', 'm1'])
      expect(await reopened.draft('synced')).toMatchObject({ version: 2 })
      expect(await reopened.draft('unsent')).toMatchObject({ pendingSave: true, version: 3 })
      expect(await reopened.syncedAt()).toBe(1_700_000_000_000)
      // A pull from the start brings the chats a version 9 copy dropped.
      expect(await reopened.cursor()).toBe(0)
      await reopened.apply(
        page({ cursor: 50, chatAccounts: [chatAccount('acct')], chats: [chat('anna', 'acct', { lastMessageAt: at })], chatMessages: [chatMessage('a1', 'anna', 'acct', at)] }),
      )
      expect((await reopened.chat('anna'))?.messages.map((m) => m.id)).toEqual(['a1'])
      expect(await reopened.cursor()).toBe(50)
      expect((await SqliteMailStore.open(sql)).upgrade).toBe('none')
    })

    it('keeps the chats that exist only on this device, and the chat values, through a rebuild', async () => {
      await db.apply(
        page({
          cursor: 11,
          chatAccounts: [chatAccount('acct')],
          chats: [chat('anna', 'acct', { lastMessageAt: at })],
          chatMessages: [chatMessage('a1', 'anna', 'acct', at)],
          chatOutgoing: [chatOutgoing('0193a000-0000-7000-8000-000000000001', 'anna', 'acct')],
        }),
      )
      await db.putChatAccount(chatAccount('wa:account'))
      await db.putChats([chat(localChat, 'wa:account', { jid: '31655555555@s.whatsapp.net', lastMessageAt: at, readThrough: at })])
      await db.putChatMessages([chatMessage(`${localChat}:X1`, localChat, 'wa:account', at, { text: 'Only here' })])
      await db.putChatOutgoing([chatOutgoing('0193a000-0000-7000-8000-0000000000aa', localChat, 'wa:account')])
      await db.setChatMeta('cursor', '812')
      await sql.run("UPDATE meta SET value = '1' WHERE key = 'schema'")

      const rebuilt = await SqliteMailStore.open(sql)

      expect(rebuilt.upgrade).toBe('rebuilt')
      expect(await rebuilt.cursor()).toBe(0)
      // What the server holds comes back with the pull from the start; what only this Mac holds stays.
      expect((await rebuilt.chatAccounts()).map((a) => a.id)).toEqual(['wa:account'])
      expect(await rebuilt.chat('anna')).toBeNull()
      const kept = await rebuilt.chat(localChat)
      expect(kept?.chat).toMatchObject({ jid: '31655555555@s.whatsapp.net', readThrough: at })
      expect(kept?.messages.map((m) => m.text)).toEqual(['Only here'])
      expect((await rebuilt.waitingOutgoing()).map((o) => o.id)).toEqual(['0193a000-0000-7000-8000-0000000000aa'])
      expect(await rebuilt.chatMeta('cursor')).toBe('812')
    })

    it('keeps the chats of this device when a rebuild comes from a copy without chat tables', async () => {
      await makeVersion9()
      await sql.run("UPDATE meta SET value = '1' WHERE key = 'schema'")

      const rebuilt = await SqliteMailStore.open(sql)

      expect(rebuilt.upgrade).toBe('rebuilt')
      expect(await rebuilt.chatAccounts()).toEqual([])
      await rebuilt.putChatAccount(chatAccount('wa:account'))
      expect((await rebuilt.chatAccounts()).map((a) => a.id)).toEqual(['wa:account'])
    })

    it('keeps the chats of this device when a pull starts again from the start', async () => {
      await db.putChatAccount(chatAccount('wa:account'))
      await db.putChats([chat(localChat, 'wa:account', { lastMessageAt: at })])
      await db.resyncFromStart()

      await db.apply(page({ cursor: 3, chatAccounts: [chatAccount('acct')] }))

      expect((await db.chatAccounts()).map((a) => a.id)).toEqual(['acct', 'wa:account'])
      expect(await db.chat(localChat)).not.toBeNull()
    })
  })

  it('is no update when the copy is new', async () => {
    const fresh = await SqliteMailStore.open(await memorySql())

    expect(fresh.afterUpdate).toBe(false)
    expect(await fresh.syncedAt()).toBeNull()
  })
})
