import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { reactive, shallowReactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  ChatApiError,
  SessionEndedDuringRequestError,
  LOCAL_CHAT_ACCOUNT,
  LOCAL_CURSOR,
  SqliteMailStore,
  localChatId,
  queueLocalReply,
  readRelayCursor,
  serverClaimKey,
  serverCursorKey,
  type RelayMessagesRequest,
  type RelayStatusRequest,
} from '@tresso/core'
import { memorySql } from '@tresso/core/testing/sql'
import type { WhatsAppConfig } from '@/platform/whatsapp'
import type { SessionEnd } from '@/stores/auth'
import { CARRIED_REPLIES, CARRY_COUNTS, MODE_SWITCH, SERVER_ACCOUNT, serverHistoryKey } from '@/stores/whatsappServer'
import { ACCOUNT_ID, FakeChatServer, OTHER_DEVICE } from './chatServerFixture'
import { DAY, DIRECT, FOLDER, FakeShell, GROUP, LINKED, NOW, RUNNING, WAITING } from './whatsappShellFixture'

const DEVICE = '0193a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b'
/** The number the fake shell's bridge is linked to. */
const NUMBER = '31698765432'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const fake = vi.hoisted(() => ({ shell: null as unknown, server: null as unknown, desktop: true }))
vi.mock('@/platform/whatsapp', async (original) => ({
  ...(await original<typeof import('@/platform/whatsapp')>()),
  whatsAppShell: () => (fake.shell as FakeShell).commands(),
}))
vi.mock('@/platform/desktop', async (original) => ({
  ...(await original<typeof import('@/platform/desktop')>()),
  get isDesktop() {
    return fake.desktop
  },
}))
vi.mock('@/api/chats', () => ({ useChatApi: () => fake.server }))

const auth = reactive({
  me: null as { id: string } | null,
  knownUserId: null as string | null,
  handlers: [] as ((reason: SessionEnd) => unknown)[],
  serverNow: () => Date.now(),
  onSessionEnd(handler: (reason: SessionEnd) => unknown) {
    auth.handlers.push(handler)
    return () => undefined
  },
})
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))

/**
 * The mail copy as the mail store offers it, with the delta: a pull (`syncNow`) brings what the fake server holds, and
 * counts as a page with chat rows and a pull that ended.
 */
const mail = shallowReactive({
  synced: true,
  store: null as SqliteMailStore | null,
  pulls: 0,
  chatChanges: 0,
  syncState: 'idle' as 'idle' | 'syncing' | 'error',
  currentStore: () => mail.store,
  syncNow: async () => {
    if (mail.store !== null) {
      await (fake.server as FakeChatServer).deliver(mail.store)
    }
    mail.chatChanges++
    mail.pulls++
  },
})
vi.mock('@/stores/mail', () => ({ useMailStore: () => mail }))

const { useWhatsAppRelayStore, ACCOUNT_GONE, COPY_FIRST, HEARTBEAT_MS, OTHER_NUMBER, RELAY_ONLY, REMOVED_ELSEWHERE, SERVER_RETRY_MS: SERVER_RETRY, UNKNOWN_NUMBER } = await import('../whatsappRelay')

/** A Storage in memory (the test environment's own may be missing). */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
}

function connectedConfig(extra: Partial<WhatsAppConfig> = {}): WhatsAppConfig {
  return {
    folder: FOLDER,
    mode: 'all',
    deviceId: DEVICE,
    deviceName: "Kim's MacBook Pro",
    linkedAt: '2026-11-01T10:00:00.000Z',
    importSince: new Date(NOW - 30 * DAY).toISOString(),
    includeGroups: true,
    notify: false,
    leftOut: [],
    ...extra,
  }
}

async function pass(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 30; i++) {
    await vi.advanceTimersByTimeAsync(0)
  }
}

describe('the WhatsApp relay store in "All my devices"', () => {
  let shell: FakeShell
  let server: FakeChatServer
  let store: SqliteMailStore
  let errors: unknown[][]

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(NOW)
    shell = new FakeShell()
    server = new FakeChatServer()
    fake.shell = shell
    fake.server = server
    fake.desktop = true
    auth.me = null
    auth.knownUserId = null
    auth.handlers = []
    store = await SqliteMailStore.open(await memorySql())
    mail.store = store
    mail.synced = true
    mail.pulls = 0
    mail.chatChanges = 0
    mail.syncState = 'idle'
    vi.stubGlobal('localStorage', memoryStorage())
    setActivePinia(createPinia())
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args))
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    await useWhatsAppRelayStore().dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function signedIn(config: WhatsAppConfig | null = null) {
    if (config !== null) {
      shell.configs.set('u1', config)
    }
    const wa = useWhatsAppRelayStore()
    await wa.init()
    auth.me = { id: 'u1' }
    await pass()
    return wa
  }

  /** An account this Mac relays, as the server and the copy hold it. */
  async function relayedHere(extra: Partial<WhatsAppConfig> = {}) {
    await server.connect({ deviceId: DEVICE, deviceName: "Kim's MacBook Pro", address: NUMBER, displayName: null, includeGroups: true, notify: false })
    server.calls.length = 0
    await server.deliver(store)
    await store.setChatMeta(SERVER_ACCOUNT, ACCOUNT_ID)
    const wa = await signedIn(connectedConfig(extra))
    // A pull of this copy in this session: only then does the relay trust it.
    await mail.syncNow()
    await pass()
    return wa
  }

  function batches(): RelayMessagesRequest[] {
    return server.callsOf('relayMessages').map((args) => args[1] as RelayMessagesRequest)
  }

  function statuses(): RelayStatusRequest[] {
    return server.callsOf('relayStatus').map((args) => args[1] as RelayStatusRequest)
  }

  it('connects in "All my devices": the server account first, then the relay, once the copy caught up with it', async () => {
    const wa = await signedIn()
    shell.add('A1', DIRECT, 60)
    await wa.chooseFolder()
    wa.riskAccepted = true
    await wa.start()
    shell.emit(WAITING)
    shell.emit(LINKED)
    await pass()

    expect(await wa.connect('all', { copy: true })).toBe(true)
    await pass()

    const [request] = server.callsOf('connect')[0] as [Record<string, unknown>]
    expect(request).toEqual({ deviceId: expect.stringMatching(UUID_V4), deviceName: "Kim's MacBook Pro", address: '31698765432', displayName: 'Kim Visser', includeGroups: true, notify: false })
    const saved = shell.saved[shell.saved.length - 1]!
    expect(saved).toMatchObject({ mode: 'all', deviceId: request.deviceId, importSince: new Date(NOW - 30 * DAY).toISOString() })
    // The same device id for every relay call; the history goes as a first import.
    expect(batches()[0]).toMatchObject({ deviceId: request.deviceId, firstImport: true })
    expect(statuses()[0]).toEqual({ deviceId: request.deviceId, bridge: 'running', link: 'linked', linkedAt: new Date(NOW).toISOString(), loopbackOnly: true, address: NUMBER })
    expect(wa.relaysHere).toBe(true)
    expect(wa.relayRunning).toBe(true)
    expect(await store.chatMeta(MODE_SWITCH)).toBeNull()
    expect(await store.chatMeta(SERVER_ACCOUNT)).toBe(ACCOUNT_ID)
    // Nothing is written as a `wa:` row: the chats come back through the delta.
    expect((await store.chatAccounts()).map((account) => account.id)).toEqual([ACCOUNT_ID])
    expect((await store.chatByJid(ACCOUNT_ID, DIRECT))?.readThrough).not.toBeNull()
  })

  it('undoes a connect the server did not take, so the dialog can be tried again', async () => {
    const wa = await signedIn()
    await wa.chooseFolder()
    wa.riskAccepted = true
    await wa.start()
    shell.emit(LINKED)
    await pass()
    server.fail('connect', new TypeError('Failed to fetch'))

    expect(await wa.connect('all', { copy: true })).toBe(false)
    expect(wa.error).toBe('Tresso could not reach your Tresso server. Try again.')
    expect(wa.connected).toBe(false)
    expect(shell.configs.has('u1')).toBe(false)
    expect(await store.chatMeta(MODE_SWITCH)).toBeNull()
  })

  it('does not start the relay before the copy holds the account and a pull ended after it', async () => {
    await server.connect({ deviceId: DEVICE, deviceName: 'Mac', address: null, displayName: null, includeGroups: true, notify: false })
    server.delivering = false
    shell.add('A1', DIRECT, 60)
    const wa = await signedIn(connectedConfig())
    shell.emit(LINKED)
    await pass(10_000)
    expect(wa.relayRunning).toBe(false)
    expect(batches()).toEqual([])

    // The account arrives during a pull: the relay waits for that pull to end.
    mail.syncState = 'syncing'
    server.delivering = true
    await server.deliver(store)
    mail.chatChanges++
    await pass(10_000)
    expect(wa.relayRunning).toBe(false)
    mail.syncState = 'idle'
    mail.pulls++
    await pass()
    expect(wa.relayRunning).toBe(true)
    expect(batches()).toHaveLength(1)
  })

  it('sends the heartbeat at once, every 60 seconds, and on every change of the bridge, also when it stops', async () => {
    const wa = await relayedHere()
    // At once, once the copy has caught up (the bridge started before that).
    expect(statuses().map((status) => status.bridge)).toEqual(['running'])
    expect(wa.relayRunning).toBe(false)

    shell.emit(LINKED)
    await pass()
    // On the change of the bridge, and again once the linked number is known (the server checks it).
    const linked = statuses().length
    expect(linked).toBeGreaterThanOrEqual(2)
    expect(statuses()[1]).toMatchObject({ bridge: 'running', link: 'linked', deviceId: DEVICE })
    expect(statuses()[linked - 1]).toMatchObject({ link: 'linked', address: NUMBER })
    expect(wa.relayRunning).toBe(true)

    await pass(HEARTBEAT_MS - 1_000)
    expect(statuses()).toHaveLength(linked)
    await pass(1_000)
    expect(statuses()).toHaveLength(linked + 1)

    shell.emit({ ...RUNNING, link: 'unlinked' })
    await pass()
    expect(statuses()).toHaveLength(linked + 2)
    expect(statuses()[linked + 1]).toMatchObject({ bridge: 'running', link: 'unlinked' })
    expect(wa.relayRunning).toBe(false)
    await pass(HEARTBEAT_MS)
    expect(statuses()).toHaveLength(linked + 3)
  })

  it('switches from "Only this Mac": the waiting replies go to the server queue with new ids, the local rows only after the account', async () => {
    const wa = await signedIn(connectedConfig({ mode: 'local' }))
    shell.add('A1', DIRECT, 10)
    shell.emit(LINKED)
    await pass(3_000)
    // The bridge unlinks: the relay stops and a reply written now waits here.
    shell.emit({ ...RUNNING, link: 'unlinked' })
    await pass()
    const localId = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51'
    await queueLocalReply(store, localChatId(DIRECT), 'On my way', localId, Date.now())

    let answer!: () => void
    server.held.set('connect', new Promise<void>((resolve) => (answer = resolve)))
    const switching = wa.switchMode('all', { copy: true })
    await pass()
    // While the server has not answered, the local rows and their reply stay.
    expect(await store.chatMeta(MODE_SWITCH)).toBe(JSON.stringify({ to: 'all', accountId: null, copy: true }))
    expect((await store.chat(localChatId(DIRECT)))?.outgoing).toHaveLength(1)
    answer()
    expect(await switching).toBe(true)
    await pass()

    expect(shell.saved[shell.saved.length - 1]).toMatchObject({ mode: 'all', deviceId: DEVICE })
    expect(await store.chat(localChatId(DIRECT))).toBeNull()
    expect(await store.chatMeta(LOCAL_CURSOR)).toBeNull()
    expect(wa.carried).toEqual([{ jid: DIRECT, text: 'On my way', id: null }])

    // The relay brings the chat to the server; once the copy has it (a pull), the reply is queued there.
    shell.emit(LINKED)
    await pass(3_000)
    expect(server.callsOf('queueReply')).toEqual([])
    await mail.syncNow()
    await pass()
    const queued = server.callsOf('queueReply')
    expect(queued).toHaveLength(1)
    const [chatId, request] = queued[0] as [string, { id: string; text: string }]
    expect(chatId).toBe(`chat-${DIRECT}`)
    expect(request.text).toBe('On my way')
    expect(request.id).toMatch(UUID_V7)
    expect(request.id).not.toBe(localId)
    expect(wa.carried).toEqual([])
    expect(await store.chatMeta(CARRIED_REPLIES)).toBeNull()
  })

  it('stays "Only this Mac", its replies where they were, when the server does not take the switch', async () => {
    const wa = await signedIn(connectedConfig({ mode: 'local' }))
    shell.add('A1', DIRECT, 10)
    shell.emit(LINKED)
    await pass(3_000)
    shell.emit({ ...RUNNING, link: 'unlinked' })
    await pass()
    await queueLocalReply(store, localChatId(DIRECT), 'On my way', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51', Date.now())
    server.fail('connect', new ChatApiError(503, 'Unavailable'))

    expect(await wa.switchMode('all', { copy: true })).toBe(false)
    expect(wa.error).toBe('Your Tresso server could not take this change just now. Try again.')
    expect(wa.config?.mode).toBe('local')
    expect(await store.chatMeta(MODE_SWITCH)).toBeNull()
    expect(await store.chatMeta(CARRIED_REPLIES)).toBeNull()
    expect((await store.chat(localChatId(DIRECT)))?.outgoing[0]).toMatchObject({ status: 'waiting' })
    shell.emit(LINKED)
    await pass(3_000)
    expect(wa.relayRunning).toBe(true)
    expect(server.callsOf('relayMessages')).toEqual([])
  })

  describe('takes up a switch to "All my devices" that stopped after', () => {
    async function localRowsWithReply(): Promise<void> {
      shell.configs.set('u1', connectedConfig({ mode: 'local' }))
      const wa = useWhatsAppRelayStore()
      await wa.init()
      auth.me = { id: 'u1' }
      await pass()
      shell.add('A1', DIRECT, 10)
      shell.emit(LINKED)
      await pass(3_000)
      shell.emit({ ...RUNNING, link: 'unlinked' })
      await pass()
      await queueLocalReply(store, localChatId(DIRECT), 'On my way', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51', Date.now())
      await wa.dispose()
      setActivePinia(createPinia())
      auth.me = null
      shell.calls.length = 0
    }

    it('marking it (the config still "Only this Mac")', async () => {
      await localRowsWithReply()
      await store.setChatMeta(MODE_SWITCH, JSON.stringify({ to: 'all', accountId: null, copy: true }))

      const wa = await signedIn()
      await pass()
      expect(server.callsOf('connect')).toHaveLength(1)
      expect(wa.config?.mode).toBe('all')
      expect(await store.chat(localChatId(DIRECT))).toBeNull()
      expect(wa.carried).toEqual([{ jid: DIRECT, text: 'On my way', id: null }])
      expect(wa.modeSwitch).toBeNull()
    })

    it('the account and the config, before the local rows went', async () => {
      await localRowsWithReply()
      await store.setChatMeta(MODE_SWITCH, JSON.stringify({ to: 'all', accountId: ACCOUNT_ID, copy: true }))
      shell.configs.set('u1', connectedConfig())

      const wa = await signedIn()
      await pass()
      expect(await store.chat(localChatId(DIRECT))).toBeNull()
      expect(wa.carried).toEqual([{ jid: DIRECT, text: 'On my way', id: null }])
      expect(wa.modeSwitch).toBeNull()
    })

    it('the local rows went: the replies noted then stay', async () => {
      await store.setChatMeta(MODE_SWITCH, JSON.stringify({ to: 'all', accountId: ACCOUNT_ID, copy: true }))
      await store.setChatMeta(CARRIED_REPLIES, JSON.stringify([{ jid: DIRECT, text: 'On my way', id: null }]))

      const wa = await signedIn(connectedConfig())
      await pass()
      expect(wa.carried).toEqual([{ jid: DIRECT, text: 'On my way', id: null }])
      expect(wa.modeSwitch).toBeNull()
    })

    it('marking a connect whose config was never saved: it is forgotten', async () => {
      await store.setChatMeta(MODE_SWITCH, JSON.stringify({ to: 'all', accountId: null, copy: true }))

      const wa = await signedIn()
      await pass()
      expect(wa.modeSwitch).toBeNull()
      expect(server.callsOf('connect')).toEqual([])
      expect(wa.connected).toBe(false)
    })
  })

  it('switches to "Only this Mac": a kept claim is reported, the account deleted, and the local relay reads from 0 once the copy applied it', async () => {
    const wa = await relayedHere()
    shell.add('A1', DIRECT, 10)
    shell.emit(LINKED)
    await pass(3_000)
    expect(wa.relayRunning).toBe(true)
    // A reply this Mac sent whose result could not be reported yet.
    await store.setChatMeta(serverClaimKey(ACCOUNT_ID), JSON.stringify({ id: 'reply-1', token: 'token-x', result: { sent: true } }))
    server.outgoing.set('reply-1', { id: 'reply-1', chatId: `chat-${DIRECT}`, chatAccountId: ACCOUNT_ID, text: 'Hi', status: 'sending', error: null, createdAt: new Date().toISOString(), claimedAt: null, sentAt: null })
    server.delivering = false

    expect(await wa.switchMode('local')).toBe(true)
    const order = server.calls.map((call) => call.name).filter((name) => name === 'reportReply' || name === 'removeAccount')
    expect(order).toEqual(['reportReply', 'removeAccount'])
    expect(server.callsOf('reportReply')[0]![2]).toMatchObject({ sent: true, claimToken: 'token-x', deviceId: DEVICE })
    expect(wa.config?.mode).toBe('local')
    expect(await store.chatMeta(serverClaimKey(ACCOUNT_ID))).toBeNull()
    expect(await store.chatMeta(serverCursorKey(ACCOUNT_ID))).toBeNull()

    // The copy has not applied the removal yet: the local relay waits.
    await pass(10_000)
    expect(wa.modeSwitch).toMatchObject({ to: 'local', removed: true, cleared: true })
    expect(wa.relayRunning).toBe(false)
    const reads = shell.calls.filter((call) => call === 'read').length

    server.delivering = true
    await mail.syncNow()
    await pass()
    expect(wa.modeSwitch).toBeNull()
    expect(wa.relayRunning).toBe(true)
    expect(shell.calls.filter((call) => call === 'read').length).toBeGreaterThan(reads)
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, DIRECT)).not.toBeNull()
    expect(await store.chatAccounts()).toEqual([expect.objectContaining({ id: LOCAL_CHAT_ACCOUNT })])
  })

  it('stays "All my devices" when the server cannot remove the account', async () => {
    const wa = await relayedHere()
    shell.emit(LINKED)
    await pass()
    server.fail('removeAccount', new ChatApiError(500, 'Broken'))

    expect(await wa.switchMode('local')).toBe(false)
    expect(wa.config?.mode).toBe('all')
    expect(wa.modeSwitch).toBeNull()
    await pass()
    expect(wa.relayRunning).toBe(true)
    expect(server.account).not.toBeNull()
  })

  describe('takes up a switch to "Only this Mac" that stopped after', () => {
    it('marking it: the account is removed then', async () => {
      await store.setChatMeta(MODE_SWITCH, JSON.stringify({ to: 'local', accountId: ACCOUNT_ID, removed: false, cleared: false }))
      const wa = await relayedHere()
      await pass()
      expect(server.callsOf('removeAccount')).toEqual([[ACCOUNT_ID]])
      expect(wa.config?.mode).toBe('local')
      expect(wa.modeSwitch).toBeNull()
    })

    it('the removal: the config follows, nothing is removed twice', async () => {
      await store.setChatMeta(MODE_SWITCH, JSON.stringify({ to: 'local', accountId: ACCOUNT_ID, removed: true, cleared: false }))
      await store.setChatMeta(serverCursorKey(ACCOUNT_ID), JSON.stringify({ storeId: 'store-1', rowid: 4, firstImport: null }))
      const wa = await relayedHere()
      server.removeElsewhere()
      await pass()
      expect(server.callsOf('removeAccount')).toEqual([])
      expect(wa.config?.mode).toBe('local')
      expect(await store.chatMeta(serverCursorKey(ACCOUNT_ID))).toBeNull()
    })

    it('everything but the copy applying the removal: it waits for that', async () => {
      await store.setChatMeta(MODE_SWITCH, JSON.stringify({ to: 'local', accountId: ACCOUNT_ID, removed: true, cleared: true }))
      await server.connect({ deviceId: DEVICE, deviceName: 'Mac', address: null, displayName: null, includeGroups: true, notify: false })
      await server.deliver(store)
      server.delivering = false
      const wa = await signedIn(connectedConfig({ mode: 'local' }))
      shell.emit(LINKED)
      await pass(10_000)
      expect(wa.relayRunning).toBe(false)
      server.delivering = true
      server.removeElsewhere()
      await mail.syncNow()
      await pass()
      expect(wa.modeSwitch).toBeNull()
      expect(wa.relayRunning).toBe(true)
    })
  })

  it('stops relaying when another Mac took over, reporting a kept sent result first', async () => {
    const wa = await relayedHere()
    shell.add('A1', DIRECT, 10)
    shell.emit(LINKED)
    await pass(3_000)
    await store.setChatMeta(serverClaimKey(ACCOUNT_ID), JSON.stringify({ id: 'reply-1', token: 'token-x', result: { sent: true } }))
    server.outgoing.set('reply-1', { id: 'reply-1', chatId: `chat-${DIRECT}`, chatAccountId: ACCOUNT_ID, text: 'Hi', status: 'sending', error: null, createdAt: new Date().toISOString(), claimedAt: null, sentAt: null })

    server.takenOverBy(OTHER_DEVICE)
    await mail.syncNow()
    await pass()
    expect(wa.relayRunning).toBe(false)
    expect(wa.relaysHere).toBe(false)
    expect(wa.otherRelay).toEqual({ name: 'Office iMac', online: true, offlineSince: null })
    // A former relay may still report `sent` for its own claim; then what it kept goes.
    expect(server.callsOf('reportReply')[0]![2]).toMatchObject({ sent: true, deviceId: DEVICE })
    expect(server.outgoing.get('reply-1')?.status).toBe('sent')
    expect(await store.chatMeta(serverClaimKey(ACCOUNT_ID))).toBeNull()
    expect(await store.chatMeta(serverCursorKey(ACCOUNT_ID))).toBeNull()
    const beats = statuses().length
    await pass(HEARTBEAT_MS * 2)
    expect(statuses()).toHaveLength(beats)
  })

  it('brings a file asked for on another device, and sends a reply file through a staged copy it removes after', async () => {
    await relayedHere()
    shell.add('A1', DIRECT, 10, { mediaType: 'image', filename: 'photo.jpg', fileLength: 3, text: '' })
    shell.emit(LINKED)
    await pass(3_000)
    const photo = [...server.messages.values()].find((message) => message.waId === 'A1')!
    await server.requestMedia(photo.id)
    server.outgoing.set('reply-file', {
      id: 'reply-file',
      chatId: `chat-${DIRECT}`,
      chatAccountId: ACCOUNT_ID,
      text: '',
      status: 'waiting',
      error: null,
      createdAt: new Date().toISOString(),
      claimedAt: null,
      sentAt: null,
      file: { name: 'plan.pdf', size: 4 },
    })

    await pass(3_000)

    const [[, messageId, upload]] = server.callsOf('uploadMedia') as [[string, string, { deviceId: string; sha256: string; body: Blob }]]
    expect(messageId).toBe(photo.id)
    expect(upload.sha256).toBe('a'.repeat(64))
    expect(server.files.get(photo.id)).toBe('bytes of /tmp/x')
    expect(shell.sent).toContainEqual({ recipient: DIRECT, text: '', file: '/outbox/1/plan.pdf' })
    expect(server.outgoing.get('reply-file')?.status).toBe('sent')
    expect(shell.staged.size).toBe(0)
    expect(shell.discarded).toEqual(['/outbox/1/plan.pdf'])
  })

  it('stops when a relay call says another device relays, and stays off until the copy says who', async () => {
    const wa = await relayedHere()
    shell.add('A1', DIRECT, 10)
    shell.emit(LINKED)
    await pass(3_000)
    server.delivering = false
    server.takenOverBy(OTHER_DEVICE)
    shell.add('A2', DIRECT, 1)
    await pass(3_000)

    expect(wa.relayRunning).toBe(false)
    // The copy still names this Mac, but nothing starts again until it changes.
    expect(wa.relaysHere).toBe(true)
    const calls = server.calls.length
    shell.emit({ ...LINKED, loopbackOnly: true, port: 8742 })
    await pass(10_000)
    expect(batches().length).toBe(server.callsOf('relayMessages').length)
    expect(server.calls.slice(calls).map((call) => call.name)).not.toContain('relayMessages')
    server.delivering = true
    await mail.syncNow()
    await pass()
    expect(wa.otherRelay?.name).toBe('Office iMac')
  })

  it('takes the relay over with "Use this Mac instead", comparing the device only once the copy shows the change', async () => {
    await server.connect({ deviceId: OTHER_DEVICE, deviceName: 'Office iMac', address: null, displayName: null, includeGroups: true, notify: false })
    await server.deliver(store)
    await store.setChatMeta(SERVER_ACCOUNT, ACCOUNT_ID)
    const wa = await signedIn(connectedConfig())
    shell.add('A1', DIRECT, 10)
    shell.emit(LINKED)
    await pass(3_000)
    expect(wa.relayRunning).toBe(false)
    expect(wa.otherRelay?.name).toBe('Office iMac')

    server.delivering = false
    let pulled!: () => void
    const pulling = new Promise<void>((resolve) => (pulled = resolve))
    const syncNow = mail.syncNow
    mail.syncNow = async () => {
      await pulling
      server.delivering = true
      await syncNow()
    }
    const taking = wa.useThisMac({ number: true })
    onTestFinished(() => {
      mail.syncNow = syncNow
    })
    await pass(10_000)
    // Asked for, not in the copy yet: neither stopped as a former relay nor started.
    expect(server.lastCall('connect')![0]).toMatchObject({ deviceId: DEVICE })
    expect(wa.takingOver).toBe(true)
    expect(wa.relayRunning).toBe(false)
    pulled()
    expect(await taking).toBe(true)
    mail.syncNow = syncNow
    await pass()
    expect(wa.relaysHere).toBe(true)
    expect(wa.relayRunning).toBe(true)
    expect(batches()[0]).toMatchObject({ deviceId: DEVICE, firstImport: true })
  })

  it('shows an import the server keeps refusing as stuck, and counts rows it passed over', async () => {
    const wa = await relayedHere()
    for (let i = 0; i < 5; i++) {
      shell.add(`A${i}`, DIRECT, 10 - i)
    }
    server.fail('relayMessages', new ChatApiError(422, 'Invalid', null, null, { 'messages[0].text': '' }))
    shell.emit(LINKED)
    await pass(3_000)
    expect(wa.serverRefused).toBe(1)

    server.fail('relayMessages', new ChatApiError(422, 'Invalid', null, null, { 'messages[0].text': '', 'messages[1].text': '', 'messages[2].text': '', 'messages[3].text': '' }), true)
    for (let i = 0; i < 5; i++) {
      shell.add(`B${i}`, DIRECT, 1)
    }
    await pass(3_000)
    expect(wa.importState).toBe('stuck')
    expect(wa.stuckRefused).toBe(4)
  })

  it('disconnects WhatsApp on this Mac when the account was removed on another device', async () => {
    const wa = await relayedHere()
    shell.emit(LINKED)
    await pass()
    server.removeElsewhere()
    await mail.syncNow()
    await pass()
    expect(server.callsOf('accounts')).toHaveLength(1)
    expect(wa.connected).toBe(false)
    expect(shell.configs.has('u1')).toBe(false)
    expect(wa.notice).toBe(REMOVED_ELSEWHERE)
    expect(wa.relayRunning).toBe(false)
    expect(await store.chatMeta(SERVER_ACCOUNT)).toBeNull()
  })

  it('does not take a copy that is behind for a removal: the server is asked first', async () => {
    const wa = await relayedHere()
    await store.removeChatAccount(ACCOUNT_ID)
    mail.chatChanges++
    await pass()
    expect(server.callsOf('accounts')).toHaveLength(1)
    expect(wa.connected).toBe(true)
  })

  it('takes a chat back in with live batches, its history marked read by the chat state', async () => {
    const wa = await relayedHere()
    shell.add('A1', DIRECT, 10)
    shell.add('G1', GROUP, 9)
    shell.emit(LINKED)
    await pass(3_000)
    await pass(70_000)
    await mail.syncNow()
    await pass()
    expect(wa.importState).toBe('done')
    expect(await wa.leaveOut(DIRECT)).toBe(true)
    expect(server.chats.get(DIRECT)?.leftOut).toBe(true)
    shell.add('A2', DIRECT, 5)
    await pass(3_000)

    const before = batches().length
    expect(await wa.takeBackIn(DIRECT)).toBe(true)
    const update = server.lastCall('updateChat')!
    expect(update[0]).toBe(`chat-${DIRECT}`)
    expect(update[1]).toEqual({ leftOut: false, readThrough: expect.any(String) })
    const cursor = readRelayCursor((await store.chatMeta(serverCursorKey(ACCOUNT_ID)))!)
    expect(cursor).toMatchObject({ rowid: expect.any(Number), firstImport: null })
    await pass(3_000)
    const reread = batches().slice(before)
    expect(reread.length).toBeGreaterThan(0)
    // Never a first-import batch after a live one.
    expect(reread.every((batch) => !batch.firstImport)).toBe(true)
    expect(reread.flatMap((batch) => batch.messages.map((message) => message.waId))).toEqual(expect.arrayContaining(['A1', 'A2']))
    expect(await store.chatMeta(serverHistoryKey(ACCOUNT_ID))).not.toBeNull()
  })

  it('turns groups on again: the group chats come in live and their history is marked read as they arrive', async () => {
    const wa = await relayedHere({ includeGroups: false })
    await server.updateAccount(ACCOUNT_ID, { includeGroups: false })
    await server.deliver(store)
    shell.add('A1', DIRECT, 10)
    shell.add('G1', GROUP, 9)
    shell.emit(LINKED)
    await pass(3_000)
    await pass(70_000)
    expect(server.chats.has(GROUP)).toBe(false)

    expect(await wa.setIncludeGroups(true)).toBe(true)
    expect(server.lastCall('updateAccount')!).toEqual([ACCOUNT_ID, { includeGroups: true }])
    await pass(3_000)
    await mail.syncNow()
    await pass()
    const group = server.chats.get(GROUP)
    expect(group).toBeDefined()
    expect(server.callsOf('updateChat').some((args) => args[0] === group!.id && typeof (args[1] as { readThrough?: string }).readThrough === 'string')).toBe(true)
    expect(Date.parse(group!.readThrough!)).toBeGreaterThanOrEqual(Date.parse(group!.lastMessageAt))
    // The re-read is done and a pull after it found nothing more: the mark goes.
    await mail.syncNow()
    await pass(3_000)
    await mail.syncNow()
    await pass()
    expect(await store.chatMeta(serverHistoryKey(ACCOUNT_ID))).toBeNull()
  })

  it('disconnects in "All my devices": the account goes from the server first, then as in "Only this Mac"', async () => {
    const wa = await relayedHere()
    shell.emit(LINKED)
    await pass()
    server.fail('removeAccount', new TypeError('Failed to fetch'))
    expect(await wa.disconnect()).toBe(false)
    expect(wa.connected).toBe(true)

    expect(await wa.disconnect()).toBe(true)
    expect(server.account).toBeNull()
    expect(wa.connected).toBe(false)
    expect(shell.configs.has('u1')).toBe(false)
    expect(shell.calls).toContain('stop')
    expect(await store.chatMeta(SERVER_ACCOUNT)).toBeNull()
  })

  it('logs no message text, names or numbers', async () => {
    const wa = await relayedHere()
    shell.add('A1', DIRECT, 10)
    server.fail('relayMessages', new ChatApiError(500, 'Secret dinner plans'), true)
    shell.emit(LINKED)
    await pass(3_000)
    expect(wa.relayFailing).toBe('store')
    const logged = JSON.stringify(errors)
    expect(logged).not.toContain('Secret')
    expect(logged).not.toContain('31612345678')
    expect(logged).not.toContain('Kim')
  })

  describe('what the audit found', () => {
    /** "Only this Mac" with the relay run once over the store, and the bridge unlinked again. */
    async function localWith(extra: Partial<WhatsAppConfig>) {
      const wa = await signedIn(connectedConfig({ mode: 'local', ...extra }))
      shell.emit(LINKED)
      await pass(3_000)
      shell.emit({ ...RUNNING, link: 'unlinked' })
      await pass()
      return wa
    }

    function sentJids(): string[] {
      return batches().flatMap((batch) => batch.messages.map((message) => message.chatJid))
    }

    it('never uploads a chat left out in "Only this Mac" after the switch, and lists it as left out', async () => {
      shell.add('A1', DIRECT, 10)
      shell.add('B1', '31622222222@s.whatsapp.net', 9)
      const wa = await localWith({ leftOut: [DIRECT] })
      expect(await wa.switchMode('all', { copy: true })).toBe(true)
      shell.emit(LINKED)
      await pass(3_000)
      await mail.syncNow()
      await pass(70_000)
      shell.add('A2', DIRECT, 1)
      await pass(3_000)
      expect(sentJids()).toContain('31622222222@s.whatsapp.net')
      expect(sentJids()).not.toContain(DIRECT)
      // Handed to the server as a left-out chat; the config's entry went once that row was in the copy.
      expect(server.chats.get(DIRECT)).toMatchObject({ leftOut: true, name: null })
      expect(wa.config?.leftOut).toEqual([])
    })

    it('never uploads groups when this Mac left them out, and makes the server leave them out before the first batch', async () => {
      shell.add('A1', DIRECT, 10)
      shell.add('G1', GROUP, 9)
      const wa = await localWith({ includeGroups: false })
      expect(await wa.switchMode('all', { copy: true })).toBe(true)
      shell.emit(LINKED)
      await pass(3_000)
      expect(batches().length).toBeGreaterThan(0)
      expect(sentJids()).not.toContain(GROUP)
      expect(server.account?.includeGroups).toBe(false)
    })

    it('takes on the stricter setting when it relays an account that exists, before the first batch, and follows the server after', async () => {
      await server.connect({ deviceId: OTHER_DEVICE, deviceName: 'Office iMac', address: NUMBER, displayName: null, includeGroups: true, notify: true })
      await server.deliver(store)
      shell.add('A1', DIRECT, 10)
      shell.add('G1', GROUP, 9)
      // This Mac leaves groups out and does not notify; the account (relayed by another Mac) does both.
      const wa = await localWith({ includeGroups: false, notify: false })
      server.calls.length = 0
      expect(await wa.switchMode('all', { copy: true })).toBe(true)
      shell.emit(LINKED)
      await pass(3_000)
      expect(server.callsOf('updateAccount')[0]).toEqual([ACCOUNT_ID, { includeGroups: false, notify: false }])
      const order = server.calls.map((call) => call.name)
      expect(order.indexOf('updateAccount')).toBeLessThan(order.indexOf('relayMessages'))
      expect(sentJids()).toContain(DIRECT)
      expect(sentJids()).not.toContain(GROUP)

      // Changed on the server later: the config follows.
      server.account = { ...server.account!, notify: true }
      await mail.syncNow()
      await pass()
      expect(wa.config?.notify).toBe(true)
    })

    describe('a carried reply', () => {
      async function carriedAfterSwitch(): Promise<ReturnType<typeof useWhatsAppRelayStore>> {
        shell.add('A1', DIRECT, 10)
        const wa = await localWith({})
        await queueLocalReply(store, localChatId(DIRECT), 'On my way', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51', Date.now())
        expect(await wa.switchMode('all', { copy: true })).toBe(true)
        return wa
      }

      it('cancelled elsewhere (409) is counted and never sent under a new id', async () => {
        const wa = await carriedAfterSwitch()
        server.fail('queueReply', new ChatApiError(409, 'Cancelled', 'cancelled'), true)
        shell.emit(LINKED)
        await pass(3_000)
        await mail.syncNow()
        await pass()
        await mail.syncNow()
        await pass(SERVER_RETRY)
        expect(new Set(server.callsOf('queueReply').map((args) => (args[1] as { id: string }).id)).size).toBe(1)
        expect(wa.carried).toEqual([])
        expect(wa.carryCounts).toMatchObject({ cancelled: 1 })
        expect(JSON.parse((await store.chatMeta(CARRY_COUNTS))!)).toMatchObject({ cancelled: 1 })
      })

      it('too old for the server (422 on id) is counted as maybe queued and never sent under a new id', async () => {
        const wa = await carriedAfterSwitch()
        server.fail('queueReply', new ChatApiError(422, 'Invalid', null, null, { id: '' }), true)
        shell.emit(LINKED)
        await pass(3_000)
        await mail.syncNow()
        await pass(SERVER_RETRY)
        await mail.syncNow()
        await pass()
        expect(server.callsOf('queueReply')).toHaveLength(1)
        expect(wa.carried).toEqual([])
        expect(wa.carryCounts).toMatchObject({ unsure: 1 })
        await wa.dismissCarryCounts()
        expect(await store.chatMeta(CARRY_COUNTS)).toBeNull()
      })

      it('sent again under its kept id after a crash once the server stored it, so it is queued once', async () => {
        const wa = await carriedAfterSwitch()
        // The first try stores it on the server, and the Mac quits before it hears back.
        const original = server.queueReply.bind(server)
        server.queueReply = async (chatId, request) => {
          await original(chatId, request)
          throw new TypeError('Failed to fetch')
        }
        shell.emit(LINKED)
        await pass(3_000)
        await mail.syncNow()
        await pass()
        server.queueReply = original
        const kept = wa.carried[0]?.id
        expect(kept).toMatch(UUID_V7)
        await pass(SERVER_RETRY)
        const ids = server.callsOf('queueReply').map((args) => (args[1] as { id: string }).id)
        expect(new Set(ids)).toEqual(new Set([kept]))
        expect(server.outgoing.size).toBe(1)
        expect(wa.carried).toEqual([])
      })

      it('can be cancelled while it waits for its chat', async () => {
        const wa = await carriedAfterSwitch()
        expect(wa.carried).toHaveLength(1)
        expect(await wa.cancelCarried()).toBe(true)
        expect(wa.carried).toEqual([])
        expect(await store.chatMeta(CARRIED_REPLIES)).toBeNull()
      })
    })

    it('counts the replies that were not sent here and are not carried over', async () => {
      shell.add('A1', DIRECT, 10)
      const wa = await localWith({})
      const row = await queueLocalReply(store, localChatId(DIRECT), 'Failed one', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52', Date.now())
      await store.putChatOutgoing([{ ...row, status: 'failed', error: 'refused' }])
      expect(await wa.notCarried()).toBe(1)
      expect(await wa.switchMode('all', { copy: true })).toBe(true)
      expect(wa.carryCounts).toMatchObject({ notSent: 1 })
      expect(wa.carried).toEqual([])
    })

    describe('consent and the WhatsApp number', () => {
      it('refuses "All my devices" without the yes to copying, unless the server holds the chats already', async () => {
        const wa = await localWith({})
        expect(await wa.switchMode('all')).toBe(false)
        expect(wa.error).toBe('Confirm that your WhatsApp chats may be copied to your Tresso server first.')
        expect(server.callsOf('connect')).toEqual([])
        expect(wa.config?.mode).toBe('local')
      })

      it('refuses to relay an account of another number, before anything changes', async () => {
        await server.connect({ deviceId: OTHER_DEVICE, deviceName: 'Office iMac', address: '31600000000', displayName: null, includeGroups: true, notify: false })
        await server.deliver(store)
        const wa = await localWith({})
        server.calls.length = 0
        expect(await wa.switchMode('all', { copy: true })).toBe(false)
        expect(wa.error).toBe(OTHER_NUMBER)
        expect(server.callsOf('connect')).toEqual([])
        expect(wa.modeSwitch).toBeNull()
        expect(wa.config?.mode).toBe('local')
      })

      it('refuses Use this Mac instead for another number, and asks when a number is not known', async () => {
        await server.connect({ deviceId: OTHER_DEVICE, deviceName: 'Office iMac', address: '31600000000', displayName: null, includeGroups: true, notify: false })
        await server.deliver(store)
        const wa = await signedIn(connectedConfig())
        await mail.syncNow()
        shell.emit(LINKED)
        await pass()
        server.calls.length = 0
        expect(await wa.useThisMac()).toBe(false)
        expect(wa.error).toBe(OTHER_NUMBER)
        expect(server.callsOf('connect')).toEqual([])

        server.account = { ...server.account!, address: null }
        await mail.syncNow()
        await pass()
        expect(await wa.useThisMac()).toBe(false)
        expect(wa.error).toBe(UNKNOWN_NUMBER)
        expect(wa.askNumber).toBe('take-over')
        expect(await wa.useThisMac({ number: true })).toBe(true)
        expect(server.callsOf('connect')).toHaveLength(1)
      })

      it('says the server refusal of another number in plain words', async () => {
        await server.connect({ deviceId: OTHER_DEVICE, deviceName: 'Office iMac', address: NUMBER, displayName: null, includeGroups: true, notify: false })
        const wa = await localWith({})
        server.fail('connect', new ChatApiError(409, 'Another number', 'other_number'))
        expect(await wa.switchMode('all', { copy: true })).toBe(false)
        expect(wa.error).toBe(OTHER_NUMBER)
        expect(wa.modeSwitch).toBeNull()
      })

      it('does not start the relay when the bridge here is linked to another number than the account', async () => {
        const wa = await relayedHere()
        server.account = { ...server.account!, address: '31600000000' }
        await mail.syncNow()
        shell.emit(LINKED)
        await pass(3_000)
        expect(wa.relayRunning).toBe(false)
        expect(batches()).toEqual([])
        expect(wa.error).toBe(OTHER_NUMBER)
      })

      it('checks the number of another folder in "All my devices"', async () => {
        const wa = await relayedHere()
        server.account = { ...server.account!, address: '31600000000' }
        await mail.syncNow()
        await pass()
        expect(await wa.changeFolder()).toBe(false)
        expect(wa.error).toBe(OTHER_NUMBER)
        expect(shell.saved[shell.saved.length - 1]?.folder ?? FOLDER).toBe(FOLDER)
      })

      it('needs a linked bridge to take the relay over', async () => {
        await server.connect({ deviceId: OTHER_DEVICE, deviceName: 'Office iMac', address: NUMBER, displayName: null, includeGroups: true, notify: false })
        await server.deliver(store)
        server.calls.length = 0
        const wa = await signedIn(connectedConfig())
        await mail.syncNow()
        expect(await wa.useThisMac()).toBe(false)
        expect(wa.error).toBe('Link WhatsApp on this Mac to your phone first: only a linked bridge can relay.')
        expect(server.callsOf('connect')).toEqual([])
      })
    })

    it('does not trust a copy whose first pull failed', async () => {
      await server.connect({ deviceId: DEVICE, deviceName: 'Mac', address: NUMBER, displayName: null, includeGroups: true, notify: false })
      await server.deliver(store)
      await store.setChatMeta(SERVER_ACCOUNT, ACCOUNT_ID)
      // Marked synced, but no pull of this copy worked in this session.
      const wa = await signedIn(connectedConfig())
      shell.add('A1', DIRECT, 10)
      shell.emit(LINKED)
      await pass(10_000)
      expect(wa.relayRunning).toBe(false)
      expect(statuses()).toEqual([])
      await mail.syncNow()
      await pass()
      expect(wa.relayRunning).toBe(true)
    })

    it('leaves taking a chat back in and groups on to the relaying Mac', async () => {
      await server.connect({ deviceId: OTHER_DEVICE, deviceName: 'Office iMac', address: NUMBER, displayName: null, includeGroups: false, notify: false })
      await server.deliver(store)
      const wa = await signedIn(connectedConfig({ leftOut: [DIRECT] }))
      await mail.syncNow()
      await pass()
      expect(await wa.takeBackIn(DIRECT)).toBe(false)
      expect(wa.error).toBe(RELAY_ONLY)
      expect(await wa.setIncludeGroups(true)).toBe(false)
      expect(server.callsOf('updateAccount')).toEqual([])
    })

    it('resets the cursor before it takes a chat back in, so a failed request leaves it left out', async () => {
      const wa = await relayedHere()
      shell.add('A1', DIRECT, 10)
      shell.emit(LINKED)
      await pass(3_000)
      await mail.syncNow()
      await pass(70_000)
      expect(await wa.leaveOut(DIRECT)).toBe(true)
      server.fail('updateChat', new ChatApiError(500, 'Broken'))
      const before = batches().length
      expect(await wa.takeBackIn(DIRECT)).toBe(false)
      expect(readRelayCursor((await store.chatMeta(serverCursorKey(ACCOUNT_ID)))!)?.rowid).toBe(0)
      expect(wa.config?.leftOut).toEqual([DIRECT])
      await pass(3_000)
      expect(batches().slice(before).flatMap((batch) => batch.messages.map((message) => message.chatJid))).not.toContain(DIRECT)
    })

    it('offers to stay on "Only this Mac" while a switch taken up after a restart is refused', async () => {
      shell.add('A1', DIRECT, 10)
      const wa = await localWith({})
      await wa.dispose()
      setActivePinia(createPinia())
      auth.me = null
      await store.setChatMeta(MODE_SWITCH, JSON.stringify({ to: 'all', accountId: null, copy: true }))
      server.fail('connect', new ChatApiError(503, 'Unavailable'), true)
      const again = await signedIn()
      await pass()
      expect(again.switchFailing).toBe(true)
      expect(await again.stayLocal()).toBe(true)
      expect(again.modeSwitch).toBeNull()
      expect(again.config?.mode).toBe('local')
      await pass(SERVER_RETRY)
      expect(server.callsOf('connect').length).toBeGreaterThan(0)
      const calls = server.callsOf('connect').length
      await pass(SERVER_RETRY * 2)
      expect(server.callsOf('connect')).toHaveLength(calls)
    })

    it('finishes a removal a sign-out cut short at the next sign-in of the same user, and drops it for another user', async () => {
      const wa = await relayedHere()
      let answer!: () => void
      server.held.set('removeAccount', new Promise<void>((resolve) => (answer = resolve)))
      server.fail('removeAccount', new SessionEndedDuringRequestError())
      const switching = wa.switchMode('local')
      await pass()
      // Signed out while the DELETE runs: the copy (and its marks) go with the sign-out.
      for (const handler of auth.handlers) {
        handler('signedOut')
      }
      auth.me = null
      answer()
      await switching
      expect(server.account).not.toBeNull()
      expect(localStorage.getItem(`tresso.whatsapp.pendingRemoval.u1`)).toBe(ACCOUNT_ID)

      // Another user signs in on this Mac: their sign-in drops it, without touching u1's account.
      await wa.dispose()
      setActivePinia(createPinia())
      const other = useWhatsAppRelayStore()
      await other.init()
      await other.keepOnly('u2')
      expect(localStorage.getItem(`tresso.whatsapp.pendingRemoval.u1`)).toBeNull()
      expect(server.callsOf('removeAccount')).toHaveLength(1)

      // The same user again, with the entry back: the removal is finished.
      localStorage.setItem(`tresso.whatsapp.pendingRemoval.u1`, ACCOUNT_ID)
      await other.dispose()
      setActivePinia(createPinia())
      await signedIn()
      await pass()
      expect(server.account).toBeNull()
      expect(localStorage.getItem(`tresso.whatsapp.pendingRemoval.u1`)).toBeNull()
    })

    it('takes up a switch to "Only this Mac" that stopped after the config was saved', async () => {
      await store.setChatMeta(MODE_SWITCH, JSON.stringify({ to: 'local', accountId: ACCOUNT_ID, removed: true, cleared: false }))
      await store.setChatMeta(serverCursorKey(ACCOUNT_ID), JSON.stringify({ storeId: 'store-1', rowid: 4, firstImport: null }))
      const wa = await relayedHere({ mode: 'local' })
      server.removeElsewhere()
      await mail.syncNow()
      await pass()
      expect(server.callsOf('removeAccount')).toEqual([])
      expect(await store.chatMeta(serverCursorKey(ACCOUNT_ID))).toBeNull()
      expect(wa.modeSwitch).toBeNull()
      expect(wa.config?.mode).toBe('local')
    })
  })

  describe('what the re-audit found', () => {
    async function localWith(extra: Partial<WhatsAppConfig>) {
      const wa = await signedIn(connectedConfig({ mode: 'local', ...extra }))
      shell.emit(LINKED)
      await pass(3_000)
      shell.emit({ ...RUNNING, link: 'unlinked' })
      await pass()
      return wa
    }

    function sentJids(): string[] {
      return batches().flatMap((batch) => batch.messages.map((message) => message.chatJid))
    }

    async function restart(config: WhatsAppConfig | null) {
      await useWhatsAppRelayStore().dispose()
      setActivePinia(createPinia())
      auth.me = null
      if (config === null) {
        shell.configs.delete('u1')
      }
      const wa = await signedIn(config)
      await mail.syncNow()
      await pass()
      return wa
    }

    it('never carries out later a removal that failed: switch to Only this Mac, the DELETE fails, restart', async () => {
      const wa = await relayedHere()
      for (const failure of [new ChatApiError(500, 'Broken'), new ChatApiError(429, 'Slow', null, 60_000), new TypeError('Failed to fetch')]) {
        server.fail('removeAccount', failure)
        expect(await wa.switchMode('local')).toBe(false)
      }
      server.fail('removeAccount', new ChatApiError(503, 'Unavailable'))
      expect(await wa.disconnect()).toBe(false)
      expect(localStorage.getItem('tresso.whatsapp.pendingRemoval.u1')).toBeNull()
      const calls = server.callsOf('removeAccount').length

      const again = await restart(connectedConfig())
      expect(server.callsOf('removeAccount')).toHaveLength(calls)
      expect(server.account).not.toBeNull()
      expect(again.connected).toBe(true)
      expect(again.config?.mode).toBe('all')
    })

    it('keeps a chat left out before the switch out on a second Mac that takes over with a fresh config', async () => {
      shell.add('A1', DIRECT, 10)
      shell.add('B1', '31622222222@s.whatsapp.net', 9)
      const wa = await localWith({ leftOut: [DIRECT] })
      expect(await wa.switchMode('all', { copy: true })).toBe(true)
      shell.emit(LINKED)
      await pass(3_000)
      await mail.syncNow()
      await pass()
      expect(server.chats.get(DIRECT)).toMatchObject({ leftOut: true })

      // Another Mac (its own copy, a fresh config without the left-out list) takes the relay over.
      const second = await SqliteMailStore.open(await memorySql())
      mail.store = second
      await server.deliver(second)
      const otherConfig = connectedConfig({ deviceId: '7a1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f' })
      const other = await restart(otherConfig)
      shell.emit(LINKED)
      await pass()
      expect(await other.useThisMac()).toBe(true)
      shell.add('A2', DIRECT, 1)
      await pass(3_000)
      expect(sentJids()).not.toContain(DIRECT)
      expect(sentJids()).toContain('31622222222@s.whatsapp.net')
    })

    it('keeps it out on the same Mac after a sign-out and a new connect', async () => {
      shell.add('A1', DIRECT, 10)
      const wa = await localWith({ leftOut: [DIRECT] })
      expect(await wa.switchMode('all', { copy: true })).toBe(true)
      shell.emit(LINKED)
      await pass(3_000)
      await mail.syncNow()
      await pass()
      expect(server.chats.get(DIRECT)).toMatchObject({ leftOut: true })

      // Signed out (config and copy go), signed in again: the server's rows come back with the delta.
      for (const handler of auth.handlers) {
        handler('signedOut')
      }
      mail.store = await SqliteMailStore.open(await memorySql())
      const again = await restart(null)
      await again.chooseFolder()
      again.riskAccepted = true
      await again.start()
      shell.emit(LINKED)
      await pass()
      expect(await again.connect('all')).toBe(true)
      shell.add('A2', DIRECT, 1)
      await pass(3_000)
      const after = batches().slice(-3)
      expect(after.flatMap((batch) => batch.messages.map((message) => message.chatJid))).not.toContain(DIRECT)
    })

    it('keeps groups out across a takeover: the account says so for every Mac', async () => {
      shell.add('G1', GROUP, 9)
      shell.add('A1', DIRECT, 10)
      const wa = await localWith({ includeGroups: false })
      expect(await wa.switchMode('all', { copy: true })).toBe(true)
      shell.emit(LINKED)
      await pass(3_000)
      expect(server.account?.includeGroups).toBe(false)
      const second = await SqliteMailStore.open(await memorySql())
      mail.store = second
      await server.deliver(second)
      const other = await restart(connectedConfig({ deviceId: '7a1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f', includeGroups: true }))
      shell.emit(LINKED)
      await pass()
      expect(await other.useThisMac()).toBe(true)
      shell.add('G2', GROUP, 1)
      await pass(3_000)
      expect(sentJids()).not.toContain(GROUP)
      expect(other.config?.includeGroups).toBe(false)
    })

    it('asks for the yes to copying when the account the takeover relied on went meanwhile, and removes the one made', async () => {
      await server.connect({ deviceId: OTHER_DEVICE, deviceName: 'Office iMac', address: NUMBER, displayName: null, includeGroups: true, notify: false })
      await server.deliver(store)
      const wa = await signedIn(connectedConfig())
      await mail.syncNow()
      shell.emit(LINKED)
      await pass()
      // Removed on another device; this copy has not pulled that yet.
      server.delivering = false
      server.removeElsewhere()
      expect(await wa.useThisMac()).toBe(false)
      expect(wa.error).toBe(ACCOUNT_GONE)
      expect(server.callsOf('removeAccount')).toHaveLength(1)
      expect(server.account).toBeNull()
    })

    it('refuses Use this Mac instead without the yes to copying when no account is in the copy', async () => {
      const wa = await signedIn(connectedConfig())
      await mail.syncNow()
      shell.emit(LINKED)
      await pass()
      expect(await wa.useThisMac()).toBe(false)
      expect(wa.error).toBe(COPY_FIRST)
      expect(server.callsOf('connect')).toEqual([])
    })

    it('stops when the server says the bridge is linked to another number than the account', async () => {
      const wa = await relayedHere()
      shell.add('A1', DIRECT, 10)
      shell.emit(LINKED)
      await pass(3_000)
      expect(wa.relayRunning).toBe(true)
      expect(statuses()[statuses().length - 1]?.address).toBe(NUMBER)
      // The account learned another number (a relay that took over not knowing its own).
      server.account = { ...server.account!, address: '31600000000' }
      await pass(HEARTBEAT_MS)
      expect(wa.relayRunning).toBe(false)
      expect(wa.error).toBe(OTHER_NUMBER)
      const beats = statuses().length
      await pass(HEARTBEAT_MS * 2)
      // Pulls do not start it again either: no more 409s for this number.
      for (let i = 0; i < 3; i++) {
        await mail.syncNow()
        await pass()
      }
      expect(statuses()).toHaveLength(beats)
    })

    it('puts the groups setting back when a switch with "Keep group chats on instead" fails', async () => {
      await server.connect({ deviceId: OTHER_DEVICE, deviceName: 'Office iMac', address: NUMBER, displayName: null, includeGroups: true, notify: false })
      await server.deliver(store)
      const wa = await localWith({ includeGroups: false })
      server.fail('connect', new ChatApiError(503, 'Unavailable'))
      expect(await wa.switchMode('all', { copy: true, keepGroups: true })).toBe(false)
      expect(wa.config).toMatchObject({ mode: 'local', includeGroups: false })
    })

    it('hands the chats left out to the server during the switch, so a Mac that takes over before this one relayed knows them', async () => {
      shell.add('A1', DIRECT, 10)
      shell.add('B1', '31622222222@s.whatsapp.net', 9)
      const wa = await localWith({ leftOut: [DIRECT] })
      // The bridge stays unlinked: this Mac never relays after the switch.
      expect(await wa.switchMode('all', { copy: true })).toBe(true)
      expect(server.chats.get(DIRECT)).toMatchObject({ leftOut: true, name: null })
      expect(batches().every((batch) => batch.messages.length === 0)).toBe(true)

      const second = await SqliteMailStore.open(await memorySql())
      mail.store = second
      await server.deliver(second)
      const other = await restart(connectedConfig({ deviceId: '7a1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f' }))
      shell.emit(LINKED)
      await pass()
      expect(await other.useThisMac()).toBe(true)
      await pass(3_000)
      expect(sentJids()).toContain('31622222222@s.whatsapp.net')
      expect(sentJids()).not.toContain(DIRECT)
    })

    it('says when a switch would remove the group chats, and keeps them on when the user chose so', async () => {
      await server.connect({ deviceId: OTHER_DEVICE, deviceName: 'Office iMac', address: NUMBER, displayName: null, includeGroups: true, notify: false })
      await server.deliver(store)
      shell.add('G1', GROUP, 9)
      const wa = await localWith({ includeGroups: false })
      expect(wa.groupsWouldGo).toBe(true)
      expect(await wa.switchMode('all', { copy: true, keepGroups: true })).toBe(true)
      shell.emit(LINKED)
      await pass(3_000)
      expect(server.account?.includeGroups).toBe(true)
      expect(server.callsOf('updateAccount')).toEqual([])
      expect(sentJids()).toContain(GROUP)
    })

  })
})
