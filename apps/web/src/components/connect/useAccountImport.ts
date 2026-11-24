import { computed, ref, watch, type Ref } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import {
  importOrder,
  importRoute,
  importServers,
  MAX_IMPORT_ENTRIES,
  nextProviderRow,
  parseAddressList,
  type ImportEntryState,
  type ImportFailure,
  type ImportProviderHint,
  type ImportRoute,
  type LeftOutAddress,
  type MailAccountCheck,
  type MailAccountImport,
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
import { stateOf } from './connectChannel'
import { afterReturn, forget, noteStarted, stop, takeReturn, type RunMode } from './importRun'

/** How many addresses are looked up at once. */
const LOOKUPS_AT_ONCE = 4

/** One row of the checklist: an entry of the list with how it connects (null while it is looked up). */
export interface ImportRow {
  id: string
  address: string
  hint: ImportProviderHint | null
  state: ImportEntryState
  failure: ImportFailure | null
  reason: string | null
  mailAccountId: string | null
  route: ImportRoute | null
  /** For a password row: the servers to start from (found, or known for iCloud and Yahoo); null to guess. */
  servers: { imap: ServerSettings; smtp: ServerSettings } | null
}

/** Something that happened, for the page to say (and announce to screen readers) in its own words. */
export type ImportEvent =
  | { kind: 'started'; entryId: string; mode: RunMode }
  | { kind: 'connected'; entryId: string }
  | { kind: 'failed'; entryId: string }
  | { kind: 'stopped' }
  | { kind: 'all-done' }

/** What the server form sends for one password row; the password goes to the API only, never anywhere else. */
export interface PasswordValues {
  imap: ServerSettings
  smtp: ServerSettings
  username: string
  password: string
}

/** What making a list from pasted text came to. */
export type CreateOutcome =
  | { ok: true; id: string; leftOut: LeftOutAddress[] }
  /** `empty`: nothing pasted; `too-many`: more than fifty addresses; else the API's message, with its reason per address. */
  | { ok: false; problem: 'empty' | 'too-many' | 'refused'; message: string | null; perAddress: { address: string; message: string }[] }

/**
 * The logic of the "Add several accounts" page (/settings/accounts/import and /settings/accounts/import/:importId):
 * making a list from pasted addresses, the checklist with how each row connects, signing in per row or all of them one
 * after another ({@link ./importRun}), the server form per password row, skipping, and finishing a provider's answer
 * that came back to the page. The page renders what this holds; nothing here starts a sign-in except a call from the
 * user's click or keypress, or a connected answer to a run the user started.
 */
export function useAccountImport(importId: Ref<string | null>) {
  const auth = useAuthStore()
  const accounts = useAccountsStore()
  const imports = useAccountImportsStore()
  const route = useRoute()
  const router = useRouter()

  const status = ref<'idle' | 'loading' | 'ready' | 'missing' | 'error'>('idle')
  const error = ref<string | null>(null)
  /** The row whose sign-in or check is under way. */
  const busyEntryId = ref<string | null>(null)
  /** "Sign in to all" is under way: each connected answer starts the next row. */
  const running = ref(false)
  /** The row offered next after a connected answer ("Next: <address>"), started with one click or keypress. */
  const offer = ref<string | null>(null)
  /** Per row: what went wrong that the list itself does not say (a request that failed). */
  const rowErrors = ref<Record<string, string>>({})
  /** Per password row: the last check, for the form to say which server refused. */
  const checks = ref<Record<string, MailAccountCheck>>({})
  const lastEvent = ref<ImportEvent | null>(null)
  const suggestions = ref<Record<string, SuggestedServerSettings | null>>({})

  const list = computed<MailAccountImport | null>(() => (imports.current !== null && imports.current.id === importId.value ? imports.current : null))
  const signInProviders = computed(() => accounts.providers.map((provider) => provider.id))

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
        reason: entry.reason,
        mailAccountId: entry.mailAccountId,
        route: rowRoute,
        servers: rowRoute === null ? null : importServers(suggestion, rowRoute),
      }
    }),
  )
  /** The rows as the page lists them: grouped by provider ({@link importOrder}); rows still looked up go last. */
  const ordered = computed<ImportRow[]>(() => {
    const known = rows.value.filter((row): row is ImportRow & { route: ImportRoute } => row.route !== null)
    return [...importOrder(known), ...rows.value.filter((row) => row.route === null)]
  })
  const createdBy = computed(() => list.value?.createdBy ?? null)
  const progress = computed(() => list.value?.progress ?? { todo: 0, connected: 0, failed: 0, skipped: 0 })
  /** Whether a provider row is left to sign in, so "Sign in to all" has something to do. */
  const providerRowsLeft = computed(() => nextProviderRow(knownRows(), null, true) !== null)

  function knownRows(): (ImportRow & { route: ImportRoute })[] {
    return importOrder(rows.value.filter((row): row is ImportRow & { route: ImportRoute } => row.route !== null))
  }

  // ---- Loading -----------------------------------------------------------------------------------------------------

  async function load(): Promise<boolean> {
    const id = importId.value
    if (id === null) {
      status.value = 'idle'
      return false
    }
    status.value = list.value === null ? 'loading' : status.value
    try {
      await imports.load(id)
    } catch (e) {
      status.value = e instanceof ApiError && e.status === 404 ? 'missing' : 'error'
      error.value = status.value === 'missing' ? null : errorMessage(e)
      return false
    }
    error.value = null
    status.value = 'ready'
    return true
  }

  /** Looks up each address not looked up yet, a few at a time, the way the single "Add account" flow does. */
  async function lookUp(): Promise<void> {
    if (accounts.providers.length === 0) {
      try {
        await accounts.loadProviders()
      } catch {
        // Without the list no row signs in at a provider's page: every row gets the server form.
      }
    }
    const generation = auth.generation
    const waiting = (list.value?.entries ?? []).filter((entry) => entry.state !== 'connected' && !(entry.address in suggestions.value)).map((entry) => entry.address)
    const queue = [...waiting]
    async function worker(): Promise<void> {
      for (let address = queue.shift(); address !== undefined; address = queue.shift()) {
        let found: SuggestedServerSettings | null = null
        try {
          found = await accounts.suggest(address)
        } catch {
          // Not found is not a failure: the hint, else the server form.
        }
        if (generation !== auth.generation) return
        suggestions.value = { ...suggestions.value, [address]: found }
      }
    }
    await Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, queue.length) }, worker))
    // Connected rows need no route; they count as looked up so nothing waits for them.
    for (const entry of list.value?.entries ?? []) {
      if (!(entry.address in suggestions.value)) suggestions.value = { ...suggestions.value, [entry.address]: null }
    }
  }

  /**
   * Opens the page: the list, how each row connects, and the provider's answer when the page came back with one. A
   * page that loads without an answer forgets any run noted before: nothing starts on load.
   */
  async function open(): Promise<void> {
    const query = route.query
    const answer = query.provider !== undefined ? { ...query } : null
    if (answer !== null) {
      // The query holds a one-time code; it leaves the address bar and the history before anything else happens.
      await router.replace({ query: {} })
    } else {
      forget()
    }
    if (!(await load())) {
      if (answer !== null) forget()
      return
    }
    await lookUp()
    if (answer !== null) await finishReturn(answer)
  }

  // ---- Provider rows -----------------------------------------------------------------------------------------------

  function featuresFor(provider: 'google' | 'microsoft'): ProviderFeature[] {
    // As the single flow asks by default: mail, and calendars when this server offers them.
    return accounts.providers.find((info) => info.id === provider)?.features.includes('calendar') ? ['mail', 'calendar'] : ['mail']
  }

  /**
   * Starts the provider sign-in of one row: on the web this tab goes to the provider's page (it comes back here), in
   * the desktop app the system browser opens. Only from the user's click or keypress, or {@link finishReturn} after a
   * connected answer while "Sign in to all" runs.
   */
  async function startSignIn(entryId: string, mode: RunMode): Promise<boolean> {
    const id = importId.value
    const row = rows.value.find((candidate) => candidate.id === entryId)
    if (id === null || row === undefined || row.route?.kind !== 'oauth' || busyEntryId.value !== null) return false
    offer.value = null
    busyEntryId.value = entryId
    rowErrors.value = { ...rowErrors.value, [entryId]: '' }
    let url: string
    let expiresAt: number
    try {
      const started = await accounts.startProviderSignIn(row.route.provider, undefined, featuresFor(row.route.provider), row.address, id)
      url = started.authorizationUrl
      expiresAt = Date.parse(started.expiresAt)
    } catch (e) {
      busyEntryId.value = null
      running.value = false
      rowErrors.value = { ...rowErrors.value, [entryId]: errorMessage(e) }
      lastEvent.value = { kind: 'failed', entryId }
      return false
    }
    const state = stateOf(url)
    if (state === null) {
      busyEntryId.value = null
      running.value = false
      rowErrors.value = { ...rowErrors.value, [entryId]: 'The sign-in page could not be opened. Try again.' }
      return false
    }
    running.value = mode === 'all'
    noteStarted({ importId: id, entryId, mode, state, expiresAt })
    lastEvent.value = { kind: 'started', entryId, mode }
    if (isDesktop) {
      await openInBrowser(url)
    } else {
      window.location.assign(url)
    }
    return true
  }

  /** "Sign in" on one row. */
  function signIn(entryId: string): Promise<boolean> {
    running.value = false
    return startSignIn(entryId, 'one')
  }

  /** "Sign in to all, one after another": the first row still to do (or failed), then each next one by itself. */
  function signInAll(): Promise<boolean> {
    const first = nextProviderRow(knownRows(), null, true)
    return first === null ? Promise.resolve(false) : startSignIn(first.id, 'all')
  }

  /** The offered next row, by one click or keypress. */
  function takeOffer(): Promise<boolean> {
    return offer.value === null ? Promise.resolve(false) : signIn(offer.value)
  }

  /** Stop: whatever is under way still finishes and shows, but nothing starts after it. */
  function stopAll(): void {
    running.value = false
    if (importId.value !== null) stop(importId.value)
    lastEvent.value = { kind: 'stopped' }
  }

  /**
   * The provider's answer came back to the page: finish it (the API records how the row ended), read the list again,
   * and go on as the run says: the next row by itself, an offer of the next one, or a stop.
   */
  async function finishReturn(answer: LocationQuery): Promise<void> {
    const id = importId.value
    if (id === null) return
    const note = takeReturn(id, typeof answer.state === 'string' ? answer.state : null)
    let result: ProviderConnection | null
    try {
      result = await accounts.finishProviderSignIn(answer)
    } catch (e) {
      busyEntryId.value = null
      running.value = false
      if (note !== null) rowErrors.value = { ...rowErrors.value, [note.entryId]: errorMessage(e) }
      await load()
      return
    }
    busyEntryId.value = null
    await load()
    if (result === null) return
    if (note === null) {
      // Not started from this tab (or no longer waited for): shown by the list as it stands, nothing follows.
      running.value = false
      return
    }
    const next = afterReturn(note, result, knownRows())
    if (next.kind === 'stopped') {
      running.value = false
      lastEvent.value = { kind: 'failed', entryId: note.entryId }
      return
    }
    lastEvent.value = { kind: 'connected', entryId: note.entryId }
    if (next.kind === 'continue') {
      await startSignIn(next.entryId, 'all')
      return
    }
    running.value = false
    offer.value = next.entryId
    if (next.entryId === null && !providerRowsLeft.value) lastEvent.value = { kind: 'all-done' }
  }

  // The desktop app gets the answer while the page is open: the app's link changes only the query.
  watch(
    () => route.query.provider,
    async (provider) => {
      if (provider === undefined || status.value !== 'ready') return
      const answer = { ...route.query }
      await router.replace({ query: {} })
      await finishReturn(answer)
    },
  )

  // ---- Password rows -----------------------------------------------------------------------------------------------

  /** The name on sent mail to start from: the user's own name, else the address before the @. */
  function startingName(address: string): string {
    const name = auth.me?.displayName?.trim() ?? ''
    return (name !== '' ? name : (address.split('@')[0] ?? address)).slice(0, 120)
  }

  /**
   * Connects a password row: checks that Tresso can sign in and send, then creates the account. A refused check is
   * recorded on the row (as a code; the password goes to the API's check and account only). True once connected.
   */
  async function connectWithPassword(entryId: string, values: PasswordValues): Promise<boolean> {
    const id = importId.value
    const row = rows.value.find((candidate) => candidate.id === entryId)
    if (id === null || row === undefined || busyEntryId.value !== null) return false
    busyEntryId.value = entryId
    rowErrors.value = { ...rowErrors.value, [entryId]: '' }
    const input = { emailAddress: row.address, username: values.username, password: values.password, imap: values.imap, smtp: values.smtp }
    try {
      const check = await accounts.check(input)
      checks.value = { ...checks.value, [entryId]: check }
      if (check.imap !== 'ok' || check.smtp !== 'ok') {
        const failure: ImportFailure = check.imap === 'auth_failed' || check.smtp === 'auth_failed' ? 'password_refused' : 'server_unreachable'
        await imports.mark(id, entryId, 'failed', failure)
        lastEvent.value = { kind: 'failed', entryId }
        return false
      }
      await accounts.create({ ...input, displayName: startingName(row.address) })
    } catch (e) {
      rowErrors.value = { ...rowErrors.value, [entryId]: errorMessage(e) }
      lastEvent.value = { kind: 'failed', entryId }
      return false
    } finally {
      busyEntryId.value = null
    }
    await load()
    lastEvent.value = { kind: 'connected', entryId }
    return true
  }

  // ---- Skipping ----------------------------------------------------------------------------------------------------

  async function setSkipped(entryId: string, skipped: boolean): Promise<void> {
    const id = importId.value
    if (id === null) return
    try {
      await imports.mark(id, entryId, skipped ? 'skipped' : 'todo')
      rowErrors.value = { ...rowErrors.value, [entryId]: '' }
    } catch (e) {
      rowErrors.value = { ...rowErrors.value, [entryId]: errorMessage(e) }
    }
  }

  // ---- A new list from pasted text ---------------------------------------------------------------------------------

  /** Makes a list of the pasted addresses and opens its page. */
  async function createFromText(text: string): Promise<CreateOutcome> {
    const addresses = parseAddressList(text)
    if (addresses.length === 0) return { ok: false, problem: 'empty', message: null, perAddress: [] }
    if (addresses.length > MAX_IMPORT_ENTRIES) return { ok: false, problem: 'too-many', message: null, perAddress: [] }
    try {
      const created = await imports.create(addresses.map((address) => ({ address })))
      await router.push({ name: 'settings-accounts-import', params: { importId: created.id } })
      return { ok: true, id: created.id, leftOut: created.leftOut }
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.violations).length > 0) {
        const perAddress = Object.entries(e.violations).flatMap(([path, message]) => {
          const index = /^entries\[(\d+)\]\.address$/.exec(path)?.[1]
          return index === undefined ? [] : [{ address: addresses[Number(index)] ?? '', message }]
        })
        return { ok: false, problem: 'refused', message: errorMessage(e), perAddress }
      }
      return { ok: false, problem: 'refused', message: errorMessage(e), perAddress: [] }
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
    forget()
    return true
  }

  // Another user signed in (the desktop app does that without a reload): nothing of this list may stay or go on.
  watch(
    () => auth.generation,
    () => {
      forget()
      running.value = false
      offer.value = null
      busyEntryId.value = null
      suggestions.value = {}
      rowErrors.value = {}
      checks.value = {}
      lastEvent.value = null
      status.value = 'idle'
    },
  )

  return {
    status,
    error,
    list,
    rows,
    ordered,
    createdBy,
    progress,
    busyEntryId,
    running,
    offer,
    rowErrors,
    checks,
    lastEvent,
    providerRowsLeft,
    open,
    load,
    signIn,
    signInAll,
    takeOffer,
    stopAll,
    connectWithPassword,
    setSkipped,
    createFromText,
    removeList,
  }
}
