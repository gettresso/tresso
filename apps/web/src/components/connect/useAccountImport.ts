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
import { abandoned, clearAwaiting, handOver, isAwaited, listenForSignIns, markAwaiting, stateOf, takeNotedOutcome, type HandedOver } from './connectChannel'
import { afterRow, connectedBy, type RunMode } from './importRun'
import { failureState, type RowState } from './importTexts'

/** A sign-in that came back in a tab signed out of Tresso, which cannot finish it. */
export const SIGNED_OUT = 'The sign-in came back in a tab that is signed out of Tresso. Sign in to Tresso there, then try again.'
const NO_STATE = 'The sign-in page could not be opened. Try again.'

/** How many addresses are looked up at once. */
const LOOKUPS_AT_ONCE = 4

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

interface PendingSignIn {
  url: string
  state: string
  expiresAt: number
  provider: OAuthProviderId
  timer: ReturnType<typeof setTimeout>
}

/**
 * The logic of step 2 of "Add several accounts" (/settings/accounts/import/:importId): the rows grouped by how they
 * connect, signing in per row, "Next" (one row, then nothing) and "Sign in to all, one after another" ({@link
 * ./importRun}), the password form per row, Stop, the stop notice, finishing without the rest and adding rows back.
 *
 * A provider sign-in opens the provider's page in a new tab on the web (in the system browser in the desktop app) while
 * this page waits; that tab comes back to the list's page, finishes the sign-in and hands the answer to this one over
 * the connect channel ({@link ./connectChannel}), as the single connect dialog does. Nothing here starts a sign-in on
 * its own except the next row of a run the user started with a click.
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
  /** The password row that is open, and whether its server settings are shown. */
  const openRow = ref<string | null>(null)
  const settingsShown = ref<Record<string, boolean>>({})
  /** Rows whose password is being checked, or whose provider answer is being finished. */
  const signingIn = ref<Record<string, boolean>>({})
  /** The last check of a password row, for which server did not answer. */
  const checks = ref<Record<string, { result: MailAccountCheck; imap: ServerSettings; smtp: ServerSettings }>>({})
  /** What went wrong that the row's state does not say (a request that failed). */
  const rowErrors = ref<Record<string, string>>({})
  const suggestions = ref<Record<string, SuggestedServerSettings | null>>({})
  const looking = ref(false)
  const pending = new Map<string, PendingSignIn>()
  const waiting = ref<Record<string, boolean>>({})
  let checking: AbortController | null = null

  const list = computed<MailAccountImport | null>(() => (imports.current !== null && imports.current.id === importId.value ? imports.current : null))
  const signInProviders = computed(() => accounts.providers.map((provider) => provider.id))

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
      const looked = entry.address in suggestions.value
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
      return { group, rows: groupRows, done: groupRows.filter((row) => row.state === 'connected' || row.state === 'already_connected').length }
    }).filter((group) => group.rows.length > 0),
  )
  const total = computed(() => rows.value.length)
  const connectedCount = computed(() => rows.value.filter((row) => row.state === 'connected' || row.state === 'already_connected').length)
  const failedCount = computed(() => rows.value.filter((row) => row.state === 'failed').length)
  const todoCount = computed(() => rows.value.filter((row) => row.state === 'todo').length)
  const skippedRows = computed(() => rows.value.filter((row) => row.state === 'skipped'))
  /** Every row is connected, already connected or skipped. */
  const allDone = computed(() => total.value > 0 && rows.value.every((row) => row.state === 'connected' || row.state === 'already_connected' || row.state === 'skipped'))
  /** The row "Next" and "Sign in to all" start with. */
  const nextRow = computed(() => nextImportRow(known.value, null, true))
  /** The row after the current one, for the run line. */
  const afterCurrent = computed(() => (current.value === null ? null : nextImportRow(known.value, current.value)))
  const createdBy = computed(() => list.value?.createdBy ?? null)
  /** The assistant's notice stays until the first sign-in. */
  const showAssistantNotice = computed(
    () => createdBy.value !== null && mode.value === null && current.value === null && rows.value.every((row) => row.state === 'todo' || row.state === 'skipped' || row.state === 'already_connected'),
  )
  const expired = ref(false)

  // ---- Loading -----------------------------------------------------------------------------------------------------

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
        expired.value = list.value !== null && Date.parse(list.value.expiresAt) <= Date.now()
        status.value = 'missing'
        error.value = null
      } else {
        status.value = 'error'
        error.value = errorMessage(e)
      }
      return false
    }
    error.value = null
    status.value = 'ready'
    return true
  }

  /** Looks up each address not looked up yet, a few at a time, the way the single "Add account" flow does. */
  async function lookUp(): Promise<void> {
    looking.value = true
    try {
      if (accounts.providers.length === 0) {
        try {
          await accounts.loadProviders()
        } catch {
          // Without the list no row signs in at a provider's page: every row gets the password form.
        }
      }
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
    } finally {
      looking.value = false
    }
  }

  /**
   * Opens the page: the list and how each row connects. A page the provider sent back (a new tab on the web) finishes
   * the sign-in, hands the answer to the tab that waits for it and closes; without such a tab it shows the list. Nothing
   * starts on load.
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

  /** Finishes an answer that came back to this page; true when it went to the tab that waits and this one closes. */
  async function finishHere(answer: LocationQuery): Promise<boolean> {
    const state = typeof answer.state === 'string' ? answer.state : null
    if (state !== null && abandoned(state) !== null) return false
    let result: ProviderConnection | null
    try {
      result = await accounts.finishProviderSignIn(answer)
    } catch (e) {
      error.value = errorMessage(e)
      return false
    }
    if (result !== null && !isDesktop && state !== null && isAwaited(state) && (await handOver(state, { kind: 'result', result }))) {
      window.close()
      return true
    }
    return false
  }

  // ---- Starting rows -----------------------------------------------------------------------------------------------

  function featuresFor(provider: OAuthProviderId): ProviderFeature[] {
    // As the single flow asks by default: mail, and calendars when this server offers them.
    return accounts.providers.find((info) => info.id === provider)?.features.includes('calendar') ? ['mail', 'calendar'] : ['mail']
  }

  /** Starts a row: a provider row opens the provider's page and waits; a password row opens and waits for the password. */
  async function startRow(entryId: string, runMode: RunMode): Promise<void> {
    const id = importId.value
    const row = rows.value.find((candidate) => candidate.id === entryId)
    if (id === null || row === undefined || row.route === null) return
    stopped.value = null
    mode.value = runMode
    current.value = entryId
    rowErrors.value = { ...rowErrors.value, [entryId]: '' }
    if (row.route.kind === 'password') {
      openRow.value = entryId
      return
    }
    const provider = row.route.provider
    let url: string
    let expiresAt: number
    try {
      const started = await accounts.startProviderSignIn(provider, undefined, featuresFor(provider), row.address, id)
      url = started.authorizationUrl
      expiresAt = Date.parse(started.expiresAt)
    } catch (e) {
      rowErrors.value = { ...rowErrors.value, [entryId]: errorMessage(e) }
      end(entryId, false)
      return
    }
    const state = stateOf(url)
    if (state === null) {
      rowErrors.value = { ...rowErrors.value, [entryId]: NO_STATE }
      end(entryId, false)
      return
    }
    // Once the sign-in expired no answer can connect anything any more.
    const timer = setTimeout(() => void expire(entryId), Math.max(0, expiresAt - Date.now()))
    pending.set(entryId, { url, state, expiresAt, provider, timer })
    waiting.value = { ...waiting.value, [entryId]: true }
    if (!isDesktop) markAwaiting(state, expiresAt)
    await openPage(url)
    readNotedOutcomes()
  }

  async function openPage(url: string): Promise<void> {
    if (isDesktop) {
      await openInBrowser(url)
    } else {
      // A blocked window leaves the row waiting; "Open the page again" is a fresh click.
      window.open(url, '_blank', 'noopener')
    }
  }

  /** A row's own action: Sign in, Try again. Nothing starts after it. */
  function signIn(entryId: string): Promise<void> {
    return startRow(entryId, 'one')
  }

  /** "Next: <address>": the next row, and nothing after it. */
  function next(): Promise<void> {
    return nextRow.value === null ? Promise.resolve() : startRow(nextRow.value.id, 'one')
  }

  /** "Sign in to all, one after another". */
  function signInAll(): Promise<void> {
    return nextRow.value === null ? Promise.resolve() : startRow(nextRow.value.id, 'all')
  }

  /** "Open the page again", for a page behind another window or blocked. */
  function openAgain(entryId: string): Promise<void> {
    const signIn = pending.get(entryId)
    return signIn === undefined ? Promise.resolve() : openPage(signIn.url)
  }

  /** Stop: the row under way still finishes, but nothing starts after it. */
  function stopAll(): void {
    if (mode.value !== null) mode.value = 'one'
    if (current.value === null || (!waiting.value[current.value] && !signingIn.value[current.value])) {
      mode.value = null
      current.value = null
    }
  }

  // ---- Answers -----------------------------------------------------------------------------------------------------

  function entryOfState(state: string): string | null {
    for (const [entryId, signIn] of pending) {
      if (signIn.state === state) return entryId
    }
    return null
  }

  function forgetPending(entryId: string): void {
    const signIn = pending.get(entryId)
    if (signIn === undefined) return
    clearTimeout(signIn.timer)
    if (!isDesktop) clearAwaiting(signIn.state)
    pending.delete(entryId)
    waiting.value = { ...waiting.value, [entryId]: false }
  }

  function take(state: string, outcome: HandedOver): boolean {
    const entryId = entryOfState(state)
    if (entryId === null) return false
    if (outcome.kind === 'signed-out') {
      forgetPending(entryId)
      rowErrors.value = { ...rowErrors.value, [entryId]: SIGNED_OUT }
      end(entryId, false)
      return true
    }
    void applyAnswer(entryId, outcome.result)
    return true
  }

  /** Answers another tab noted while this one was not listening. */
  function readNotedOutcomes(): void {
    for (const [, signIn] of pending) {
      const outcome = takeNotedOutcome(signIn.state)
      if (outcome !== null) take(signIn.state, outcome)
    }
  }

  async function applyAnswer(entryId: string, result: ProviderConnection): Promise<void> {
    forgetPending(entryId)
    // The API wrote on the row how it ended; read the list again before deciding what follows.
    await load()
    end(entryId, connectedBy(result))
  }

  /** A waiting sign-in expired without an answer: the row says so and a run stops there. */
  async function expire(entryId: string): Promise<void> {
    if (!pending.has(entryId)) return
    forgetPending(entryId)
    const id = importId.value
    if (id !== null) {
      try {
        await imports.mark(id, entryId, 'failed', 'expired')
      } catch (e) {
        rowErrors.value = { ...rowErrors.value, [entryId]: errorMessage(e) }
      }
    }
    end(entryId, false)
  }

  /** A row ended: go on, stop the run here, or end. */
  function end(entryId: string, connected: boolean): void {
    const decision = afterRow(entryId, connected, mode.value, known.value)
    if (connected && openRow.value === entryId) openRow.value = null
    if (decision.kind === 'continue') {
      void startRow(decision.entryId, 'all')
      return
    }
    if (decision.kind === 'stopped') stopped.value = entryId
    mode.value = null
    current.value = null
  }

  // The desktop app gets the answer while the page is open: the app's link changes only the query.
  watch(
    () => route.query.provider,
    async (provider) => {
      if (provider === undefined || status.value !== 'ready') return
      const answer = { ...route.query }
      await router.replace({ query: {} })
      const state = typeof answer.state === 'string' ? answer.state : null
      const entryId = state === null ? null : entryOfState(state)
      if (entryId !== null) {
        waiting.value = { ...waiting.value, [entryId]: false }
        signingIn.value = { ...signingIn.value, [entryId]: true }
      }
      let result: ProviderConnection | null = null
      try {
        result = await accounts.finishProviderSignIn(answer)
      } catch (e) {
        if (entryId !== null) rowErrors.value = { ...rowErrors.value, [entryId]: errorMessage(e) }
      } finally {
        if (entryId !== null) signingIn.value = { ...signingIn.value, [entryId]: false }
      }
      if (entryId === null) {
        await load()
        return
      }
      if (result === null) {
        forgetPending(entryId)
        end(entryId, false)
        return
      }
      await applyAnswer(entryId, result)
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
   * came from there. A refused check is recorded on the row as a code; the password goes to the API only.
   */
  async function connectWithPassword(entryId: string, values: PasswordValues): Promise<boolean> {
    const id = importId.value
    const row = rows.value.find((candidate) => candidate.id === entryId)
    if (id === null || row === undefined || signingIn.value[entryId]) return false
    signingIn.value = { ...signingIn.value, [entryId]: true }
    rowErrors.value = { ...rowErrors.value, [entryId]: '' }
    const controller = new AbortController()
    checking = controller
    const secret = row.route?.kind === 'password' && row.route.service !== null ? normalizeAppPassword(values.password) : values.password
    const input = { emailAddress: row.address, username: values.username, password: secret, imap: values.imap, smtp: values.smtp }
    let connected = false
    try {
      const check = await accounts.check(input, controller.signal)
      checks.value = { ...checks.value, [entryId]: { result: check, imap: values.imap, smtp: values.smtp } }
      if (check.imap !== 'ok' || check.smtp !== 'ok') {
        const failure: ImportFailure = check.imap === 'auth_failed' || check.smtp === 'auth_failed' ? 'password_refused' : 'server_unreachable'
        await imports.mark(id, entryId, 'failed', failure)
      } else {
        const created = await accounts.create({ ...input, displayName: startingName(row.address) })
        if (controller.signal.aborted) {
          // Cancelled while the account was being created: it goes again, so cancelling leaves nothing.
          await accounts.remove(created.id)
          return false
        }
        await imports.mark(id, entryId, 'connected')
        connected = true
      }
    } catch (e) {
      if (controller.signal.aborted) return false
      rowErrors.value = { ...rowErrors.value, [entryId]: errorMessage(e) }
    } finally {
      if (checking === controller) checking = null
      signingIn.value = { ...signingIn.value, [entryId]: false }
    }
    await load()
    end(entryId, connected)
    return connected
  }

  /** Cancel while a password is checked: the row goes back to To do, and a run stops. */
  function cancelCheck(entryId: string): void {
    checking?.abort()
    signingIn.value = { ...signingIn.value, [entryId]: false }
    mode.value = null
    current.value = null
  }

  /** The server that did not answer for a password row: the one its last check named, else the found one. */
  function unreachableServer(row: ImportRow): ServerSettings | null {
    const check = checks.value[row.id]
    if (check !== undefined) return check.result.imap !== 'ok' && check.result.imap !== 'not_checked' ? check.imap : check.smtp
    return row.servers?.imap ?? null
  }

  // ---- The stop notice ---------------------------------------------------------------------------------------------

  /** "Continue with the next": leaves the row as it is and goes on. */
  function continueWithNext(): Promise<void> {
    const at = stopped.value
    const following = at === null ? null : nextImportRow(known.value, at)
    stopped.value = null
    return following === null ? Promise.resolve() : startRow(following.id, 'all')
  }

  /** "Try this one again": the run goes on from the row it stopped at. */
  function tryAgain(): Promise<void> {
    const at = stopped.value
    return at === null ? Promise.resolve() : startRow(at, 'all')
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
      for (const row of rows.value.filter((candidate) => states.includes(candidate.state))) {
        await imports.mark(id, row.id, to)
      }
    } catch (e) {
      error.value = errorMessage(e)
    }
  }

  /** "Finish without the rest": every row not connected becomes Skipped, and the ending shows. */
  async function finishWithoutRest(): Promise<void> {
    for (const entryId of pending.keys()) forgetPending(entryId)
    mode.value = null
    current.value = null
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
    for (const entryId of pending.keys()) forgetPending(entryId)
    checking?.abort()
  })

  function reset(): void {
    for (const entryId of pending.keys()) forgetPending(entryId)
    checking?.abort()
    mode.value = null
    current.value = null
    stopped.value = null
    openRow.value = null
    settingsShown.value = {}
    signingIn.value = {}
    waiting.value = {}
    checks.value = {}
    rowErrors.value = {}
    suggestions.value = {}
    expired.value = false
    error.value = null
    status.value = 'idle'
  }

  // Another user signed in (the desktop app does that without a reload): nothing of this list may stay or go on.
  watch(() => auth.generation, reset)
  // Another list in the same page (Start a new list, a link): start afresh.
  watch(importId, (id, previous) => {
    if (id !== previous) {
      reset()
      void open()
    }
  })

  return {
    status,
    error,
    expired,
    list,
    rows,
    known,
    groups,
    total,
    connectedCount,
    failedCount,
    todoCount,
    skippedRows,
    allDone,
    nextRow,
    afterCurrent,
    createdBy,
    showAssistantNotice,
    looking,
    mode,
    current,
    stopped,
    openRow,
    settingsShown,
    rowErrors,
    open,
    load,
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
    unreachableServer,
    continueWithNext,
    tryAgain,
    copyApprovalLink,
    finishWithoutRest,
    goBackToSkipped,
    addBack,
    removeList,
  }
}
