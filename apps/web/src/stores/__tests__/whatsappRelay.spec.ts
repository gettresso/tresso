import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive, shallowReactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { ChatRelayImportStuck, LOCAL_CHAT_ACCOUNT, LOCAL_CURSOR, LOCAL_HISTORY_THROUGH, SqliteMailStore, localChatId, queueLocalReply } from '@tresso/core'
import { memorySql } from '@tresso/core/testing/sql'
import type { WhatsAppConfig } from '@/platform/whatsapp'
import type { SessionEnd } from '@/stores/auth'
import { NOW, DAY, FOLDER, DIRECT, GROUP, MESSAGE_TEXT, RUNNING, LINKED, WAITING, GOOD_FOLDER, FakeShell } from './whatsappShellFixture'

const fake = vi.hoisted(() => ({ shell: null as unknown, desktop: true }))
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

/** The signed-in user and the session's end, as the auth store offers them. */
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

/** The mail copy, as the mail store offers it: open and caught up with the server (`synced`), or not. */
// Shallow, as the mail store's shallowRef: the copy is handed out as itself, never as a proxy.
const mail = shallowReactive({ synced: false, store: null as SqliteMailStore | null, currentStore: () => mail.store })
vi.mock('@/stores/mail', () => ({ useMailStore: () => mail }))

const { useWhatsAppRelayStore } = await import('../whatsappRelay')

function connectedConfig(extra: Partial<WhatsAppConfig> = {}): WhatsAppConfig {
  return {
    folder: FOLDER,
    mode: 'local',
    deviceId: '0193a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b',
    deviceName: "Kim's MacBook Pro",
    linkedAt: '2026-11-01T10:00:00.000Z',
    importSince: new Date(NOW - 30 * DAY).toISOString(),
    includeGroups: true,
    notify: false,
    leftOut: [],
    ...extra,
  }
}

/** Lets promises and the relay's timers run for `ms` of fake time. */
async function pass(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(0)
  }
}

describe('the WhatsApp relay store', () => {
  let shell: FakeShell
  let store: SqliteMailStore
  let errors: unknown[][]

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(NOW)
    shell = new FakeShell()
    fake.shell = shell
    fake.desktop = true
    auth.me = null
    auth.knownUserId = null
    auth.handlers = []
    store = await SqliteMailStore.open(await memorySql())
    mail.store = store
    mail.synced = false
    setActivePinia(createPinia())
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args))
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    await useWhatsAppRelayStore().dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** Signed in as u1, with `config` saved, the copy caught up, and the bridge as the shell says. */
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

  it('does nothing where WhatsApp is not on: not available, not the desktop app', async () => {
    shell.available = false
    const wa = useWhatsAppRelayStore()
    await wa.init()
    auth.me = { id: 'u1' }
    await pass()
    expect(wa.available).toBe(false)
    expect(shell.calls).toEqual(['available'])

    setActivePinia(createPinia())
    fake.desktop = false
    shell.calls.length = 0
    const browser = useWhatsAppRelayStore()
    await browser.init()
    await browser.ready()
    expect(browser.available).toBe(false)
    expect(shell.calls).toEqual([])
  })

  it('resumes a connection: starts the bridge, and the relay only once it is linked and the copy caught up', async () => {
    const wa = await signedIn(connectedConfig())
    expect(shell.calls).toContain('start')
    expect(wa.connected).toBe(true)
    shell.add('A1', DIRECT, 60)

    shell.emit(LINKED)
    await pass(10_000)
    expect(shell.calls).not.toContain('read')
    expect(wa.relayRunning).toBe(false)

    mail.synced = true
    await pass()
    expect(wa.relayRunning).toBe(true)
    expect(shell.calls).toContain('read')
    expect(wa.importState).toBe('reading')
    expect(wa.identity).toEqual({ number: '31698765432', name: 'Kim Visser' })
    expect((await store.chat(localChatId(DIRECT)))?.messages).toHaveLength(1)

    // The store stays quiet for a minute: the first import is done, counts only.
    await pass(70_000)
    expect(wa.importState).toBe('done')
    expect(wa.chatCount).toBe(1)
    expect(wa.progress).toMatchObject({ chats: 1, stored: 1, firstImport: false })
    expect(wa.lastMessageAt).toBe(new Date(NOW - 60 * 60_000).toISOString())
    // The account row the chat screens read carries the bridge's state.
    expect((await store.chatAccounts())[0]).toMatchObject({ id: LOCAL_CHAT_ACCOUNT, bridge: 'running', link: 'linked', notify: false, address: '31698765432' })
  })

  it('stops the relay when the bridge stops or unlinks, and starts one again only after the old one stopped', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.emit(LINKED)
    await pass()
    expect(wa.relayRunning).toBe(true)

    // A reply going out while the link ends: the old relay finishes its send before a new one starts.
    let finish!: () => void
    shell.sendAnswer = () => new Promise((resolve) => (finish = () => resolve({ ok: true, message: 'sent' })))
    shell.add('A1', DIRECT, 5)
    await pass(3_000)
    await queueLocalReply(store, localChatId(DIRECT), 'On my way', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51', Date.now())
    await pass(3_000)
    expect(shell.sent).toHaveLength(1)

    shell.emit({ ...RUNNING, link: 'unlinked' })
    await pass()
    expect(wa.relayRunning).toBe(false)
    expect((await store.chatAccounts())[0]).toMatchObject({ link: 'unlinked' })

    shell.emit(LINKED)
    await pass()
    const reads = shell.calls.filter((call) => call === 'read').length
    await pass(10_000)
    // The new relay waits for the stopped one, which waits for its send.
    expect(shell.calls.filter((call) => call === 'read').length).toBe(reads)
    finish()
    await pass(3_000)
    expect(wa.relayRunning).toBe(true)
    expect(shell.calls.filter((call) => call === 'read').length).toBeGreaterThan(reads)
    expect((await store.chat(localChatId(DIRECT)))?.outgoing[0]).toMatchObject({ status: 'sent' })
    expect(shell.sent).toHaveLength(1)
  })

  it('connects: folder, risk, bridge, scan, then saves the config once with the import date and starts the relay', async () => {
    const wa = await signedIn()
    mail.synced = true
    expect(wa.connected).toBe(false)

    await wa.chooseFolder()
    expect(wa.folder).toBe(FOLDER)
    expect(wa.inspection).toEqual(GOOD_FOLDER)

    // Nothing links before the risk was confirmed.
    expect(await wa.start()).toBe(false)
    expect(shell.calls).not.toContain('start')
    expect(wa.error).toBe('Confirm the risk and choose a folder with a built bridge first.')

    wa.riskAccepted = true
    expect(await wa.start()).toBe(true)
    expect(shell.calls).toContain('start')
    // Not linked yet: no config can be saved.
    expect(await wa.connect()).toBe(false)

    shell.emit(WAITING)
    shell.emit(LINKED)
    await pass()
    expect(wa.linkedHere).toBe(new Date(NOW).toISOString())
    expect(wa.relayRunning).toBe(false)

    expect(await wa.connect()).toBe(true)
    await pass()
    expect(shell.saved).toHaveLength(1)
    expect(shell.saved[0]).toMatchObject({
      folder: FOLDER,
      mode: 'local',
      deviceName: "Kim's MacBook Pro",
      linkedAt: new Date(NOW).toISOString(),
      importSince: new Date(NOW - 30 * DAY).toISOString(),
      includeGroups: true,
      notify: false,
      leftOut: [],
    })
    expect(shell.saved[0]!.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(wa.relayRunning).toBe(true)

    // The import date never moves: a later change keeps it.
    vi.setSystemTime(NOW + 5 * DAY)
    await wa.setNotify(true)
    expect(shell.saved[shell.saved.length - 1]).toMatchObject({ notify: true, importSince: new Date(NOW - 30 * DAY).toISOString() })
    expect((await store.chatAccounts())[0]).toMatchObject({ notify: true })
  })

  it('keeps the mode at "Only this Mac": a config of another mode starts no relay', async () => {
    const wa = await signedIn(connectedConfig({ mode: 'all' }))
    mail.synced = true
    shell.emit(LINKED)
    await pass(10_000)
    expect(wa.relayRunning).toBe(false)
    expect(shell.calls).not.toContain('read')
  })

  it('stops the bridge it started when the dialog closes without connecting', async () => {
    const wa = await signedIn()
    await wa.chooseFolder()
    wa.riskAccepted = true
    await wa.start()
    await wa.cancel()
    expect(shell.calls[shell.calls.length - 1]).toBe('stop')
    expect(wa.folder).toBeNull()
    expect(wa.riskAccepted).toBe(false)
  })

  it('says what failed in plain words, and logs only the step and the error name', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.add('A1', DIRECT, 5, { text: MESSAGE_TEXT })

    // The bridge writes to its store: the round is skipped, nothing failed.
    shell.readFails = 'busy'
    shell.emit(LINKED)
    await pass(3_000)
    expect(wa.relayFailing).toBeNull()

    shell.readFails = 'no_store'
    await pass(3_000)
    expect(wa.relayFailing).toBe('read')

    shell.readFails = new ChatRelayImportStuck('too_many_refused', 4)
    await pass(15_000)
    expect(wa.importState).toBe('stuck')
    expect(wa.stuckRefused).toBe(4)

    shell.readFails = null
    await pass(15_000)
    expect(wa.relayFailing).toBeNull()
    expect(wa.importState).toBe('reading')

    const logged = JSON.stringify(errors)
    expect(logged).toContain('The WhatsApp relay failed at read')
    expect(logged).not.toContain(MESSAGE_TEXT)
    expect(logged).not.toContain('Kim')
    expect(logged).not.toContain('31612345678')
  })

  it('maps a refused shell command to a plain sentence', async () => {
    const wa = await signedIn()
    shell.failures.chooseFolder = 'unsupported'
    expect(await wa.chooseFolder()).toBe(false)
    expect(wa.error).toBe('WhatsApp works in Tresso for Mac only.')

    shell.failures = { start: 'not_chosen' }
    wa.riskAccepted = true
    wa.folder = FOLDER
    wa.inspection = GOOD_FOLDER
    await wa.start()
    expect(wa.error).toBe('Choose the whatsapp-mcp folder again: Tresso only uses a folder you picked.')
    expect(JSON.stringify(errors)).not.toContain(FOLDER)
  })

  it('disconnects: stops the relay and the bridge, removes the copied chats and the config, and keeps nothing', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.add('A1', DIRECT, 5)
    shell.emit(LINKED)
    await pass(3_000)
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, DIRECT)).not.toBeNull()

    expect(await wa.disconnect()).toBe(true)
    await pass(10_000)

    expect(shell.calls).toEqual(expect.arrayContaining(['stop', 'clearConfig']))
    expect(shell.configs.has('u1')).toBe(false)
    expect(wa.connected).toBe(false)
    expect(wa.relayRunning).toBe(false)
    expect(await store.chatAccounts()).toEqual([])
    expect(await store.chatMeta(LOCAL_CURSOR)).toBeNull()
    // Nothing comes back: the bridge's rows are not read again.
    const reads = shell.calls.filter((call) => call === 'read').length
    await pass(30_000)
    expect(shell.calls.filter((call) => call === 'read').length).toBe(reads)
  })

  it('at sign-out stops the relay without waiting for it and removes the config', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.emit(LINKED)
    await pass()
    expect(wa.relayRunning).toBe(true)

    // A send that does not answer must not hold the sign-out.
    let release!: () => void
    shell.sendAnswer = () => new Promise((resolve) => (release = () => resolve({ ok: true, message: 'sent' })))
    shell.add('A1', DIRECT, 5)
    await pass(3_000)
    await queueLocalReply(store, localChatId(DIRECT), 'Hi', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52', Date.now())
    await pass(3_000)

    auth.me = null
    const results = auth.handlers.map((handler) => handler('signedOut'))
    expect(results.every((result) => result === undefined)).toBe(true)
    await pass()
    expect(wa.relayRunning).toBe(false)
    expect(shell.calls).toContain('clearConfig')
    expect(wa.connected).toBe(false)
    release()
    await pass()
  })

  it('keeps the config when the session only expired', async () => {
    await signedIn(connectedConfig())
    auth.me = null
    for (const handler of auth.handlers) {
      handler('expired')
    }
    await pass()
    expect(shell.calls).not.toContain('clearConfig')
    expect(shell.configs.has('u1')).toBe(true)
  })

  it('turning groups off removes the group chats copied; on again reads the store from the start', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.add('A1', DIRECT, 10)
    shell.add('G1', GROUP, 9)
    shell.emit(LINKED)
    await pass(3_000)
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, GROUP)).not.toBeNull()

    expect(await wa.setIncludeGroups(false)).toBe(true)
    await pass()
    expect(shell.saved[shell.saved.length - 1]).toMatchObject({ includeGroups: false })
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, GROUP)).toBeNull()
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, DIRECT)).not.toBeNull()
    expect(wa.chatCount).toBe(1)
    await pass(10_000)
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, GROUP)).toBeNull()

    expect(await wa.setIncludeGroups(true)).toBe(true)
    await pass(3_000)
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, GROUP)).not.toBeNull()
  })

  it('leaves a chat out for the chat screens: config first, then the copy', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.add('A1', DIRECT, 10)
    shell.emit(LINKED)
    await pass(3_000)

    expect(await wa.leaveOut(DIRECT)).toBe(true)
    expect(shell.saved[shell.saved.length - 1]).toMatchObject({ leftOut: [DIRECT] })
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, DIRECT)).toMatchObject({ leftOut: true })
    shell.add('A2', DIRECT, 1)
    await pass(3_000)
    expect((await store.chat(localChatId(DIRECT)))?.messages ?? []).toEqual([])
  })

  it('changes the folder: picks and checks first, then stops, saves and starts again, keeping the chats', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.add('A1', DIRECT, 10)
    shell.emit(LINKED)
    await pass(3_000)

    expect(await wa.changeFolder()).toBe(true)
    await pass()
    expect(shell.saved[shell.saved.length - 1]).toMatchObject({ folder: FOLDER, linkedAt: null })
    expect(shell.calls.slice(-3)).toEqual(['stop', 'saveConfig', 'start'])
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, DIRECT)).not.toBeNull()
  })

  it('connects only after the risk was confirmed on this page, and stops a bridge a reloaded page left', async () => {
    // A page that started the bridge and was reloaded while the code showed: no config, the bridge still runs.
    shell.state = { ...RUNNING, link: 'waiting_for_scan' }
    const wa = await signedIn()
    expect(shell.calls).toContain('stop')
    expect(wa.bridge.process).toBe('stopped')

    // Even linked, connecting needs the risk confirmed here.
    await wa.chooseFolder()
    shell.emit(LINKED)
    await pass()
    expect(await wa.connect()).toBe(false)
    expect(wa.error).toBe('Confirm the risk first.')
    expect(shell.saved).toEqual([])
    wa.riskAccepted = true
    expect(await wa.connect()).toBe(true)
  })

  it('closing the dialog while the bridge starts waits for the start, then stops the bridge', async () => {
    const wa = await signedIn()
    await wa.chooseFolder()
    wa.riskAccepted = true
    let release!: () => void
    shell.startHeld = new Promise((resolve) => (release = resolve))
    const starting = wa.start()
    await pass()
    expect(wa.busy).toBe('start')

    const closing = wa.cancel()
    await pass()
    expect(shell.calls).not.toContain('stop')
    release()
    await starting
    expect(await closing).toBe(true)
    expect(shell.calls[shell.calls.length - 1]).toBe('stop')
    expect(wa.bridge.process).toBe('stopped')
  })

  it('refuses groups off while the copy is not open, saving nothing; groups off again still removes them', async () => {
    const wa = await signedIn(connectedConfig())
    mail.store = null
    expect(await wa.setIncludeGroups(false)).toBe(false)
    expect(wa.error).toBe('Your mail on this Mac is still opening. Try again in a moment.')
    expect(shell.saved).toEqual([])

    // A config that already says no groups, with group chats still in the copy (an earlier removal did not finish).
    mail.store = store
    mail.synced = true
    shell.configs.set('u1', connectedConfig({ includeGroups: false }))
    shell.add('G1', GROUP, 9)
    await store.putChatAccount({ id: LOCAL_CHAT_ACCOUNT, channel: 'whatsapp', address: null, displayName: null, relayDeviceId: 'd', relayDeviceName: 'Mac', relayOnline: true, relayOfflineSince: null, bridge: 'running', link: 'linked', linkedAt: null, loopbackOnly: true, includeGroups: true, notify: false })
    await store.putChats([{ id: localChatId(GROUP), chatAccountId: LOCAL_CHAT_ACCOUNT, jid: GROUP, kind: 'group', name: 'Family', lastMessageAt: new Date(NOW).toISOString(), readThrough: null, archivedThrough: null, leftOut: false }])
    auth.me = null
    await pass()
    auth.me = { id: 'u1' }
    await pass()
    expect(wa.config?.includeGroups).toBe(false)
    expect(await wa.setIncludeGroups(false)).toBe(true)
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, GROUP)).toBeNull()
  })

  it('removes the config at a sign-out that came before the server said who is signed in', async () => {
    const wa = useWhatsAppRelayStore()
    auth.knownUserId = 'u1'
    shell.configs.set('u1', connectedConfig())
    await wa.init()
    await pass()
    expect(wa.userId).toBeNull()
    for (const handler of auth.handlers) {
      handler('signedOut')
    }
    await pass()
    expect(shell.configs.has('u1')).toBe(false)
  })

  it('switches users: the first one leaves nothing running, the second gets their own config', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.emit(LINKED)
    await pass()
    expect(wa.relayRunning).toBe(true)

    shell.configs.set('u2', connectedConfig({ folder: '/Users/sam/whatsapp-mcp', includeGroups: false }))
    auth.me = { id: 'u2' }
    await pass()
    expect(wa.userId).toBe('u2')
    expect(wa.config?.folder).toBe('/Users/sam/whatsapp-mcp')
    expect(wa.config?.includeGroups).toBe(false)

    // A user without WhatsApp: nothing of the other one shows.
    auth.me = { id: 'u3' }
    await pass()
    expect(wa.config).toBeNull()
    expect(wa.connected).toBe(false)
    expect(wa.relayRunning).toBe(false)
  })

  it('moves to a reopened copy only after the old relay finished its send', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.emit(LINKED)
    await pass()
    expect(wa.relayRunning).toBe(true)
    shell.add('A1', DIRECT, 5)
    await pass(3_000)
    let finish!: () => void
    shell.sendAnswer = () => new Promise((resolve) => (finish = () => resolve({ ok: true, message: 'sent' })))
    await queueLocalReply(store, localChatId(DIRECT), 'On my way', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a53', Date.now())
    await pass(3_000)
    expect(shell.sent).toHaveLength(1)

    const reopened = await SqliteMailStore.open(await memorySql())
    mail.store = reopened
    await pass(10_000)
    expect(await reopened.chatByJid(LOCAL_CHAT_ACCOUNT, DIRECT)).toBeNull()
    finish()
    await pass(3_000)
    expect((await store.chat(localChatId(DIRECT)))?.outgoing[0]).toMatchObject({ status: 'sent' })
    expect(await reopened.chatByJid(LOCAL_CHAT_ACCOUNT, DIRECT)).not.toBeNull()
    expect(shell.sent).toHaveLength(1)
  })

  it('says a damaged config in plain words and connects nothing', async () => {
    shell.failures.loadConfig = 'The WhatsApp settings are damaged: expected value at line 1 column 1'
    const wa = await signedIn()
    expect(wa.configLoaded).toBe(true)
    expect(wa.connected).toBe(false)
    expect(wa.error).toBe('The WhatsApp settings are damaged: expected value at line 1 column 1')
    expect(shell.calls).not.toContain('start')
  })

  it('starts a relay again on the same copy after it stopped by itself', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.emit(LINKED)
    await pass()
    expect(wa.relayRunning).toBe(true)

    // The chats were removed under it: it stops at its next write.
    const { removeLocalChats } = await import('@tresso/core')
    await removeLocalChats(store)
    shell.add('A1', DIRECT, 5)
    await pass(3_000)
    expect(wa.relayRunning).toBe(false)

    // The next change of the bridge starts a new one on the same copy.
    shell.emit({ ...LINKED, port: 8742 })
    await pass(3_000)
    expect(wa.relayRunning).toBe(true)
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, DIRECT)).not.toBeNull()
  })

  it('removes other users\' WhatsApp settings once the server confirmed who is signed in', async () => {
    shell.configs.set('u2', connectedConfig())
    const wa = await signedIn(connectedConfig())
    await wa.keepOnly('u1')
    expect([...shell.configs.keys()]).toEqual(['u1'])
  })

  it('waits for the switch before removing other users\' settings, so the cleanup is not skipped at launch', async () => {
    shell.configs.set('u2', connectedConfig())
    const wa = useWhatsAppRelayStore()
    // keepOnly runs before init had its answer.
    const kept = wa.keepOnly('u1')
    await pass()
    expect(shell.configs.has('u2')).toBe(true)
    await wa.init()
    await kept
    expect(shell.calls).toContain('keepOnlyConfig')
    expect(shell.configs.has('u2')).toBe(false)
  })

  it('turns groups on again when an earlier attempt saved the config but did not reset the cursor', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.add('A1', DIRECT, 10)
    shell.add('G1', GROUP, 9)
    shell.emit(LINKED)
    await pass(3_000)
    expect(await wa.setIncludeGroups(false)).toBe(true)
    await pass()
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, GROUP)).toBeNull()

    // Groups on, but the cursor reset fails after the config was saved.
    const failing = vi.spyOn(store, 'setChatMeta').mockImplementationOnce(() => Promise.reject(new Error('disk')))
    expect(await wa.setIncludeGroups(true)).toBe(false)
    failing.mockRestore()
    await pass(3_000)
    expect(wa.config?.includeGroups).toBe(true)
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, GROUP)).toBeNull()

    // Trying again resets the cursor: the older group messages come back.
    expect(await wa.setIncludeGroups(true)).toBe(true)
    await pass(3_000)
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, GROUP)).not.toBeNull()

    // With group chats in the copy, groups on again changes nothing.
    const saves = shell.calls.filter((call) => call === 'saveConfig').length
    expect(await wa.setIncludeGroups(true)).toBe(true)
    expect(shell.calls.filter((call) => call === 'saveConfig').length).toBe(saves)
  })

  it('takes a chat back in: config first, then the relay reads the store again and the chat comes back read', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.add('A1', DIRECT, 10)
    shell.emit(LINKED)
    await pass(3_000)
    expect(await wa.leaveOut(DIRECT)).toBe(true)
    await pass(3_000)
    expect(await store.chat(localChatId(DIRECT))).toMatchObject({ chat: { leftOut: true }, messages: [] })
    const before = wa.revision

    const takenAt = Date.now()
    expect(await wa.takeBackIn(DIRECT)).toBe(true)
    expect(shell.saved[shell.saved.length - 1]!.leftOut).toEqual([])
    // Rows sent since the last read the relay stored are live (unread, notified): the reset counts from that read, not
    // from the click, so a message that came in between is not taken for history.
    expect(shell.readTimes).toContain(wa.liveFrom)
    expect(wa.liveFrom!).toBeLessThanOrEqual(takenAt)
    expect(await store.chatMeta(LOCAL_HISTORY_THROUGH)).toBe(String(wa.liveFrom))
    await pass(3_000)
    const back = (await store.chats()).find(({ chat }) => chat.jid === DIRECT)
    expect(back).toMatchObject({ unread: 0, chat: { leftOut: false } })
    expect((await store.chat(localChatId(DIRECT)))?.messages).toHaveLength(1)
    expect(wa.revision).toBeGreaterThan(before)
    // A chat that is not left out is not touched.
    expect(await wa.takeBackIn(GROUP)).toBe(true)
  })

  it('learns sender names from the relay and from the chat screens, once per session each', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.add('G1', GROUP, 9)
    shell.emit(LINKED)
    await pass(3_000)
    // The fake gives numbers only: the relay learnt the sender as +number.
    expect(wa.senderNames.get('31699999999')).toBe('+31699999999')

    await wa.lookUpNames(['31611111111', '31611111111'])
    expect(wa.senderNames.get('31611111111')).toBe('+31611111111')
    const asked = shell.calls.filter((call) => call === 'names').length
    await wa.lookUpNames(['31611111111'])
    expect(shell.calls.filter((call) => call === 'names').length).toBe(asked)
    expect(errors).toEqual([])
  })

  it('raises the revision when a reply was reported, so the lists move with it', async () => {
    const wa = await signedIn(connectedConfig())
    mail.synced = true
    shell.add('A1', DIRECT, 10)
    shell.emit(LINKED)
    await pass(3_000)
    await queueLocalReply(store, localChatId(DIRECT), 'On my way', '0193a000-0000-7000-8000-0000000000a1', Date.now())
    const before = wa.revision
    await wa.pollNow()
    await pass()
    expect(shell.sent).toEqual([{ recipient: DIRECT, text: 'On my way' }])
    expect(wa.revision).toBeGreaterThan(before)
  })

  it('turning groups on again reads the store with only rows from before as history', async () => {
    const wa = await signedIn(connectedConfig({ includeGroups: false }))
    mail.synced = true
    shell.emit(LINKED)
    await pass(3_000)
    const at = Date.now()
    expect(await wa.setIncludeGroups(true)).toBe(true)
    expect(wa.liveFrom).not.toBeNull()
    expect(wa.liveFrom!).toBeLessThanOrEqual(at)
    expect(await store.chatMeta(LOCAL_HISTORY_THROUGH)).toBe(String(wa.liveFrom))
  })
})
