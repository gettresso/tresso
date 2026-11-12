import { beforeEach, describe, expect, it } from 'vitest'
import { describeMailStore, draft, firstPage, message, page } from './contract'
import { CopyClosingError } from './mailStore'
import { memorySql } from './memorySql'
import type { Sql } from './sql'
import { SCHEMA_VERSION, SqliteMailStore } from './sqlite'

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
})
