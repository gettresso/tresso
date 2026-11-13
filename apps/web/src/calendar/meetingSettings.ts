import {
  accountServiceProvider,
  appLabel,
  defaultMeetingApp,
  meetingChoices,
  meetingLinkProblem,
  sortCalendars,
  type MailAccount,
  type MeetingApp,
  type MeetingChoice,
  type MeetingDefault,
  type MeetingPreferences,
  type SyncedCalendar,
} from '@tresso/core'

/**
 * The rules of Settings, Meeting apps (build plan 5.3): which account rows the Google Meet and Microsoft Teams cards
 * have and what each says, the cards' pills, and the default app table. The app rules themselves are core's
 * (meetingChoices); this only arranges them for the page.
 */

export type ProviderApp = 'meet' | 'teams'

/** How an account serves Meet or Teams: made through it, switched off or without calendar access, or signed out. */
export type RowState = 'connected' | 'off' | 'expired'

export interface AppRow {
  account: MailAccount
  state: RowState
  /** The status words under the address. */
  status: string
  /** The row's button. */
  action: 'Connect' | 'Disconnect' | 'Reconnect'
}

export type Pill = { text: string; tone: 'ok' | 'warn' | 'plain' }

/** The writable calendar of an account that new events go to: its default, else the first in the usual order. */
export function accountCalendar(calendars: SyncedCalendar[], accountId: string): SyncedCalendar | undefined {
  const own = sortCalendars(calendars.filter((calendar) => calendar.mailAccountId === accountId && calendar.writable))
  return own.find((calendar) => calendar.isDefault) ?? own[0]
}

/** Whether the account signs in with the app's company: Gmail for Meet, Microsoft for Teams. */
function servedBy(app: ProviderApp, account: MailAccount): boolean {
  return account.provider === (app === 'meet' ? 'gmail' : 'microsoft')
}

/** A Microsoft account whose calendars are synced and none of which can have a Teams meeting. */
function withoutTeams(account: MailAccount, calendars: SyncedCalendar[]): boolean {
  const own = calendars.filter((calendar) => calendar.mailAccountId === account.id)
  return own.length > 0 && !own.some((calendar) => calendar.conferenceProviders.includes('teams'))
}

/**
 * The account rows of the Meet or Teams card. Every Gmail account for Meet. For Teams every Microsoft account, except
 * one whose calendars are synced and none of which can have a Teams meeting (a personal account): Teams is not offered
 * there at all.
 */
export function appRows(app: ProviderApp, accounts: MailAccount[], calendars: SyncedCalendar[], preferences: MeetingPreferences): AppRow[] {
  const company = app === 'meet' ? 'Google' : 'Microsoft 365'
  return accounts
    .filter((account) => servedBy(app, account))
    .filter((account) => app === 'meet' || !withoutTeams(account, calendars))
    .map((account): AppRow => {
      // A failed sign-in first; calendar access that was never given reads as not connected, with Connect asking for it.
      if (account.status === 'auth_failed' || account.calendarStatus === 'auth_failed') {
        return { account, state: 'expired', status: 'Permission expired', action: 'Reconnect' }
      }
      const off = preferences.disabled.some((entry) => entry.app === app && entry.mailAccountId === account.id)
      if (off || account.calendarStatus === 'not_granted') {
        const status = account.calendarStatus === 'not_granted' ? 'Not connected. Needs calendar access.' : 'Not connected'
        return { account, state: 'off', status, action: 'Connect' }
      }
      return { account, state: 'connected', status: `Connected through this ${company} account`, action: 'Disconnect' }
    })
}

/** The Teams card without rows: no Microsoft account at all, or only ones that cannot make Teams links. */
export function teamsEmpty(accounts: MailAccount[]): string {
  return accounts.some((account) => account.provider === 'microsoft') ? 'No work or school account yet' : 'No Microsoft 365 account yet'
}

/** "Connected" when a row is and none needs signing in again, "Needs reconnecting" when one does, else "Not connected". */
export function appPill(rows: AppRow[]): Pill {
  if (rows.some((row) => row.state === 'expired')) return { text: 'Needs reconnecting', tone: 'warn' }
  if (rows.some((row) => row.state === 'connected')) return { text: 'Connected', tone: 'ok' }
  return { text: 'Not connected', tone: 'plain' }
}

/**
 * The provider words of a default table row: "kim@company.example, Microsoft 365". A personal Microsoft address reads
 * "Outlook", and another Microsoft account whose calendars cannot have Teams "Microsoft, without Teams": Tresso cannot
 * tell those apart from a work account any better.
 */
export function accountKind(account: Pick<MailAccount, 'id' | 'provider' | 'emailAddress'>, calendars: SyncedCalendar[]): string {
  if (account.provider === 'gmail') return 'Google'
  if (account.provider === 'microsoft') {
    if (accountServiceProvider(account) === 'outlook') return 'Outlook'
    return withoutTeams(account as MailAccount, calendars) ? 'Microsoft, without Teams' : 'Microsoft 365'
  }
  return 'CalDAV'
}

export interface DefaultOption {
  value: MeetingDefault
  label: string
}

/**
 * The bracket after an app the account could use but cannot right now, in the word of the card's button: calendar
 * access never given is "connect first" there too, though core counts it as reconnecting.
 */
function bracket(choice: MeetingChoice, account: MailAccount | null): string {
  switch (choice.problem) {
    case 'reconnect':
      return account?.calendarStatus === 'not_granted' ? ' (connect first)' : ' (reconnect first)'
    case 'no_link':
      return ' (paste it first)'
    case null:
      return ''
    default:
      return ' (connect first)'
  }
}

const NONE: DefaultOption = { value: 'none', label: 'No meeting link' }

/** A saved choice that cannot serve the calendar (Teams on a personal account, Zoom on a server without it). */
function unavailable(value: MeetingDefault): DefaultOption {
  return { value, label: `${appLabel(value as MeetingApp)} (not available here)` }
}

/**
 * The options of a select: the apps that may serve it, a saved choice that cannot (said so), then "No meeting link";
 * and the value it shows: the saved choice, else the one that applies anyway when it is listed, else "" ("Not set").
 */
function withValue(options: DefaultOption[], saved: MeetingDefault | null, applies: MeetingDefault | null): { options: DefaultOption[]; value: string } {
  const listed = (value: MeetingDefault | null) => value !== null && options.some((option) => option.value === value)
  if (saved !== null) {
    return listed(saved) ? { options: [...options, NONE], value: saved } : saved === 'none' ? { options: [...options, NONE], value: 'none' } : { options: [...options, unavailable(saved), NONE], value: saved }
  }
  const all = [...options, NONE]
  return { options: all, value: applies === 'none' || listed(applies) ? (applies as string) : '' }
}

export interface DefaultRow {
  account: MailAccount
  calendar: SyncedCalendar
  options: DefaultOption[]
  /** What the select shows; "" when nothing is saved and nothing applies. */
  value: string
  /** "Google Meet is not offered for Work: ..." lines for the apps this account's calendar cannot use. */
  notOffered: string[]
}

/** "a Google calendar", "a Microsoft 365 calendar", "a CalDAV calendar", "a calendar in Tresso", as core says it. */
function calendarKind(calendar: SyncedCalendar): string {
  switch (calendar.source) {
    case 'google':
      return 'a Google calendar'
    case 'microsoft':
      return 'a Microsoft 365 calendar'
    case 'caldav':
      return 'a CalDAV calendar'
    default:
      return 'a calendar in Tresso'
  }
}

/** Why an app is not offered for an account: another kind of calendar, or a calendar of the right kind without it. */
function notOfferedLine(choice: MeetingChoice, name: string, calendar: SyncedCalendar): string {
  if (choice.problem === 'unsupported') {
    return `${choice.label} is not offered for ${name}: ${choice.via}`
  }
  return choice.app === 'meet'
    ? `Google Meet is not offered for ${name}: a Meet link is made through a Google calendar event, and ${name} is ${calendarKind(calendar)}.`
    : `Microsoft Teams is not offered for ${name}: a Teams link is made through a Microsoft 365 calendar event, and ${name} is ${calendarKind(calendar)}.`
}

/** One row per mail account with a writable calendar, in the order of the accounts. */
export function defaultRows(accounts: MailAccount[], calendars: SyncedCalendar[], preferences: MeetingPreferences): DefaultRow[] {
  const rows: DefaultRow[] = []
  for (const account of accounts) {
    const calendar = accountCalendar(calendars, account.id)
    if (calendar === undefined) continue
    const choices = meetingChoices(calendar, account, preferences)
    const offered = choices
      .filter((choice) => choice.problem !== 'other_calendar' && choice.problem !== 'unsupported')
      .map((choice) => ({ value: choice.app, label: choice.label + bracket(choice, account) }))
    const saved = Object.prototype.hasOwnProperty.call(preferences.defaults, account.id) ? (preferences.defaults[account.id] ?? null) : null
    const notOffered = choices.filter((choice) => choice.problem === 'other_calendar' || choice.problem === 'unsupported').map((choice) => notOfferedLine(choice, account.displayName, calendar))
    rows.push({ account, calendar, ...withValue(offered, saved, defaultMeetingApp(calendar, account, preferences)), notOffered })
  }
  return rows
}

/**
 * "Every other calendar": the apps that work with any calendar (the own link, Zoom when the server has it), a saved
 * choice that cannot apply (said so), then none; it shows `defaultOther`, else the own link when one is saved.
 */
export function otherRow(preferences: MeetingPreferences): { options: DefaultOption[]; value: string } {
  const offered = meetingChoices(undefined, null, preferences)
    .filter((choice) => choice.app === 'own' || choice.app === 'zoom')
    .map((choice) => ({ value: choice.app, label: choice.label + bracket(choice, null) }))
  const own = preferences.ownLink !== null && meetingLinkProblem(preferences.ownLink) === null
  return withValue(offered, preferences.defaultOther, own ? 'own' : 'none')
}
