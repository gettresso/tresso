import { computed, effectScope, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  ChatRelay,
  ChatRelayImportStuck,
  ChatRelayStopped,
  chatApiFailure,
  labelText,
  LOCAL_CHAT_ACCOUNT,
  LOCAL_CHAT_PREFIX,
  LOCAL_CURSOR,
  LOCAL_HISTORY_THROUGH,
  readHistoryThrough,
  LocalChatBackend,
  LocalChatError,
  localChatId,
  phoneLabel,
  readRelayCursor,
  removeLocalChats,
  removeLocalGroupChats,
  removeServerChatState,
  resetLocalCursor,
  serverClaimKey,
  serverCursorKey,
  ServerChatBackend,
  setLocalChatAccount,
  setLocalChatState,
  uuidV7,
  type ChatBackend,
  type ChatBridge,
  type MailStore,
  type RelayProgress,
  type RelayStatusRequest,
  type RelayStep,
  type SenderLookup,
  type ServerChatProblem,
  type SyncedChatAccount,
} from '@tresso/core'
import { useChatApi } from '@/api/chats'
import { isDesktop } from '@/platform/desktop'
import { whatsAppShell, type BridgeInspection, type BridgeState, type WhatsAppConfig, type WhatsAppIdentity } from '@/platform/whatsapp'
import { errorName, folderText, IMPORT_DAYS, shellErrorText, type ImportState } from '@/components/chat/whatsappTexts'
import { useAuthStore, type SessionEnd } from '@/stores/auth'
import { ChatActionError, chatActionError, serverChatActions } from '@/stores/chatActions'
import { useMailStore } from '@/stores/mail'
import {
  CARRIED_REPLIES,
  historyAt,
  MODE_SWITCH,
  SERVER_ACCOUNT,
  readCarriedReplies,
  readModeSwitch,
  readServerHistory,
  removeServerState,
  resetServerCursor,
  serverAccountIn,
  serverHistoryKey,
  setCarriedReplies,
  setModeSwitch,
  type CarriedReply,
  type ModeSwitch,
  type ServerHistory,
} from '@/stores/whatsappServer'

const DAY = 24 * 60 * 60 * 1000
/** How often the chat count and the last message time are read from the copy while messages come in. */
const CHATS_REFRESH_MS = 5_000
/** The device name when the shell cannot tell it (the config needs one). */
const FALLBACK_DEVICE = 'This Mac'
/** At most this many sender ids in one `names` call (the shell's limit). */
const NAMES_PER_CALL = 500
/** How often the relaying Mac tells the server it is there ("All my devices"), besides at connect and on each change. */
export const HEARTBEAT_MS = 60_000
/** How long a step of "All my devices" that failed for a passing reason (no network) waits before it is tried again. */
export const SERVER_RETRY_MS = 30_000
/** The longest device and display name the server takes. */
const NAME_MAX = 255
/** Characters that draw nothing; the server takes no format characters in a device or display name. */
const FORMAT_CHARACTERS = /\p{Cf}/gu

export const STOPPED_BRIDGE: BridgeState = { process: 'stopped', port: null, loopbackOnly: null, link: 'unknown', qr: null, error: null }

/** What runs now, so a second click waits for it instead of starting the same thing twice. */
export type WhatsAppTask = 'folder' | 'start' | 'connect' | 'disconnect' | 'groups' | 'notify' | 'cancel' | 'leave' | 'take-back' | 'mode' | 'take-over'

/** Where the chats live: "Only this Mac" or "All my devices". */
export type WhatsAppMode = WhatsAppConfig['mode']

/** Said when the server's WhatsApp account went while this Mac relayed it or showed it (removed on another device). */
export const REMOVED_ELSEWHERE = 'WhatsApp was disconnected from your Tresso server, so Tresso disconnected it on this Mac too. WhatsApp itself, the bridge and its own message store on this Mac stay as they are.'

/** A name as the server takes it (no control or format characters, at most 255 characters); null when nothing is left. */
function plainName(value: string | null | undefined): string | null {
  const text = labelText(value ?? '').replace(FORMAT_CHARACTERS, '').trim()
  const cut = [...text].slice(0, NAME_MAX).join('').trim()
  return cut === '' ? null : cut
}

/** The bridge's link as the server keeps it. */
function serverLink(state: BridgeState): RelayStatusRequest['link'] {
  return state.link === 'linked' ? 'linked' : state.link === 'unknown' ? 'unknown' : 'unlinked'
}

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
 * WhatsApp on this Mac: the desktop shell's bridge (platform/whatsapp.ts) and the relay that brings its messages in
 * (ChatRelay, packages/core/src/chat), in one of two modes the config keeps:
 * - "Only this Mac" (`local`, the WhatsApp plan's WP5): LocalChatBackend writes the chats into the mail copy only.
 * - "All my devices" (`all`, WP10): ServerChatBackend passes them to the user's Tresso server, whose chat account names
 *   the one desktop that relays it; every device (this Mac too) gets the chats through the delta, and replies written
 *   anywhere wait in the server's queue until the relaying Mac sends them. Another desktop in this mode shows the chats
 *   and queues replies, and can take the relay over ("Use this Mac instead").
 * macOS desktop only, and only once WhatsApp was turned on for this Mac (`available`); elsewhere it does nothing.
 *
 * The wiring keeps the rules of docs/ARCHITECTURE.md ("what the desktop wiring must respect", for both backends):
 * - One relay per copy: a new one starts only after the previous one's `stop()` resolved, and so does every removal.
 *   Sign-out does not wait for it: the closing copy refuses writes and the relay stops itself.
 * - The relay runs only while the bridge is linked and the copy has caught up with the server (`mail.synced`); against
 *   the server only once the account is in the copy and a pull ended after it arrived (a chat left out on another
 *   device is known as left out only from its row), and only while the account names this device.
 * - The config is saved first, then the backend is made (or configured) from it, then the copy is changed.
 * - The import date and the device id are set once at connect, kept in the config and never changed by anything else.
 * - Errors are logged with the step and the error's name only, never with what a message or a store holds.
 *
 * A switch between the modes is kept in the copy from its first step to its last (MODE_SWITCH), so a crash, a quit or
 * a sign-out between two steps leaves a state the next start takes up (resumeSwitch); each step is safe to repeat:
 *
 * "Only this Mac" to "All my devices" (and connecting in "All my devices"):
 *   1. The switch is marked (to `all`). Nothing else changed: a start finds the mark and goes on; a connect that never
 *      saved its config is forgotten (the user connects again).
 *   2. The replies still waiting here are noted (CARRIED_REPLIES), while their rows exist; noted again, whole, as long
 *      as the local rows are there, so a crash before step 5 loses none and adds none. The local relay does not run
 *      while the switch is marked, so none of them is sent here meanwhile.
 *   3. PUT chat-accounts/whatsapp with this device: the server makes the account or makes this Mac its relay; repeated
 *      it does the same. The mark gets the account id.
 *   4. The config is saved with the mode `all` (device id and import date unchanged).
 *   5. The local `wa:` rows go (removeLocalChats): only now, after the server accepted the account.
 *   6. The relay's server cursor goes (a first import from 0 with the same import date); a claim kept for the account
 *      stays. The mark goes. The relay starts once the delta brought the account and a pull ended after it.
 *   7. The noted replies are queued on the server one by one, each with a new UUIDv7 kept before it is sent (the
 *      server takes an id at most 10 minutes old, and a repeat of a queued id gets the same reply back), as soon as
 *      their chat came in through the delta (carryReplies). One whose chat never comes is given up once the first
 *      import ended and a pull after it, and counted (`carryLost`).
 *
 * "All my devices" to "Only this Mac":
 *   1. The switch is marked (to `local`, with the account id); the relay and the heartbeat stop.
 *   2. A claim this Mac kept is reported first (ServerChatBackend.prepare), so a `sent` result is never dropped.
 *   3. DELETE the account (404 counts as done). The mark says it is removed. A failure in steps 2 or 3 of a switch the
 *      user asked for undoes the mark and leaves "All my devices" as it was; after a crash they are tried again.
 *   4. The config is saved with the mode `local`.
 *   5. What this Mac kept for the account goes (removeServerState), and the local cursor (removeLocalChats).
 *   6. The mark stays until the copy applied the account's removal (its tombstone); then it goes and the local relay
 *      reads the bridge's store from 0.
 *
 * Disconnecting in "All my devices" reports a kept claim, deletes the account, then disconnects as in "Only this Mac".
 * A crash after the DELETE finds the account gone at the next start and disconnects then (REMOVED_ELSEWHERE).
 */
export const useWhatsAppRelayStore = defineStore('whatsappRelay', () => {
  const auth = useAuthStore()
  const mail = useMailStore()
  const commands = whatsAppShell()
  const api = useChatApi()
  /** Chat state and replies on the server, for the leave-out and take-back-in steps (the chat screens use their own). */
  const serverActions = serverChatActions({ api, store: () => mail.currentStore(), pulled: () => void mail.syncNow() })

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
   * Raised whenever the chats in the copy changed through this store: the relay stored messages or reported a reply's
   * result, or the user left a chat out, took one back in or changed which chats come in. The chat screens read again
   * on it.
   */
  const revision = ref(0)
  /**
   * While the store is read again after a chat was taken back in or groups were turned on: the moment that began (epoch
   * ms). Rows sent before it are history, rows after it live (LOCAL_HISTORY_THROUGH); null otherwise, also during the
   * first import after connecting, where everything is history.
   */
  const liveFrom = ref<number | null>(null)
  /**
   * What group senders are called, by sender id, as far as this session learned it (the relay's lookups and the chat
   * screens' own, lookUpNames): a message stored before its sender's name was known shows the name once it is. Kept
   * in memory only, never logged.
   */
  const senderNames = shallowRef<ReadonlyMap<string, string>>(new Map())

  // "All my devices" ------------------------------------------------------------------------------------------------
  /** The server's WhatsApp account as the copy holds it (the delta's chatAccounts); null when the copy holds none. */
  const serverAccount = shallowRef<SyncedChatAccount | null>(null)
  /** A switch between the modes under way, as the copy keeps it; null when none is. */
  const modeSwitch = shallowRef<ModeSwitch | null>(null)
  /** Replies that waited here at the switch to "All my devices" and are not on the server's queue yet. */
  const carried = shallowRef<CarriedReply[]>([])
  /** Of those, how many could not be carried over (their chat never came, or was left out). */
  const carryLost = ref(0)
  /** Messages the server backend passed over as refused, and results the server would not take (counts only). */
  const serverRefused = ref(0)
  /** This Mac asked the server to make it the relay, and the copy has not caught up with that yet. */
  const takingOver = ref(false)
  /** A plain-words notice that is not an action's failure (the account went on another device). */
  const notice = ref<string | null>(null)
  /**
   * A relay call refused this device (409 `not_the_relay`, or the account was gone) while the copy still named it: the
   * relay and the heartbeat stay off until the copy says otherwise (the delta brings who relays now).
   */
  const refusedFor = shallowRef<{ accountId: string; relayDeviceId: string } | null>(null)
  /** The pull count after which the copy has caught up with the delta that brought the account (see caughtUp). */
  const seenAtPull = ref<number | null>(null)
  /** While a re-read with live batches runs against the server: what it marks read (ServerHistory). */
  const serverHistory = shallowRef<ServerHistory | null>(null)

  const connected = computed(() => config.value !== null)
  const folderReady = computed(() => folderText(inspection.value).ok)
  const linked = computed(() => bridge.value.process === 'owned' && bridge.value.link === 'linked')
  const mode = computed<WhatsAppMode | null>(() => config.value?.mode ?? null)
  /** This Mac relays the server's account: "All my devices", and the account in the copy names this device. */
  const relaysHere = computed(() => {
    const current = config.value
    const account = serverAccount.value
    return current !== null && current.mode === 'all' && account !== null && account.relayDeviceId === current.deviceId
  })
  /**
   * The server's account names another device as its relay (it may be this Mac's own earlier one): what Settings names
   * with "Use this Mac instead". Null when there is no account or this Mac relays it.
   */
  const otherRelay = computed(() => {
    const account = serverAccount.value
    if (account === null || relaysHere.value) {
      return null
    }
    return { name: account.relayDeviceName, online: account.relayOnline, offlineSince: account.relayOfflineSince }
  })

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
  /** The local backend the relay runs on ("Only this Mac"); null while none runs, or the relay goes to the server. */
  let backend: LocalChatBackend | null = null
  /** The copy the relay runs on, or is being started on. */
  let relayStore: MailStore | null = null
  /** The server account the relay runs for; null for the local backend (or no relay). */
  let relayAccountId: string | null = null
  /** The heartbeat while this Mac relays the server's account. */
  let heartbeat: { accountId: string; backend: ServerChatBackend; stop: () => void } | null = null
  /** The server state read and acted on, one at a time (refreshServerState); a request during one runs once more. */
  let serverWork: Promise<void> | null = null
  let serverAgain = false
  /** The next try of a server step that failed for a passing reason. */
  let serverRetry: (() => void) | null = null
  /** The pull count once the first import against the server ended; replies to carry give up after a later pull. */
  let importDoneAtPull: number | null = null
  /** The pull count once the live re-read reached where it began; its mark goes after a later pull. */
  let historyDoneAtPull: number | null = null
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
  /** When the read whose rows the relay stored last began (epoch ms): every row the bridge had stored by then is in. */
  let lastReadAt: number | null = null
  /** When the read under way (or the last one) began, until its rows are stored. */
  let readStartedAt: number | null = null
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
      watch([config, bridge, () => mail.synced, () => mail.currentStore(), serverAccount, modeSwitch, takingOver, refusedFor, seenAtPull, () => mail.pulls], () => {
        ensureRelay()
        ensureHeartbeat()
      })
      // The server's account and the switch marks come with the copy and its pages of the delta.
      watch([() => mail.currentStore(), () => mail.chatChanges, () => mail.pulls, () => mail.synced, configLoaded, () => config.value?.mode], () => void refreshServerState(), { immediate: true })
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
    stopHeartbeat()
    cancelServerRetry()
    config.value = null
    configLoaded.value = false
    resetFlow()
    resetImport()
  }

  /** The session ended: the relay stops without being waited for, and a sign-out removes the user's config. */
  function sessionEnded(reason: SessionEnd): void {
    const id = userId.value ?? previousUser ?? knownUser
    void stopRelay()
    stopHeartbeat()
    cancelServerRetry()
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
    liveFrom.value = null
    lastReadAt = null
    readStartedAt = null
    importState.value = 'waiting'
    progress.value = null
    stuckRefused.value = 0
    chatCount.value = 0
    lastMessageAt.value = null
    relayFailing.value = null
    serverRefused.value = 0
    carryLost.value = 0
    importDoneAtPull = null
    historyDoneAtPull = null
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
    if (heartbeat !== null && (state.process !== before.process || state.link !== before.link || state.loopbackOnly !== before.loopbackOnly)) {
      void beat()
    }
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
    // "All my devices" keeps the bridge's state on the server's account (the heartbeat), never on a `wa:` row.
    if (store === null || current === null || current.mode !== 'local' || modeSwitch.value !== null) {
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

  /**
   * Where the relay should run now: the copy, and the server account it relays (null for "Only this Mac"); null when it
   * should not run at all.
   */
  function wanted(): { store: MailStore; account: SyncedChatAccount | null } | null {
    const current = config.value
    const store = mail.synced ? mail.currentStore() : null
    if (current === null || store === null || !linked.value || held !== 0 || modeSwitch.value !== null) {
      return null
    }
    if (current.mode === 'local') {
      return { store, account: null }
    }
    const account = serverAccount.value
    if (account === null || !relaysHere.value || takingOver.value || refusedNow(account) || !caughtUp()) {
      return null
    }
    return { store, account }
  }

  /** The copy has caught up with the delta that brought the server's account: a pull ended after it arrived. */
  function caughtUp(): boolean {
    return seenAtPull.value !== null && mail.pulls > seenAtPull.value
  }

  /** A relay call refused this device for this account, and the copy still says what it said then. */
  function refusedNow(account: SyncedChatAccount): boolean {
    const refused = refusedFor.value
    return refused !== null && refused.accountId === account.id && refused.relayDeviceId === account.relayDeviceId
  }

  function ensureRelay(): void {
    const want = wanted()
    const accountId = want?.account?.id ?? null
    if (want !== null && want.store === relayStore && accountId === relayAccountId) {
      return
    }
    if (relayStore !== null) {
      void stopRelay()
    }
    if (want !== null) {
      void startRelay(want.store, want.account)
    }
  }

  /** Stops the relay; resolves once it finished the round under way (and every relay stopped before). */
  function stopRelay(): Promise<void> {
    relayRun++
    const stopped = relay
    relay = null
    backend = null
    relayStore = null
    relayAccountId = null
    relayRunning.value = false
    if (stopped !== null) {
      stopping = stopping.then(() => stopped.stop()).catch(() => undefined)
    }
    return stopping
  }

  async function startRelay(store: MailStore, account: SyncedChatAccount | null): Promise<void> {
    const mine = ++relayRun
    relayStore = store
    relayAccountId = account?.id ?? null
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
    let made: ChatBackend
    let local: LocalChatBackend | null = null
    if (account === null) {
      local = new LocalChatBackend(
        store,
        { includeGroups: current.includeGroups, leftOut: current.leftOut, importSince: Date.parse(current.importSince) },
        { number: who?.number ?? null, name: who?.name ?? null, deviceId: current.deviceId, deviceName: current.deviceName },
        Date.now,
      )
      made = local
      try {
        // The relay prepares too; doing it here first makes the account row, so the bridge's state lands on it.
        await local.prepare()
      } catch (cause) {
        logRelayError(cause, 'prepare')
      }
      if (mine !== relayRun) {
        return
      }
      await syncAccount()
    } else {
      try {
        made = new ServerChatBackend({
          api,
          store,
          accountId: account.id,
          deviceId: current.deviceId,
          importSince: Date.parse(current.importSince),
          onProblem: (kind) => serverProblem(mine, kind),
        })
      } catch (cause) {
        // A device id or import date the server would refuse in every call: nothing to relay with.
        logRelayError(cause, 'prepare')
        relayStore = null
        relayAccountId = null
        error.value = 'The WhatsApp settings on this Mac cannot be used with your Tresso server. Disconnect WhatsApp and connect it again.'
        return
      }
    }
    await readImportState(store)
    if (mine !== relayRun) {
      return
    }
    backend = local
    relay = new ChatRelay({
      bridge: chatBridge(current.folder),
      backend: reporting(made, mine),
      now: Date.now,
      schedule,
      onProgress: (next) => progressed(mine, store, next),
      onError: (cause, step) => failed(mine, cause, step),
      onStopped: (reason) => stoppedItself(mine, reason),
    })
    relayRunning.value = true
    relay.start()
  }

  /** A problem the server backend went past: counted for Settings (counts only, nothing of the rows). */
  function serverProblem(mine: number, kind: ServerChatProblem): void {
    console.warn('The WhatsApp relay passed over a refusal of the server', kind)
    if (mine === relayRun) {
      serverRefused.value++
    }
  }

  /**
   * The moment a re-read begins from (resetLocalCursor's `liveFrom`): the start of the last read whose rows were stored,
   * so a message that came in between that read and the reset still counts as live; now when no read was stored yet.
   */
  function resetMoment(): number {
    return lastReadAt ?? Date.now()
  }

  /**
   * The backend as the relay uses it, telling the chat screens each reply's result: the list's last message time and the
   * pane's reply state move as soon as a reply was sent or refused, not only after the next stored message.
   */
  function reporting(made: ChatBackend, mine: number): ChatBackend {
    return {
      prepare: () => made.prepare(),
      settings: () => made.settings(),
      ingest: (chats, messages, firstImport) => made.ingest(chats, messages, firstImport),
      cursor: () => made.cursor(),
      async setCursor(cursor) {
        await made.setCursor(cursor)
        // The rows of that read are stored now.
        lastReadAt = readStartedAt ?? lastReadAt
      },
      claimNext: () => made.claimNext(),
      async report(reply, result) {
        await made.report(reply, result)
        if (mine === relayRun) {
          revision.value++
        }
      },
    }
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
        const started = Date.now()
        try {
          const page = await commands.read(from, afterRowid, limit)
          readStartedAt = started
          return page
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

  /** The import's state and the copy's chats, for the relay that runs now (local, or to the server account). */
  async function readImportState(store: MailStore, accountId: string | null = relayAccountId): Promise<void> {
    try {
      if (accountId === null) {
        liveFrom.value = readHistoryThrough(await store.chatMeta(LOCAL_HISTORY_THROUGH))
      } else {
        serverHistory.value = readServerHistory(await store.chatMeta(serverHistoryKey(accountId)))
        liveFrom.value = historyStart(serverHistory.value)
      }
      const value = await store.chatMeta(accountId === null ? LOCAL_CURSOR : serverCursorKey(accountId))
      const cursor = value === null ? null : readRelayCursor(value)
      importState.value = value === null ? 'waiting' : cursor !== null && cursor.firstImport !== null ? 'reading' : 'done'
      await readChats(store, true)
    } catch (cause) {
      logRelayError(cause, 'read')
    }
  }

  /** The earliest moment a live re-read against the server marks read through; null when none runs. */
  function historyStart(history: ServerHistory | null): number | null {
    return history === null ? null : Math.min(...history.scopes.map((scope) => scope.at))
  }

  /** The chat account whose chats this Mac shows: `wa:account`, or the server's in "All my devices". */
  function shownAccountId(): string | null {
    return config.value?.mode === 'all' ? (serverAccount.value?.id ?? null) : LOCAL_CHAT_ACCOUNT
  }

  /** The chat count and the last message time, from the copy; at most every few seconds unless `now`. */
  async function readChats(store: MailStore, now = false): Promise<void> {
    if (!now && Date.now() - chatsReadAt < CHATS_REFRESH_MS) {
      return
    }
    chatsReadAt = Date.now()
    const accountId = shownAccountId()
    const shown = (await store.chats()).filter(({ chat }) => chat.chatAccountId === accountId)
    chatCount.value = shown.length
    lastMessageAt.value = shown[0]?.chat.lastMessageAt ?? null
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
    if (!next.firstImport && relayAccountId === null) {
      // Against the server a re-read is live throughout; its mark ends in markHistory.
      liveFrom.value = null
    }
    if (ended && relayAccountId !== null) {
      // The history is on the server: replies whose chat did not come by the next pull will not come.
      importDoneAtPull = mail.pulls
    }
    readChats(store, ended).catch((cause: unknown) => logRelayError(cause, 'read'))
    if (relayAccountId !== null && (serverHistory.value !== null || carried.value.length > 0)) {
      void refreshServerState()
    }
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

  /**
   * The relay stopped by itself (the copy closes, the chats were removed, or the server said this Mac no longer relays
   * the account or that the account is gone): it starts again only on a change. Against the server the copy is pulled
   * at once, so it learns who relays now (or that the account went); until it does, the relay stays off for this account.
   */
  function stoppedItself(mine: number, reason: unknown): void {
    if (mine !== relayRun) {
      return
    }
    console.info('The WhatsApp relay stopped', errorName(reason))
    const accountId = relayAccountId
    relay = null
    backend = null
    // A later change (the bridge, the copy, the config) may start one again, also on the same copy.
    relayStore = null
    relayAccountId = null
    relayRunning.value = false
    if (accountId !== null && reason instanceof ChatRelayStopped) {
      refuse(accountId)
    }
  }

  /** The server refused this device for the account: off until the copy names the relay anew, and a pull now. */
  function refuse(accountId: string): void {
    const account = serverAccount.value
    if (account !== null && account.id === accountId) {
      refusedFor.value = { accountId, relayDeviceId: account.relayDeviceId }
    }
    void mail.syncNow()
  }

  function logRelayError(cause: unknown, step: RelayStep): void {
    console.error(`The WhatsApp relay failed at ${step}`, errorName(cause))
  }

  // ---- "All my devices": the server's account, the switches, the heartbeat -------------------------------------------

  /** Reads the server's account and the switch marks from the copy, then acts on them; one at a time. */
  function refreshServerState(): Promise<void> {
    if (serverWork !== null) {
      serverAgain = true
      return serverWork
    }
    serverWork = (async () => {
      try {
        do {
          serverAgain = false
          await readServerState()
        } while (serverAgain)
      } finally {
        serverWork = null
      }
    })()
    return serverWork
  }

  async function readServerState(): Promise<void> {
    const store = mail.currentStore()
    if (store === null || !available.value) {
      serverAccount.value = null
      modeSwitch.value = null
      carried.value = []
      serverHistory.value = null
      seenAtPull.value = null
      return
    }
    try {
      const [account, switching, replies] = await Promise.all([
        serverAccountIn(store),
        store.chatMeta(MODE_SWITCH).then(readModeSwitch),
        store.chatMeta(CARRIED_REPLIES).then(readCarriedReplies),
      ])
      if (store !== mail.currentStore()) {
        return
      }
      if (account?.id !== serverAccount.value?.id || seenAtPull.value === null) {
        // Caught up once a pull ends after this one: the one under way, or the next when none runs.
        seenAtPull.value = account === null ? null : mail.syncState === 'syncing' ? mail.pulls : mail.pulls - 1
      }
      if (JSON.stringify(account) !== JSON.stringify(serverAccount.value)) {
        serverAccount.value = account
      }
      if (JSON.stringify(switching) !== JSON.stringify(modeSwitch.value)) {
        modeSwitch.value = switching
      }
      if (JSON.stringify(replies) !== JSON.stringify(carried.value)) {
        carried.value = replies
      }
      const history = account === null ? null : readServerHistory(await store.chatMeta(serverHistoryKey(account.id)))
      if (JSON.stringify(history) !== JSON.stringify(serverHistory.value)) {
        serverHistory.value = history
        if (relayAccountId !== null) {
          liveFrom.value = historyStart(history)
        }
      }
      await reconcile(store)
    } catch (cause) {
      console.error('Reading the WhatsApp server state failed', errorName(cause))
      retryServerLater()
    }
  }

  function retryServerLater(): void {
    if (serverRetry !== null) {
      return
    }
    serverRetry = schedule(() => {
      serverRetry = null
      void refreshServerState()
    }, SERVER_RETRY_MS)
  }

  function cancelServerRetry(): void {
    serverRetry?.()
    serverRetry = null
  }

  /**
   * Puts right what the copy says: a switch left half done, an account removed or taken over elsewhere, replies to
   * carry over, history to mark read. Only between the user's own actions (they do the same steps themselves) and once
   * the copy caught up with the server; a step that fails for a passing reason is tried again a little later.
   */
  async function reconcile(store: MailStore): Promise<void> {
    const id = userId.value
    if (busy.value !== null || held > 0 || !mail.synced || id === null || !configLoaded.value) {
      return
    }
    const current = config.value
    if (modeSwitch.value !== null) {
      await resumeSwitch(store, id, modeSwitch.value)
      return
    }
    if (current === null || current.mode !== 'all') {
      return
    }
    await checkAccount(store, id, current)
    if (config.value?.mode === 'all') {
      await carryReplies(store)
      await markHistory(store)
    }
  }

  /** Writes the switch mark, and keeps it in memory, so the relay and the heartbeat see it at once. */
  async function writeSwitch(store: MailStore, value: ModeSwitch | null): Promise<void> {
    await setModeSwitch(store, value)
    modeSwitch.value = value
  }

  async function writeCarried(store: MailStore, replies: CarriedReply[]): Promise<void> {
    await setCarriedReplies(store, replies)
    carried.value = replies
  }

  /** Takes up a switch a crash, a quit or a sign-out interrupted, from where its mark says it is. */
  async function resumeSwitch(store: MailStore, id: string, switching: ModeSwitch): Promise<void> {
    if (switching.to === 'all' && config.value === null) {
      // A connect that never saved its config: nothing was made with it here. The user connects again.
      await writeSwitch(store, null)
      await writeCarried(store, [])
      return
    }
    if (switching.to === 'local' && switching.cleared) {
      // Only the copy's removal of the account is awaited; nothing to stop or to ask.
      await finishLocalSwitch(store)
      return
    }
    try {
      await holding(async () => {
        await stopRelay()
        if (switching.to === 'all') {
          await stepsToAll(store, id)
        } else {
          await stepsToLocal(store, id, switching)
        }
      })
    } catch (cause) {
      console.error('Finishing the switch of where WhatsApp chats live failed', errorName(cause))
      retryServerLater()
    }
  }

  /**
   * The steps to "All my devices" from wherever the mark says the switch is (the class comment lists them). The config
   * must be saved already (a connect) or be the local one (a switch). Throws when the server cannot be asked; a step
   * done before stays done and the mark says so.
   */
  async function stepsToAll(store: MailStore, id: string): Promise<void> {
    const current = config.value
    if (current === null) {
      return
    }
    if (modeSwitch.value?.to !== 'all') {
      await writeSwitch(store, { to: 'all', accountId: null })
    }
    if ((await store.chatAccounts()).some((account) => account.id === LOCAL_CHAT_ACCOUNT)) {
      // The local rows are there: the replies waiting in them are what goes over, whole (a repeat notes the same).
      await writeCarried(store, await waitingHere(store))
    }
    let who: WhatsAppIdentity | null = identity.value
    try {
      who = await commands.identity(current.folder)
    } catch (cause) {
      console.error('Reading the linked WhatsApp account failed', errorName(cause))
    }
    takingOver.value = true
    try {
      const account = await server(() =>
        api.connect({
          deviceId: current.deviceId,
          deviceName: plainName(current.deviceName) ?? FALLBACK_DEVICE,
          address: who?.number && /^[0-9]{5,20}$/.test(who.number) ? who.number : null,
          displayName: plainName(who?.name),
          includeGroups: current.includeGroups,
          notify: current.notify,
        }),
      )
      refusedFor.value = null
      await writeSwitch(store, { to: 'all', accountId: account.id })
      await store.setChatMeta(SERVER_ACCOUNT, account.id)
      if (config.value?.mode !== 'all') {
        await updateConfig(id, (latest) => ({ ...latest, mode: 'all' }))
      }
      // Only now that the server took the account: the chats copied here go (the delta brings the server's).
      await removeLocalChats(store)
      // A first import from 0 with the same import date; a claim this Mac kept for the account stays to be reported.
      await store.setChatMeta(serverCursorKey(account.id), null)
      await store.setChatMeta(serverHistoryKey(account.id), null)
      await writeSwitch(store, null)
      resetImport()
      revision.value++
      // The account (and who relays it) comes with the next pull; until then nothing compares the relay's device.
      await mail.syncNow()
    } finally {
      takingOver.value = false
    }
  }

  /** The replies waiting in the local rows, by chat JID, oldest first. */
  async function waitingHere(store: MailStore): Promise<CarriedReply[]> {
    return (await store.waitingOutgoing())
      .filter((row) => row.chatAccountId === LOCAL_CHAT_ACCOUNT && row.chatId.startsWith(LOCAL_CHAT_PREFIX))
      .map((row) => ({ jid: row.chatId.slice(LOCAL_CHAT_PREFIX.length), text: row.text, id: null }))
  }

  /**
   * The steps to "Only this Mac" from wherever the mark says the switch is (the class comment lists them). Throws when
   * the server cannot be asked before the account is removed; the mark then says how far it got.
   */
  async function stepsToLocal(store: MailStore, id: string, switching: Extract<ModeSwitch, { to: 'local' }>): Promise<void> {
    const current = config.value
    if (current === null) {
      await writeSwitch(store, null)
      return
    }
    stopHeartbeat()
    let step = switching
    if (!step.removed) {
      if (modeSwitch.value === null) {
        await writeSwitch(store, step)
      }
      await settleClaim(store, step.accountId, current.deviceId)
      await removeAccountOnServer(step.accountId)
      step = { ...step, removed: true }
      await writeSwitch(store, step)
    }
    if (!step.cleared) {
      if (config.value?.mode !== 'local') {
        await updateConfig(id, (latest) => ({ ...latest, mode: 'local' }))
      }
      await removeServerState(store, step.accountId)
      await writeCarried(store, [])
      // The local relay reads the bridge's store from 0, once the copy applied the removal (finishLocalSwitch).
      await removeLocalChats(store)
      step = { ...step, cleared: true }
      await writeSwitch(store, step)
      resetImport()
      revision.value++
      await mail.syncNow()
    }
    await finishLocalSwitch(store)
  }

  /** The last step to "Only this Mac": the mark goes once the copy holds the server's account no more. */
  async function finishLocalSwitch(store: MailStore): Promise<void> {
    const switching = modeSwitch.value
    if (switching?.to !== 'local' || !switching.removed) {
      return
    }
    const still = (await store.chatAccounts()).some((account) => account.id === switching.accountId)
    if (!still) {
      await writeSwitch(store, null)
    }
  }

  /** DELETE the account; one already gone is what was wanted. */
  async function removeAccountOnServer(accountId: string): Promise<void> {
    try {
      await api.removeAccount(accountId)
    } catch (cause) {
      if (chatApiFailure(cause)?.status !== 404) {
        throw chatActionError(cause)
      }
    }
  }

  /**
   * Reports a claim this Mac kept for the account (ServerChatBackend.prepare): its kept result, or `unconfirmed`. A
   * former relay may still report `sent: true` for its own claim, so a reply that went out is never failed for want of
   * its report. Done when the server took it, or when it never will (the account is gone, or the result is one a
   * former relay may not report). Throws when it should be tried again (no network, 5xx, a pause asked for).
   */
  async function settleClaim(store: MailStore, accountId: string, deviceId: string): Promise<void> {
    if ((await store.chatMeta(serverClaimKey(accountId))) === null) {
      return
    }
    let former: ServerChatBackend
    try {
      former = new ServerChatBackend({ api, store, accountId, deviceId, importSince: 0 })
    } catch {
      // A device id the server never took: no claim can be this device's.
      await store.setChatMeta(serverClaimKey(accountId), null)
      return
    }
    try {
      await former.prepare()
    } catch (cause) {
      if (!(cause instanceof ChatRelayStopped)) {
        throw cause
      }
      // The account is gone, or the server takes no result but `sent` from a former relay: its sweep fails the reply.
      await store.setChatMeta(serverClaimKey(accountId), null)
    }
  }

  /**
   * In "All my devices", with no switch under way: notes the account this Mac knows, and acts when it changed elsewhere.
   * - Another device relays it now (after this Mac's own takeover only once the copy shows it): the relay stops (wanted),
   *   a claim this Mac kept is reported first, then what it kept for the account goes.
   * - It is gone from the copy: the server is asked; gone there too, WhatsApp is disconnected on this Mac as well.
   */
  async function checkAccount(store: MailStore, id: string, current: WhatsAppConfig): Promise<void> {
    if (takingOver.value) {
      return
    }
    const known = await store.chatMeta(SERVER_ACCOUNT)
    const account = serverAccount.value
    if (account !== null) {
      if (known !== account.id) {
        await store.setChatMeta(SERVER_ACCOUNT, account.id)
        if (known !== null) {
          await removeServerState(store, known)
        }
      }
      if (account.relayDeviceId !== current.deviceId && caughtUp()) {
        await formerRelay(store, account.id, current.deviceId)
      }
      return
    }
    if (known === null || mail.syncState === 'syncing') {
      return
    }
    let accounts: SyncedChatAccount[]
    try {
      accounts = await api.accounts()
    } catch (cause) {
      console.error('Asking the server for the WhatsApp account failed', errorName(cause))
      retryServerLater()
      return
    }
    if (accounts.some((candidate) => candidate.id === known)) {
      // The copy is behind; a later pull brings it.
      return
    }
    await removedElsewhere(store, id, known)
  }

  /** This Mac relayed the account and another device does now: report a kept claim, then forget the relay's state. */
  async function formerRelay(store: MailStore, accountId: string, deviceId: string): Promise<void> {
    const kept = (await store.chatMeta(serverCursorKey(accountId))) !== null || (await store.chatMeta(serverClaimKey(accountId))) !== null
    if (!kept) {
      return
    }
    await holding(async () => {
      await stopRelay()
      try {
        await settleClaim(store, accountId, deviceId)
      } catch (cause) {
        console.error('Reporting the reply this Mac was sending failed; trying again', errorName(cause))
        retryServerLater()
        return
      }
      await removeServerChatState(store, accountId)
      await store.setChatMeta(serverHistoryKey(accountId), null)
      resetImport()
    })
  }

  /** The server's account went (disconnected on another device): WhatsApp is disconnected here too. */
  async function removedElsewhere(store: MailStore, id: string, accountId: string): Promise<void> {
    await holding(async () => {
      await stopRelay()
      stopHeartbeat()
      await removeServerState(store, accountId)
      await writeCarried(store, [])
      try {
        onBridge(await commands.stop())
      } catch (cause) {
        console.error('Stopping the WhatsApp bridge failed', errorName(cause))
      }
      await commands.clearConfig(id)
      if (userId.value === id) {
        config.value = null
      }
      resetFlow()
      resetImport()
      notice.value = REMOVED_ELSEWHERE
      revision.value++
    })
  }

  /**
   * Queues the replies carried over from "Only this Mac" once their chat is in the copy, oldest first, each with a UUIDv7
   * kept before it is sent: a repeat with the same id gets the same reply back; an id the server finds too old (422 on
   * `id`) was never queued and gets a new one. A reply whose chat is left out, or that the server refuses for good, is
   * given up and counted; one whose chat never came is given up once the first import ended and a pull after it.
   */
  async function carryReplies(store: MailStore): Promise<void> {
    const account = serverAccount.value
    if (account === null || carried.value.length === 0 || !caughtUp()) {
      return
    }
    let list = [...carried.value]
    const drop = async (reply: CarriedReply): Promise<void> => {
      list = list.filter((entry) => entry !== reply)
      carryLost.value++
      await writeCarried(store, list)
    }
    for (const reply of list) {
      const chat = await store.chatByJid(account.id, reply.jid)
      if (chat === null) {
        continue
      }
      if (chat.leftOut) {
        await drop(reply)
        continue
      }
      let sending = reply
      if (sending.id === null) {
        sending = { ...reply, id: uuidV7() }
        list = list.map((entry) => (entry === reply ? sending : entry))
        await writeCarried(store, list)
      }
      try {
        const queued = await api.queueReply(chat.id, { id: sending.id!, text: sending.text })
        await store.putChatOutgoing([queued])
        list = list.filter((entry) => entry !== sending)
        await writeCarried(store, list)
        revision.value++
      } catch (cause) {
        const failure = chatApiFailure(cause)
        if (failure?.status === 422 && failure.violationPaths.includes('id')) {
          // Never queued (a queued id comes back whatever its age): a new id next time.
          list = list.map((entry) => (entry === sending ? { ...sending, id: null } : entry))
          await writeCarried(store, list)
          retryServerLater()
          continue
        }
        if (failure !== null && (failure.status === 404 || failure.status === 409 || failure.status === 422)) {
          await drop(sending)
          continue
        }
        console.error('Carrying a waiting reply over to the server failed; trying again', errorName(cause))
        retryServerLater()
        return
      }
    }
    if (list.length > 0 && importDoneAtPull !== null && mail.pulls > importDoneAtPull) {
      for (const reply of list) {
        if ((await store.chatByJid(account.id, reply.jid)) === null) {
          await drop(reply)
        }
      }
    }
  }

  /**
   * A live re-read against the server (a chat taken back in, groups on again): marks the history of its chats read
   * through the moment it began, by a chat state change, as their rows come in. The mark goes once the relay read
   * past where it began and a pull after that found nothing more to mark.
   */
  async function markHistory(store: MailStore): Promise<void> {
    const account = serverAccount.value
    const history = serverHistory.value
    if (account === null || history === null) {
      return
    }
    let marked = 0
    for (const { chat } of await store.chats()) {
      if (chat.chatAccountId !== account.id) {
        continue
      }
      const at = historyAt(history, chat)
      if (at === null || (chat.readThrough !== null && Date.parse(chat.readThrough) >= at)) {
        continue
      }
      try {
        await serverActions.setState(chat.id, { readThrough: new Date(at).toISOString() })
        marked++
      } catch (cause) {
        console.error('Marking the history of a chat read failed; trying again', errorName(cause))
        retryServerLater()
        return
      }
    }
    if (marked > 0) {
      revision.value++
    }
    const value = await store.chatMeta(serverCursorKey(account.id))
    const cursor = value === null ? null : readRelayCursor(value)
    if (cursor === null || cursor.rowid < history.throughRowid) {
      historyDoneAtPull = null
      return
    }
    if (historyDoneAtPull === null) {
      historyDoneAtPull = mail.pulls
      return
    }
    if (mail.pulls > historyDoneAtPull && marked === 0) {
      await store.setChatMeta(serverHistoryKey(account.id), null)
      serverHistory.value = null
      historyDoneAtPull = null
      if (relayAccountId !== null) {
        liveFrom.value = null
      }
    }
  }

  /** Runs a server request; any failure becomes a ChatActionError in plain words. */
  async function server<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (cause) {
      throw chatActionError(cause)
    }
  }

  /** The heartbeat runs while this Mac relays the server's account, whatever the bridge does (it reports that too). */
  function ensureHeartbeat(): void {
    const current = config.value
    const account = serverAccount.value
    const store = mail.synced ? mail.currentStore() : null
    const want =
      current !== null && current.mode === 'all' && account !== null && relaysHere.value && store !== null && !takingOver.value && modeSwitch.value === null && !refusedNow(account) && caughtUp()
    if (!want) {
      stopHeartbeat()
      return
    }
    if (heartbeat?.accountId === account.id) {
      return
    }
    stopHeartbeat()
    let made: ServerChatBackend
    try {
      made = new ServerChatBackend({ api, store, accountId: account.id, deviceId: current.deviceId, importSince: Date.parse(current.importSince) })
    } catch (cause) {
      logRelayError(cause, 'prepare')
      return
    }
    const timer = setInterval(() => void beat(), HEARTBEAT_MS)
    heartbeat = { accountId: account.id, backend: made, stop: () => clearInterval(timer) }
    void beat()
  }

  function stopHeartbeat(): void {
    heartbeat?.stop()
    heartbeat = null
  }

  /** One heartbeat (`relay/status`): the bridge's state as the server keeps it. */
  async function beat(): Promise<void> {
    const current = heartbeat
    if (current === null) {
      return
    }
    const state = bridge.value
    try {
      await current.backend.reportStatus({
        bridge: state.process === 'owned' ? 'running' : 'stopped',
        link: serverLink(state),
        linkedAt: config.value?.linkedAt ?? null,
        loopbackOnly: state.loopbackOnly,
      })
    } catch (cause) {
      console.error('Telling the server the WhatsApp relay is here failed', errorName(cause))
      if (cause instanceof ChatRelayStopped && heartbeat === current) {
        stopHeartbeat()
        refuse(current.accountId)
      }
    }
  }

  // ---- What the user does ---------------------------------------------------------------------------------------

  async function run(task: WhatsAppTask, work: () => Promise<void>): Promise<boolean> {
    if (busy.value !== null) {
      return false
    }
    busy.value = task
    error.value = null
    notice.value = null
    try {
      const running = (async () => {
        // What the copy asked of the server state goes first; it does not start again while this runs.
        await serverWork?.catch(() => undefined)
        await work()
      })()
      runningTask = running.catch(() => undefined)
      await running
      return true
    } catch (cause) {
      error.value = cause instanceof WhatsAppProblem || cause instanceof ChatActionError ? cause.message : chatApiFailure(cause) !== null ? chatActionError(cause).message : shellErrorText(cause)
      console.error(`WhatsApp: ${task} failed`, errorName(cause))
      return false
    } finally {
      busy.value = null
      // The state the action left is the copy's to settle now (a switch it marked, replies to carry).
      void refreshServerState()
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
   * Connects: saves the config with a new device id and the import date (now less 30 days, kept from here on), then the
   * relay starts and brings the recent chats in. Chats left from an earlier connection go first. "Only this Mac" (the
   * default) keeps them in the copy; "All my devices" makes the server's account with this Mac as its relay first (the
   * switch steps of the class comment): when the server cannot be asked, nothing stays connected and the dialog says so.
   */
  function connect(where: WhatsAppMode = 'local'): Promise<boolean> {
    return run('connect', async () => {
      const id = userId.value
      const from = folder.value
      if (!riskAccepted.value) {
        throw new WhatsAppProblem('Confirm the risk first.')
      }
      if (id === null || from === null || !linked.value || config.value !== null) {
        throw new WhatsAppProblem('Link WhatsApp to your phone first.')
      }
      const store = mail.currentStore()
      if (where === 'all' && store === null) {
        throw new WhatsAppProblem('Your mail on this Mac is still opening. Try again in a moment.')
      }
      await holding(async () => {
        await stopping
        if (store !== null) {
          await removeLocalChats(store)
        }
        if (where === 'all' && store !== null) {
          await writeSwitch(store, { to: 'all', accountId: null })
        }
        const now = Date.now()
        const next: WhatsAppConfig = {
          folder: from,
          mode: where,
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
        if (where === 'all' && store !== null) {
          try {
            await stepsToAll(store, id)
          } catch (cause) {
            if (modeSwitch.value?.to === 'all' && modeSwitch.value.accountId === null) {
              // The server took nothing: the connection is undone, so the dialog can be tried again as it was.
              await writeSwitch(store, null)
              await commands.clearConfig(id)
              if (userId.value === id) {
                config.value = null
              }
            }
            throw cause
          }
        }
      })
    })
  }

  /**
   * Settings' "Where messages live", after the user confirmed: "All my devices" copies the chats to the Tresso server
   * (this Mac relays them; another Mac that did stops), "Only this Mac" removes them from the server and from every
   * other device and brings them in here again. The steps, and what a crash between them leaves, are in the class
   * comment. A switch the server did not take yet is undone when the request fails, and the error says why.
   */
  function switchMode(to: WhatsAppMode): Promise<boolean> {
    return run('mode', async () => {
      const id = userId.value
      const current = config.value
      if (id === null || current === null || current.mode === to) {
        return
      }
      const store = mail.currentStore()
      if (store === null || !mail.synced) {
        throw new WhatsAppProblem('Your mail on this Mac is still opening. Try again in a moment.')
      }
      await holding(async () => {
        await stopRelay()
        if (to === 'all') {
          try {
            await stepsToAll(store, id)
          } catch (cause) {
            if (modeSwitch.value?.to === 'all' && modeSwitch.value.accountId === null) {
              // The server took nothing: still "Only this Mac", its waiting replies where they were.
              await writeSwitch(store, null)
              await writeCarried(store, [])
            }
            throw cause
          }
          return
        }
        const accountId = serverAccount.value?.id ?? (await store.chatMeta(SERVER_ACCOUNT))
        if (accountId === null) {
          // No account on the server this Mac knows of: only the config changes.
          await updateConfig(id, (latest) => ({ ...latest, mode: 'local' }))
          await removeLocalChats(store)
          resetImport()
          return
        }
        try {
          await stepsToLocal(store, id, { to: 'local', accountId, removed: false, cleared: false })
        } catch (cause) {
          if (modeSwitch.value?.to === 'local' && !modeSwitch.value.removed) {
            // The account is still on the server: "All my devices" goes on as it was.
            await writeSwitch(store, null)
          }
          throw cause
        }
      })
    })
  }

  /**
   * "Use this Mac instead", on a Mac in "All my devices" that does not relay: makes this Mac the relay (PUT with its
   * device). The Mac that relayed stops at its next call or when the delta tells it. The relay here starts once the copy
   * shows the change; until then the device the copy names is not compared (the copy is behind). A claim this Mac kept
   * from an earlier time as the relay stays to be reported; the cursor starts again (the server takes a first import
   * again from a relay that takes over).
   */
  function useThisMac(): Promise<boolean> {
    return run('take-over', async () => {
      const current = config.value
      const store = mail.currentStore()
      if (current === null) {
        throw new WhatsAppProblem('Connect WhatsApp on this Mac first.')
      }
      if (current.mode !== 'all') {
        throw new WhatsAppProblem('Choose All my devices first.')
      }
      if (store === null || !mail.synced) {
        throw new WhatsAppProblem('Your mail on this Mac is still opening. Try again in a moment.')
      }
      let who: WhatsAppIdentity | null = identity.value
      try {
        who = await commands.identity(current.folder)
      } catch (cause) {
        console.error('Reading the linked WhatsApp account failed', errorName(cause))
      }
      await holding(async () => {
        await stopRelay()
        takingOver.value = true
        try {
          const account = await server(() =>
            api.connect({
              deviceId: current.deviceId,
              deviceName: plainName(current.deviceName) ?? FALLBACK_DEVICE,
              address: who?.number && /^[0-9]{5,20}$/.test(who.number) ? who.number : null,
              displayName: plainName(who?.name),
              includeGroups: current.includeGroups,
              notify: current.notify,
            }),
          )
          refusedFor.value = null
          await store.setChatMeta(SERVER_ACCOUNT, account.id)
          await store.setChatMeta(serverCursorKey(account.id), null)
          await store.setChatMeta(serverHistoryKey(account.id), null)
          resetImport()
          await mail.syncNow()
        } finally {
          takingOver.value = false
        }
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
   * the bridge and its own store in the user's folder stay as they are: Tresso deletes nothing there. In "All my
   * devices" the server's account goes first, with its chats on every device (a claim this Mac kept is reported before);
   * when the server cannot be asked nothing changes here and the error says why.
   */
  function disconnect(): Promise<boolean> {
    return run('disconnect', async () => {
      const id = userId.value
      const store = mail.currentStore()
      const current = config.value
      if (id === null || current === null) {
        return
      }
      if (store === null) {
        throw new WhatsAppProblem('Your mail on this Mac is still opening. Try again in a moment.')
      }
      await holding(async () => {
        await stopRelay()
        const accountId = current.mode === 'all' ? (serverAccount.value?.id ?? (await store.chatMeta(SERVER_ACCOUNT))) : null
        if (accountId !== null) {
          stopHeartbeat()
          await settleClaim(store, accountId, current.deviceId)
          await removeAccountOnServer(accountId)
          await removeServerState(store, accountId)
        }
        onBridge(await commands.stop())
        await removeLocalChats(store)
        await writeCarried(store, [])
        await writeSwitch(store, null)
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

  /** The server's account this Mac shows in "All my devices"; a problem while the copy has none yet. */
  function shownServerAccount(): SyncedChatAccount {
    const account = serverAccount.value
    if (account === null) {
      throw new WhatsAppProblem('Your WhatsApp chats are not on this Mac yet. Try again in a moment.')
    }
    return account
  }

  /**
   * Settings' "Chats to bring in". "Only this Mac": groups off removes the group chats copied; on reads the store again.
   * "All my devices": the server's account says it (groups off removes the group chats from the server and every device);
   * on reads the store again with live batches, the history of the group chats marked read as they come in.
   */
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
      if (current.mode === 'all') {
        const account = shownServerAccount()
        await holding(async () => {
          await stopRelay()
          if (include) {
            // The re-read is marked first: a crash before the account says so re-reads with groups still off, which
            // stores nothing, and the switch can simply be set again.
            await resetServerCursor(store, account.id, { jid: null, at: resetMoment() })
          }
          const answered = await server(() => api.updateAccount(account.id, { includeGroups: include }))
          await store.putChatAccount(answered)
          serverAccount.value = answered
          await updateConfig(id, (latest) => ({ ...latest, includeGroups: include }))
          await readImportState(store, account.id)
          revision.value++
          void mail.syncNow()
        })
        return
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
          await resetLocalCursor(store, resetMoment())
          await readImportState(store, null)
        } else {
          await removeLocalGroupChats(store)
        }
        await readChats(store, true)
        revision.value++
      })
    })
  }

  /**
   * Settings' "Notify me" (off by default): kept in the config and on the account row the chat screens read; in "All my
   * devices" on the server's account too (whether the phone gets a push, which names the chat only).
   */
  function setNotify(notify: boolean): Promise<boolean> {
    return run('notify', async () => {
      const id = userId.value
      const current = config.value
      if (id === null || current === null) {
        return
      }
      if (current.mode === 'all') {
        const account = shownServerAccount()
        const answered = await server(() => api.updateAccount(account.id, { notify }))
        await mail.currentStore()?.putChatAccount(answered)
        serverAccount.value = answered
      }
      await updateConfig(id, (latest) => ({ ...latest, notify }))
      await syncAccount()
    })
  }

  /**
   * For the chat screens: leave a chat out. "Only this Mac": the config first, then the relay's backend, then the copy.
   * "All my devices": the server's chat state (shown at once in the copy, which the relay reads it from, and put back
   * when the server refuses), then the config.
   */
  function leaveOut(jid: string): Promise<boolean> {
    return run('leave', async () => {
      const id = userId.value
      const current = config.value
      if (id === null || current === null) {
        return
      }
      if (current.mode === 'all') {
        const account = shownServerAccount()
        const chat = (await mail.currentStore()?.chatByJid(account.id, jid)) ?? null
        if (chat === null) {
          throw new WhatsAppProblem('This chat is not on this Mac.')
        }
        await serverActions.setState(chat.id, { leftOut: true })
        await updateConfig(id, (latest) => ({ ...latest, leftOut: [...new Set([...latest.leftOut, jid])] }))
        revision.value++
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
   * Settings' "Take back in".
   * - "Only this Mac": the config first (the chat is no longer left out), then, with the relay stopped, the copy's row is
   *   marked in again and the relay reads the bridge's store from the start (resetLocalCursor), as a first import: the
   *   chat's messages, which the relay passed over while it was left out, come back read. Then it starts again.
   * - "All my devices": against the server a first-import batch may never follow a live one, so with the relay stopped
   *   the chat is taken in on the server with its history marked read through the moment of the reset (one chat state
   *   change), and the relay reads the store again from its first row with live batches (resetServerCursor): the rows
   *   it passed over arrive, the older ones read, and what came since unread.
   */
  function takeBackIn(jid: string): Promise<boolean> {
    return run('take-back', async () => {
      const id = userId.value
      const current = config.value
      if (id === null || current === null || (current.mode === 'local' && !current.leftOut.includes(jid))) {
        return
      }
      const store = relayStore ?? mail.currentStore()
      if (store === null) {
        throw new WhatsAppProblem('Your mail on this Mac is still opening. Try again in a moment.')
      }
      if (current.mode === 'all') {
        const account = shownServerAccount()
        await holding(async () => {
          await stopRelay()
          const at = resetMoment()
          const chat = await store.chatByJid(account.id, jid)
          if (chat !== null && chat.leftOut) {
            await serverActions.setState(chat.id, { leftOut: false, readThrough: new Date(at).toISOString() })
          }
          await updateConfig(id, (latest) => ({ ...latest, leftOut: latest.leftOut.filter((left) => left !== jid) }))
          await resetServerCursor(store, account.id, { jid, at })
          await readImportState(store, account.id)
          revision.value++
        })
        return
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
        await resetLocalCursor(store, resetMoment())
        await readImportState(store, null)
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
    stopHeartbeat()
    cancelServerRetry()
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
    liveFrom,
    senderNames,
    serverAccount,
    modeSwitch,
    carried,
    carryLost,
    serverRefused,
    takingOver,
    notice,
    mode,
    relaysHere,
    otherRelay,
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
    switchMode,
    useThisMac,
    lookUpNames,
    keepOnly,
    pollNow,
    dispose,
  }
})
