import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memorySql } from '../store/memorySql'
import { SqliteMailStore } from '../store/sqlite'
import { CopyClosingError } from '../store/mailStore'
import { LOCAL_CHAT_ACCOUNT, LOCAL_CURSOR, LocalChatBackend, localChatId, queueLocalReply, removeLocalChats, retryLocalReply, setLocalChatState } from './localBackend'
import {
  ChatRelay,
  ChatRelayRetryLater,
  ChatRelayStopped,
  FIRST_IMPORT_MAX,
  FIRST_IMPORT_QUIET,
  FIRST_IMPORT_STEP_MAX,
  NAME_RETRY,
  RELAY_ERROR_DELAY,
  RELAY_INTERVAL,
  RELAY_PAGE,
  RELAY_RETRY_MAX,
  RELAY_RETRY_MIN,
  retryDelay,
  senderAddress,
  type BridgePage,
  type BridgeSendResult,
  type ChatBackend,
  type ChatBridge,
  type ClaimedReply,
  type IncomingChat,
  type IncomingMessage,
  type RelayCursor,
  type RelayProgress,
  type RelayStep,
  type ReplyResult,
  type SenderLookup,
} from './relay'
import type { MailStore } from '../store/mailStore'
import type { BridgeRow } from './types'

const DIRECT = '31612345678@s.whatsapp.net'
const OTHER = '31687654321@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'
const NOW = Date.parse('2026-11-12T10:00:00Z')
const IMPORT_SINCE = NOW - 30 * 24 * 60 * 60 * 1000
const at = (minutes: number) => NOW + minutes * 60_000

/** The bridge's store and REST API as the desktop shell offers them. */
class FakeBridge implements ChatBridge {
  rows: BridgeRow[] = []
  storeId = 'file-1:1:1'
  busy = false
  private nextRowid = 1
  readonly reads: number[] = []
  readonly nameCalls: string[][] = []
  readonly sent: { recipient: string; text: string }[] = []
  known: Record<string, SenderLookup> = {}
  answer: (recipient: string, text: string) => Promise<BridgeSendResult> = async () => ({ ok: true })

  add(id: string, chatJid: string, extra: Partial<BridgeRow> = {}): BridgeRow {
    const row: BridgeRow = {
      rowid: this.nextRowid++,
      id,
      chatJid,
      chatName: null,
      sender: chatJid.split('@')[0]!,
      text: `Text ${id}`,
      sentAt: at(0),
      fromMe: false,
      mediaType: null,
      filename: null,
      fileLength: null,
      ...extra,
    }
    this.rows.push(row)
    return row
  }

  /** INSERT OR REPLACE: the row leaves its rowid and gets the next one. */
  storeAgain(id: string, chatJid: string, extra: Partial<BridgeRow>): void {
    const old = this.rows.find((row) => row.id === id && row.chatJid === chatJid)!
    this.rows = this.rows.filter((row) => row !== old)
    this.rows.push({ ...old, ...extra, rowid: this.nextRowid++ })
  }

  /** VACUUM or a store made again: the rows numbered anew from 1, under another store id. */
  renumber(storeId: string): void {
    this.rows = this.rows.map((row, index) => ({ ...row, rowid: index + 1 }))
    this.nextRowid = this.rows.length + 1
    this.storeId = storeId
  }

  async read(afterRowid: number, limit: number): Promise<BridgePage | null> {
    this.reads.push(afterRowid)
    if (this.busy) {
      return null
    }
    const rows = this.rows.filter((row) => row.rowid > afterRowid).sort((a, b) => a.rowid - b.rowid)
    return { rows: rows.slice(0, limit).map((row) => ({ ...row })), maxRowid: Math.max(0, ...this.rows.map((row) => row.rowid)), storeId: this.storeId }
  }

  async names(ids: string[]): Promise<Record<string, SenderLookup>> {
    this.nameCalls.push(ids)
    // As the shell: every id answered, a short one taken for a phone number when nothing else is known.
    return Object.fromEntries(ids.map((id) => [id, this.known[id] ?? { number: id.length <= 13 ? id : null, name: null }]))
  }

  async send(recipient: string, text: string): Promise<BridgeSendResult> {
    this.sent.push({ recipient, text })
    return this.answer(recipient, text)
  }
}

/** Timers run by hand. */
function fakeScheduler() {
  const timers: { run: () => void; ms: number; done: boolean }[] = []
  return {
    schedule: (run: () => void, ms: number) => {
      const timer = { run, ms, done: false }
      timers.push(timer)
      return () => {
        timer.done = true
      }
    },
    active: () => timers.filter((timer) => !timer.done),
    /** Runs the one planned timer; returns its delay. */
    fire(): number {
      const active = timers.filter((timer) => !timer.done)
      expect(active).toHaveLength(1)
      const timer = active[0]!
      timer.done = true
      timer.run()
      return timer.ms
    },
  }
}

/** A backend that passes everything to another, with hooks to fail or hold a step. */
class Wrapped implements ChatBackend {
  ingests: { flag: boolean; waIds: string[] }[] = []
  failIngest: unknown = null
  failSetCursor: unknown = null
  failReport: unknown = null
  holdIngest: Promise<void> | null = null
  ingesting = 0
  mostAtOnce = 0

  constructor(readonly inner: ChatBackend) {}

  prepare() {
    return this.inner.prepare()
  }
  settings() {
    return this.inner.settings()
  }
  async ingest(chats: IncomingChat[], messages: IncomingMessage[], firstImport: boolean) {
    this.ingesting++
    this.mostAtOnce = Math.max(this.mostAtOnce, this.ingesting)
    try {
      if (this.holdIngest !== null) {
        await this.holdIngest
      }
      if (this.failIngest !== null) {
        const error = this.failIngest
        this.failIngest = null
        throw error
      }
      this.ingests.push({ flag: firstImport, waIds: messages.map((message) => message.waId) })
      return await this.inner.ingest(chats, messages, firstImport)
    } finally {
      this.ingesting--
    }
  }
  cursor() {
    return this.inner.cursor()
  }
  async setCursor(cursor: RelayCursor) {
    if (this.failSetCursor !== null) {
      const error = this.failSetCursor
      this.failSetCursor = null
      throw error
    }
    await this.inner.setCursor(cursor)
  }
  claims = 0
  claimNext() {
    this.claims++
    return this.inner.claimNext()
  }
  async report(reply: ClaimedReply, result: ReplyResult) {
    if (this.failReport !== null) {
      const error = this.failReport
      this.failReport = null
      throw error
    }
    await this.inner.report(reply, result)
  }
}

describe('ChatRelay with the local backend', () => {
  let store: SqliteMailStore
  let bridge: FakeBridge
  let backend: Wrapped
  let scheduler: ReturnType<typeof fakeScheduler>
  let errors: { error: unknown; step: RelayStep }[]
  let relay: ChatRelay
  let config: { includeGroups: boolean; leftOut: string[]; importSince: number }
  let clock: number
  let progress: RelayProgress[]

  const identity = { number: '31698765432', name: 'Sam', deviceId: '0193a000-0000-7000-8000-000000000001', deviceName: 'MacBook Air' }

  function makeRelay(on: MailStore = store): ChatRelay {
    backend = new Wrapped(new LocalChatBackend(on, config, identity, () => clock))
    errors = []
    progress = []
    relay = new ChatRelay({
      now: () => clock,
      bridge,
      backend,
      schedule: scheduler.schedule,
      onError: (error, step) => errors.push({ error, step }),
      onProgress: (counts) => progress.push(counts),
    })
    return relay
  }

  /** Past the first import: rows read from here on are live. */
  async function live(): Promise<void> {
    await store.setChatMeta(LOCAL_CURSOR, JSON.stringify({ storeId: bridge.storeId, rowid: 0, firstImport: null }))
  }

  async function messageIds(): Promise<string[]> {
    const ids: string[] = []
    for (const summary of await store.chats()) {
      ids.push(...((await store.chat(summary.chat.id))?.messages.map((message) => message.id) ?? []))
    }
    return ids.sort()
  }

  async function storedCursor(): Promise<RelayCursor | null> {
    const value = await store.chatMeta(LOCAL_CURSOR)
    return value === null ? null : (JSON.parse(value) as RelayCursor)
  }

  beforeEach(async () => {
    store = await SqliteMailStore.open(await memorySql())
    bridge = new FakeBridge()
    scheduler = fakeScheduler()
    config = { includeGroups: true, leftOut: [], importSince: IMPORT_SINCE }
    clock = NOW
    makeRelay()
  })

  it('imports a page: chats, messages, group senders, files, and the cursor once stored', async () => {
    bridge.known = { '31611111111': { number: '31611111111', name: 'Mom' }, '99999999999999': { number: null, name: null } }
    bridge.add('A1', DIRECT, { chatName: 'Kim', text: 'Hello', sentAt: at(-10) })
    bridge.add('A2', DIRECT, { fromMe: true, sender: '31698765432', text: 'Hi Kim', sentAt: at(-9) })
    bridge.add('G1', GROUP, { chatName: 'Family', sender: '31611111111', text: 'Dinner?', sentAt: at(-8) })
    bridge.add('G2', GROUP, { sender: '31622222222', text: '', mediaType: 'image', filename: 'x.jpg', fileLength: 1200, sentAt: at(-7) })
    bridge.add('G3', GROUP, { sender: '99999999999999', text: 'From a LID', sentAt: at(-6) })
    bridge.add('G4', GROUP, { sender: '31611111111', text: 'A sticker', mediaType: 'sticker', sentAt: at(-5) })

    await relay.pollNow()

    expect(errors).toEqual([])
    const account = (await store.chatAccounts())[0]!
    expect(account).toMatchObject({ id: LOCAL_CHAT_ACCOUNT, address: '31698765432', displayName: 'Sam', relayDeviceId: identity.deviceId })
    const direct = (await store.chat(localChatId(DIRECT)))!
    expect(direct.chat).toMatchObject({ jid: DIRECT, kind: 'direct', name: 'Kim', lastMessageAt: new Date(at(-9)).toISOString() })
    expect(direct.messages.map((message) => [message.id, message.fromMe, message.sender, message.text])).toEqual([
      [`wa:${DIRECT}:A1`, false, null, 'Hello'],
      [`wa:${DIRECT}:A2`, true, null, 'Hi Kim'],
    ])
    const group = (await store.chat(localChatId(GROUP)))!
    expect(group.chat).toMatchObject({ kind: 'group', name: 'Family' })
    expect(group.messages.map((message) => [message.waId, message.sender, message.mediaKind, message.mediaName, message.mediaSize])).toEqual([
      ['G1', { id: '31611111111', name: 'Mom' }, null, null, null],
      ['G2', { id: '31622222222', name: '+31622222222' }, 'image', 'x.jpg', 1200],
      ['G3', { id: '99999999999999', name: null }, null, null, null],
      ['G4', { id: '31611111111', name: 'Mom' }, null, null, null],
    ])
    expect(await storedCursor()).toEqual({ storeId: 'file-1:1:1', rowid: 6, firstImport: { through: 6, ranFor: 0, quietFor: 0 } })
    expect(scheduler.active()).toEqual([])
  })

  it('stores nothing twice when rows are read again, and moves no cursor back', async () => {
    bridge.add('A1', DIRECT)
    bridge.add('A2', DIRECT)
    await relay.pollNow()
    // A crash between storing and the cursor write: the cursor is back where it was.
    await store.setChatMeta(LOCAL_CURSOR, JSON.stringify({ storeId: bridge.storeId, rowid: 0, firstImport: null }))

    await relay.pollNow()
    await relay.pollNow()

    expect(await messageIds()).toEqual([`wa:${DIRECT}:A1`, `wa:${DIRECT}:A2`])
    expect(bridge.reads).toEqual([0, 0, 2])
    expect((await storedCursor())?.rowid).toBe(2)
  })

  it('reads a row the bridge stored again (a new rowid) and keeps one message with the new text', async () => {
    bridge.add('A1', DIRECT, { text: 'first' })
    bridge.add('A2', DIRECT)
    await relay.pollNow()

    bridge.storeAgain('A1', DIRECT, { text: 'edited' })
    await relay.pollNow()

    const messages = (await store.chat(localChatId(DIRECT)))!.messages
    expect(messages.map((message) => [message.waId, message.text])).toEqual([
      ['A1', 'edited'],
      ['A2', 'Text A2'],
    ])
    expect((await storedCursor())?.rowid).toBe(3)
  })

  it('reads a renumbered store from 0, losing nothing and doubling nothing', async () => {
    for (let i = 1; i <= 5; i++) {
      bridge.add(`A${i}`, DIRECT)
    }
    await relay.pollNow()
    // The first import ends once the store was quiet while the relay ran.
    for (let round = 0; round < FIRST_IMPORT_QUIET / RELAY_INTERVAL; round++) {
      clock += RELAY_INTERVAL
      await relay.pollNow()
    }
    expect((await storedCursor())?.firstImport).toBeNull()
    bridge.reads.length = 0
    bridge.rows = bridge.rows.filter((row) => row.id !== 'A2')
    bridge.renumber('file-1:2:1')
    bridge.add('A6', DIRECT, { sentAt: at(1) })

    await relay.pollNow()

    expect(bridge.reads).toEqual([5, 0])
    expect(await messageIds()).toEqual([1, 2, 3, 4, 5, 6].map((i) => `wa:${DIRECT}:A${i}`))
    expect(await storedCursor()).toEqual({ storeId: 'file-1:2:1', rowid: 5, firstImport: null })
    // Not a first import: the new message is unread.
    expect((await store.chats())[0]!.unread).toBe(1)
  })

  it('reads from 0 when the highest rowid falls below the cursor, even under the same store id', async () => {
    bridge.add('A1', DIRECT)
    bridge.add('A2', DIRECT)
    bridge.add('A3', DIRECT)
    await relay.pollNow()
    bridge.rows = [bridge.rows[0]!]
    bridge.renumber(bridge.storeId)

    await relay.pollNow()

    expect(bridge.reads).toEqual([0, 3, 0])
    expect((await storedCursor())?.rowid).toBe(1)
  })

  it('does not move the cursor when storing fails, and stores the page in a later round', async () => {
    bridge.add('A1', DIRECT)
    relay.start()
    backend.failIngest = new Error('disk full')

    expect(scheduler.fire()).toBe(0)
    await vi.waitFor(() => expect(scheduler.active()).toHaveLength(1))

    expect(errors.map(({ step }) => step)).toEqual(['store'])
    expect(await storedCursor()).toBeNull()
    expect(await messageIds()).toEqual([])
    expect(scheduler.active()[0]!.ms).toBe(RELAY_ERROR_DELAY)

    scheduler.fire()
    await vi.waitFor(() => expect(scheduler.active()).toHaveLength(1))
    expect(await messageIds()).toEqual([`wa:${DIRECT}:A1`])
    expect((await storedCursor())?.rowid).toBe(1)
    expect(scheduler.active()[0]!.ms).toBe(RELAY_INTERVAL)
    await relay.stop()
  })

  it('reads the page again after a crash between storing and the cursor write', async () => {
    bridge.add('A1', DIRECT)
    backend.failSetCursor = new Error('crashed')
    await relay.pollNow()
    expect(errors.map(({ step }) => step)).toEqual(['store'])
    expect(await storedCursor()).toBeNull()

    await relay.pollNow()

    expect(bridge.reads).toEqual([0, 0])
    expect(await messageIds()).toEqual([`wa:${DIRECT}:A1`])
    expect((await storedCursor())?.rowid).toBe(1)
  })

  it('leaves out groups when they are not brought in, chats the user left out, and what is not a chat or too old', async () => {
    config.includeGroups = false
    config.leftOut = [OTHER]
    makeRelay()
    bridge.add('A1', DIRECT)
    bridge.add('G1', GROUP)
    bridge.add('O1', OTHER)
    bridge.add('S1', 'status@broadcast')
    bridge.add('N1', '120363000000000002@newsletter')
    bridge.add('OLD', DIRECT, { sentAt: IMPORT_SINCE - 1 })
    bridge.add('NOTIME', DIRECT, { sentAt: null })
    bridge.add('EMPTY', DIRECT, { text: '  ' })
    bridge.add('', DIRECT)
    bridge.add('BAD ID', DIRECT)
    bridge.add('AHEAD', DIRECT, { sentAt: NOW + 25 * 60 * 60 * 1000 })

    await relay.pollNow()

    expect(await messageIds()).toEqual([`wa:${DIRECT}:A1`])
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, GROUP)).toBeNull()
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, OTHER)).toBeNull()
    expect(bridge.nameCalls).toEqual([])
    // Left out rows still move the cursor: they are decided, not pending.
    expect((await storedCursor())?.rowid).toBe(11)
  })

  it('stores nothing more for a chat the copy holds as left out', async () => {
    bridge.add('A1', DIRECT)
    await relay.pollNow()
    await setLocalChatState(store, localChatId(DIRECT), { leftOut: true })
    bridge.add('A2', DIRECT)

    await relay.pollNow()

    const chat = await store.chat(localChatId(DIRECT))
    expect(chat?.chat.leftOut).toBe(true)
    expect(chat?.messages).toEqual([])
  })

  it('keeps one chat per JID in the form the server stores, whatever form the bridge wrote', async () => {
    bridge.add('A1', '31612345678:12@s.whatsapp.net')
    bridge.add('A2', '31612345678@S.WhatsApp.Net')
    bridge.add('G1', '120363000000000001@G.US', { sender: '31611111111' })

    await relay.pollNow()

    expect((await store.chats()).map((summary) => summary.chat.jid).sort()).toEqual([GROUP, DIRECT])
    expect(await messageIds()).toEqual([`wa:${GROUP}:G1`, `wa:${DIRECT}:A1`, `wa:${DIRECT}:A2`])
  })

  it('looks up each group sender once per session, in batches the shell takes', async () => {
    bridge.known = { '31611111111': { number: '31611111111', name: 'Mom' } }
    bridge.add('G1', GROUP, { sender: '31611111111' })
    bridge.add('G2', GROUP, { sender: '31611111111' })
    bridge.add('G3', GROUP, { sender: 'not-an-id' })
    bridge.add('G4', GROUP, { sender: '31611111111', fromMe: true })
    await relay.pollNow()
    bridge.add('G5', GROUP, { sender: '31611111111' })
    bridge.add('G6', GROUP, { sender: '31633333333' })

    await relay.pollNow()

    expect(bridge.nameCalls).toEqual([['31611111111'], ['31633333333']])
    const senders = (await store.chat(localChatId(GROUP)))!.messages.map((message) => message.sender)
    expect(senders).toEqual([
      { id: '31611111111', name: 'Mom' },
      { id: '31611111111', name: 'Mom' },
      { id: 'not-an-id', name: null },
      null,
      { id: '31611111111', name: 'Mom' },
      { id: '31633333333', name: '+31633333333' },
    ])
  })

  /** Runs the planned round and waits until the next is planned. */
  async function nextRound(): Promise<void> {
    scheduler.fire()
    await vi.waitFor(() => expect(scheduler.active()).toHaveLength(1))
  }

  /** Rounds `step` ms of clock apart, each after `add` (rows arriving), one round per call of pollNow. */
  async function rounds(count: number, step: number = RELAY_INTERVAL, add: (index: number) => void = () => {}): Promise<void> {
    for (let index = 0; index < count; index++) {
      clock += step
      add(index)
      await relay.pollNow()
    }
  }

  const quietRounds = FIRST_IMPORT_QUIET / RELAY_INTERVAL

  it('takes history arriving in bursts after linking as the first import, until the store is quiet', async () => {
    // Freshly linked: the store is empty, then the history sync writes in bursts over minutes.
    relay.start()
    await nextRound()
    for (let burst = 0; burst < 3; burst++) {
      clock += 40_000
      for (let i = 1; i <= (burst === 1 ? RELAY_PAGE + 10 : 30); i++) {
        bridge.add(`H${burst}-${i}`, DIRECT, { sentAt: at(-2000 + burst * 600 + i) })
      }
      await nextRound()
      if (scheduler.active()[0]!.ms === 0) {
        await nextRound()
      }
    }
    await relay.stop()
    makeRelay()
    // Taken up again (a restart): the quiet time starts at 0, and counts only rounds.
    await relay.pollNow()
    expect(backend.ingests).toEqual([])
    expect((await storedCursor())?.firstImport).toMatchObject({ through: 30 + RELAY_PAGE + 10 + 30, quietFor: 0 })

    await rounds(quietRounds - 1)
    expect((await storedCursor())?.firstImport).toMatchObject({ quietFor: FIRST_IMPORT_QUIET - RELAY_INTERVAL })
    await rounds(1)
    expect((await storedCursor())?.firstImport).toBeNull()
    expect(progress.at(-1)).toMatchObject({ firstImport: false })

    bridge.add('LIVE', DIRECT, { sentAt: at(1) })
    await rounds(1)

    expect(backend.ingests).toEqual([{ flag: false, waIds: ['LIVE'] }])
    const summary = (await store.chats())[0]!
    // History arrived read; the live message did not.
    expect(summary.unread).toBe(1)
    expect(summary.chat.readThrough).toBe(new Date(at(-2000 + 1200 + 30)).toISOString())
  })

  it('goes on with the first import when the app reopens a day after it was quit, and ends it once quiet', async () => {
    bridge.add('H1', DIRECT, { sentAt: at(-100) })
    await relay.pollNow()
    // Five minutes of history sync, a row now and then.
    await rounds(100, RELAY_INTERVAL, (index) => {
      if (index % 10 === 0) {
        bridge.add(`H${index + 2}`, DIRECT, { sentAt: at(-99 + index) })
      }
    })
    const before = (await storedCursor())!.firstImport!
    expect(before.ranFor).toBe(5 * 60_000)

    // Quit; reopened a day later, when the bridge catches up with the rest of the history.
    clock += 24 * 60 * 60 * 1000
    makeRelay()
    bridge.add('LATE-HISTORY', DIRECT, { sentAt: at(-10) })
    await relay.pollNow()
    expect(backend.ingests).toEqual([{ flag: true, waIds: ['LATE-HISTORY'] }])
    expect((await storedCursor())?.firstImport).toMatchObject({ ranFor: 5 * 60_000, quietFor: 0 })

    await rounds(quietRounds)
    expect((await storedCursor())?.firstImport).toBeNull()
    expect((await store.chats())[0]!.unread).toBe(0)
  })

  it('does not end the first import by its maximum when the Mac wakes after two hours asleep', async () => {
    bridge.add('H1', DIRECT, { sentAt: at(-100) })
    await relay.pollNow()
    await rounds(10)

    // Asleep: no rounds ran. On waking the history sync goes on.
    await rounds(1, 2 * 60 * 60 * 1000, () => bridge.add('H2', DIRECT, { sentAt: at(-50) }))

    expect((await storedCursor())?.firstImport).toEqual({ through: 2, ranFor: 10 * RELAY_INTERVAL + FIRST_IMPORT_STEP_MAX, quietFor: 0 })
    expect(backend.ingests.at(-1)).toEqual({ flag: true, waIds: ['H2'] })
  })

  it('ends the first import after its longest running time when the store never goes quiet', async () => {
    bridge.add('H1', DIRECT, { sentAt: at(-100) })
    await relay.pollNow()
    const steps = FIRST_IMPORT_MAX / FIRST_IMPORT_STEP_MAX
    await rounds(steps - 1, FIRST_IMPORT_STEP_MAX, (index) => bridge.add(`H${index + 2}`, DIRECT, { sentAt: at(-99 + index / 10) }))
    expect(backend.ingests.every(({ flag }) => flag)).toBe(true)
    expect((await storedCursor())?.firstImport).not.toBeNull()

    await rounds(1, FIRST_IMPORT_STEP_MAX, () => bridge.add('LATE', DIRECT, { sentAt: at(5) }))

    expect(backend.ingests.at(-1)).toEqual({ flag: false, waIds: ['LATE'] })
    expect((await storedCursor())?.firstImport).toBeNull()
    expect((await store.chats())[0]!.unread).toBe(1)
  })

  it('does not let a clock that jumps back keep the first import going', async () => {
    bridge.add('H1', DIRECT, { sentAt: at(-100) })
    await relay.pollNow()
    await rounds(5)

    // The clock goes back an hour (a time zone or NTP fix): that round counts nothing, the next ones count again.
    await rounds(1, -60 * 60 * 1000)
    expect((await storedCursor())?.firstImport).toMatchObject({ ranFor: 5 * RELAY_INTERVAL, quietFor: 5 * RELAY_INTERVAL })
    await rounds(quietRounds - 5)

    expect((await storedCursor())?.firstImport).toBeNull()
  })

  it('skips a round quietly while the bridge writes to its store', async () => {
    bridge.add('A1', DIRECT)
    bridge.busy = true
    relay.start()
    scheduler.fire()
    await vi.waitFor(() => expect(scheduler.active()).toHaveLength(1))

    expect(errors).toEqual([])
    expect(scheduler.active()[0]!.ms).toBe(RELAY_INTERVAL)
    expect(await storedCursor()).toBeNull()
    await relay.stop()
  })

  it('sends waiting replies oldest first and records each outcome', async () => {
    bridge.add('A1', DIRECT, { sentAt: at(-5) })
    bridge.add('B1', OTHER)
    await relay.pollNow()
    await queueLocalReply(store, localChatId(OTHER), 'second', '0193a000-0000-7000-8000-000000000002', at(2))
    await queueLocalReply(store, localChatId(DIRECT), 'first', '0193a000-0000-7000-8000-000000000001', at(1))
    await queueLocalReply(store, localChatId(DIRECT), 'third', '0193a000-0000-7000-8000-000000000003', at(3))
    await queueLocalReply(store, localChatId(DIRECT), 'fourth', '0193a000-0000-7000-8000-000000000004', at(4))
    bridge.answer = async (_recipient, text) => {
      if (text === 'second') {
        return { ok: false, error: 'not_linked' }
      }
      if (text === 'third') {
        throw new Error('The recipient is not a phone number or a WhatsApp chat.')
      }
      if (text === 'fourth') {
        return { ok: false, error: 'unconfirmed' }
      }
      return { ok: true }
    }

    await relay.pollNow()

    expect(bridge.sent).toEqual([
      { recipient: DIRECT, text: 'first' },
      { recipient: OTHER, text: 'second' },
      { recipient: DIRECT, text: 'third' },
      { recipient: DIRECT, text: 'fourth' },
    ])
    const direct = (await store.chat(localChatId(DIRECT)))!
    expect(direct.outgoing.map((row) => [row.text, row.status, row.error, row.sentAt])).toEqual([
      ['first', 'sent', null, new Date(NOW).toISOString()],
      ['third', 'failed', 'refused', null],
      ['fourth', 'failed', 'unconfirmed', null],
    ])
    expect(direct.chat.lastMessageAt).toBe(new Date(NOW).toISOString())
    expect((await store.chat(localChatId(OTHER)))!.outgoing.map((row) => [row.status, row.error])).toEqual([['failed', 'not_linked']])

    // Nothing is sent again by itself, an unconfirmed reply least of all.
    await relay.pollNow()
    expect(bridge.sent).toHaveLength(4)
    expect(await store.chatMeta('sending')).toBeNull()
  })

  it('reports a result again when reporting failed, without sending a second time', async () => {
    bridge.add('A1', DIRECT)
    await relay.pollNow()
    await queueLocalReply(store, localChatId(DIRECT), 'once', '0193a000-0000-7000-8000-000000000001', at(1))
    await queueLocalReply(store, localChatId(DIRECT), 'next', '0193a000-0000-7000-8000-000000000002', at(2))
    backend.failReport = new Error('database is locked')

    await relay.pollNow()
    expect(errors.map(({ step }) => step)).toEqual(['report'])
    expect(bridge.sent.map(({ text }) => text)).toEqual(['once'])
    expect((await store.chat(localChatId(DIRECT)))!.outgoing.map((row) => row.status)).toEqual(['sending', 'waiting'])

    await relay.pollNow()

    expect(bridge.sent.map(({ text }) => text)).toEqual(['once', 'next'])
    expect((await store.chat(localChatId(DIRECT)))!.outgoing.map((row) => row.status)).toEqual(['sent', 'sent'])
  })

  it('shows a reply interrupted by a crash as not sent, and sends it only on Try again', async () => {
    bridge.add('A1', DIRECT)
    await relay.pollNow()
    const id = '0193a000-0000-7000-8000-000000000001'
    await queueLocalReply(store, localChatId(DIRECT), 'maybe', id, at(1))
    // The app dies while the bridge call is under way: claimed, never reported.
    bridge.answer = () => new Promise(() => {})
    void relay.pollNow()
    await vi.waitFor(() => expect(bridge.sent).toHaveLength(1))
    expect((await store.chat(localChatId(DIRECT)))!.outgoing[0]!.status).toBe('sending')

    bridge.answer = async () => ({ ok: true })
    const restarted = makeRelay()
    await restarted.pollNow()

    expect(bridge.sent).toHaveLength(1)
    expect((await store.chat(localChatId(DIRECT)))!.outgoing.map((row) => [row.status, row.error])).toEqual([['failed', 'unconfirmed']])

    await retryLocalReply(store, localChatId(DIRECT), id)
    await restarted.pollNow()
    expect(bridge.sent).toHaveLength(2)
    expect((await store.chat(localChatId(DIRECT)))!.outgoing.map((row) => row.status)).toEqual(['sent'])
  })

  it('never overlaps rounds when one takes longer than the interval', async () => {
    bridge.add('A1', DIRECT)
    let release!: () => void
    backend.holdIngest = new Promise((resolve) => (release = resolve))
    relay.start()
    scheduler.fire()
    await vi.waitFor(() => expect(backend.ingesting).toBe(1))

    // Far past the interval: nothing is planned while the round runs, and asking for a round waits for it.
    expect(scheduler.active()).toEqual([])
    const asked = relay.pollNow()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(backend.ingesting).toBe(1)

    backend.holdIngest = null
    release()
    await asked
    expect(backend.mostAtOnce).toBe(1)
    expect(scheduler.active().map((timer) => timer.ms)).toEqual([RELAY_INTERVAL])
    expect(bridge.reads).toEqual([0, 1])
    await relay.stop()
  })

  it('stop waits for the round under way, a send included, and plans nothing after', async () => {
    bridge.add('A1', DIRECT)
    await relay.pollNow()
    await queueLocalReply(store, localChatId(DIRECT), 'going', '0193a000-0000-7000-8000-000000000001', at(1))
    await queueLocalReply(store, localChatId(DIRECT), 'stays', '0193a000-0000-7000-8000-000000000002', at(2))
    let answer!: (result: BridgeSendResult) => void
    bridge.answer = () => new Promise((resolve) => (answer = resolve))
    relay.start()
    scheduler.fire()
    await vi.waitFor(() => expect(bridge.sent).toHaveLength(1))

    let stopped = false
    const stopping = relay.stop().then(() => (stopped = true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stopped).toBe(false)
    answer({ ok: true })
    await stopping

    expect(relay.running).toBe(false)
    expect(scheduler.active()).toEqual([])
    expect(bridge.sent.map(({ text }) => text)).toEqual(['going'])
    expect((await store.chat(localChatId(DIRECT)))!.outgoing.map((row) => row.status)).toEqual(['sent', 'waiting'])
    await relay.pollNow()
    expect(bridge.sent).toHaveLength(1)
  })

  it('stops cleanly when the chats are removed: nothing comes back', async () => {
    bridge.add('A1', DIRECT)
    relay.start()
    scheduler.fire()
    await vi.waitFor(() => expect(scheduler.active()).toHaveLength(1))

    await relay.stop()
    await removeLocalChats(store)
    bridge.add('A2', DIRECT)
    await relay.pollNow()

    expect(await store.chatAccounts()).toEqual([])
    expect(await store.chats()).toEqual([])
    expect(await store.chatMeta(LOCAL_CURSOR)).toBeNull()
  })

  it('stops by itself when the chats are removed while it runs', async () => {
    const stoppedFor: unknown[] = []
    backend = new Wrapped(new LocalChatBackend(store, config, identity, () => NOW))
    relay = new ChatRelay({ now: () => NOW, bridge, backend, schedule: scheduler.schedule, onError: (error, step) => errors.push({ error, step }), onStopped: (reason) => stoppedFor.push(reason) })
    bridge.add('A1', DIRECT)
    relay.start()
    scheduler.fire()
    await vi.waitFor(() => expect(scheduler.active()).toHaveLength(1))

    await removeLocalChats(store)
    bridge.add('A2', DIRECT)
    scheduler.fire()
    await vi.waitFor(() => expect(stoppedFor).toHaveLength(1))

    expect(stoppedFor[0]).toBeInstanceOf(ChatRelayStopped)
    expect(errors).toEqual([])
    expect(relay.running).toBe(false)
    expect(scheduler.active()).toEqual([])
    expect(await store.chats()).toEqual([])
  })

  it('stops quietly when the copy closes at sign-out', async () => {
    const stoppedFor: unknown[] = []
    relay = new ChatRelay({ now: () => NOW, bridge, backend, schedule: scheduler.schedule, onError: (error, step) => errors.push({ error, step }), onStopped: (reason) => stoppedFor.push(reason) })
    bridge.add('A1', DIRECT)
    relay.start()
    await store.close()
    scheduler.fire()
    await vi.waitFor(() => expect(stoppedFor).toHaveLength(1))

    expect(stoppedFor[0]).toBeInstanceOf(CopyClosingError)
    expect(errors).toEqual([])
    expect(scheduler.active()).toEqual([])
  })

  it('claims again after a claim whose write failed, instead of holding the queue until a restart', async () => {
    let failNext = false
    const flaky = new Proxy(store, {
      get(target, key) {
        if (key === 'putChatOutgoing') {
          return async (rows: Parameters<MailStore['putChatOutgoing']>[0]) => {
            if (failNext) {
              failNext = false
              throw new Error('disk I/O error')
            }
            return target.putChatOutgoing(rows)
          }
        }
        const value = Reflect.get(target, key, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as MailStore
    makeRelay(flaky)
    bridge.add('A1', DIRECT)
    await relay.pollNow()
    await queueLocalReply(flaky, localChatId(DIRECT), 'hi', '0193a000-0000-7000-8000-000000000001', at(1))
    failNext = true

    await relay.pollNow()
    expect(errors.map(({ step }) => step)).toEqual(['claim'])
    expect(bridge.sent).toEqual([])
    expect((await store.chat(localChatId(DIRECT)))!.outgoing.map((row) => row.status)).toEqual(['waiting'])

    await relay.pollNow()
    expect(bridge.sent.map(({ text }) => text)).toEqual(['hi'])
    expect((await store.chat(localChatId(DIRECT)))!.outgoing.map((row) => row.status)).toEqual(['sent'])
  })

  it('takes group senders stored as JIDs (history sync) as the same sender as live ones', async () => {
    await live()
    bridge.known = {
      '31611111111': { number: '31611111111', name: 'Mom' },
      // The shell guesses a number for an id it knows nothing of; the JID says this one is a LID.
      '84932172912345': { number: '84932172912345', name: null },
    }
    bridge.add('G1', GROUP, { sender: '31611111111' })
    bridge.add('G2', GROUP, { sender: '31611111111:5@s.whatsapp.net' })
    bridge.add('G3', GROUP, { sender: '31611111111.0:2@S.WHATSAPP.NET' })
    bridge.add('G4', GROUP, { sender: '84932172912345@lid' })
    bridge.add('G5', GROUP, { sender: '31622222222222@s.whatsapp.net' })
    bridge.add('G6', GROUP, { sender: '@lid' })

    await relay.pollNow()

    expect(bridge.nameCalls).toEqual([['31611111111', '84932172912345', '31622222222222']])
    expect((await store.chat(localChatId(GROUP)))!.messages.map((message) => message.sender)).toEqual([
      { id: '31611111111', name: 'Mom' },
      { id: '31611111111', name: 'Mom' },
      { id: '31611111111', name: 'Mom' },
      { id: '84932172912345', name: null },
      // A phone JID is a number, also when the shell could not tell.
      { id: '31622222222222', name: '+31622222222222' },
      null,
    ])
  })

  it('looks a sender without a name up again after a while, and keeps a name it found', async () => {
    await live()
    bridge.add('G1', GROUP, { sender: '31611111111' })
    await relay.pollNow()
    bridge.known = { '31611111111': { number: '31611111111', name: 'Mom' } }
    bridge.add('G2', GROUP, { sender: '31611111111' })
    clock += NAME_RETRY - 1
    await relay.pollNow()
    expect(bridge.nameCalls).toHaveLength(1)

    clock += 1
    bridge.add('G3', GROUP, { sender: '31611111111' })
    await relay.pollNow()
    bridge.add('G4', GROUP, { sender: '31611111111' })
    clock += NAME_RETRY
    await relay.pollNow()

    expect(bridge.nameCalls).toEqual([['31611111111'], ['31611111111']])
    // Messages stored before the name was known keep what was known then: the copy has no cheap way to find them.
    expect((await store.chat(localChatId(GROUP)))!.messages.map((message) => message.sender?.name)).toEqual(['+31611111111', '+31611111111', 'Mom', 'Mom'])
  })

  it('counts what it stored and what it left out, by why, with numbers only', async () => {
    await live()
    config.includeGroups = false
    makeRelay()
    bridge.add('A1', DIRECT)
    bridge.add('A2', DIRECT)
    bridge.add('G1', GROUP)
    bridge.add('S1', 'status@broadcast')
    bridge.add('OLD', DIRECT, { sentAt: IMPORT_SINCE - 1 })
    bridge.add('NOTIME', DIRECT, { sentAt: null })
    bridge.add('FUTURE', DIRECT, { sentAt: NOW + 2 * 24 * 60 * 60 * 1000 })
    bridge.add('BAD ID', DIRECT)
    bridge.add('EMPTY', DIRECT, { text: '' })
    await relay.pollNow()
    await setLocalChatState(store, localChatId(DIRECT), { leftOut: true })
    bridge.add('A3', DIRECT)
    await relay.pollNow()

    expect(progress.at(-1)).toEqual({
      chats: 1,
      stored: 2,
      known: 0,
      leftOut: 1,
      refused: 0,
      skipped: { not_a_chat: 1, groups_off: 1, left_out: 0, before_import: 1, no_time: 1, bad_time: 1, bad_id: 1, nothing_to_show: 1 },
      firstImport: false,
    })
  })

  it('passes a file size on only when it is a whole number of 0 or more', async () => {
    await live()
    bridge.add('M1', DIRECT, { mediaType: 'image', fileLength: -1 })
    bridge.add('M2', DIRECT, { mediaType: 'video', fileLength: 1.5 })
    bridge.add('M3', DIRECT, { mediaType: 'audio', fileLength: 0 })
    await relay.pollNow()

    expect((await store.chat(localChatId(DIRECT)))!.messages.map((message) => message.mediaSize)).toEqual([null, null, 0])
  })

  it('reports nothing when the chats were removed before stop flushed a result', async () => {
    bridge.add('A1', DIRECT)
    await relay.pollNow()
    await queueLocalReply(store, localChatId(DIRECT), 'hi', '0193a000-0000-7000-8000-000000000001', at(1))
    backend.failReport = new Error('database is locked')
    await relay.pollNow()
    expect(errors.map(({ step }) => step)).toEqual(['report'])

    await removeLocalChats(store)
    await relay.stop()

    expect(errors.map(({ step }) => step)).toEqual(['report'])
  })
})

describe('ChatRelay with a backend that asks to wait or stop', () => {
  function backendOf(overrides: Partial<ChatBackend>): ChatBackend {
    return {
      prepare: async () => {},
      settings: async () => ({ includeGroups: true, leftOut: new Set<string>(), importSince: 0 }),
      ingest: async () => ({ stored: 0, known: 0, leftOut: 0, refused: 0 }),
      cursor: async () => null,
      setCursor: async () => {},
      claimNext: async () => null,
      report: async () => {},
      ...overrides,
    }
  }

  it('waits as long as the backend asks', async () => {
    const bridge = new FakeBridge()
    bridge.add('A1', DIRECT)
    const scheduler = fakeScheduler()
    const relay = new ChatRelay({ now: () => NOW, bridge, backend: backendOf({ ingest: async () => Promise.reject(new ChatRelayRetryLater(60_000)) }), schedule: scheduler.schedule })
    relay.start()
    scheduler.fire()
    await vi.waitFor(() => expect(scheduler.active()).toHaveLength(1))

    expect(scheduler.active()[0]!.ms).toBe(60_000)
    await relay.stop()
  })

  it('keeps a pause a backend asks for in range', () => {
    expect(retryDelay(new ChatRelayRetryLater(Number.NaN))).toBe(RELAY_ERROR_DELAY)
    expect(retryDelay(new ChatRelayRetryLater(Number.POSITIVE_INFINITY))).toBe(RELAY_ERROR_DELAY)
    expect(retryDelay(new ChatRelayRetryLater(0))).toBe(RELAY_RETRY_MIN)
    expect(retryDelay(new ChatRelayRetryLater(-5))).toBe(RELAY_RETRY_MIN)
    expect(retryDelay(new ChatRelayRetryLater(24 * 60 * 60 * 1000))).toBe(RELAY_RETRY_MAX)
    expect(retryDelay(new ChatRelayRetryLater(30_000))).toBe(30_000)
  })

  it('claims no reply in a round in which the backend asked to wait', async () => {
    const bridge = new FakeBridge()
    bridge.add('A1', DIRECT)
    let claims = 0
    const scheduler = fakeScheduler()
    const relay = new ChatRelay({
      now: () => NOW,
      bridge,
      backend: backendOf({ ingest: async () => Promise.reject(new ChatRelayRetryLater(Number.NaN)), claimNext: async () => (claims++, null) }),
      schedule: scheduler.schedule,
    })
    relay.start()
    scheduler.fire()
    await vi.waitFor(() => expect(scheduler.active()).toHaveLength(1))

    expect(claims).toBe(0)
    expect(scheduler.active()[0]!.ms).toBe(RELAY_ERROR_DELAY)
    await relay.stop()
  })

  it('reads the user part of a sender JID', () => {
    expect(senderAddress('31612345678')).toEqual({ id: '31612345678', kind: null })
    expect(senderAddress('31612345678:12@s.whatsapp.net')).toEqual({ id: '31612345678', kind: 'phone' })
    expect(senderAddress('31612345678.0:3@S.WhatsApp.Net')).toEqual({ id: '31612345678', kind: 'phone' })
    expect(senderAddress('84932172912345@lid')).toEqual({ id: '84932172912345', kind: 'lid' })
    expect(senderAddress('84932172912345:4@lid')).toEqual({ id: '84932172912345', kind: 'lid' })
    expect(senderAddress('@lid')).toBeNull()
    expect(senderAddress('')).toBeNull()
  })

  it('still sends replies when reading fails, and waits longer after', async () => {
    const bridge = new FakeBridge()
    bridge.read = async () => Promise.reject(new Error('no_store'))
    const reported: ReplyResult[] = []
    let claimed = false
    const backend = backendOf({
      claimNext: async () => {
        if (claimed) {
          return null
        }
        claimed = true
        return { id: 'r1', chatId: 'c1', chatJid: DIRECT, text: 'hi', token: 'claim-1' }
      },
      report: async (reply, result) => {
        expect(reply.token).toBe('claim-1')
        reported.push(result)
      },
    })
    const scheduler = fakeScheduler()
    const steps: RelayStep[] = []
    const relay = new ChatRelay({ now: () => NOW, bridge, backend, schedule: scheduler.schedule, onError: (_error, step) => steps.push(step) })
    relay.start()
    scheduler.fire()
    await vi.waitFor(() => expect(scheduler.active()).toHaveLength(1))

    expect(steps).toEqual(['read'])
    expect(reported).toEqual([{ sent: true }])
    expect(scheduler.active()[0]!.ms).toBe(RELAY_ERROR_DELAY)
    await relay.stop()
  })

  it('tries again to prepare before anything else when preparing failed', async () => {
    const bridge = new FakeBridge()
    let tries = 0
    const reads: number[] = []
    bridge.read = async (after) => (reads.push(after), null)
    const relay = new ChatRelay({
      now: () => NOW,
      bridge,
      backend: backendOf({
        prepare: async () => {
          tries++
          if (tries === 1) {
            throw new Error('locked')
          }
        },
      }),
      schedule: fakeScheduler().schedule,
    })

    await relay.pollNow()
    expect(reads).toEqual([])
    await relay.pollNow()
    await relay.pollNow()
    expect(tries).toBe(2)
    expect(reads).toEqual([0, 0])
  })
})
