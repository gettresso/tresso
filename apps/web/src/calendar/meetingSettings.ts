import {
  meetingChoices,
  sortCalendars,
  type MailAccount,
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

/**
 * The account rows of the Meet or Teams card. Every Gmail account for Meet. For Teams every Microsoft account, except
 * one whose calendars are synced and none of which can have a Teams meeting (a personal account): Teams is not offered
 * there at all.
 */
export function appRows(app: ProviderApp, accounts: MailAccount[], calendars: SyncedCalendar[], preferences: MeetingPreferences): AppRow[] {
  const company = app === 'meet' ? 'Google' : 'Microsoft 365'
  return accounts
    .filter((account) => servedBy(app, account))
    .filter((account) => {
      if (app === 'meet') return true
      const own = calendars.filter((calendar) => calendar.mailAccountId === account.id)
      return own.length === 0 || own.some((calendar) => calendar.conferenceProviders.includes('teams'))
    })
    .map((account): AppRow => {
      // A failed sign-in first; calendar access that was never given reads as not connected, with Connect asking for it.
      if (account.status === 'auth_failed' || account.calendarStatus === 'auth_failed') {
        return { account, state: 'expired', status: 'Permission expired', action: 'Reconnect' }
      }
      const off = preferences.disabled.some((entry) => entry.app === app && entry.mailAccountId === account.id)
      if (off || account.calendarStatus === 'not_granted') {
        const status = app === 'teams' && account.calendarStatus === 'not_granted' ? 'Not connected. Needs calendar access.' : 'Not connected'
        return { account, state: 'off', status, action: 'Connect' }
      }
      return { account, state: 'connected', status: `Connected through this ${company} account`, action: 'Disconnect' }
    })
}

/** "Connected" when a row is and none needs signing in again, "Needs reconnecting" when one does, else "Not connected". */
export function appPill(rows: AppRow[]): Pill {
  if (rows.some((row) => row.state === 'expired')) return { text: 'Needs reconnecting', tone: 'warn' }
  if (rows.some((row) => row.state === 'connected')) return { text: 'Connected', tone: 'ok' }
  return { text: 'Not connected', tone: 'plain' }
}

/** The provider words of a default table row: "kim@company.example, Microsoft 365". */
export function accountKind(account: Pick<MailAccount, 'provider'>): string {
  if (account.provider === 'gmail') return 'Google'
  if (account.provider === 'microsoft') return 'Microsoft 365'
  return 'CalDAV'
}

export interface DefaultOption {
  value: MeetingDefault
  label: string
}

/** The bracket after an app the account could use but cannot right now. */
function bracket(choice: MeetingChoice): string {
  switch (choice.problem) {
    case 'reconnect':
      return ' (reconnect first)'
    case 'no_link':
      return ' (paste it first)'
    case null:
      return ''
    default:
      return ' (connect first)'
  }
}

const NONE: DefaultOption = { value: 'none', label: 'No meeting link' }

/**
 * The options of an account's select: every app that could serve its calendar, in core's order, with a bracket when
 * it cannot right now, then "No meeting link". An app that never serves that calendar (Meet for a Microsoft account,
 * Teams for an account without Teams) is left out.
 */
export function defaultOptions(choices: MeetingChoice[]): DefaultOption[] {
  return [...choices.filter((choice) => choice.problem !== 'other_calendar' && choice.problem !== 'unsupported').map((choice) => ({ value: choice.app, label: choice.label + bracket(choice) })), NONE]
}

/** The options of "Every other calendar": the apps that work with any calendar (the own link, Zoom), then none. */
export function otherOptions(choices: MeetingChoice[]): DefaultOption[] {
  return [...choices.filter((choice) => choice.app === 'own' || choice.app === 'zoom').map((choice) => ({ value: choice.app, label: choice.label + bracket(choice) })), NONE]
}

export interface DefaultRow {
  account: MailAccount
  calendar: SyncedCalendar
  options: DefaultOption[]
  /** The saved choice; null when nothing is saved for this account (the select then shows what applies anyway). */
  saved: MeetingDefault | null
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

/** One row per mail account with a writable calendar, in the order of the accounts. */
export function defaultRows(accounts: MailAccount[], calendars: SyncedCalendar[], preferences: MeetingPreferences): DefaultRow[] {
  const rows: DefaultRow[] = []
  for (const account of accounts) {
    const calendar = accountCalendar(calendars, account.id)
    if (calendar === undefined) continue
    const choices = meetingChoices(calendar, account, preferences)
    const kind = calendarKind(calendar)
    const notOffered = choices
      .filter((choice) => choice.problem === 'other_calendar')
      .map((choice) =>
        choice.app === 'meet'
          ? `Google Meet is not offered for ${account.displayName}: a Meet link is made through a Google calendar event, and ${account.displayName} is ${kind}.`
          : `Microsoft Teams is not offered for ${account.displayName}: a Teams link is made through a Microsoft 365 calendar event, and ${account.displayName} is ${kind}.`,
      )
    const saved = Object.prototype.hasOwnProperty.call(preferences.defaults, account.id) ? (preferences.defaults[account.id] ?? null) : null
    rows.push({ account, calendar, options: defaultOptions(choices), saved, notOffered })
  }
  return rows
}
