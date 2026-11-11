<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  accountServiceProvider,
  APP_PASSWORD_SERVERS,
  connectErrorMessage,
  connectRoute,
  guessedServers,
  normalizeAppPassword,
  oauthProviderFor,
  providerLabel,
  type CheckMailAccount,
  type MailAccount,
  type MailAccountCheck,
  type MailServiceProvider,
  type OAuthProviderId,
  type ProviderConnection,
  type ProviderFeature,
  type ServerSettings,
  type SuggestedServerSettings,
} from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { displayNameSchema, emailSchema, EMAIL_MESSAGE, fieldErrors, manualSchema } from '@/forms/accounts'
import { isDesktop, openInBrowser } from '@/platform/desktop'
import { useAccountsStore } from '@/stores/accounts'
import { useAuthStore } from '@/stores/auth'
import { useMailStore } from '@/stores/mail'
import AppIcon from '@/components/AppIcon.vue'
import TressoMark from '@/components/TressoMark.vue'
import ConnectAppPassword from './ConnectAppPassword.vue'
import ConnectChecks from './ConnectChecks.vue'
import ConnectManual from './ConnectManual.vue'
import ConnectPicker from './ConnectPicker.vue'
import ConnectSuccess from './ConnectSuccess.vue'
import ProviderMark from './ProviderMark.vue'
import { abandoned, clearAwaiting, handOver, isAwaited, listenForSignIns, markAwaiting, markCancelled, stateOf, takeNotedOutcome, type HandedOver } from './connectChannel'
import { PROVIDERS, type ProviderChoice } from './providers'

/**
 * Connecting a mail account, as one dialog (the Connect mail boards): the address first, then the easiest way to
 * connect it (the provider's sign-in page, an app password, or server settings), a check that Tresso can sign in
 * before anything is created, and the name on sent mail with how far the mail and calendars are.
 *
 * It also finishes provider sign-ins that come back to /settings/accounts/new: in the desktop app through its link,
 * on the web in the tab the provider page opened in, which hands the outcome to the tab that started it.
 */
const emit = defineEmits<{ close: [openAccountId: string | null] }>()

type Step = 'email' | 'detecting' | 'oauth' | 'oauth-waiting' | 'oauth-stalled' | 'oauth-cancelled' | 'oauth-error' | 'app-password' | 'picker' | 'manual' | 'checking' | 'success'
type FormStep = 'app-password' | 'manual'

const EYEBROWS: Record<Step, string> = {
  email: 'Step 1 of 3',
  detecting: 'Step 1 of 3',
  oauth: 'Step 2 of 3',
  'oauth-waiting': 'Step 2 of 3',
  'oauth-stalled': 'Step 2 of 3',
  'oauth-cancelled': 'Step 2 of 3',
  'oauth-error': 'Step 2 of 3',
  'app-password': 'Step 2 of 3',
  picker: 'Step 2 of 3',
  manual: 'Step 2 of 3',
  checking: 'Step 2 of 3',
  success: 'Step 3 of 3',
}
/** Where Back goes when the way here is not known (a sign-in that came back to a fresh page). */
const BACK_FALLBACK: Partial<Record<Step, Step>> = { oauth: 'email', picker: 'email', manual: 'picker', 'app-password': 'email', checking: 'manual' }
const ALREADY_CONNECTED = 'This address is already connected. You find it under Settings, Accounts.'
const EXCHANGE_LEAD = 'Exchange servers often have IMAP turned off. Ask your IT team for the IMAP and SMTP settings and enter them below.'
/** How long the detecting and checking rows take at least, so each one can be read. */
const ROW_MS = 300
const CHECK_ROW_MS = 1500
/** How long a check waits, in steps, for the user's previous check that is still running on the server. */
const BUSY_RETRY_MS = 30_000
const BUSY_RETRY_STEP_MS = 2000

const auth = useAuthStore()
const accounts = useAccountsStore()
const mail = useMailStore()
const route = useRoute()
const router = useRouter()

const dialog = ref<HTMLDialogElement | null>(null)
const step = ref<Step>('email')
const history = ref<Step[]>([])
const busy = ref(false)
/** Stops what is running (a lookup, a check) when the user goes elsewhere; answers for an old run are dropped. */
let running: AbortController | null = null
let run = 0
const timers = new Set<ReturnType<typeof setTimeout>>()

function later(ms: number, then: () => void): void {
  const timer = setTimeout(() => {
    timers.delete(timer)
    then()
  }, ms)
  timers.add(timer)
}
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => later(ms, resolve))
}

/** Starts a new run and stops the previous one; returns its number and signal. */
function startRun(): { id: number; signal: AbortSignal } {
  stopRun()
  running = new AbortController()
  return { id: run, signal: running.signal }
}
function stopRun(): void {
  run++
  running?.abort()
  running = null
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  busy.value = false
}

function go(next: Step): void {
  history.value.push(step.value)
  step.value = next
}

function back(): void {
  stopRun()
  if (step.value === 'oauth-waiting') forgetSignIn()
  step.value = history.value.pop() ?? BACK_FALLBACK[step.value] ?? 'email'
  if (step.value === 'email') password.value = ''
}

function close(): void {
  stopRun()
  emit('close', null)
}

// ---- Step 1: the address ------------------------------------------------------------------------------------------

const email = ref('')
const emailError = ref<string | null>(null)
/** A line above the address field, such as an organization's approval that came back. */
const notice = ref<string | null>(null)
const addressValid = computed(() => emailSchema.safeParse(email.value).success)
/** The address came from step 1 (or a sign-in); false when the user skipped it, so the next step asks for it. */
const addressGiven = ref(false)
/** The address once it is a valid one; null while the user has not given one. */
const address = computed(() => (addressValid.value ? email.value.trim().toLowerCase() : null))
const domain = computed(() => address.value?.split('@')[1] ?? '')

function alreadyConnected(value: string): boolean {
  return accounts.accounts.some((account) => account.emailAddress.toLowerCase() === value)
}

async function submitEmail(): Promise<void> {
  emailError.value = null
  notice.value = null
  const parsed = emailSchema.safeParse(email.value)
  if (!parsed.success) {
    emailError.value = EMAIL_MESSAGE
    return
  }
  if (!accounts.loaded) {
    try {
      await accounts.load()
    } catch {
      // Creating the account checks again; a list that cannot be loaded now only means it is said later.
    }
  }
  if (alreadyConnected(parsed.data.toLowerCase())) {
    emailError.value = ALREADY_CONNECTED
    return
  }
  addressGiven.value = true
  await detect()
}

// ---- Finding the provider -----------------------------------------------------------------------------------------

const suggestion = ref<SuggestedServerSettings | null>(null)
const detectStage = ref(0)
const detectLabels = computed(() => [`Looking at ${domain.value}`, 'Checking which service handles its mail', 'Choosing the easiest way to connect'])

async function detect(): Promise<void> {
  const { id, signal } = startRun()
  history.value = []
  step.value = 'detecting'
  detectStage.value = 1
  let found: SuggestedServerSettings
  try {
    // Where the address goes depends on the providers this server signs in with; their list may still be loading.
    ;[found] = await Promise.all([accounts.suggest(address.value ?? '', signal), providersLoaded])
  } catch (e) {
    if (id !== run) return
    step.value = 'email'
    emailError.value = e instanceof ApiError && e.violations.emailAddress ? EMAIL_MESSAGE : errorMessage(e)
    return
  }
  if (id !== run) return
  suggestion.value = found
  detectStage.value = 2
  await pause(ROW_MS)
  if (id !== run) return
  detectStage.value = 3

  history.value = ['email']
  switch (connectRoute(found, signInProviders.value)) {
    case 'oauth':
      choose(found.provider!)
      step.value = 'oauth'
      break
    case 'app-password':
      choose(found.provider!)
      step.value = 'app-password'
      break
    case 'manual':
      choose('manual')
      step.value = 'manual'
      break
    case 'picker':
      choice.value = null
      step.value = 'picker'
      break
  }
}

// ---- The provider list ------------------------------------------------------------------------------------------

/** The provider being connected, as found or picked. */
const choice = ref<ProviderChoice | null>(null)
const signInProviders = computed(() => accounts.providers.map((provider) => provider.id))
/** Settles once the providers are loaded; without the list nothing signs in at a provider's page. */
let providersLoaded: Promise<void> = Promise.resolve()

/** Sets the provider and fills its forms afresh, so nothing of an earlier address carries over. */
function choose(next: ProviderChoice): void {
  choice.value = next
  appPassword.value = ''
  appPasswordError.value = null
  formError.value = null
  check.value = null
  oauthError.value = null
  if (PROVIDERS[next].kind === 'manual') fillManual()
}

function toPicker(): void {
  stopRun()
  if (step.value === 'oauth-waiting') forgetSignIn()
  if (step.value === 'email') {
    emailError.value = null
    addressGiven.value = addressValid.value
  }
  go('picker')
}

function pick(next: ProviderChoice): void {
  choose(next)
  go(PROVIDERS[next].kind === 'oauth' ? 'oauth' : PROVIDERS[next].kind)
}

function startOver(): void {
  stopRun()
  forgetSignIn()
  email.value = ''
  emailError.value = null
  addressGiven.value = false
  password.value = ''
  suggestion.value = null
  choice.value = null
  connected.value = null
  history.value = []
  step.value = 'email'
}

// ---- Browser sign-in (Google, Outlook, Microsoft 365) ------------------------------------------------------------

const oauthProvider = computed<OAuthProviderId | null>(() => (choice.value === null || choice.value === 'exchange' || choice.value === 'manual' ? null : oauthProviderFor(choice.value)))
const description = computed(() => PROVIDERS[choice.value ?? 'manual'])
/** Calendars are asked for along with the mail unless the user turns them off; they never cost the mail. */
const calendars = ref(true)
const calendarsOffered = computed(() => accounts.providers.find((provider) => provider.id === oauthProvider.value)?.features.includes('calendar') ?? false)
const features = computed<ProviderFeature[]>(() => (calendars.value && calendarsOffered.value ? ['mail', 'calendar'] : ['mail']))
const oauthError = ref<string | null>(null)
const approvalUrl = ref<string | null>(null)
const copied = ref(false)
/** What the last sign-in asked for, as the API reported it. */
const requested = ref<ProviderFeature[]>([])

/** A started sign-in: its page can be opened again until it expires. */
interface PendingSignIn {
  url: string
  state: string
  expiresAt: number
  key: string
}
let pending: PendingSignIn | null = null
/** The start that is under way, so preparing ahead and a click do not start two. */
let preparing: Promise<PendingSignIn> | null = null
/** The sign-in this dialog waits for; answers for any other are not ours (or were cancelled). */
const awaitedState = ref<string | null>(null)
/**
 * Why the waiting stopped without an answer: the sign-in expired, came back in a tab signed out of Tresso, or (in the
 * provider's tab) was given up by the tab that waited.
 */
const stalled = ref<'timeout' | 'signed-out' | 'given-up'>('timeout')
let waitTimer: ReturnType<typeof setTimeout> | null = null

function stopWaitTimer(): void {
  if (waitTimer !== null) clearTimeout(waitTimer)
  waitTimer = null
}

/** The waiting ended without a connection: say why, and offer to try again. */
function stopWaiting(reason: 'timeout' | 'signed-out'): void {
  stopWaitTimer()
  if (awaitedState.value !== null) {
    // This tab tells the user nothing was connected: the provider's tab must not connect it later after all.
    // Kept a while past the sign-in's own expiry: the provider's tab may still come back after it.
    markCancelled(awaitedState.value, Math.max(pending?.expiresAt ?? 0, Date.now()) + 15 * 60_000, 'given-up')
    clearAwaiting(awaitedState.value)
  }
  awaitedState.value = null
  pending = null
  stalled.value = reason
  step.value = 'oauth-stalled'
}

/** An outcome the other tab noted while this one was not listening (or before it started to). */
function readNotedOutcome(): void {
  const state = awaitedState.value
  const outcome = state === null ? null : takeNotedOutcome(state)
  if (outcome !== null) takeOutcome(outcome)
}

function takeOutcome(outcome: HandedOver): void {
  if (outcome.kind === 'signed-out') stopWaiting('signed-out')
  else void applySignIn(outcome.result)
}

function signInKey(): string {
  return `${oauthProvider.value}|${features.value.join(',')}|${address.value ?? ''}`
}

/** Starts the sign-in at the API, or reuses the one started for the same choice that has not expired. */
async function prepareSignIn(): Promise<PendingSignIn> {
  const provider = oauthProvider.value
  if (provider === null) throw new Error('No provider to sign in with.')
  const key = signInKey()
  if (pending !== null && pending.key === key && pending.expiresAt - Date.now() > 60_000) return pending
  if (preparing !== null) {
    const started = await preparing
    if (started.key === key) return started
  }
  preparing = accounts.startProviderSignIn(provider, undefined, features.value, address.value ?? undefined).then((started) => {
    const state = stateOf(started.authorizationUrl)
    if (state === null) throw new Error('The sign-in page has no state.')
    return { url: started.authorizationUrl, state, expiresAt: Date.parse(started.expiresAt), key }
  })
  try {
    pending = await preparing
  } finally {
    preparing = null
  }
  return pending
}

/** Opens the provider's page: on the web in a new tab, in the desktop app in the system browser. */
async function openSignIn(fresh = false): Promise<void> {
  oauthError.value = null
  if (fresh) pending = null
  busy.value = true
  let started: PendingSignIn
  try {
    started = await prepareSignIn()
  } catch (e) {
    oauthError.value = errorMessage(e)
    busy.value = false
    return
  }
  busy.value = false
  awaitedState.value = started.state
  if (!isDesktop) markAwaiting(started.state, started.expiresAt)
  // Once the sign-in expired no answer can connect anything any more.
  stopWaitTimer()
  const state = started.state
  waitTimer = setTimeout(() => {
    if (awaitedState.value === state) stopWaiting('timeout')
  }, Math.max(0, started.expiresAt - Date.now()))
  if (isDesktop) {
    await openInBrowser(started.url)
  } else {
    // A blocked window leaves the waiting screen up; its note says so, and "Open the page again" is a fresh click.
    window.open(started.url, '_blank', 'noopener')
  }
  if (step.value !== 'oauth-waiting') go('oauth-waiting')
  readNotedOutcome()
}

/** Gives up the sign-in waited for: an answer that still comes back, in this tab or another, is not finished. */
function forgetSignIn(): void {
  stopWaitTimer()
  if (awaitedState.value !== null) {
    markCancelled(awaitedState.value, pending?.expiresAt ?? Date.now() + 15 * 60_000)
    clearAwaiting(awaitedState.value)
  }
  awaitedState.value = null
  pending = null
}

/** Cancel while waiting: back to the explanation, and whatever the provider still answers is ignored. */
function cancelWaiting(): void {
  forgetSignIn()
  back()
}

function mailOnly(): void {
  calendars.value = false
  void openSignIn(true)
}

async function copyApprovalUrl(): Promise<void> {
  if (approvalUrl.value === null) return
  await navigator.clipboard.writeText(approvalUrl.value)
  copied.value = true
  later(2000, () => (copied.value = false))
}

/** Shows how a provider sign-in ended. */
async function applySignIn(result: ProviderConnection): Promise<void> {
  stopWaitTimer()
  if (awaitedState.value !== null) clearAwaiting(awaitedState.value)
  awaitedState.value = null
  pending = null
  requested.value = result.requested
  if (choice.value === null || PROVIDERS[choice.value].kind !== 'oauth') choice.value = result.provider === 'google' ? 'google' : 'm365'
  if (result.connectError === null && result.connected !== null) {
    try {
      const account = await accounts.get(result.connected)
      choice.value = accountServiceProvider(account) ?? choice.value
      addressGiven.value = true
      await showConnected(account, { existing: result.existing, refused: result.missing.includes('calendar') })
    } catch (e) {
      oauthError.value = errorMessage(e)
      step.value = 'oauth'
    }
    return
  }
  if (result.connectError === 'denied') {
    step.value = 'oauth-cancelled'
  } else if (result.connectError === 'admin_approval_required') {
    approvalUrl.value = result.approvalUrl
    step.value = 'oauth-error'
  } else if (result.connectError !== null) {
    oauthError.value = connectErrorMessage(result.connectError, result.provider)
    step.value = 'oauth'
  }
  if (history.value.length === 0) history.value = ['email']
}

/** The provider sent this page back with its answer: finish the sign-in here, and tell the tab that started it. */
async function finishFromRoute(): Promise<void> {
  const query = route.query
  if (query.adminConsent === 'granted') {
    await router.replace({ query: {} })
    notice.value = 'If your organization approved Tresso, enter your work address to connect it.'
    return
  }
  if (query.provider === undefined) return
  // The query holds a one-time code; it leaves the address bar and the history before anything else happens.
  await router.replace({ query: {} })
  const state = typeof query.state === 'string' ? query.state : null
  const gaveUp = state === null ? null : abandoned(state)
  if (gaveUp !== null) {
    // Cancelled, or given up by the tab that waited (it told the user nothing was connected): nothing is finished, so
    // nothing is connected, and the user starts again from the dialog.
    choice.value = query.provider === 'google' ? 'google' : 'm365'
    history.value = ['email']
    if (gaveUp === 'cancelled') {
      step.value = 'oauth-cancelled'
    } else {
      stalled.value = 'given-up'
      step.value = 'oauth-stalled'
    }
    return
  }

  let result: ProviderConnection | null
  try {
    result = await accounts.finishProviderSignIn(query)
  } catch (e) {
    oauthError.value = errorMessage(e)
    choice.value = query.provider === 'google' ? 'google' : 'm365'
    history.value = ['email']
    step.value = 'oauth'
    return
  }
  if (result === null) return
  if (!isDesktop && state !== null && isAwaited(state) && (await handOver(state, { kind: 'result', result }))) {
    // The tab that started the sign-in shows it; this one was only the provider's way back.
    window.close()
  }
  await applySignIn(result)
}

watch(
  () => [route.query.provider, route.query.adminConsent],
  ([provider, adminConsent]) => {
    if (provider !== undefined || adminConsent !== undefined) void finishFromRoute()
  },
)

let stopListening: () => void = () => {}

// ---- App password (iCloud, Yahoo) ---------------------------------------------------------------------------------

const appPassword = ref('')
const appPasswordError = ref<'refused' | 'empty' | null>(null)
const appPasswordProvider = computed(() => (choice.value === 'icloud' || choice.value === 'yahoo' ? choice.value : null))

function openSite(url: string): void {
  if (isDesktop) void openInBrowser(url)
  else window.open(url, '_blank', 'noopener')
}

function connectAppPassword(): void {
  const provider = appPasswordProvider.value
  if (provider === null) return
  formError.value = null
  appPasswordError.value = null
  emailError.value = null
  if (address.value === null) {
    emailError.value = EMAIL_MESSAGE
    return
  }
  if (alreadyConnected(address.value)) {
    emailError.value = ALREADY_CONNECTED
    return
  }
  const secret = normalizeAppPassword(appPassword.value)
  if (secret === '') {
    appPasswordError.value = 'empty'
    return
  }
  const found = suggestion.value
  const servers = found?.found && found.provider === provider && found.imap && found.smtp ? { imap: found.imap, smtp: found.smtp } : APP_PASSWORD_SERVERS[provider]
  void checkAndCreate({ emailAddress: address.value, username: address.value, password: secret, ...servers }, 'app-password')
}

// ---- Manual set-up ------------------------------------------------------------------------------------------------

const imap = ref<ServerSettings>({ host: '', port: 993, security: 'tls' })
const smtp = ref<ServerSettings>({ host: '', port: 465, security: 'tls' })
const username = ref('')
const password = ref('')
const manualErrors = ref<Record<string, string>>({})
const check = ref<MailAccountCheck | null>(null)
const formError = ref<string | null>(null)

/** The found settings, else the usual guess for the domain; never what an earlier address left behind. */
function fillManual(): void {
  const found = suggestion.value
  const usable = found !== null && found.emailAddress === address.value && found.found
  const guess = guessedServers(domain.value)
  imap.value = usable && found.imap ? { ...found.imap } : guess.imap
  smtp.value = usable && found.smtp ? { ...found.smtp } : guess.smtp
  username.value = usable && found.username ? found.username : (address.value ?? '')
  password.value = ''
  manualErrors.value = {}
}

const manualLead = computed(() =>
  choice.value === 'exchange' ? EXCHANGE_LEAD : `We filled in what we could guess for ${domain.value || 'your domain'}. Your mail provider or IT team can give you the right settings.`,
)
/** A provider that signs in through its own page, which this server does not offer: an app password may still work. */
const manualNote = computed(() => {
  const provider = suggestion.value?.emailAddress === address.value ? suggestion.value?.provider : null
  if (provider === null || provider === undefined || oauthProviderFor(provider) === null) return null
  return `${providerLabel(provider)} normally signs you in through its own page, which this server does not offer. Make an app password in your ${providerLabel(provider)} account settings and use it as the password below.`
})

// An address typed on the form itself fills in the username and the usual servers, as long as the user has not
// changed those.
watch(address, (next, previous) => {
  if (step.value !== 'manual' || addressGiven.value) return
  const old = guessedServers(previous?.split('@')[1] ?? '')
  const guess = guessedServers(next?.split('@')[1] ?? '')
  if (imap.value.host === old.imap.host) imap.value = { ...imap.value, host: guess.imap.host }
  if (smtp.value.host === old.smtp.host) smtp.value = { ...smtp.value, host: guess.smtp.host }
  if (username.value === (previous ?? '')) username.value = next ?? ''
})

function connectManual(): void {
  formError.value = null
  check.value = null
  const errors: Record<string, string> = {}
  if (address.value === null) errors.emailAddress = EMAIL_MESSAGE
  else if (alreadyConnected(address.value)) errors.emailAddress = ALREADY_CONNECTED
  const parsed = manualSchema(domain.value).safeParse({ imap: imap.value, smtp: smtp.value, username: username.value, password: password.value })
  if (!parsed.success) Object.assign(errors, fieldErrors(parsed.error))
  manualErrors.value = errors
  if (!parsed.success || Object.keys(errors).length > 0 || address.value === null) return
  void checkAndCreate({ emailAddress: address.value, ...parsed.data }, 'manual')
}

// ---- Checking, then creating --------------------------------------------------------------------------------------

const checkStage = ref(0)
const checkingHost = ref('')
const checkLabels = computed(() => [`Signing in to ${checkingHost.value}`, 'Checking that Tresso can send mail', 'Finding your folders'])

/** Checks the settings; only when Tresso can sign in and send is the account created. */
async function checkAndCreate(input: CheckMailAccount, from: FormStep): Promise<void> {
  const { id, signal } = startRun()
  checkingHost.value = input.imap.host
  checkStage.value = 0
  go('checking')
  later(CHECK_ROW_MS, () => (checkStage.value = Math.max(checkStage.value, 1)))
  later(CHECK_ROW_MS * 2, () => (checkStage.value = Math.max(checkStage.value, 2)))

  const returnTo = (): void => {
    if (step.value === 'checking') {
      history.value.pop()
      step.value = from
    }
  }

  let result: MailAccountCheck
  const started = Date.now()
  for (;;) {
    try {
      result = await accounts.check(input, signal)
      break
    } catch (e) {
      if (id !== run) return
      // 409: a check this user gave up (Cancel, then Connect again) still runs on the server until its deadline, at
      // most 25 seconds. Waited for quietly; this one then runs.
      if (e instanceof ApiError && e.status === 409 && Date.now() - started < BUSY_RETRY_MS) {
        await pause(BUSY_RETRY_STEP_MS)
        if (id !== run) return
        continue
      }
      returnTo()
      failedRequest(e, from)
      return
    }
  }
  if (id !== run) return
  if (result.imap !== 'ok' || result.smtp !== 'ok') {
    returnTo()
    check.value = result
    if (from === 'app-password') {
      if (result.imap === 'auth_failed' || result.smtp === 'auth_failed') appPasswordError.value = 'refused'
      else formError.value = checkFailure(result)
    }
    return
  }

  checkStage.value = 3
  busy.value = true
  let created: MailAccount
  try {
    created = await accounts.create({ ...input, displayName: startingName() })
  } catch (e) {
    if (id !== run) return
    returnTo()
    failedRequest(e, from)
    return
  } finally {
    busy.value = false
  }
  if (id !== run) {
    // Cancelled (or closed) while the account was being created: it goes again, so cancelling leaves nothing.
    await removeCancelled(created)
    return
  }
  await showConnected(created, { existing: false, refused: false })
}

async function removeCancelled(account: MailAccount): Promise<void> {
  try {
    await accounts.remove(account.id)
  } catch (e) {
    formError.value = `The account was created before the cancel arrived and could not be removed: ${errorMessage(e)} Remove it under Settings, Accounts.`
  }
}

/** A failed check on the app password step: the provider's servers rarely fail, so one sentence and the detail. */
function checkFailure(result: MailAccountCheck): string {
  const side = result.imap !== 'ok' ? 'incoming' : 'outgoing'
  return `Tresso could not reach ${description.value.company}'s ${side} mail server. Try again in a moment.${result.detail ? ` (${result.detail})` : ''}`
}

function failedRequest(e: unknown, from: FormStep): void {
  if (e instanceof ApiError && Object.keys(e.violations).length > 0) {
    if (e.violations.emailAddress) {
      if (from === 'manual' && address.value === null) {
        manualErrors.value = { ...manualErrors.value, emailAddress: e.violations.emailAddress }
      } else {
        emailError.value = e.violations.emailAddress
        if (from === 'manual') manualErrors.value = { ...manualErrors.value, emailAddress: e.violations.emailAddress }
      }
    }
    if (from === 'manual') manualErrors.value = { ...manualErrors.value, ...e.violations }
    else formError.value = errorMessage(e)
    return
  }
  formError.value = errorMessage(e)
}

/** The name on sent mail to start from: the user's own name, else the address before the @. */
function startingName(): string {
  const name = auth.me?.displayName?.trim() ?? ''
  return (name !== '' ? name : (address.value?.split('@')[0] ?? 'Me')).slice(0, 120)
}

// ---- Connected ----------------------------------------------------------------------------------------------------

const connected = ref<MailAccount | null>(null)
const existing = ref(false)
const calendarsRefused = ref(false)
const firstAccount = ref(false)
const displayName = ref('')
const nameError = ref<string | null>(null)
const successError = ref<string | null>(null)
/** The desktop app opened the provider's page to allow calendars; the accounts page shows how it went. */
const calendarsInBrowser = ref(false)

async function showConnected(account: MailAccount, outcome: { existing: boolean; refused: boolean }): Promise<void> {
  stopRun()
  connected.value = account
  existing.value = outcome.existing
  calendarsRefused.value = outcome.refused
  displayName.value = account.displayName
  nameError.value = null
  successError.value = null
  calendarsInBrowser.value = false
  email.value = account.emailAddress
  password.value = ''
  appPassword.value = ''
  if (!accounts.loaded) {
    try {
      await accounts.load()
    } catch {
      // Only decides where Done leads; without the list it stays here.
    }
  }
  firstAccount.value = accounts.loaded && accounts.accounts.every((other) => other.id === account.id)
  history.value = []
  step.value = 'success'
}

/** The synced copy has the worker's progress in real time; the API's answer only until it arrives there. */
const live = computed(() => {
  const account = connected.value
  if (account === null) return null
  return mail.accounts.find((synced) => synced.id === account.id) ?? account
})
const calendarCount = computed(() => mail.calendars.filter((calendar) => calendar.mailAccountId === connected.value?.id).length)
const connectedProviderName = computed(() => {
  const kind: MailServiceProvider | null = connected.value === null ? null : (accountServiceProvider(connected.value) ?? (choice.value === 'icloud' || choice.value === 'yahoo' ? choice.value : null))
  return kind === null ? 'IMAP' : providerLabel(kind)
})

async function saveName(): Promise<boolean> {
  const account = connected.value
  if (account === null) return true
  const parsed = displayNameSchema.safeParse(displayName.value)
  if (!parsed.success) {
    nameError.value = parsed.error.issues[0]?.message ?? 'Enter the name people see.'
    return false
  }
  nameError.value = null
  if (parsed.data === account.displayName) return true
  try {
    connected.value = await accounts.update(account.id, { displayName: parsed.data })
    return true
  } catch (e) {
    nameError.value = e instanceof ApiError && e.violations.displayName ? e.violations.displayName : errorMessage(e)
    return false
  }
}

async function allowCalendars(): Promise<void> {
  const account = connected.value
  const provider = account === null ? null : accountServiceProvider(account)
  const oauth = provider === null ? null : oauthProviderFor(provider)
  if (account === null || oauth === null) return
  busy.value = true
  successError.value = null
  try {
    if ((await accounts.openProviderSignIn(oauth, account.id, ['calendar'])) === 'browser') {
      successError.value = null
      calendarsInBrowser.value = true
    }
  } catch (e) {
    successError.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function done(): Promise<void> {
  busy.value = true
  const saved = await saveName()
  busy.value = false
  if (!saved) return
  emit('close', firstAccount.value && connected.value !== null ? connected.value.id : null)
}

// ---- The dialog -------------------------------------------------------------------------------------------------

const width = computed(() => (step.value === 'manual' ? 640 : step.value === 'picker' ? 660 : 520))
const canGoBack = computed(() => step.value !== 'email' && step.value !== 'success')

// The provider's page is prepared as soon as the explanation shows, so "Proceed in browser" opens it at once (a
// browser lets a page open a tab only right after a click).
watch([step, features, address], () => {
  if (step.value === 'oauth' && oauthProvider.value !== null) void prepareSignIn().catch(() => (pending = null))
})

onMounted(async () => {
  dialog.value?.showModal?.()
  stopListening = listenForSignIns((state, outcome) => {
    if (state !== awaitedState.value) return false
    takeOutcome(outcome)
    return true
  })
  window.addEventListener('focus', readNotedOutcome)
  // A failed load leaves the list empty: the provider list then says signing in at Google or Microsoft is unavailable.
  providersLoaded = accounts.loadProviders().catch(() => undefined)
  await finishFromRoute()
  await providersLoaded
  try {
    await accounts.loadServerRules()
  } catch {
    // Without it "None" is not offered as connection security, which only local test servers need.
  }
})

onBeforeUnmount(() => {
  stopRun()
  stopWaitTimer()
  stopListening()
  window.removeEventListener('focus', readNotedOutcome)
})
</script>

<template>
  <dialog ref="dialog" class="connect-dialog" aria-labelledby="connect-title" :style="{ maxWidth: `${width}px` }" @cancel.prevent="close">
    <div class="cf-head">
      <button v-if="canGoBack" type="button" class="cf-icon" aria-label="Back" @click="step === 'oauth-waiting' ? cancelWaiting() : back()"><AppIcon name="back" :size="18" /></button>
      <span class="cf-eyebrow">{{ EYEBROWS[step] }}</span>
      <button type="button" class="cf-icon" aria-label="Close" @click="close"><AppIcon name="close" :size="18" /></button>
    </div>

    <form v-if="step === 'email'" class="cf-form" novalidate @submit.prevent="submitEmail">
      <div class="cf-heading">
        <h1 id="connect-title">Connect a mail account</h1>
        <p class="cf-lead">Enter your email address. We find out who handles your mail and show you the easiest way to connect it.</p>
      </div>
      <p v-if="notice" class="cf-done" role="status">{{ notice }}</p>
      <label class="cf-field">
        <span class="cf-label">Email address</span>
        <input v-model="email" type="email" autocomplete="email" placeholder="you@example.com" maxlength="320" autofocus :aria-invalid="emailError ? 'true' : undefined" />
        <span v-if="emailError" class="cf-error" role="alert"
          ><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg
          >{{ emailError }}</span
        >
      </label>
      <p class="cf-note">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
        <span>Your mail stays with your provider. Passwords and sign-in tokens are encrypted, and you can disconnect at any time.</span>
      </p>
      <div class="cf-footer">
        <button type="button" class="button button-quiet" @click="toPicker">Choose my provider myself</button>
        <button type="submit" class="button button-primary">Continue</button>
      </div>
    </form>

    <template v-else-if="step === 'detecting'">
      <div class="cf-heading">
        <h1 id="connect-title">Finding your provider</h1>
        <p class="cf-lead">One moment. We are checking who handles mail for <strong>{{ address }}</strong>.</p>
      </div>
      <ConnectChecks :labels="detectLabels" :stage="detectStage" />
      <div class="cf-footer">
        <button type="button" class="button button-quiet" @click="toPicker">Choose my provider myself</button>
        <button type="button" class="button cf-secondary" @click="back">Cancel</button>
      </div>
    </template>

    <template v-else-if="step === 'oauth'">
      <div class="cf-marks">
        <span class="cf-tresso"><TressoMark :size="24" /></span>
        <svg width="28" height="12" viewBox="0 0 28 12" aria-hidden="true"><path d="M2 6h24" class="cf-dashes" stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round" /></svg>
        <ProviderMark :provider="choice ?? 'manual'" :size="52" />
      </div>
      <div class="cf-heading">
        <h1 id="connect-title">Open your browser to link your {{ description.name }} account</h1>
        <p class="cf-lead">You sign in on {{ description.company }}'s own page and allow Tresso to read and send your mail. Tresso never sees your password.</p>
      </div>
      <div class="cf-chips">
        <span v-if="address" class="cf-chip"
          ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg
          >{{ address }} uses {{ description.name }}</span
        >
        <button type="button" class="cf-link" @click="toPicker">Not right? Choose another provider</button>
      </div>
      <div v-if="calendarsOffered" class="cf-switch-row">
        <span class="cf-switch-text">
          <span class="cf-switch-title">Also sync my calendars</span>
          <span class="cf-switch-help">{{ description.company }} asks you for access to your calendars on the same page. You can turn this on or off later in Settings.</span>
        </span>
        <button type="button" role="switch" class="cf-switch" :aria-checked="calendars ? 'true' : 'false'" aria-label="Also sync my calendars" @click="calendars = !calendars"><span /></button>
      </div>
      <p v-if="oauthError" class="cf-error" role="alert">{{ oauthError }}</p>
      <p v-if="oauthError && requested.includes('calendar')" class="cf-note">
        <span>Did your organization refuse access to your calendars? Then connect your mail only; calendars can follow later.</span>
        <button type="button" class="button cf-small" :disabled="busy" @click="mailOnly">Connect mail only</button>
      </p>
      <div class="cf-footer">
        <button type="button" class="button button-quiet" @click="back">Back</button>
        <button type="button" class="button button-primary" :disabled="busy" @click="openSignIn()">
          Proceed in browser
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
          </svg>
        </button>
      </div>
    </template>

    <template v-else-if="step === 'oauth-waiting'">
      <div class="cf-center">
        <span class="cf-waiting">
          <svg class="cf-spin" width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden="true">
            <circle cx="36" cy="36" r="33" class="cf-track" stroke-width="4" />
            <path d="M69 36A33 33 0 0036 3" class="cf-arc" stroke-width="4" stroke-linecap="round" />
          </svg>
          <ProviderMark :provider="choice ?? 'manual'" :size="48" />
        </span>
        <div class="cf-heading narrow">
          <h1 id="connect-title">Finish in your browser</h1>
          <p class="cf-lead">We opened {{ description.company }}'s sign-in page in your browser. Sign in there and allow access. This window updates by itself when you are done.</p>
        </div>
        <span class="cf-pulse" role="status">Waiting for {{ description.company }}...</span>
      </div>
      <p class="cf-note">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.01" /></svg>
        <span>Don't see the page? It may have opened behind this window, or your browser blocked it.</span>
      </p>
      <p v-if="oauthError" class="cf-error" role="alert">{{ oauthError }}</p>
      <div class="cf-footer">
        <button type="button" class="button button-quiet" @click="cancelWaiting">Cancel</button>
        <button type="button" class="button cf-secondary" :disabled="busy" @click="openSignIn()">Open the page again</button>
      </div>
    </template>

    <template v-else-if="step === 'oauth-stalled'">
      <div class="cf-center">
        <span class="cf-badge neutral" aria-hidden="true"
          ><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg
        ></span>
        <div class="cf-heading narrow">
          <h1 id="connect-title">
            {{ stalled === 'signed-out' ? 'Sign-in came back signed out' : stalled === 'given-up' ? 'This sign-in was given up' : 'No answer from ' + description.company }}
          </h1>
          <p class="cf-lead">
            <template v-if="stalled === 'given-up'"
              >Tresso already stopped waiting for this sign-in, so nothing was connected. Start again from the dialog: choose Try again.</template
            >
            <template v-else-if="stalled === 'signed-out'"
              >{{ description.company }}'s page came back in a tab that is not signed in to Tresso, so nothing was connected. Sign in to Tresso in that browser too, then try
              again.</template
            >
            <template v-else
              >We did not hear back from {{ description.company }}'s page, and the sign-in has expired. Nothing was connected. If you finished signing in, the page may have opened in
              a browser where you are not signed in to Tresso.</template
            >
          </p>
        </div>
      </div>
      <p v-if="oauthError" class="cf-error" role="alert">{{ oauthError }}</p>
      <div class="cf-footer">
        <button type="button" class="button button-quiet" @click="toPicker">Choose another provider</button>
        <button type="button" class="button button-primary" :disabled="busy" @click="openSignIn(true)">Try again</button>
      </div>
    </template>

    <template v-else-if="step === 'oauth-cancelled'">
      <div class="cf-center">
        <span class="cf-badge neutral" aria-hidden="true"
          ><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 010 11H11" /></svg
        ></span>
        <div class="cf-heading narrow">
          <h1 id="connect-title">Sign-in was cancelled</h1>
          <p class="cf-lead">You closed the {{ description.company }} page or chose not to give access. Nothing was connected. You can try again whenever you like.</p>
        </div>
      </div>
      <p v-if="requested.includes('calendar')" class="cf-note">
        <span>Did your organization refuse access to your calendars? Then connect your mail only; calendars can follow later.</span>
        <button type="button" class="button cf-small" :disabled="busy" @click="mailOnly">Connect mail only</button>
      </p>
      <p v-if="oauthError" class="cf-error" role="alert">{{ oauthError }}</p>
      <div class="cf-footer">
        <button type="button" class="button button-quiet" @click="toPicker">Choose another provider</button>
        <button type="button" class="button button-primary" :disabled="busy" @click="openSignIn(true)">Try again</button>
      </div>
    </template>

    <template v-else-if="step === 'oauth-error'">
      <div class="cf-center">
        <span class="cf-badge danger" aria-hidden="true"
          ><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg
        ></span>
        <div class="cf-heading narrow">
          <h1 id="connect-title">Your organization has to approve Tresso first</h1>
          <p class="cf-lead">
            {{ address ?? 'This' }} is a work account. Your organization only lets you use apps that your IT team has approved. Send them the link below. Once they approve Tresso, try
            again.
          </p>
        </div>
      </div>
      <div v-if="approvalUrl" class="cf-linkbox">
        <span class="cf-url">{{ approvalUrl }}</span>
        <button type="button" class="button cf-small" @click="copyApprovalUrl">{{ copied ? 'Copied' : 'Copy link' }}</button>
      </div>
      <p v-if="requested.includes('calendar')" class="cf-note">
        <span>Did your organization refuse access to your calendars? Then connect your mail only; calendars can follow later.</span>
        <button type="button" class="button cf-small" :disabled="busy" @click="mailOnly">Connect mail only</button>
      </p>
      <p v-if="oauthError" class="cf-error" role="alert">{{ oauthError }}</p>
      <div class="cf-footer">
        <button type="button" class="button button-quiet" @click="toPicker">Choose another provider</button>
        <button type="button" class="button button-primary" :disabled="busy" @click="openSignIn(true)">Try again</button>
      </div>
    </template>

    <ConnectAppPassword
      v-else-if="step === 'app-password' && appPasswordProvider"
      v-model:password="appPassword"
      v-model:email="email"
      :provider="appPasswordProvider"
      :address="address"
      :ask-address="!addressGiven"
      :password-error="appPasswordError"
      :email-error="emailError"
      :form-error="formError"
      :busy="busy"
      @open="openSite"
      @back="back"
      @connect="connectAppPassword"
    />

    <ConnectPicker v-else-if="step === 'picker'" :address="address" :sign-in-providers="signInProviders" @pick="pick" @other-address="startOver" />

    <ConnectManual
      v-else-if="step === 'manual'"
      v-model:imap="imap"
      v-model:smtp="smtp"
      v-model:username="username"
      v-model:password="password"
      v-model:email="email"
      :address="address"
      :ask-address="!addressGiven"
      :lead="manualLead"
      :note="manualNote"
      :errors="manualErrors"
      :check="check"
      :form-error="formError"
      :allow-unencrypted="accounts.allowUnencrypted"
      :busy="busy"
      @back="back"
      @connect="connectManual"
    />

    <template v-else-if="step === 'checking'">
      <div class="cf-heading">
        <h1 id="connect-title">Connecting {{ address }}</h1>
        <p class="cf-lead">We are checking that Tresso can sign in, read your mail and send mail for you.</p>
      </div>
      <ConnectChecks :labels="checkLabels" :stage="checkStage" />
      <div class="cf-footer">
        <button type="button" class="button cf-secondary" @click="back">Cancel</button>
      </div>
    </template>

    <ConnectSuccess
      v-else-if="step === 'success' && connected && live"
      v-model:name="displayName"
      :address="connected.emailAddress"
      :provider-name="connectedProviderName"
      :existing="existing"
      :status="live.status"
      :status-detail="live.statusDetail"
      :last-synced-at="live.lastSyncedAt"
      :calendar-status="live.calendarStatus"
      :calendar-status-detail="live.calendarStatusDetail"
      :calendar-count="calendarCount"
      :can-allow-calendars="accountServiceProvider(connected) !== null"
      :calendars-requested="requested.includes('calendar')"
      :calendars-refused="calendarsRefused"
      :name-error="nameError"
      :error="successError"
      :calendars-in-browser="calendarsInBrowser"
      :busy="busy"
      @save-name="saveName"
      @allow-calendars="allowCalendars"
      @add-another="startOver"
      @done="done"
    />
  </dialog>
</template>

<style>
/* The connect dialog's own look (the Connect mail boards): pill controls and larger type than the settings forms. */
.connect-dialog {
  width: calc(100vw - 32px);
  max-height: calc(100vh - 48px);
  padding: 24px 28px 28px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--paper);
  color: var(--ink);
  box-shadow: var(--raised);
  animation: pop-in var(--motion-base) var(--ease-out);
}
.connect-dialog[open] {
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.connect-dialog .cf-form {
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.connect-dialog .cf-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 36px;
}
.connect-dialog .cf-eyebrow {
  flex: 1;
  color: var(--ink-2);
  font-size: 13px;
  font-weight: 600;
}
.connect-dialog .cf-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--paper);
  color: var(--ink-2);
  cursor: pointer;
}
.connect-dialog .cf-heading {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.connect-dialog .cf-heading.narrow {
  max-width: 420px;
}
.connect-dialog h1 {
  margin: 0;
  font: 700 26px/32px var(--font-display);
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.connect-dialog .cf-lead {
  margin: 0;
  color: var(--ink-2);
  font-size: 15px;
  line-height: 22px;
  overflow-wrap: anywhere;
}
.connect-dialog .cf-lead strong {
  color: var(--ink);
}
.connect-dialog .cf-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.connect-dialog .cf-label {
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
}
.connect-dialog .cf-field input,
.connect-dialog .field input,
.connect-dialog .field select {
  box-sizing: border-box;
  width: 100%;
  height: 46px;
  padding: 0 18px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--paper);
  color: var(--ink);
  font: 400 15px var(--font-ui);
}
.connect-dialog .field input.mono {
  font-size: 14px;
}
.connect-dialog .cf-field input:focus-visible,
.connect-dialog .field input:focus-visible,
.connect-dialog .field select:focus-visible {
  outline: none;
  border: 1.5px solid var(--focus);
  box-shadow: 0 0 0 3px var(--do-soft);
}
.connect-dialog .cf-field input[aria-invalid='true'],
.connect-dialog .field input[aria-invalid='true'] {
  border: 1.5px solid var(--danger);
  box-shadow: 0 0 0 3px var(--danger-soft);
}
.connect-dialog .cf-error {
  display: flex;
  gap: 6px;
  margin: 0;
  color: var(--danger);
  font-size: 13px;
  line-height: 19px;
}
.connect-dialog .cf-error svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.connect-dialog .cf-hint {
  margin: 0;
  color: var(--ink-2);
  font-size: 13px;
  line-height: 19px;
}
.connect-dialog .cf-done {
  margin: 0;
  color: var(--know);
  font-weight: 600;
}
.connect-dialog .cf-note {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
  padding: 12px 16px;
  border-radius: 16px;
  background: var(--ground);
  color: var(--ink);
  font-size: 13px;
  line-height: 19px;
}
.connect-dialog .cf-note svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--ink-2);
}
.connect-dialog .cf-note span {
  flex: 1;
  min-width: 200px;
}
.connect-dialog .cf-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
}
.connect-dialog .button {
  height: 46px;
  padding: 0 20px;
  border-radius: 999px;
  font-size: 15px;
}
.connect-dialog .button-primary {
  padding: 0 24px;
}
.connect-dialog .button.cf-secondary {
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
}
.connect-dialog .button.cf-secondary:hover:not(:disabled) {
  background: var(--ground);
}
.connect-dialog .button.cf-small {
  flex-shrink: 0;
  height: 34px;
  padding: 0 14px;
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
  font-size: 13px;
}
.connect-dialog .cf-link {
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--focus);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.connect-dialog .cf-marks {
  display: flex;
  align-items: center;
  gap: 14px;
}
.connect-dialog .cf-tresso {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 999px;
  background: var(--ink);
}
.connect-dialog .cf-dashes {
  stroke: var(--line-strong);
}
.connect-dialog .cf-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.connect-dialog .cf-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--know-soft);
  color: var(--know);
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.connect-dialog .cf-switch-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 16px;
}
.connect-dialog .cf-switch-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
}
.connect-dialog .cf-switch-title {
  font-size: 15px;
  font-weight: 600;
}
.connect-dialog .cf-switch-help {
  color: var(--ink-2);
  font-size: 13px;
  line-height: 19px;
}
.connect-dialog .cf-switch {
  display: flex;
  flex-shrink: 0;
  justify-content: flex-start;
  width: 44px;
  height: 26px;
  padding: 3px;
  border: 0;
  border-radius: 999px;
  background: var(--line-strong);
  cursor: pointer;
  transition: background-color var(--motion-fast) ease;
}
.connect-dialog .cf-switch[aria-checked='true'] {
  justify-content: flex-end;
  background: var(--ink);
}
.connect-dialog .cf-switch span {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--paper);
  box-shadow: 0 1px 2px rgb(22 24 29 / 20%);
}
.connect-dialog .cf-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 12px 0 4px;
  text-align: center;
}
.connect-dialog .cf-waiting {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
}
.connect-dialog .cf-waiting .cf-spin {
  position: absolute;
  inset: 0;
}
.connect-dialog .cf-track {
  stroke: var(--line-strong);
}
.connect-dialog .cf-arc {
  stroke: var(--focus);
}
.connect-dialog .cf-spin {
  animation: connect-spin 0.9s linear infinite;
}
.connect-dialog .cf-pulse {
  color: var(--ink-2);
  font-size: 13px;
  animation: connect-pulse 1.6s ease-in-out infinite;
}
.connect-dialog .cf-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 999px;
}
.connect-dialog .cf-badge.neutral {
  background: var(--ground);
  color: var(--ink-2);
}
.connect-dialog .cf-badge.danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.connect-dialog .cf-linkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 18px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
}
.connect-dialog .cf-url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font: 400 13px var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes connect-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes connect-pulse {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .connect-dialog .cf-spin,
  .connect-dialog .cf-pulse {
    animation: none;
  }
}
@media (max-width: 600px) {
  .connect-dialog {
    padding: 20px 16px 20px;
  }
}
</style>
