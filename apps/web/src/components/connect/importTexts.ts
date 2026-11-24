import { connectErrorMessage, type ImportFailure, type ImportGroup, type OAuthProviderId, type PastedAddresses, type PastedIssue } from '@tresso/core'

/**
 * The words of the "Add several accounts" pages, as the boards AddAccountsPaste, AddAccountsList and AddAccountsStates
 * have them. States without a board (a provider failure other than a refusal or an organization's approval) say what
 * the single connect flow says ({@link connectErrorMessage}).
 */

export const LIMIT = 50

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "Tuesday 21 October at 10:12". */
export function listTime(iso: string): string {
  const date = new Date(iso)
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(date)
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
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

export function checkTitle(read: PastedAddresses): string {
  return read.issues.length > 0 ? 'Check these first' : 'Nothing to check'
}

export function checkLead(read: PastedAddresses): string {
  if (read.issues.length > 0) return `${plural(read.issues.length, 'address needs', 'addresses need')} a look. The others are ready.`
  return read.total === 0 ? 'Addresses that need a look show up here.' : 'Every address looks right.'
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

export function continueLabel(read: PastedAddresses): string {
  return `Continue with ${plural(read.toAdd.length, 'address', 'addresses')}`
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

export function assistantNotice(app: string): string {
  return `This list was made by ${app}. Check the addresses before you sign in.`
}

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

export function passwordLabel(address: string): string {
  return `Password for ${address}`
}

// ---- Row states --------------------------------------------------------------------------------------------------------

/** The states of a row, as the states board draws them; `failed` is a provider failure without a board of its own. */
export type RowState = 'todo' | 'signing-in' | 'waiting' | 'connected' | 'cancelled' | 'approve' | 'refused' | 'unreachable' | 'already' | 'skipped' | 'failed'

export type RowIcon = 'dot' | 'spin' | 'check' | 'undo' | 'alert' | 'dash'

export const ROW_STATES: Record<RowState, { label: string; icon: RowIcon; tone: 'muted' | 'ink' | 'know' | 'danger' }> = {
  todo: { label: 'To do', icon: 'dot', tone: 'muted' },
  'signing-in': { label: 'Signing in', icon: 'spin', tone: 'ink' },
  waiting: { label: 'Waiting for the browser', icon: 'spin', tone: 'ink' },
  connected: { label: 'Connected', icon: 'check', tone: 'know' },
  cancelled: { label: 'Sign-in cancelled', icon: 'undo', tone: 'muted' },
  approve: { label: 'Organization must approve', icon: 'alert', tone: 'danger' },
  refused: { label: 'Password refused', icon: 'alert', tone: 'danger' },
  unreachable: { label: 'Server not reached', icon: 'alert', tone: 'danger' },
  already: { label: 'Already connected', icon: 'check', tone: 'muted' },
  skipped: { label: 'Skipped', icon: 'dash', tone: 'muted' },
  failed: { label: 'Sign-in failed', icon: 'alert', tone: 'danger' },
}

/** The row state of a failure code. */
export function failureState(failure: ImportFailure | null): RowState {
  switch (failure) {
    case 'denied':
      return 'cancelled'
    case 'admin_approval_required':
      return 'approve'
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
  return approvalUrl === null ? first : `${first} Send them ${approvalUrl}.`
}

export function refusedHint(address: string): string {
  return `${domainOf(address)} did not accept this password. Check that all of it was filled in.`
}

export function unreachableHint(server: { host: string; port: number }): string {
  return `${server.host} did not answer on port ${server.port}.`
}

/** A provider failure without a board of its own: what the single connect flow says. */
export function failedHint(failure: ImportFailure | null, provider: OAuthProviderId): string {
  return connectErrorMessage(failure ?? 'failed', provider)
}

// ---- The run stopped ---------------------------------------------------------------------------------------------------

export function stoppedTitle(address: string): string {
  return `Stopped at ${address}`
}

export function stoppedReason(state: RowState, address: string, server: { host: string } | null, failure: ImportFailure | null, provider: OAuthProviderId | null): string {
  switch (state) {
    case 'cancelled':
      return 'Sign-in was cancelled. Nothing was connected for this address.'
    case 'approve':
      return `The IT team of ${domainOf(address)} has to approve Tresso first. Other addresses of ${domainOf(address)} will stop here too.`
    case 'refused':
      return `${domainOf(address)} did not accept the password for this address.`
    case 'unreachable':
      return `${server?.host ?? domainOf(address)} did not answer. Nothing was connected for this address.`
    default:
      return failedHint(failure, provider ?? 'microsoft')
  }
}

export function soFar(connected: number, total: number): string {
  return `${connected} of ${total} are connected so far.`
}

// ---- Endings -----------------------------------------------------------------------------------------------------------

export function doneTitle(added: number, total: number, skipped: number): string {
  if (skipped === 0) return total === 1 ? '1 account added' : `All ${total} accounts added`
  return plural(added, 'account added', 'accounts added')
}

export function doneLine(skipped: number): string {
  const rest = 'Mail for the new accounts is coming in, newest first.'
  return skipped === 0 ? rest : `${skipped} ${skipped === 1 ? 'was' : 'were'} skipped. ${rest}`
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
  return `The ${connected} accounts you connected stay connected. The other ${rest} were not added.`
}
