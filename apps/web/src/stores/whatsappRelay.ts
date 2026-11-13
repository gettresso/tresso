import { computed, effectScope, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  ChatRelay,
  ChatRelayImportStuck,
  LOCAL_CHAT_ACCOUNT,
  LOCAL_CURSOR,
  LocalChatBackend,
  LocalChatError,
  localChatId,
  phoneLabel,
  readRelayCursor,
  removeLocalChats,
  removeLocalGroupChats,
  resetLocalCursor,
  setLocalChatAccount,
  setLocalChatState,
  type ChatBridge,
  type MailStore,
  type RelayProgress,
  type RelayStep,
  type SenderLookup,
} from '@tresso/core'
import { isDesktop } from '@/platform/desktop'
import { whatsAppShell, type BridgeInspection, type BridgeState, type WhatsAppConfig, type WhatsAppIdentity } from '@/platform/whatsapp'
import { errorName, folderText, IMPORT_DAYS, shellErrorText, type ImportState } from '@/components/chat/whatsappTexts'
import { useAuthStore, type SessionEnd } from '@/stores/auth'
import { useMailStore } from '@/stores/mail'

const DAY = 24 * 60 * 60 * 1000
/** How often the chat count and the last message time are read from the copy while messages come in. */
const CHATS_REFRESH_MS = 5_000
/** The device name when the shell cannot tell it (the config needs one). */
const FALLBACK_DEVICE = 'This Mac'
/** At most this many sender ids in one `names` call (the shell's limit). */
const NAMES_PER_CALL = 500

export const STOPPED_BRIDGE: BridgeState = { process: 'stopped', port: null, loopbackOnly: null, link: 'unknown', qr: null, error: null }

/** What runs now, so a second click waits for it instead of starting the same thing twice. */
export type WhatsAppTask = 'folder' | 'start' | 'connect' | 'disconnect' | 'groups' | 'notify' | 'cancel' | 'leave' | 'take-back'

/** A step refused for a reason the user can act on; its message is shown as it is. */
class WhatsAppProblem extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WhatsAppProblem'
  }
}

function schedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

/**
 * WhatsApp on this Mac ("Only this Mac", the WhatsApp plan's WP5): the desktop shell's bridge (platform/whatsapp.ts) and
 * the relay that brings its messages into the mail copy (ChatRelay with LocalChatBackend, packages/core/src/chat).
 * macOS desktop only, and only once WhatsApp was turned on for this Mac (`available`); elsewhere it does nothing.
 *
 * The wiring keeps the rules of docs/ARCHITECTURE.md ("what the desktop wiring must respect"):
 * - One relay per copy: a new one starts only after the previous one's `stop()` resolved, and so does every removal.
 *   Sign-out does not wait for it: the closing copy refuses writes and the relay stops itself.
 * - The relay runs only while the bridge is linked and the copy has caught up with the server (`mail.synced`).
 * - The config is saved first, then the backend is made (or configured) from it, then the copy is changed.
 * - The import date is set once at connect, kept in the config and never changed by anything else.
 * - Errors are logged with the step and the error's name only, never with what a message or a store holds.
 */
export const useWhatsAppRelayStore = defineStore('whatsappRelay', () => {
  const auth = useAuthStore()
  const mail = useMailStore()
  const commands = whatsAppShell()

  /** WhatsApp can be used here: the desktop app on macOS, turned on. */
  const available = ref(false)
  /** `available` is known. */
  const checked = ref(!isDesktop)
  const deviceName = ref<string | null>(null)
  /** The signed-in user the config belongs to. */
  const userId = ref<string | null>(null)
  /** Null until loaded, and when WhatsApp is not connected for this user. */
  const config = ref<WhatsAppConfig | null>(null)
  const configLoaded = ref(false)
  const bridge = ref<BridgeState>(STOPPED_BRIDGE)
  /** A start was asked for in this session, so a stopped bridge is reported as stopped rather than not started. */
  const bridgeStarted = ref(false)
  /** The folder of the connect flow, or the connected one. */
  const folder = ref<string | null>(null)
  const inspection = ref<BridgeInspection | null>(null)
  const identity = ref<WhatsAppIdentity | null>(null)
  /** The user confirmed the risk in the connect dialog; nothing links before. */
  const riskAccepted = ref(false)
  /** When Tresso saw the phone link (the code was scanned in this session). */
  const linkedHere = ref<string | null>(null)
  const importState = ref<ImportState>('waiting')
  const progress = ref<RelayProgress | null>(null)
  /** Messages a stuck import could not store (ChatRelayImportStuck). */
  const stuckRefused = ref(0)
  /** WhatsApp chats in the copy. */
  const chatCount = ref(0)
  /** The newest chat's last message time in the copy; null without chats. */
  const lastMessageAt = ref<string | null>(null)
  const relayRunning = ref(false)
  /** The step the relay's last round failed at; null once a round brought something in. */
  const relayFailing = ref<RelayStep | null>(null)
  const busy = ref<WhatsAppTask | null>(null)
  /** The last action's failure, in plain words. */
  const error = ref<string | null>(null)
  /**
   * Raised whenever the chats in the copy changed through this store: the relay stored messages or sent replies, or
   * the user left a chat out, took one back in or changed which chats come in. The chat screens read again on it.
   */
  const revision = ref(0)
  /**
   * What group senders are called, by sender id, as far as this session learned it (the relay's lookups and the chat
   * screens' own, lookUpNames): a message stored before its sender's name was known shows the name once it is. Kept
   * in memory only, never logged.
   */
  const senderNames = shallowRef<ReadonlyMap<string, string>>(new Map())

  const connected = computed(() => config.value !== null)
  const folderReady = computed(() => folderText(inspection.value).ok)
  const linked = computed(() => bridge.value.process === 'owned' && bridge.value.link === 'linked')

  let resolveChecked!: () => void
  const whenChecked = new Promise<void>((resolve) => (resolveChecked = resolve))
  if (!isDesktop) {
    resolveChecked()
  }
  let initialized = false
  let stopListening: (() => void) | null = null
  let stopSessionEnd: (() => void) | null = null
  /** The watchers init starts; dispose stops them. */
  const scope = effectScope(true)
  /** The user before the last change, for the sign-out (the session may be gone by the time it is told). */
  let previousUser: string | null = null
  /** The user the tokens name (auth.knownUserId), for a sign-out before the server said who is signed in. */
  let knownUser: string | null = null
  let userRun = 0

  let relay: ChatRelay | null = null
  let backend: LocalChatBackend | null = null
  /** The copy the relay runs on, or is being started on. */
  let relayStore: MailStore | null = null
  /** Raised by every start and stop, so a start overtaken meanwhile gives up. */
  let relayRun = 0
  /** Resolves once every relay stopped so far has finished its round. */
  let stopping: Promise<void> = Promise.resolve()
  /** While a change of the chats runs (groups, connect), no relay may start in between. */
  let held = 0
  let chatsReadAt = 0
  /** The task `run` is doing now, so closing the dialog can wait for it. */
  let runningTask: Promise<void> | null = null
  /** The config changes, in order (updateConfig). */
  let saves: Promise<void> = Promise.resolve()
  /** Sender ids the chat screens asked the store about in this session (lookUpNames), found or not. */
  const askedNames = new Set<string>()

  // ---- Starting ---------------------------------------------------------------------------------------------------

  /** Once, in the desktop app: whether WhatsApp is on here, then the bridge's state and the signed-in user's config. */
  async function init(): Promise<void> {
    if (initialized) {
      return
    }
    initialized = true
    if (!isDesktop) {
      return
    }
    try {
      available.value = await commands.available()
    } catch (cause) {
      console.error('Asking whether WhatsApp is available failed', errorName(cause))
      available.value = false
    }
    checked.value = true
    resolveChecked()
    if (!available.value) {
      return
    }
    try {
      stopListening = await commands.onState(onBridge)
      onBridge(await commands.state())
    } catch (cause) {
      console.error('Reading the WhatsApp bridge state failed', errorName(cause))
    }
    try {
      deviceName.value = (await commands.device()).name
    } catch (cause) {
      console.error('Reading the name of this Mac failed', errorName(cause))
    }
    scope.run(() => {
      watch(
        () => auth.knownUserId,
        (id) => {
          if (id !== null) {
            knownUser = id
          }
        },
        { immediate: true },
      )
      watch(
        () => auth.me?.id ?? null,
        (id) => void userChanged(id),
        { immediate: true },
      )
      watch([config, bridge, () => mail.synced, () => mail.currentStore()], () => ensureRelay())
    })
    stopSessionEnd = auth.onSessionEnd(sessionEnded)
  }

  /** Resolves once `available` is known (at once in the browser). */
  function ready(): Promise<void> {
    return whenChecked
  }

  async function userChanged(id: string | null): Promise<void> {
    if (id === userId.value) {
      return
    }
    const mine = ++userRun
    if (userId.value !== null) {
      previousUser = userId.value
      leaveUser()
    }
    userId.value = id
    if (id === null) {
      return
    }
    try {
      const loaded = await commands.loadConfig(id)
      if (mine !== userRun) {
        return
      }
      config.value = loaded
    } catch (cause) {
      if (mine === userRun) {
        error.value = shellErrorText(cause)
      }
      console.error('Reading the WhatsApp settings failed', errorName(cause))
    } finally {
      if (mine === userRun) {
        configLoaded.value = true
      }
    }
    if (mine !== userRun) {
      return
    }
    if (config.value !== null) {
      folder.value = config.value.folder
      await startBridge(config.value.folder)
    } else if (bridge.value.process === 'owned') {
      // A connect flow the page left (a reload while the code showed): the bridge it started stops, and connecting
      // starts again from the risk.
      try {
        onBridge(await commands.stop())
      } catch (cause) {
        console.error('Stopping a WhatsApp bridge nobody connected failed', errorName(cause))
      }
    }
  }

  /** Forgets the user who left; their relay stops in the background (the shell stops the bridge). */
  function leaveUser(): void {
    void stopRelay()
    config.value = null
    configLoaded.value = false
    resetFlow()
    resetImport()
  }

  /** The session ended: the relay stops without being waited for, and a sign-out removes the user's config. */
  function sessionEnded(reason: SessionEnd): void {
    const id = userId.value ?? previousUser ?? knownUser
    void stopRelay()
    if (reason === 'signedOut' && id !== null) {
      commands.clearConfig(id).catch((cause: unknown) => console.error('Removing the WhatsApp settings at sign-out failed', errorName(cause)))
    }
  }

  function resetFlow(): void {
    folder.value = null
    inspection.value = null
    identity.value = null
    riskAccepted.value = false
    linkedHere.value = null
    bridgeStarted.value = false
    error.value = null
  }

  function resetImport(): void {
    senderNames.value = new Map()
    askedNames.clear()
    importState.value = 'waiting'
    progress.value = null
    stuckRefused.value = 0
    chatCount.value = 0
    lastMessageAt.value = null
    relayFailing.value = null
  }

  // ---- The bridge -------------------------------------------------------------------------------------------------

  function onBridge(state: BridgeState): void {
    const before = bridge.value
    bridge.value = state
    if (state.link === 'linked' && before.link !== 'linked') {
      if (before.link === 'waiting_for_scan') {
        void linkedNow()
      }
      void loadIdentity()
    } else if (state.link === 'unlinked' || state.link === 'waiting_for_scan') {
      identity.value = null
    }
    void syncAccount()
  }

  /** The code was scanned: remembered for Settings ("Linked 3 days ago"), and saved once WhatsApp is connected. */
  async function linkedNow(): Promise<void> {
    const at = new Date().toISOString()
    linkedHere.value = at
    const id = userId.value
    if (id !== null && config.value !== null) {
      await updateConfig(id, (current) => ({ ...current, linkedAt: at })).catch((cause: unknown) => console.error('Saving the WhatsApp link time failed', errorName(cause)))
    }
  }

  async function loadIdentity(): Promise<void> {
    const from = config.value?.folder ?? folder.value
    if (from === null) {
      return
    }
    try {
      identity.value = await commands.identity(from)
    } catch (cause) {
      console.error('Reading the linked WhatsApp account failed', errorName(cause))
    }
  }

  async function startBridge(from: string): Promise<void> {
    bridgeStarted.value = true
    try {
      onBridge(await commands.start(from))
    } catch (cause) {
      error.value = shellErrorText(cause)
      console.error('Starting the WhatsApp bridge failed', errorName(cause))
    }
  }

  /** The account row the chat screens read keeps the bridge's state and Notify me (setLocalChatAccount). */
  async function syncAccount(): Promise<void> {
    const store = mail.synced ? mail.currentStore() : null
    const current = config.value
    if (store === null || current === null) {
      return
    }
    const state = bridge.value
    try {
      await setLocalChatAccount(store, {
        bridge: state.process === 'owned' ? 'running' : 'stopped',
        link: state.link === 'linked' ? 'linked' : state.link === 'unknown' ? 'unknown' : 'unlinked',
        linkedAt: current.linkedAt,
        loopbackOnly: state.loopbackOnly,
        notify: current.notify,
      })
    } catch (cause) {
      console.error('Updating the WhatsApp account on this Mac failed', errorName(cause))
    }
  }

  /** Saves a new config (at connect), and takes it only once the shell kept it. */
  async function saveConfig(id: string, next: WhatsAppConfig): Promise<void> {
    await commands.saveConfig(id, next)
    if (userId.value === id) {
      config.value = next
    }
  }

  /**
   * Changes the saved config, one change after the other and each on the newest one, so two changes made close
   * together (a link seen while a setting is saved) never undo each other. Nothing is changed for another user.
   */
  function updateConfig(id: string, change: (current: WhatsAppConfig) => WhatsAppConfig): Promise<void> {
    const saved = saves.then(async () => {
      const current = config.value
      if (current === null || userId.value !== id) {
        return
      }
      const next = change(current)
      await commands.saveConfig(id, next)
      if (userId.value === id && config.value === current) {
        config.value = next
      }
    })
    saves = saved.catch(() => undefined)
    return saved
  }

  // ---- The relay --------------------------------------------------------------------------------------------------

  /** The copy the relay should run on now, or null when it should not run. */
  function wanted(): MailStore | null {
    const current = config.value
    const store = mail.synced ? mail.currentStore() : null
    return current !== null && current.mode === 'local' && store !== null && linked.value && held === 0 ? store : null
  }

  function ensureRelay(): void {
    const store = wanted()
    if (store !== null && store === relayStore) {
      return
    }
    if (relayStore !== null) {
      void stopRelay()
    }
    if (store !== null) {
      void startRelay(store)
    }
  }

  /** Stops the relay; resolves once it finished the round under way (and every relay stopped before). */
  function stopRelay(): Promise<void> {
    relayRun++
    const stopped = relay
    relay = null
    backend = null
    relayStore = null
    relayRunning.value = false
    if (stopped !== null) {
      stopping = stopping.then(() => stopped.stop()).catch(() => undefined)
    }
    return stopping
  }

  async function startRelay(store: MailStore): Promise<void> {
    const mine = ++relayRun
    relayStore = store
    await stopping
    const current = config.value
    if (mine !== relayRun || current === null) {
      return
    }
    let who: WhatsAppIdentity | null = null
    try {
      who = await commands.identity(current.folder)
    } catch (cause) {
      console.error('Reading the linked WhatsApp account failed', errorName(cause))
    }
    if (mine !== relayRun) {
      return
    }
    identity.value = who ?? identity.value
    const made = new LocalChatBackend(
      store,
      { includeGroups: current.includeGroups, leftOut: current.leftOut, importSince: Date.parse(current.importSince) },
      { number: who?.number ?? null, name: who?.name ?? null, deviceId: current.deviceId, deviceName: current.deviceName },
      Date.now,
    )
    try {
      // The relay prepares too; doing it here first makes the account row, so the bridge's state lands on it.
      await made.prepare()
    } catch (cause) {
      logRelayError(cause, 'prepare')
    }
    if (mine !== relayRun) {
      return
    }
    await syncAccount()
    await readImportState(store)
    if (mine !== relayRun) {
      return
    }
    backend = made
    relay = new ChatRelay({
      bridge: chatBridge(current.folder),
      backend: made,
      now: Date.now,
      schedule,
      onProgress: (next) => progressed(mine, store, next),
      onError: (cause, step) => failed(mine, cause, step),
      onStopped: (reason) => stoppedItself(mine, reason),
    })
    relayRunning.value = true
    relay.start()
  }

  /** Keeps the names a lookup found (a name, else the number), so stored messages without one show it. */
  function learnNames(found: Record<string, SenderLookup>): void {
    const next = new Map(senderNames.value)
    for (const [id, lookup] of Object.entries(found)) {
      const name = lookup?.name?.trim() ? lookup.name : lookup?.number ? phoneLabel(lookup.number) : null
      if (name !== null && next.get(id) !== name) {
        next.set(id, name)
      }
    }
    if (next.size !== senderNames.value.size || [...next].some(([id, name]) => senderNames.value.get(id) !== name)) {
      senderNames.value = next
    }
  }

  /**
   * For the chat screens: looks up group senders whose messages carry no name (stored before the name was known), once
   * per session each; what is found lands in `senderNames`.
   */
  async function lookUpNames(ids: readonly string[]): Promise<void> {
    const from = config.value?.folder ?? null
    const due = [...new Set(ids)].filter((id) => !askedNames.has(id) && !senderNames.value.has(id))
    if (from === null || due.length === 0) {
      return
    }
    for (const id of due) {
      askedNames.add(id)
    }
    try {
      for (let start = 0; start < due.length; start += NAMES_PER_CALL) {
        learnNames(await commands.names(from, due.slice(start, start + NAMES_PER_CALL)))
      }
    } catch (cause) {
      // Asked again in a later session; the relay's own lookups may find it meanwhile.
      console.error('Looking up WhatsApp sender names failed', errorName(cause))
    }
  }

  /** The shell's bridge commands as the relay needs them (docs/ARCHITECTURE.md, the relay's wiring rules). */
  function chatBridge(from: string): ChatBridge {
    return {
      async read(afterRowid, limit) {
        try {
          return await commands.read(from, afterRowid, limit)
        } catch (cause) {
          // The bridge writes to its store just now: this round is skipped, the next one reads.
          if (cause === 'busy') {
            return null
          }
          throw cause
        }
      },
      async names(ids) {
        const found = await commands.names(from, ids)
        learnNames(found)
        return found
      },
      // Rejects only when the shell refused the request before the bridge saw it; no timeout here may reject.
      async send(recipient, text) {
        const result = await commands.send(recipient, text)
        return result.ok ? { ok: true } : { ok: false, error: result.message }
      },
    }
  }

  async function readImportState(store: MailStore): Promise<void> {
    try {
      const value = await store.chatMeta(LOCAL_CURSOR)
      const cursor = value === null ? null : readRelayCursor(value)
      importState.value = value === null ? 'waiting' : cursor !== null && cursor.firstImport !== null ? 'reading' : 'done'
      await readChats(store, true)
    } catch (cause) {
      logRelayError(cause, 'read')
    }
  }

  /** The chat count and the last message time, from the copy; at most every few seconds unless `now`. */
  async function readChats(store: MailStore, now = false): Promise<void> {
    if (!now && Date.now() - chatsReadAt < CHATS_REFRESH_MS) {
      return
    }
    chatsReadAt = Date.now()
    const local = (await store.chats()).filter(({ chat }) => chat.chatAccountId === LOCAL_CHAT_ACCOUNT)
    chatCount.value = local.length
    lastMessageAt.value = local[0]?.chat.lastMessageAt ?? null
  }

  function progressed(mine: number, store: MailStore, next: RelayProgress): void {
    if (mine !== relayRun) {
      return
    }
    const ended = importState.value !== 'done' && !next.firstImport
    if (progress.value === null || next.stored !== progress.value.stored || next.chats !== progress.value.chats) {
      revision.value++
    }
    progress.value = next
    relayFailing.value = null
    importState.value = next.firstImport ? 'reading' : 'done'
    readChats(store, ended).catch((cause: unknown) => logRelayError(cause, 'read'))
  }

  function failed(mine: number, cause: unknown, step: RelayStep): void {
    logRelayError(cause, step)
    if (mine !== relayRun) {
      return
    }
    relayFailing.value = step
    if (cause instanceof ChatRelayImportStuck) {
      importState.value = 'stuck'
      stuckRefused.value = cause.refused
    }
  }

  /** The relay stopped by itself (the copy closes, the chats were removed): it starts again only on a change. */
  function stoppedItself(mine: number, reason: unknown): void {
    if (mine !== relayRun) {
      return
    }
    console.info('The WhatsApp relay stopped', errorName(reason))
    relay = null
    backend = null
    // A later change (the bridge, the copy, the config) may start one again, also on the same copy.
    relayStore = null
    relayRunning.value = false
  }

  function logRelayError(cause: unknown, step: RelayStep): void {
    console.error(`The WhatsApp relay failed at ${step}`, errorName(cause))
  }

  // ---- What the user does ---------------------------------------------------------------------------------------

  async function run(task: WhatsAppTask, work: () => Promise<void>): Promise<boolean> {
    if (busy.value !== null) {
      return false
    }
    busy.value = task
    error.value = null
    try {
      const running = work()
      runningTask = running.catch(() => undefined)
      await running
      return true
    } catch (cause) {
      error.value = cause instanceof WhatsAppProblem ? cause.message : shellErrorText(cause)
      console.error(`WhatsApp: ${task} failed`, errorName(cause))
      return false
    } finally {
      busy.value = null
    }
  }

  /** Holds the relay while `work` changes the chats, then lets it start again. */
  async function holding<T>(work: () => Promise<T>): Promise<T> {
    held++
    try {
      return await work()
    } finally {
      held--
      ensureRelay()
    }
  }

  /** The connect dialog's folder (the native folder dialog), checked at once. A bridge started for another one stops. */
  function chooseFolder(): Promise<boolean> {
    return run('folder', async () => {
      const picked = await commands.chooseFolder()
      if (picked === null) {
        return
      }
      if (config.value === null && bridge.value.process === 'owned') {
        onBridge(await commands.stop())
      }
      folder.value = picked
      inspection.value = null
      inspection.value = await commands.inspect(picked)
    })
  }

  /** The connect dialog's "Start the bridge" (also "Start again" and "Show a new code"); only after the risk was confirmed. */
  function start(): Promise<boolean> {
    return run('start', async () => {
      const from = config.value?.folder ?? folder.value
      if (from === null) {
        throw new WhatsAppProblem('Choose the whatsapp-mcp folder first.')
      }
      if (config.value === null && (!riskAccepted.value || !folderReady.value)) {
        throw new WhatsAppProblem('Confirm the risk and choose a folder with a built bridge first.')
      }
      await startBridge(from)
    })
  }

  /**
   * "Only this Mac": saves the config with a new device id and the import date (now less 30 days, kept from here on),
   * then the relay starts and brings the recent chats in. Chats left from an earlier connection go first.
   */
  function connect(): Promise<boolean> {
    return run('connect', async () => {
      const id = userId.value
      const from = folder.value
      if (!riskAccepted.value) {
        throw new WhatsAppProblem('Confirm the risk first.')
      }
      if (id === null || from === null || !linked.value || config.value !== null) {
        throw new WhatsAppProblem('Link WhatsApp to your phone first.')
      }
      await holding(async () => {
        await stopping
        const store = mail.currentStore()
        if (store !== null) {
          await removeLocalChats(store)
        }
        const now = Date.now()
        const next: WhatsAppConfig = {
          folder: from,
          mode: 'local',
          deviceId: crypto.randomUUID(),
          deviceName: deviceName.value ?? FALLBACK_DEVICE,
          linkedAt: linkedHere.value,
          importSince: new Date(now - IMPORT_DAYS * DAY).toISOString(),
          includeGroups: true,
          notify: false,
          leftOut: [],
        }
        resetImport()
        await saveConfig(id, next)
      })
    })
  }

  /** The connect dialog closed without connecting: a bridge started for it stops. */
  async function cancel(): Promise<boolean> {
    // A start (or a folder check) still running finishes first, so the bridge it starts is stopped below too.
    while (busy.value !== null && runningTask !== null) {
      await runningTask
    }
    if (config.value !== null) {
      resetFlowKeepingConnection()
      return true
    }
    return run('cancel', async () => {
      if (bridgeStarted.value || bridge.value.process === 'owned') {
        onBridge(await commands.stop())
      }
      resetFlow()
    })
  }

  function resetFlowKeepingConnection(): void {
    riskAccepted.value = false
    error.value = null
  }

  /**
   * Stops the relay (and waits for it), stops the bridge, removes the chats Tresso copied and the config. WhatsApp,
   * the bridge and its own store in the user's folder stay as they are: Tresso deletes nothing there.
   */
  function disconnect(): Promise<boolean> {
    return run('disconnect', async () => {
      const id = userId.value
      const store = mail.currentStore()
      if (id === null || config.value === null) {
        return
      }
      if (store === null) {
        throw new WhatsAppProblem('Your mail on this Mac is still opening. Try again in a moment.')
      }
      await holding(async () => {
        await stopRelay()
        onBridge(await commands.stop())
        await removeLocalChats(store)
        await commands.clearConfig(id)
        config.value = null
        resetFlow()
        resetImport()
      })
    })
  }

  /** Settings' "Change folder": picks and checks first (a cancel changes nothing), then stops, saves and starts. */
  function changeFolder(): Promise<boolean> {
    return run('folder', async () => {
      const id = userId.value
      const current = config.value
      if (id === null || current === null) {
        return
      }
      const picked = await commands.chooseFolder()
      if (picked === null) {
        return
      }
      const found = await commands.inspect(picked)
      const text = folderText(found)
      if (!text.ok) {
        throw new WhatsAppProblem(`${text.status}. ${text.detail ?? ''}`.trim())
      }
      await holding(async () => {
        await stopRelay()
        onBridge(await commands.stop())
        // Another folder is another store: the relay reads it from the start, the chats stay.
        await updateConfig(id, (latest) => ({ ...latest, folder: picked, linkedAt: null }))
        folder.value = picked
        inspection.value = found
        identity.value = null
      })
      await startBridge(picked)
    })
  }

  /** Settings' "Chats to bring in": groups off removes the group chats copied; on reads the store again. */
  function setIncludeGroups(include: boolean): Promise<boolean> {
    return run('groups', async () => {
      const id = userId.value
      const current = config.value
      if (id === null || current === null) {
        return
      }
      const store = relayStore ?? mail.currentStore()
      if (store === null) {
        throw new WhatsAppProblem('Your mail on this Mac is still opening. Try again in a moment.')
      }
      // Groups off always removes what is copied (a removal an earlier attempt could not finish is done now). Groups on
      // while the config says so already does nothing, unless the copy holds no group chat: then an earlier attempt
      // saved the config but did not get to reset the cursor, and the older group messages are read again now.
      if (include && current.includeGroups && (await store.chats()).some(({ chat }) => chat.chatAccountId === LOCAL_CHAT_ACCOUNT && chat.kind === 'group')) {
        return
      }
      await holding(async () => {
        await stopRelay()
        await updateConfig(id, (latest) => ({ ...latest, includeGroups: include }))
        if (include) {
          await resetLocalCursor(store)
        } else {
          await removeLocalGroupChats(store)
        }
        await readChats(store, true)
        revision.value++
      })
    })
  }

  /** Settings' "Notify me" (off by default): kept in the config and on the account row the chat screens read. */
  function setNotify(notify: boolean): Promise<boolean> {
    return run('notify', async () => {
      const id = userId.value
      const current = config.value
      if (id === null || current === null) {
        return
      }
      await updateConfig(id, (latest) => ({ ...latest, notify }))
      await syncAccount()
    })
  }

  /** For the chat screens: leave a chat out (config first, then the relay's backend, then the copy). */
  function leaveOut(jid: string): Promise<boolean> {
    return run('leave', async () => {
      const id = userId.value
      const current = config.value
      if (id === null || current === null) {
        return
      }
      await updateConfig(id, (latest) => ({ ...latest, leftOut: [...new Set([...latest.leftOut, jid])] }))
      await backend?.configure({ leftOut: config.value?.leftOut ?? current.leftOut })
      const store = mail.currentStore()
      if (store !== null) {
        await setLocalChatState(store, localChatId(jid), { leftOut: true })
      }
      revision.value++
    })
  }

  /**
   * Settings' "Take back in": the config first (the chat is no longer left out), then, with the relay stopped, the
   * copy's row is marked in again and the relay reads the bridge's store from the start (resetLocalCursor), as a first
   * import: the chat's messages, which the relay passed over while it was left out, come back read. Then it starts again.
   */
  function takeBackIn(jid: string): Promise<boolean> {
    return run('take-back', async () => {
      const id = userId.value
      const current = config.value
      if (id === null || current === null || !current.leftOut.includes(jid)) {
        return
      }
      const store = relayStore ?? mail.currentStore()
      if (store === null) {
        throw new WhatsAppProblem('Your mail on this Mac is still opening. Try again in a moment.')
      }
      await holding(async () => {
        await stopRelay()
        await updateConfig(id, (latest) => ({ ...latest, leftOut: latest.leftOut.filter((left) => left !== jid) }))
        try {
          await setLocalChatState(store, localChatId(jid), { leftOut: false })
        } catch (cause) {
          // A chat whose row is gone (groups were turned off meanwhile) is simply read again.
          if (!(cause instanceof LocalChatError && cause.code === 'no_chat')) {
            throw cause
          }
        }
        await resetLocalCursor(store)
        await readImportState(store)
        revision.value++
      })
    })
  }

  /**
   * The server confirmed who is signed in: every other user's WhatsApp config on this Mac goes, with the folders only
   * they named (called where the mail store removes other users' copies). The shell keeps the tokens but has no user
   * id it could check them against, so config load and save stay bound to the confirmed user here, in the web client.
   */
  async function keepOnly(id: string): Promise<void> {
    // The switch may not be known yet (init has not had its answer): the cleanup waits for it rather than being skipped.
    await whenChecked
    if (!available.value) {
      return
    }
    try {
      await commands.keepOnlyConfig(id)
    } catch (cause) {
      console.error("Removing other users' WhatsApp settings failed", errorName(cause))
    }
  }

  /** For the chat screens: a round now (a reply was queued), after the one under way. */
  async function pollNow(): Promise<void> {
    await relay?.pollNow()
  }

  /** Stops listening and the relay (tests, and a page that goes away). */
  async function dispose(): Promise<void> {
    scope.stop()
    stopListening?.()
    stopListening = null
    stopSessionEnd?.()
    stopSessionEnd = null
    await stopRelay()
  }

  return {
    available,
    checked,
    deviceName,
    userId,
    config,
    configLoaded,
    bridge,
    bridgeStarted,
    folder,
    inspection,
    identity,
    riskAccepted,
    linkedHere,
    importState,
    progress,
    stuckRefused,
    chatCount,
    lastMessageAt,
    relayRunning,
    relayFailing,
    busy,
    error,
    revision,
    senderNames,
    connected,
    folderReady,
    linked,
    init,
    ready,
    chooseFolder,
    start,
    connect,
    cancel,
    disconnect,
    changeFolder,
    setIncludeGroups,
    setNotify,
    leaveOut,
    takeBackIn,
    lookUpNames,
    keepOnly,
    pollNow,
    dispose,
  }
})
