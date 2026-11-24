import { connectErrorMessage, type ImportFailure, type ImportGroup, type LeftOutAddress, type OAuthProviderId, type PastedAddresses, type PastedIssue } from '@tresso/core'

/**
 * The words of the "Add several accounts" pages, as the boards AddAccountsPaste, AddAccountsList and AddAccountsStates
 * have them. States without a board (a provider failure other than a refusal or an organization's approval) say what
 * the single connect flow says ({@link connectErrorMessage}).
 */

export const LIMIT = 50

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "Tuesday 21 October at 10:12", in the time zone of the device (or the one given). */
export function listTime(iso: string, timeZone?: string): string {
  const date = new Date(iso)
  const zone = timeZone === undefined ? {} : { timeZone }
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', ...zone }).format(date)
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...zone }).format(date)
  return `${day} at ${time}`
}

export function domainOf(address: string): string {
  return address.split('@')[1] ?? address
}

// ---- Step 1, paste ----------------------------------------------------------------------------------------------------

export const PASTE = {
  title: 'Add several accounts',
  lead: 'Step 1 of 2. Paste the addresses of the mail accounts you want to add. In the next step you sign in to each one.',
  back: 'Back to accounts',
  label: 'Email addresses',
  hint: 'One on each line, or separated by commas. Up to 50 at a time.',
  nothingConnected: 'Nothing is connected in this step. Next you sign in to each account yourself, in your browser or with its password.',
  cancel: 'Cancel',
  continue: 'Continue',
} as const

export function countLine(read: PastedAddresses): string {
  if (read.total === 0) return 'No addresses yet.'
  const parts = [`${read.toAdd.length} to add`]
  if (read.already > 0) parts.push(`${read.already} already connected`)
  if (read.invalid > 0) parts.push(`${read.invalid} not valid`)
  if (read.twice > 0) parts.push(`${read.twice} listed twice`)
  return `${plural(read.total, 'address', 'addresses')}: ${parts.join(', ')}.`
}

export function limitLabel(read: PastedAddresses): string {
  return `${read.toAdd.length} of ${LIMIT}`
}

export function overLine(read: PastedAddresses): string {
  return `That is ${read.toAdd.length - LIMIT} more than ${LIMIT}. Remove some addresses, or add the rest in a second list.`
}

export function checkTitle(read: PastedAddresses, issues = read.issues.length): string {
  return issues > 0 ? 'Check these first' : 'Nothing to check'
}

export function checkLead(read: PastedAddresses, issues = read.issues.length): string {
  if (issues > 0) return `${plural(issues, 'address needs', 'addresses need')} a look. The others are ready.`
  return read.total === 0 ? 'Addresses that need a look show up here.' : 'Every address looks right.'
}

/** An address the API left out of the list it made, as "Check these first" names it. */
export function leftOutPill(left: LeftOutAddress): string {
  return left.reason === 'invalid' ? 'Not valid' : left.reason === 'duplicate' ? 'Listed twice' : 'Already connected'
}

export function leftOutText(left: LeftOutAddress): string {
  return `${left.message} It is left out.`
}

export function issuePill(issue: PastedIssue): string {
  return issue.kind === 'invalid' ? 'Not valid' : issue.kind === 'twice' ? 'Listed twice' : 'Already connected'
}

export function issueText(issue: PastedIssue): string {
  const where = `Line ${issue.line}. `
  switch (issue.kind) {
    case 'invalid':
      return `${where}${issue.noAt ? 'There is no @ in this address.' : 'The part after the @ is not complete.'} It is left out unless you fix it.`
    case 'twice':
      return `${where}Also on line ${issue.firstLine}. It is added once.`
    case 'connected':
      return `${where}This account is already in Tresso. It is left out.`
  }
}

/** With `leftOut` addresses the API left out of the list it made, the list holds that many fewer. */
export function continueLabel(read: PastedAddresses, leftOut = 0): string {
  return `Continue with ${plural(read.toAdd.length - leftOut, 'address', 'addresses')}`
}

// ---- Step 2, the list ------------------------------------------------------------------------------------------------

export const LIST = {
  title: 'Add several accounts',
  lead: 'Step 2 of 2. Sign in to each account. Microsoft and Google open in your browser. Other mail asks for its password here.',
  back: 'Back to the addresses',
  stop: 'Stop',
  all: 'Sign in to all, one after another',
  idleLine: 'Nothing starts by itself. Sign in to all in one go, or do them one at a time with Next.',
  finish: 'Finish without the rest',
  deleteList: 'Delete this list',
  continueNext: 'Continue with the next',
  tryAgain: 'Try this one again',
  copyApproval: 'Copy approval link',
  progressLabel: 'Accounts connected',
  checkAndAdd: 'Check and add',
  username: 'Username',
  changeSettings: 'Change settings',
  passwordNote: 'Your password manager can fill this in. The password is stored encrypted and is only used to read and send mail for this address.',
  looking: ['Checking which service handles each address', 'Choosing the easiest way to connect'],
} as const

export function nextLabel(address: string): string {
  return `Next: ${address}`
}

export function summaryTitle(connected: number, total: number): string {
  return `${connected} of ${total} connected`
}

export function summaryLine(failed: number, todo: number): string {
  const parts: string[] = []
  if (failed > 0) parts.push(`${failed} ${failed === 1 ? 'needs' : 'need'} another try.`)
  if (todo > 0) parts.push(`${todo} to go.`)
  return parts.join(' ')
}

export function runLine(mode: 'all' | 'one', now: string, after: string | null): string {
  if (mode === 'one') return `Signing in to ${now}. Nothing else starts after it.`
  return after === null ? `Signing in one after another. Now: ${now}.` : `Signing in one after another. Now: ${now}. Next: ${after}. After each sign-in the next one starts by itself.`
}

/** The app's own name, cut at 60 characters: the user reads it as text, whatever the app called itself. */
export function appName(app: string): string {
  const characters = [...app.trim()]
  return characters.length > 60 ? `${characters.slice(0, 60).join('')}\u2026` : characters.join('')
}

export function assistantNotice(app: string): string {
  return `This list was made by ${appName(app)}. Check the addresses before you sign in.`
}

export const USE_ADDRESSES = 'Use these addresses'

/** A sign-in that came back in a tab signed out of Tresso, which cannot finish it. */
export const SIGNED_OUT = 'The sign-in came back in a tab that is signed out of Tresso. Sign in to Tresso there, then try again.'
/** The API answered a sign-in page without its state. */
export const NO_STATE = 'The sign-in page could not be opened. Try again.'
/** The browser did not open the provider's page (a blocked pop-up, a run without a tab to go on in). */
export const BLOCKED_HINT = 'Your browser blocked the sign-in page. Choose Open the page again.'

export function keptLine(expiresAt: string): string {
  return `This list is kept for 24 hours, until ${listTime(expiresAt)}. You can leave and continue later: choose Add several accounts in Settings, Accounts.`
}

export const GROUPS: Record<ImportGroup, { title: string; how: string; mark: 'm365' | 'google' | 'manual' }> = {
  microsoft: { title: 'Microsoft 365', how: 'You sign in at Microsoft, in your browser', mark: 'm365' },
  google: { title: 'Google', how: 'You sign in at Google, in your browser', mark: 'google' },
  password: { title: 'Other mail with a password', how: 'You enter the password of each address, here in Tresso', mark: 'manual' },
}

export function groupCount(done: number, total: number): string {
  return `${done} of ${total} connected`
}

/** Under servers typed by hand: where the password goes, named before it is typed. */
export function passwordGoesTo(imap: string, smtp: string): string {
  return imap === smtp ? `The password is sent to ${imap} only.` : `The password is sent to ${imap} and ${smtp} only.`
}

export function passwordLabel(address: string): string {
  return `Password for ${address}`
}

// ---- Row states --------------------------------------------------------------------------------------------------------

/** The states of a row, as the states board draws them; `failed` is a provider failure without a board of its own. */
export type RowState = 'todo' | 'signing-in' | 'waiting' | 'connected' | 'cancelled' | 'approve' | 'wrong' | 'refused' | 'unreachable' | 'already' | 'skipped' | 'failed' | 'failed-final'

export type RowIcon = 'dot' | 'spin' | 'check' | 'undo' | 'alert' | 'dash'

export const ROW_STATES: Record<RowState, { label: string; icon: RowIcon; tone: 'muted' | 'ink' | 'know' | 'danger' }> = {
  todo: { label: 'To do', icon: 'dot', tone: 'muted' },
  'signing-in': { label: 'Signing in', icon: 'spin', tone: 'ink' },
  waiting: { label: 'Waiting for the browser', icon: 'spin', tone: 'ink' },
  connected: { label: 'Connected', icon: 'check', tone: 'know' },
  cancelled: { label: 'Sign-in cancelled', icon: 'undo', tone: 'muted' },
  approve: { label: 'Organization must approve', icon: 'alert', tone: 'danger' },
  wrong: { label: 'Signed in with another account', icon: 'alert', tone: 'danger' },
  refused: { label: 'Password refused', icon: 'alert', tone: 'danger' },
  unreachable: { label: 'Server not reached', icon: 'alert', tone: 'danger' },
  already: { label: 'Already connected', icon: 'check', tone: 'muted' },
  skipped: { label: 'Skipped', icon: 'dash', tone: 'muted' },
  failed: { label: 'Sign-in failed', icon: 'alert', tone: 'danger' },
  'failed-final': { label: 'Sign-in failed', icon: 'alert', tone: 'danger' },
}

/** The row state of a failure code. */
export function failureState(failure: ImportFailure | null): RowState {
  switch (failure) {
    case 'denied':
      return 'cancelled'
    case 'admin_approval_required':
      return 'approve'
    case 'wrong_account':
      return 'wrong'
    case 'already_connected':
      return 'already'
    case 'unverified_address':
    case 'no_mailbox':
      // Trying again changes nothing: the provider account itself is the problem.
      return 'failed-final'
    case 'password_refused':
      return 'refused'
    case 'server_unreachable':
      return 'unreachable'
    default:
      return 'failed'
  }
}

export const ROW_ACTIONS = {
  signIn: 'Sign in',
  enterPassword: 'Enter password',
  close: 'Close',
  cancel: 'Cancel',
  openAgain: 'Open the page again',
  tryAgain: 'Try again',
  checkSettings: 'Check settings',
  addBack: 'Add back',
} as const

export function waitingHint(provider: OAuthProviderId): string {
  return `Sign in at ${provider === 'google' ? 'Google' : 'Microsoft'} and allow access. This row updates by itself.`
}

export const CANCELLED_HINT = 'You closed the page or did not give access. Nothing was connected.'
export const ALREADY_HINT = 'This account is already in Tresso.'

export function approveHint(address: string, approvalUrl: string | null): string {
  const first = `The IT team of ${domainOf(address)} has to approve Tresso first.`
  return approvalUrl === null ? first : `${first} Send them ${approvalUrl}`
}

export function refusedHint(address: string): string {
  return `${domainOf(address)} did not accept this password. Check that all of it was filled in.`
}

export function unreachableHint(server: { host: string; port: number }): string {
  return `${server.host} did not answer on port ${server.port}.`
}

/** How a server check failed: as the single connect flow's server form says it. */
export type CheckProblem = 'unreachable' | 'certificate' | 'blocked' | 'failed'

export function checkHint(problem: CheckProblem, server: { host: string; port: number }): string {
  switch (problem) {
    case 'certificate':
      return `The security certificate of ${server.host} could not be verified.`
    case 'blocked':
      return `Tresso may not connect to ${server.host}.`
    case 'failed':
      return `${server.host} did not answer like a mail server.`
    default:
      return unreachableHint(server)
  }
}

/** A provider failure without a board of its own: what the single connect flow says. */
export function failedHint(failure: ImportFailure | null, provider: OAuthProviderId): string {
  return connectErrorMessage(failure ?? 'failed', provider)
}

// ---- The run stopped ---------------------------------------------------------------------------------------------------

export function stoppedTitle(address: string): string {
  return `Stopped at ${address}`
}

/** The first sentence of the stop notice: why the row did not connect, in the row's own words. */
export function stoppedReason(input: { state: RowState; address: string; provider: OAuthProviderId | null; failure: ImportFailure | null; check: { problem: CheckProblem; host: string } | null; error: string | null }): string {
  if (input.error !== null && input.error !== '') return input.error
  switch (input.state) {
    case 'cancelled':
      return 'Sign-in was cancelled. Nothing was connected for this address.'
    case 'approve':
      return `The IT team of ${domainOf(input.address)} has to approve Tresso first. Other addresses of ${domainOf(input.address)} will stop here too.`
    case 'refused':
      return `${domainOf(input.address)} did not accept the password for this address.`
    case 'unreachable': {
      const host = input.check?.host ?? domainOf(input.address)
      switch (input.check?.problem) {
        case 'certificate':
          return `The security certificate of ${host} could not be verified. Nothing was connected for this address.`
        case 'blocked':
          return `Tresso may not connect to ${host}. Nothing was connected for this address.`
        case 'failed':
          return `${host} did not answer like a mail server. Nothing was connected for this address.`
        default:
          return `${host} did not answer. Nothing was connected for this address.`
      }
    }
    default:
      return input.provider === null ? NOTHING_CONNECTED : failedHint(input.failure, input.provider)
  }
}

/** A row without a provider whose reason is not known here. */
export const NOTHING_CONNECTED = 'Nothing was connected for this address.'

export function soFar(connected: number, total: number): string {
  return `${connected} of ${total} are connected so far.`
}

// ---- Endings -----------------------------------------------------------------------------------------------------------

/**
 * The title of the ending: how many accounts this list added (an account added another way is not counted). With
 * nothing skipped and nothing there already, "All N accounts added".
 */
export function doneTitle(added: number, total: number, skipped: number, already: number): string {
  if (added === 0) return 'No accounts were added.'
  if (skipped === 0 && already === 0) return total === 1 ? '1 account added' : `All ${total} accounts added`
  return plural(added, 'account added', 'accounts added')
}

export function doneLine(added: number, skipped: number): string {
  const parts: string[] = []
  if (skipped > 0) parts.push(`${skipped} ${skipped === 1 ? 'was' : 'were'} skipped.`)
  if (added > 0) parts.push('Mail for the new accounts is coming in, newest first.')
  return parts.join(' ')
}

export const DONE = {
  added: 'Added',
  skipped: 'Skipped',
  done: 'Done',
  goBack: 'Go back to the skipped ones',
} as const

export function stillAddLine(expiresAt: string): string {
  return `You can still add the skipped ones until ${listTime(expiresAt)}.`
}

export const EXPIRED = {
  title: 'This list has expired',
  kept: 'A list of addresses is kept for 24 hours.',
  startNew: 'Start a new list',
  back: 'Back to accounts',
} as const

export function expiredMade(createdAt: string): string {
  return `${EXPIRED.kept} This one was made on ${listTime(createdAt)}.`
}

export function expiredCounts(connected: number, rest: number): string {
  const kept = connected === 1 ? 'The 1 account you connected stays connected.' : `The ${connected} accounts you connected stay connected.`
  const lost = rest === 1 ? 'The other 1 was not added.' : `The other ${rest} were not added.`
  if (connected === 0) return rest === 1 ? 'The 1 account was not added.' : `The ${rest} accounts were not added.`
  return rest === 0 ? kept : `${kept} ${lost}`
}
