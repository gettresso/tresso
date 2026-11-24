import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import {
  IMPORT_GROUPS,
  importGroup,
  importOrder,
  importRoute,
  importServers,
  nextImportRow,
  normalizeAppPassword,
  type ImportEntryState,
  type ImportFailure,
  type ImportGroup,
  type ImportProviderHint,
  type ImportRoute,
  type MailAccountCheck,
  type MailAccountImport,
  type OAuthProviderId,
  type ProviderConnection,
  type ProviderFeature,
  type ServerSettings,
  type SuggestedServerSettings,
} from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { isDesktop, openInBrowser } from '@/platform/desktop'
import { useAccountImportsStore } from '@/stores/accountImports'
import { useAccountsStore } from '@/stores/accounts'
import { useAuthStore } from '@/stores/auth'
import { abandoned, clearAwaiting, handOverAndGoOn, isAwaited, listenForSignIns, markAwaiting, markCancelled, stateOf, takeNotedOutcome, type HandedOver } from './connectChannel'
import { afterRow, type RunMode } from './importRun'
import { failureState, NO_STATE, SIGNED_OUT, type RowState } from './importTexts'

/** How many addresses are looked up at once. */
const LOOKUPS_AT_ONCE = 4
/** How long a tab the provider sent back waits for the waiting page to say where it goes on to. */
const CONTINUE_WAIT_MS = 20_000

/** One row of the list: an entry with how it connects (null while it is looked up) and the state it shows. */
export interface ImportRow {
  id: string
  address: string
  hint: ImportProviderHint | null
  /** As the API says it. */
  state: ImportEntryState
  failure: ImportFailure | null
  approvalUrl: string | null
  route: ImportRoute | null
  group: ImportGroup | null
  /** The servers found for a password row (or those of iCloud and Yahoo); null when none were found. */
  servers: { imap: ServerSettings; smtp: ServerSettings } | null
  /** The username the lookup found, else the address. */
  username: string
  /** As the row shows it. */
  view: RowState
}

/** What the server form sends for one password row; the password goes to the API only. */
export interface PasswordValues {
  imap: ServerSettings
  smtp: ServerSettings
  username: string
  password: string
}

/** The last server check of a password row, for the sentence that says which server failed and how. */
export interface RowCheck {
  result: MailAccountCheck
  imap: ServerSettings
  smtp: ServerSettings
}

interface PendingSignIn {
  url: string
  state: string
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

/** How a provider page is opened: in a tab the click opened, by the tab that came back, or with nothing to open it. */
type Opener = { kind: 'tab'; tab: Window | null } | { kind: 'chain' } | { kind: 'none' }

/**
 * The logic of step 2 of "Add several accounts" (/settings/accounts/import/:importId): the rows grouped by how they
 * connect, signing in per row, "Next" (one row, then nothing) and "Sign in to all, one after another" ({@link
 * ./importRun}), the password form per row, Stop, the stop notice, finishing without the rest and adding rows back.
 *
 * On the web a provider page opens in a tab the user's click opened; the provider sends that tab back to the list's
 * page, which finishes the sign-in and hands the answer to this page over the connect channel ({@link
 * ./connectChannel}). In a run this page answers with the next provider page, and the returning tab goes there itself:
 * a page may only open a tab on a click, so the run goes on in that one tab. In the desktop app the system browser opens
 * each page. Nothing starts on its own except the next row of a run the user started with a click.
 */
export function useAccountImport(importId: Ref<string | null>) {
  const auth = useAuthStore()
  const accounts = useAccountsStore()
  const imports = useAccountImportsStore()
  const route = useRoute()
  const router = useRouter()

  const status = ref<'idle' | 'loading' | 'ready' | 'missing' | 'error'>('idle')
  const error = ref<string | null>(null)
  /** The run under way: `all` goes on by itself, `one` ends after its row; null when nothing runs. */
  const mode = ref<RunMode | null>(null)
  /** The row the run (or the single sign-in) is at. */
  const current = ref<string | null>(null)
  /** Where a run stopped at a row that did not connect. */
  const stopped = ref<string | null>(null)
  /** The password row that is open, whether its server settings are shown, and whether a run opened it. */
  const openRow = ref<string | null>(null)
  const openedByRun = ref(false)
  const settingsShown = ref<Record<string, boolean>>({})
  /** Per row, how often its password was tried; the form empties its password field on each new try. */
  const attempts = ref<Record<string, number>>({})
  /** Rows whose password is being checked, or whose provider answer is being finished. */
  const signingIn = ref<Record<string, boolean>>({})
  /** The last check of a password row. */
  const checks = ref<Record<string, RowCheck>>({})
  /** What went wrong that the row's state does not say (a request that failed, a signed-out return). */
  const rowErrors = ref<Record<string, string>>({})
  /** Rows waiting for a provider page the browser did not open. */
  const blocked = ref<Record<string, boolean>>({})
  const suggestions = ref<Record<string, SuggestedServerSettings | null>>({})
  /** Looking the addresses up: 0 while the addresses are looked up, 1 while the way to connect each is chosen. */
  const looking = ref(false)
  const lookStage = ref(0)
  const pending = new Map<string, PendingSignIn>()
  const waiting = ref<Record<string, boolean>>({})
  const checking = new Map<string, AbortController>()
  /** The list expired while the page was open. */
  const expired = ref(false)
  let expiryTimer: ReturnType<typeof setTimeout> | null = null

  const list = computed<MailAccountImport | null>(() => (imports.current !== null && imports.current.id === importId.value ? imports.current : null))
  const signInProviders = computed(() => accounts.providers.map((provider) => provider.id))
  /** A list an app made is used only once the user checked its addresses. */
  const confirmed = computed(() => list.value?.confirmed ?? false)

  function viewOf(entryId: string, state: ImportEntryState, failure: ImportFailure | null): RowState {
    if (waiting.value[entryId]) return 'waiting'
    if (signingIn.value[entryId]) return 'signing-in'
    switch (state) {
      case 'connected':
        return 'connected'
      case 'already_connected':
        return 'already'
      case 'skipped':
        return 'skipped'
      case 'failed':
        return failureState(failure)
      default:
        return 'todo'
    }
  }

  const rows = computed<ImportRow[]>(() =>
    (list.value?.entries ?? []).map((entry) => {
      const looked = confirmed.value && entry.address in suggestions.value && !looking.value
      const suggestion = suggestions.value[entry.address] ?? null
      const rowRoute = looked ? importRoute(suggestion, entry.provider, signInProviders.value) : null
      return {
        id: entry.id,
        address: entry.address,
        hint: entry.provider,
        state: entry.state,
        failure: entry.failure,
        approvalUrl: entry.approvalUrl,
        route: rowRoute,
        group: rowRoute === null ? null : importGroup(rowRoute),
        servers: rowRoute === null ? null : importServers(suggestion, rowRoute),
        username: suggestion?.found && suggestion.username ? suggestion.username : entry.address,
        view: viewOf(entry.id, entry.state, entry.failure),
      }
    }),
  )
  const known = computed(() => importOrder(rows.value.filter((row): row is ImportRow & { route: ImportRoute } => row.route !== null)))
  const groups = computed(() =>
    IMPORT_GROUPS.map((group) => {
      const groupRows = known.value.filter((row) => row.group === group)
      return { group, rows: groupRows, done: groupRows.filter((row) => row.state === 'connected' || row.state === 'already_connected').length, added: groupRows.filter((row) => row.state === 'connected').length }
    }).filter((group) => group.rows.length > 0),
  )
  const total = computed(() => rows.value.length)
  const connectedCount = computed(() => rows.value.filter((row) => row.state === 'connected' || row.state === 'already_connected').length)
  const addedCount = computed(() => rows.value.filter((row) => row.state === 'connected').length)
  const alreadyCount = computed(() => rows.value.filter((row) => row.state === 'already_connected').length)
  const failedCount = computed(() => rows.value.filter((row) => row.state === 'failed' && row.view !== 'already').length)
  const todoCount = computed(() => rows.value.filter((row) => row.state === 'todo').length)
  const skippedRows = computed(() => rows.value.filter((row) => row.state === 'skipped'))
  /** Every row is connected, already connected or skipped. */
  const allDone = computed(() => total.value > 0 && rows.value.every((row) => row.state === 'connected' || row.state === 'already_connected' || row.state === 'skipped'))
  /** The rows a sign-in may still be started for: to do, or failed with something to try again. */
  const startable = computed(() => known.value.filter((row) => row.view !== 'already' && row.view !== 'failed-final'))
  /** The row "Next" and "Sign in to all" start with. */
  const nextRow = computed(() => nextImportRow(startable.value, null, true))
  /** The row after the current one, for the run line. */
  const afterCurrent = computed(() => (current.value === null ? null : nextImportRow(startable.value, current.value)))
  const createdBy = computed(() => list.value?.createdBy ?? null)
  /** The assistant's notice stays until the first sign-in. */
  const showAssistantNotice = computed(
    () => createdBy.value !== null && mode.value === null && current.value === null && rows.value.every((row) => row.state === 'todo' || row.state === 'skipped' || row.state === 'already_connected'),
  )

  // ---- Loading -----------------------------------------------------------------------------------------------------

  function watchExpiry(): void {
    if (expiryTimer !== null) clearTimeout(expiryTimer)
    const at = list.value === null ? Number.NaN : Date.parse(list.value.expiresAt)
    if (Number.isNaN(at)) return
    // A page left open past the list's day shows that it expired, without waiting for a click.
    expiryTimer = setTimeout(() => goneExpired(), Math.max(0, at - Date.now()))
  }

  function goneExpired(): void {
    giveUpAll()
    expired.value = true
    status.value = 'missing'
  }

  async function load(): Promise<boolean> {
    const id = importId.value
    if (id === null) {
      status.value = 'idle'
      return false
    }
    if (list.value === null) status.value = 'loading'
    try {
      await imports.load(id)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Expired while the page was open: what the list held is still known here.
        if (list.value !== null && Date.parse(list.value.expiresAt) <= Date.now()) {
          goneExpired()
        } else {
          status.value = 'missing'
        }
        error.value = null
      } else {
        status.value = 'error'
        error.value = errorMessage(e)
      }
      return false
    }
    error.value = null
    status.value = 'ready'
    watchExpiry()
    return true
  }

  /**
   * Looks up each address not looked up yet, a few at a time, the way the single "Add account" flow does, and then
   * chooses how each connects. Not for a list an app made until the user confirmed it.
   */
  async function lookUp(): Promise<void> {
    if (!confirmed.value) return
    looking.value = true
    lookStage.value = 0
    try {
      const generation = auth.generation
      const queue = (list.value?.entries ?? []).filter((entry) => !(entry.address in suggestions.value)).map((entry) => entry.address)
      const worker = async (): Promise<void> => {
        for (let address = queue.shift(); address !== undefined; address = queue.shift()) {
          let found: SuggestedServerSettings | null = null
          try {
            found = await accounts.suggest(address)
          } catch {
            // Not found is no failure: the hint, else the password form.
          }
          if (generation !== auth.generation) return
          suggestions.value = { ...suggestions.value, [address]: found }
        }
      }
      await Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, queue.length) }, worker))
      lookStage.value = 1
      if (accounts.providers.length === 0) {
        try {
          await accounts.loadProviders()
        } catch {
          // Without the list no row signs in at a provider's page: every row gets the password form.
        }
      }
    } finally {
      looking.value = false
    }
  }

  /** "Use these addresses": the user checked the addresses of a list an app made. */
  async function confirm(): Promise<void> {
    const id = importId.value
    if (id === null) return
    try {
      await imports.confirm(id)
    } catch (e) {
      error.value = errorMessage(e)
      return
    }
    await lookUp()
  }

  /**
   * Opens the page. A tab the provider sent back finishes the sign-in and hands the answer to the page that waits for
   * it, which may send it on to the next provider page; otherwise it closes, and shows the list where the browser keeps
   * it open. Nothing starts on load.
   */
  async function open(): Promise<void> {
    const answer = route.query.provider !== undefined ? { ...route.query } : null
    if (answer !== null) {
      // The query holds a one-time code; it leaves the address bar and the history before anything else happens.
      await router.replace({ query: {} })
      if (await finishHere(answer)) return
    }
    if (!(await load())) return
    await lookUp()
  }

  /** Finishes an answer that came back to this tab; true when this tab went on to the next provider page. */
  async function finishHere(answer: LocationQuery): Promise<boolean> {
    const state = typeof answer.state === 'string' ? answer.state : null
    if (state !== null && abandoned(state) !== null) {
      // Stopped or given up in the page that waited: nothing is finished, and this tab is not needed.
      if (!isDesktop && isAwaited(state)) window.close()
      return false
    }
    let result: ProviderConnection | null
    try {
      result = await accounts.finishProviderSignIn(answer)
    } catch (e) {
      error.value = errorMessage(e)
      return false
    }
    if (result === null || isDesktop || state === null || !isAwaited(state)) return false
    const reply = await handOverAndGoOn(state, { kind: 'result', result }, CONTINUE_WAIT_MS)
    if (!reply.taken) return false
    if (reply.next !== null) {
      window.location.assign(reply.next)
      return true
    }
    // The page that waited shows how it went. Should the browser keep this tab open, it shows the list too.
    window.close()
    return false
  }

  // ---- Starting rows -----------------------------------------------------------------------------------------------

  function featuresFor(provider: OAuthProviderId): ProviderFeature[] {
    // As the single flow asks by default: mail, and calendars when this server offers them.
    return accounts.providers.find((info) => info.id === provider)?.features.includes('calendar') ? ['mail', 'calendar'] : ['mail']
  }

  /** A tab for a provider page, opened in the click itself (a page may only open one then); null when blocked. */
  function tabForClick(): Window | null {
    if (isDesktop) return null
    try {
      return window.open('', '_blank')
    } catch {
      return null
    }
  }

  function showPage(tab: Window | null, url: string): boolean {
    if (tab === null) return false
    try {
      tab.opener = null
      tab.location.href = url
      return true
    } catch {
      return false
    }
  }

  /**
   * Starts a row: a provider row opens the provider's page and waits; a password row opens and waits for the password.
   * Answers the provider page when the tab that came back is to go there itself (`chain`).
   */
  async function startRow(entryId: string, runMode: RunMode, opener: Opener): Promise<string | null> {
    const id = importId.value
    const row = rows.value.find((candidate) => candidate.id === entryId)
    if (id === null || row === undefined || row.route === null) {
      if (opener.kind === 'tab') opener.tab?.close()
      return null
    }
    stopped.value = null
    mode.value = runMode
    current.value = entryId
    rowErrors.value = { ...rowErrors.value, [entryId]: '' }
    blocked.value = { ...blocked.value, [entryId]: false }
    if (row.route.kind === 'password') {
      if (opener.kind === 'tab') opener.tab?.close()
      openRow.value = entryId
      openedByRun.value = true
      return null
    }
    // A sign-in started for this row before is given up: its answer must not finish anything any more.
    giveUp(entryId)
    const provider = row.route.provider
    let url: string
    let expiresAt: number
    try {
      const started = await accounts.startProviderSignIn(provider, undefined, featuresFor(provider), row.address, id)
      url = started.authorizationUrl
      expiresAt = Date.parse(started.expiresAt)
    } catch (e) {
      if (opener.kind === 'tab') opener.tab?.close()
      rowErrors.value = { ...rowErrors.value, [entryId]: errorMessage(e) }
      end(entryId, false)
      return null
    }
    const state = stateOf(url)
    if (state === null) {
      if (opener.kind === 'tab') opener.tab?.close()
      rowErrors.value = { ...rowErrors.value, [entryId]: NO_STATE }
      end(entryId, false)
      return null
    }
    // Once the sign-in expired no answer can connect anything any more.
    const timer = setTimeout(() => void expire(entryId), Math.max(0, expiresAt - Date.now()))
    pending.set(entryId, { url, state, expiresAt, timer })
    waiting.value = { ...waiting.value, [entryId]: true }
    if (isDesktop) {
      await openInBrowser(url)
      return null
    }
    markAwaiting(state, expiresAt)
    if (opener.kind === 'chain') return url
    if (!(opener.kind === 'tab' && showPage(opener.tab, url))) blocked.value = { ...blocked.value, [entryId]: true }
    readNotedOutcomes()
    return null
  }

  /** A row's own action (Sign in, Try again), from a click. Nothing starts after it. */
  function signIn(entryId: string): Promise<string | null> {
    return startRow(entryId, 'one', { kind: 'tab', tab: tabForClick() })
  }

  /** "Next: <address>", from a click: the next row, and nothing after it. */
  function next(): Promise<string | null> {
    const row = nextRow.value
    return row === null ? Promise.resolve(null) : startRow(row.id, 'one', { kind: 'tab', tab: row.route.kind === 'oauth' ? tabForClick() : null })
  }

  /** "Sign in to all, one after another", from a click. */
  function signInAll(): Promise<string | null> {
    const row = nextRow.value
    return row === null ? Promise.resolve(null) : startRow(row.id, 'all', { kind: 'tab', tab: row.route.kind === 'oauth' ? tabForClick() : null })
  }

  /** "Open the page again", from a click, for a page behind another window or blocked. */
  function openAgain(entryId: string): void {
    const signIn = pending.get(entryId)
    if (signIn === undefined) return
    if (isDesktop) {
      void openInBrowser(signIn.url)
      return
    }
    blocked.value = { ...blocked.value, [entryId]: !showPage(tabForClick(), signIn.url) }
  }

  /** Stop: whatever waits is given up, its row back on To do, and nothing starts after it. */
  function stopAll(): void {
    for (const entryId of pending.keys()) giveUp(entryId)
    mode.value = null
    current.value = null
  }

  // ---- Answers -----------------------------------------------------------------------------------------------------

  function entryOfState(state: string): string | null {
    for (const [entryId, signIn] of pending) {
      if (signIn.state === state) return entryId
    }
    return null
  }

  /** No longer waits for the row's sign-in; its answer will not be finished in any tab. */
  function giveUp(entryId: string): void {
    const signIn = pending.get(entryId)
    if (signIn === undefined) return
    markCancelled(signIn.state, signIn.expiresAt + 15 * 60_000)
    forgetPending(entryId)
  }

  function giveUpAll(): void {
    for (const entryId of pending.keys()) giveUp(entryId)
    for (const controller of checking.values()) controller.abort()
    checking.clear()
    mode.value = null
    current.value = null
  }

  function forgetPending(entryId: string): void {
    const signIn = pending.get(entryId)
    if (signIn === undefined) return
    clearTimeout(signIn.timer)
    if (!isDesktop) clearAwaiting(signIn.state)
    pending.delete(entryId)
    waiting.value = { ...waiting.value, [entryId]: false }
    blocked.value = { ...blocked.value, [entryId]: false }
  }

  /** An answer another tab hands over: this page's when it waits for that state. */
  function take(state: string, outcome: HandedOver): false | Promise<{ next: string | null }> {
    const entryId = entryOfState(state)
    if (entryId === null) return false
    if (outcome.kind === 'signed-out') {
      forgetPending(entryId)
      rowErrors.value = { ...rowErrors.value, [entryId]: SIGNED_OUT }
      return Promise.resolve(end(entryId, false)).then(() => ({ next: null }))
    }
    return applyAnswer(entryId, { kind: 'chain' }).then((next) => ({ next }))
  }

  /** Answers another tab noted while this one was not listening: a run goes on, but without a tab to open it in. */
  function readNotedOutcomes(): void {
    for (const [, signIn] of pending) {
      const outcome = takeNotedOutcome(signIn.state)
      if (outcome === null) continue
      const entryId = entryOfState(signIn.state)
      if (entryId === null) continue
      if (outcome.kind === 'signed-out') {
        forgetPending(entryId)
        rowErrors.value = { ...rowErrors.value, [entryId]: SIGNED_OUT }
        void end(entryId, false)
      } else {
        void applyAnswer(entryId, { kind: 'none' })
      }
    }
  }

  /**
   * The row's sign-in came back: read the list again (the API wrote on the row how it ended) and go on from what the
   * row says now, not from the message.
   */
  async function applyAnswer(entryId: string, opener: Opener): Promise<string | null> {
    forgetPending(entryId)
    await load()
    const row = rows.value.find((candidate) => candidate.id === entryId)
    return end(entryId, row?.state === 'connected' || row?.state === 'already_connected', opener)
  }

  /** A waiting sign-in expired without an answer: the row says so and a run stops there. */
  async function expire(entryId: string): Promise<void> {
    if (!pending.has(entryId)) return
    giveUp(entryId)
    const id = importId.value
    if (id !== null) {
      try {
        await imports.mark(id, entryId, 'failed', 'expired')
      } catch (e) {
        rowErrors.value = { ...rowErrors.value, [entryId]: errorMessage(e) }
      }
    }
    await end(entryId, false)
  }

  /**
   * A row ended: only the row the run is at decides what follows (another row that ended, say one signed in in a tab
   * of its own, changes nothing but itself). Goes on, stops the run here, or ends.
   */
  async function end(entryId: string, connected: boolean, opener: Opener = { kind: 'none' }): Promise<string | null> {
    if (openRow.value === entryId && connected) openRow.value = null
    if (entryId !== current.value) return null
    const decision = afterRow(entryId, connected, mode.value, startable.value)
    if (decision.kind === 'continue') return startRow(decision.entryId, 'all', opener)
    if (decision.kind === 'stopped') stopped.value = entryId
    mode.value = null
    current.value = null
    return null
  }

  // The desktop app gets the answer while the page is open: the app's link changes only the query.
  watch(
    () => route.query.provider,
    async (provider) => {
      if (provider === undefined || status.value !== 'ready') return
      const answer = { ...route.query }
      await router.replace({ query: {} })
      const state = typeof answer.state === 'string' ? answer.state : null
      // A sign-in given up (Stop, expiry, finished without the rest) is not finished.
      if (state !== null && abandoned(state) !== null) return
      const entryId = state === null ? null : entryOfState(state)
      if (entryId !== null) {
        waiting.value = { ...waiting.value, [entryId]: false }
        signingIn.value = { ...signingIn.value, [entryId]: true }
      }
      try {
        await accounts.finishProviderSignIn(answer)
      } catch (e) {
        if (entryId !== null) rowErrors.value = { ...rowErrors.value, [entryId]: errorMessage(e) }
      } finally {
        if (entryId !== null) signingIn.value = { ...signingIn.value, [entryId]: false }
      }
      if (entryId === null) {
        await load()
        return
      }
      await applyAnswer(entryId, { kind: 'none' })
    },
  )

  // ---- Password rows -----------------------------------------------------------------------------------------------

  /** Enter password / Close; a run waiting at the row stops when it is closed. */
  function toggleForm(entryId: string): void {
    if (openRow.value === entryId) {
      openRow.value = null
      if (current.value === entryId) {
        mode.value = null
        current.value = null
      }
      return
    }
    // Opening a row by hand starts no run: the password is checked when the user chooses Check and add.
    openRow.value = entryId
    openedByRun.value = false
  }

  /** "Check settings": the row opens with its server settings shown. */
  function checkSettings(entryId: string): void {
    settingsShown.value = { ...settingsShown.value, [entryId]: true }
    if (openRow.value !== entryId) toggleForm(entryId)
  }

  function showSettings(entryId: string): void {
    settingsShown.value = { ...settingsShown.value, [entryId]: true }
  }

  /** The name on sent mail to start from: the user's own name, else the address before the @. */
  function startingName(address: string): string {
    const name = auth.me?.displayName?.trim() ?? ''
    return (name !== '' ? name : (address.split('@')[0] ?? address)).slice(0, 120)
  }

  /**
   * "Check and add": checks that Tresso can sign in and send, then creates the account and says on the list that it
   * came from there. A refused check is recorded on the row as a code; the password goes to the API only. A refused
   * password closes the row, so Enter password opens it again with an empty field.
   */
  async function connectWithPassword(entryId: string, values: PasswordValues): Promise<boolean> {
    const id = importId.value
    const row = rows.value.find((candidate) => candidate.id === entryId)
    if (id === null || row === undefined || signingIn.value[entryId] || checking.has(entryId)) return false
    signingIn.value = { ...signingIn.value, [entryId]: true }
    rowErrors.value = { ...rowErrors.value, [entryId]: '' }
    attempts.value = { ...attempts.value, [entryId]: (attempts.value[entryId] ?? 0) + 1 }
    const controller = new AbortController()
    checking.set(entryId, controller)
    const secret = row.route?.kind === 'password' && row.route.service !== null ? normalizeAppPassword(values.password) : values.password
    const input = { emailAddress: row.address, username: values.username, password: secret, imap: values.imap, smtp: values.smtp }
    let failure: ImportFailure | null = null
    try {
      const check = await accounts.check(input, controller.signal)
      if (controller.signal.aborted) return false
      checks.value = { ...checks.value, [entryId]: { result: check, imap: values.imap, smtp: values.smtp } }
      if (check.imap !== 'ok' || check.smtp !== 'ok') {
        failure = check.imap === 'auth_failed' || check.smtp === 'auth_failed' ? 'password_refused' : 'server_unreachable'
        await imports.mark(id, entryId, 'failed', failure)
      } else {
        const created = await accounts.create({ ...input, displayName: startingName(row.address) })
        if (controller.signal.aborted) {
          // Cancelled while the account was being created: it goes again, so cancelling leaves nothing.
          await accounts.remove(created.id)
          return false
        }
        await imports.mark(id, entryId, 'connected')
      }
    } catch (e) {
      if (controller.signal.aborted) return false
      rowErrors.value = { ...rowErrors.value, [entryId]: errorMessage(e) }
    } finally {
      if (checking.get(entryId) === controller) checking.delete(entryId)
      signingIn.value = { ...signingIn.value, [entryId]: false }
    }
    if (failure === 'password_refused' && openRow.value === entryId) openRow.value = null
    await load()
    const now = rows.value.find((candidate) => candidate.id === entryId)
    const connected = now?.state === 'connected' || now?.state === 'already_connected'
    if (!connected && current.value !== entryId) return false
    await end(entryId, connected)
    return connected
  }

  /** Cancel while a password is checked: that row goes back to To do, and a run stops. */
  function cancelCheck(entryId: string): void {
    checking.get(entryId)?.abort()
    checking.delete(entryId)
    signingIn.value = { ...signingIn.value, [entryId]: false }
    if (current.value === entryId) {
      mode.value = null
      current.value = null
    }
  }

  // ---- The stop notice ---------------------------------------------------------------------------------------------

  /** "Continue with the next", from a click: leaves the row as it is and goes on. */
  function continueWithNext(): Promise<string | null> {
    const at = stopped.value
    const following = at === null ? null : nextImportRow(startable.value, at)
    stopped.value = null
    if (following === null) return Promise.resolve(null)
    return startRow(following.id, 'all', { kind: 'tab', tab: following.route.kind === 'oauth' ? tabForClick() : null })
  }

  /** "Try this one again", from a click: the run goes on from the row it stopped at. */
  function tryAgain(): Promise<string | null> {
    const at = rows.value.find((row) => row.id === stopped.value)
    if (at === undefined) return Promise.resolve(null)
    return startRow(at.id, 'all', { kind: 'tab', tab: at.route?.kind === 'oauth' ? tabForClick() : null })
  }

  async function copyApprovalLink(entryId: string): Promise<void> {
    const url = rows.value.find((row) => row.id === entryId)?.approvalUrl
    if (url) await navigator.clipboard.writeText(url)
  }

  // ---- Skipping ----------------------------------------------------------------------------------------------------

  async function markAll(states: ImportEntryState[], to: 'skipped' | 'todo'): Promise<void> {
    const id = importId.value
    if (id === null) return
    try {
      for (const row of rows.value.filter((candidate) => states.includes(candidate.state) && candidate.view !== 'already')) {
        await imports.mark(id, row.id, to)
      }
    } catch (e) {
      error.value = errorMessage(e)
    }
  }

  /** "Finish without the rest": what waits is given up, and every row not connected becomes Skipped. */
  async function finishWithoutRest(): Promise<void> {
    giveUpAll()
    stopped.value = null
    openRow.value = null
    await markAll(['todo', 'failed'], 'skipped')
  }

  /** "Go back to the skipped ones": they are on To do again. */
  function goBackToSkipped(): Promise<void> {
    return markAll(['skipped'], 'todo')
  }

  async function addBack(entryId: string): Promise<void> {
    const id = importId.value
    if (id === null) return
    try {
      await imports.mark(id, entryId, 'todo')
    } catch (e) {
      rowErrors.value = { ...rowErrors.value, [entryId]: errorMessage(e) }
    }
  }

  async function removeList(): Promise<boolean> {
    const id = importId.value
    if (id === null) return false
    giveUpAll()
    try {
      await imports.remove(id)
    } catch (e) {
      error.value = errorMessage(e)
      return false
    }
    return true
  }

  // ---- Lifetime ----------------------------------------------------------------------------------------------------

  let stopListening: () => void = () => {}
  function onVisible(): void {
    if (document.visibilityState === 'visible') readNotedOutcomes()
  }
  onMounted(() => {
    stopListening = listenForSignIns(take)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', readNotedOutcomes)
  })
  onBeforeUnmount(() => {
    stopListening()
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', readNotedOutcomes)
    // Leaving the page gives up what it waited for: a provider tab that comes back later finishes nothing.
    giveUpAll()
    if (expiryTimer !== null) clearTimeout(expiryTimer)
  })

  function reset(): void {
    giveUpAll()
    stopped.value = null
    openRow.value = null
    settingsShown.value = {}
    attempts.value = {}
    signingIn.value = {}
    waiting.value = {}
    blocked.value = {}
    checks.value = {}
    rowErrors.value = {}
    suggestions.value = {}
    expired.value = false
    error.value = null
    status.value = 'idle'
    if (expiryTimer !== null) clearTimeout(expiryTimer)
  }

  // Another user signed in (the desktop app does that without a reload): nothing of this list may stay or go on.
  watch(() => auth.generation, reset)

  return {
    status,
    error,
    expired,
    list,
    confirmed,
    rows,
    known,
    groups,
    total,
    connectedCount,
    addedCount,
    alreadyCount,
    failedCount,
    todoCount,
    skippedRows,
    allDone,
    nextRow,
    afterCurrent,
    createdBy,
    showAssistantNotice,
    looking,
    lookStage,
    mode,
    current,
    stopped,
    openRow,
    openedByRun,
    settingsShown,
    attempts,
    checks,
    rowErrors,
    blocked,
    open,
    load,
    confirm,
    signIn,
    next,
    signInAll,
    openAgain,
    stopAll,
    toggleForm,
    checkSettings,
    showSettings,
    connectWithPassword,
    cancelCheck,
    continueWithNext,
    tryAgain,
    copyApprovalLink,
    finishWithoutRest,
    goBackToSkipped,
    addBack,
    removeList,
  }
}
