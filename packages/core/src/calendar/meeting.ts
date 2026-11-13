/**
 * Meeting links: which meeting app an event's calendar can use, the state of the "Meeting link" row in the event
 * editor, and every text about it, shared by the web, the desktop and the phone. Pure functions; the clients bring
 * the calendar, its mail account, the user's meeting preferences and the time.
 */

import type { CalendarSource, Conference, ConferenceRequest, SyncedCalendar, SyncedCalendarEvent } from './types'

export type MeetingApp = 'meet' | 'teams' | 'zoom' | 'own'
export type MeetingDefault = MeetingApp | 'none'

/** GET and PATCH /api/v1/calendar/meeting-preferences. */
export interface MeetingPreferences {
  ownLink: string | null
  addWithGuests: boolean
  /** Mail account id to the app new events on its calendars start with. */
  defaults: Record<string, MeetingDefault>
  /** The same for calendars without an entry in {@link defaults} (Tresso calendars, accounts added later). */
  defaultOther: MeetingDefault | null
  /** Apps the user switched off in Tresso for one account; nothing changes at the provider. */
  disabled: { app: 'meet' | 'teams'; mailAccountId: string }[]
  /** Apps this server can offer. */
  apps: MeetingApp[]
}
/**
 * A PATCH of the preferences. `ownLink: ""` clears the own link; `ownLink: null`, like leaving it out, keeps it.
 */
export type MeetingPreferencesUpdate = Partial<Omit<MeetingPreferences, 'apps'>>

/** What the rules need of a mail account (MailAccount and SyncedMailAccount both fit). */
export interface MeetingAccount {
  id: string
  emailAddress: string
  provider: string
  status: string
  calendarStatus: string
}

/**
 * Why an app cannot make a link for an event right now:
 * - `other_calendar`: the app makes links only through events on another kind of calendar.
 * - `reconnect`: the calendar's account needs to be signed in again (or calendar access allowed).
 * - `unsupported`: a calendar of the right kind whose provider does not make that meeting.
 * - `off`: the user switched the app off for this account in Settings.
 * - `no_link`: no own link is saved.
 * - `not_connected`: nothing to make the link with (no Zoom account, a calendar whose account is unknown).
 */
export type MeetingProblem = 'other_calendar' | 'reconnect' | 'unsupported' | 'off' | 'no_link' | 'not_connected'

/** One app as the editor's menu offers it; `via` is the menu choice's second line. */
export interface MeetingChoice {
  app: MeetingApp
  label: string
  short: string
  company: string
  ok: boolean
  problem: MeetingProblem | null
  via: string
}

/** A requested link still pending after this long reads as failed: the provider did not answer in time. */
export const MEETING_PENDING_MS = 120_000

/** The longest own link the API takes. */
export const OWN_LINK_MAX_LENGTH = 2048

/** The order of the editor's menu, and of the fall back when the default app cannot make a link. */
const ORDER: MeetingApp[] = ['teams', 'meet', 'own', 'zoom']

const NAMES: Record<MeetingApp, { label: string; short: string; company: string }> = {
  meet: { label: 'Google Meet', short: 'Google Meet', company: 'Google' },
  teams: { label: 'Microsoft Teams', short: 'Teams', company: 'Microsoft' },
  zoom: { label: 'Zoom', short: 'Zoom', company: 'Zoom' },
  // Nothing is made for the own link, so its short name and company never appear in a sentence.
  own: { label: 'My own link', short: 'My own link', company: '' },
}

/**
 * Neutral words for an app this client does not know (a newer server can name more), so a row never breaks on one:
 * "Making the meeting link", "The meeting app did not answer in time."
 */
const UNKNOWN = { label: 'Meeting link', short: 'meeting', company: 'The meeting app', app: 'The meeting app' }

/** The names of an app, or the neutral ones for an app this client does not know. */
function namesOf(app: string): { label: string; short: string; company: string; app: string } {
  if (!Object.prototype.hasOwnProperty.call(NAMES, app)) {
    return UNKNOWN
  }
  const names = NAMES[app as MeetingApp]
  return { ...names, app: names.label }
}

/** "Google Meet", "Microsoft Teams", "Zoom", "My own link"; "Meeting link" for an app this client does not know. */
export function appLabel(app: MeetingApp): string {
  return namesOf(app).label
}

/** The name of the app an event's link belongs to: the saved own link is "My own link", an unknown one "Meeting link". */
export function conferenceLabel(conference: Conference, ownLink: string | null): string {
  if (ownLink !== null && ownLink !== '' && conference.url === ownLink) {
    return 'My own link'
  }
  switch (conference.provider) {
    case 'teams':
      return 'Microsoft Teams'
    case 'meet':
      return 'Google Meet'
    case 'zoom':
      return 'Zoom'
    case 'webex':
      return 'Webex'
    default:
      return 'Meeting link'
  }
}

/** The Join button's words, on every device. */
export function joinLabel(provider: Conference['provider']): string {
  switch (provider) {
    case 'teams':
      return 'Join with Microsoft Teams'
    case 'meet':
      return 'Join with Google Meet'
    case 'zoom':
      return 'Join with Zoom'
    case 'webex':
      return 'Join with Webex'
    default:
      return 'Join the meeting'
  }
}

/** The longest a link is shown as text; a longer one ends in an ellipsis (Copy still copies all of it). */
export const DISPLAY_LINK_MAX = 300

/** Every character that shows nothing or turns text around (see HIDDEN) as a visible U+FFFD. */
function visible(url: string): string {
  return url.replace(HIDDEN_ALL, '\ufffd')
}

/**
 * A link as text on screen, never as a key to open it: characters that show nothing or reverse the text (a right to
 * left override can make "evil.example/moc.smaet" read as another host) become a visible U+FFFD, and the text ends in an
 * ellipsis after {@link DISPLAY_LINK_MAX} characters. Copy keeps the link as it is.
 */
export function displayLink(url: string): string {
  const chars = Array.from(visible(url))
  return chars.length <= DISPLAY_LINK_MAX ? chars.join('') : `${chars.slice(0, DISPLAY_LINK_MAX - 1).join('')}\u2026`
}

/**
 * A link as one short line: without a leading `https://`, at most `max` characters (real Teams links are about 250),
 * with hidden characters made visible as in {@link displayLink}. The host is never cut in the middle, so a lookalike
 * such as "teams.microsoft.com.evil.example" always shows where it leads: the scheme (other than https) and the host,
 * up to the first `/`, `?` or `#`, stay whole and the rest is cut in the middle; a host longer than `max` alone loses
 * its left end, keeping the registrable part on the right. A link without a host (`javascript:`) is cut in the
 * middle. Show the full link in a title; Copy always copies the full link.
 */
export function linkText(url: string, max = 44): string {
  const limit = Math.max(3, Math.floor(max))
  const https = url.startsWith('https://')
  const rest = visible(https ? url.slice('https://'.length) : url)
  const scheme = https ? null : /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest)
  const chars = Array.from(rest)
  if (chars.length <= limit) {
    return chars.join('')
  }
  const cutMiddle = (part: string[], room: number): string => {
    if (room <= 1) {
      return '\u2026'
    }
    const head = Math.ceil((room - 1) / 2)
    const tail = room - 1 - head
    return `${part.slice(0, head).join('')}\u2026${tail > 0 ? part.slice(part.length - tail).join('') : ''}`
  }
  if (!https && scheme === null) {
    return cutMiddle(chars, limit)
  }
  const lead = scheme === null ? 0 : Array.from(scheme[0]).length
  const found = chars.findIndex((char, index) => index >= lead && (char === '/' || char === '?' || char === '#'))
  const hostEnd = found === -1 ? chars.length : found
  const host = chars.slice(0, hostEnd)
  if (host.length >= limit) {
    return `\u2026${host.slice(host.length - (limit - 1)).join('')}`
  }
  return host.join('') + cutMiddle(chars.slice(hostEnd), limit - host.length)
}

/**
 * Why a link must not be saved or opened:
 * - `empty`: nothing typed.
 * - `too_long`: longer than {@link OWN_LINK_MAX_LENGTH}.
 * - `whitespace`: a space, tab or line break anywhere, also at the start or the end.
 * - `control`: a control character, or an invisible one that can disguise where a link leads (zero width, direction
 *   marks and overrides).
 * - `not_https`: not `https://` (`http:`, `javascript:`, `data:`, `file:`, no scheme).
 * - `credentials`: a user name or password before the host.
 * - `no_host`: no host with a dot (`https://localhost`, an IP v6 address, an empty host).
 * - `invalid`: anything else that is no plain web address (a backslash, a bad port).
 */
export type MeetingLinkProblem = 'empty' | 'too_long' | 'whitespace' | 'control' | 'not_https' | 'credentials' | 'no_host' | 'invalid'

// C0 and C1 controls, DEL, soft hyphen, zero width characters, direction marks, embeddings, overrides and isolates,
// the byte order mark, the interlinear annotation and object replacement characters, and the Hangul fillers: letters
// that show nothing and that a browser drops from a host, so "exa<filler>mple.com" would open example.com.
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufeff\uffa0\ufff9-\ufffc]/
const HIDDEN_ALL = new RegExp(HIDDEN.source, 'g')
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u

/**
 * Checks a meeting link as typed or pasted, without changing it: an own link before it is saved, and any link before
 * it is opened by a click. Null when it is a plain https web address. Never fetches the link. Parsed by hand, not with
 * `URL`, so every platform (React Native's `URL` lacks parts) gives the same answer.
 */
export function meetingLinkProblem(value: string): MeetingLinkProblem | null {
  return checkLink(value).problem
}

/** The problem of a link, or its host when it has none. */
function checkLink(value: string): { problem: MeetingLinkProblem; host: null } | { problem: null; host: string } {
  const problem = (code: MeetingLinkProblem): { problem: MeetingLinkProblem; host: null } => ({ problem: code, host: null })
  if (value === '') {
    return problem('empty')
  }
  if (value.length > OWN_LINK_MAX_LENGTH) {
    return problem('too_long')
  }
  if (/\s/u.test(value)) {
    return problem('whitespace')
  }
  if (HIDDEN.test(value)) {
    return problem('control')
  }
  if (!value.startsWith('https://')) {
    return problem('not_https')
  }
  if (value.includes('\\')) {
    return problem('invalid')
  }
  const rest = value.slice('https://'.length)
  const end = rest.search(/[/?#]/)
  const authority = end === -1 ? rest : rest.slice(0, end)
  if (authority.includes('@')) {
    return problem('credentials')
  }
  const match = /^([^:]*)(?::(\d*))?$/.exec(authority)
  if (match === null) {
    return problem(authority.startsWith('[') ? 'no_host' : 'invalid')
  }
  const host = match[1] ?? ''
  const port = match[2]
  if (port !== undefined && (port === '' || port.length > 5 || Number(port) < 1 || Number(port) > 65535)) {
    return problem('invalid')
  }
  const labels = host.replace(/\.$/, '').split('.')
  if (host === '' || labels.length < 2) {
    return problem('no_host')
  }
  // A last label of digits or a hex number makes a browser read the host as an IP address (127.1, 0x7f.1), or
  // refuse it (example.123): one rule, a named host with a dot.
  const last = labels[labels.length - 1] ?? ''
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/i.test(last)) {
    return problem('no_host')
  }
  // A browser maps wide and other digits and letters to ASCII first (127.0.0.<fullwidth 1>, 1.0<fullwidth x>7f), so a
  // last label with any character outside ASCII and any number in it is not taken either.
  if (/[^\x00-\x7f]/.test(last) && /\p{N}/u.test(last)) {
    return problem('no_host')
  }
  if (!labels.every((label) => label.length <= 63 && LABEL.test(label))) {
    return problem('invalid')
  }
  return { problem: null, host }
}

/** What the own link field says about a problem; never the value itself. */
export function meetingLinkError(problem: MeetingLinkProblem): string {
  switch (problem) {
    case 'empty':
      return 'Paste your room link.'
    case 'too_long':
      return `Use a link of at most ${OWN_LINK_MAX_LENGTH} characters.`
    case 'whitespace':
    case 'control':
      return 'Use a link without spaces, line breaks or hidden characters.'
    case 'credentials':
      return 'Use a link without a user name or password in it.'
    case 'no_host':
      return 'Use a link with a full web address, such as https://meet.example.com/room.'
    case 'invalid':
      return 'This link does not look right. Check it and paste it again.'
    default:
      return 'Use a link that starts with https://.'
  }
}

/**
 * A conference link that a Join button may open: a plain https web address (an invitation can carry anything) whose
 * host is plain ASCII. A link from someone else with letters outside ASCII in its host may imitate another host (a
 * Cyrillic letter in "teams.microsoft.com"), so Join is not offered for it unless the host is given in punycode
 * (xn--); the clients still show the link with Copy. The user's own pasted link is not held to this: it may use an
 * international host name, see {@link meetingLinkProblem}.
 */
export function canJoin(conference: Pick<Conference, 'url'>): boolean {
  const checked = checkLink(conference.url)
  return checked.problem === null && /^[a-z0-9.-]+$/i.test(checked.host)
}

/**
 * Microsoft keeps a Teams meeting on its event: once a Microsoft 365 event has one, the API refuses to remove it (or
 * to swap it for another app). The editor, the popover and the phone neither offer nor confirm that removal.
 */
export function cannotRemoveMeeting(source: CalendarSource | undefined, conference: Pick<Conference, 'provider'> | null): boolean {
  return source === 'microsoft' && conference !== null && conference.provider === 'teams'
}

/**
 * Whether an event's meeting link can be taken off: the server's `removable` when it sent one, else the opposite of
 * {@link cannotRemoveMeeting} (rows stored before the server sent the flag lack it). False when there is no link.
 */
export function meetingRemovable(source: CalendarSource | undefined, conference: Pick<Conference, 'provider' | 'removable'> | null): boolean {
  if (conference === null) {
    return false
  }
  if (typeof conference.removable === 'boolean') {
    return conference.removable
  }
  return !cannotRemoveMeeting(source, conference)
}

/** What the editor's app menu says on such an event, under its heading. */
export const TEAMS_MEETING_KEPT = 'Microsoft keeps a Teams meeting on its event. To meet elsewhere, delete this event and make a new one.'

/** The account needs to be signed in again, or to allow calendar access, before Meet or Teams can make a link. */
export function needsReconnect(account: MeetingAccount | null): boolean {
  if (account === null) {
    return false
  }
  return account.status === 'auth_failed' || account.calendarStatus === 'not_granted' || account.calendarStatus === 'auth_failed'
}

/** "a Google calendar", "a Microsoft 365 calendar", "a CalDAV calendar", "a calendar in Tresso". */
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

/** The saved own link when it is one the editor may use. */
function usableOwnLink(preferences: MeetingPreferences): string | null {
  const link = preferences.ownLink
  return link !== null && meetingLinkProblem(link) === null ? link : null
}

function choice(app: MeetingApp, problem: MeetingProblem | null, via: string): MeetingChoice {
  return { app, ...NAMES[app], ok: problem === null, problem, via }
}

/** Meet or Teams: made by the calendar's provider in the same write that saves the event. */
function providerChoice(
  app: 'meet' | 'teams',
  calendar: SyncedCalendar | undefined,
  account: MeetingAccount | null,
  preferences: MeetingPreferences,
): MeetingChoice {
  const source = app === 'meet' ? 'google' : 'microsoft'
  const only = app === 'meet' ? 'Only for events on a Google calendar.' : 'Only for events on a Microsoft 365 calendar.'
  if (calendar === undefined) {
    return choice(app, 'other_calendar', only)
  }
  if (calendar.source !== source) {
    return choice(app, 'other_calendar', `${only} ${calendar.name} is ${calendarKind(calendar)}.`)
  }
  const accountId = account?.id ?? calendar.mailAccountId
  // Switched off by the user: their own choice, so it is said before anything about the account.
  if (preferences.disabled.some((entry) => entry.app === app && entry.mailAccountId === accountId)) {
    return choice(app, 'off', 'Not connected. Connect it in Settings.')
  }
  if (account === null) {
    return choice(app, 'not_connected', 'Not connected. Connect it in Settings.')
  }
  // Before the calendar's list: a calendar whose account lost access may list nothing, or an old list.
  if (needsReconnect(account)) {
    return choice(app, 'reconnect', `${account.emailAddress} needs to be reconnected first.`)
  }
  if (!calendar.conferenceProviders.includes(app)) {
    return app === 'meet'
      ? choice(app, 'unsupported', `Google Meet is not available for ${calendar.name}.`)
      : choice(app, 'unsupported', `Teams links need a Microsoft 365 work or school account. ${account.emailAddress} cannot make them.`)
  }
  return choice(app, null, `With ${account.emailAddress}`)
}

/**
 * Every app this server offers for an event on `calendar` (with its mail account), in the menu's order: Teams, Meet,
 * own link, Zoom. Apps that cannot make a link are listed too, with the reason as `via`.
 */
export function meetingChoices(calendar: SyncedCalendar | undefined, account: MeetingAccount | null, preferences: MeetingPreferences): MeetingChoice[] {
  const choices: MeetingChoice[] = []
  for (const app of ORDER) {
    if (!preferences.apps.includes(app)) {
      continue
    }
    if (app === 'meet' || app === 'teams') {
      choices.push(providerChoice(app, calendar, account, preferences))
    } else if (app === 'own') {
      const link = usableOwnLink(preferences)
      choices.push(link === null ? choice('own', 'no_link', 'Paste your room link in Settings first.') : choice('own', null, `${linkText(link)}, the same room every time`))
    } else {
      // V2 connects Zoom accounts; until then the server lists Zoom only to show it.
      choices.push(choice('zoom', 'not_connected', 'Not connected yet.'))
    }
  }
  return choices
}

/**
 * The app new events on `calendar` start with: the account's entry in the preferences, else the one for every other
 * calendar, else the natural one (Meet on Google, Teams on Microsoft, the own link when one is saved), else `none`.
 * Null only when the calendar is not known and the user set nothing for other calendars.
 */
export function defaultMeetingApp(calendar: SyncedCalendar | undefined, account: MeetingAccount | null, preferences: MeetingPreferences): MeetingDefault | null {
  const accountId = calendar?.mailAccountId ?? account?.id ?? null
  if (accountId !== null && Object.prototype.hasOwnProperty.call(preferences.defaults, accountId)) {
    const value = preferences.defaults[accountId]
    if (value !== undefined) {
      return value
    }
  }
  if (preferences.defaultOther !== null) {
    return preferences.defaultOther
  }
  if (calendar === undefined) {
    return null
  }
  if (calendar.source === 'google') {
    return 'meet'
  }
  if (calendar.source === 'microsoft') {
    return 'teams'
  }
  return usableOwnLink(preferences) !== null ? 'own' : 'none'
}

/**
 * The app the row switches on with. The preferred app when it can make a link; otherwise the first that can, in the
 * menu's order, with the preferred one as `fellBack` so the row says why. `choice` is null when no app can; `none` or
 * null as preferred (the user switches the row on by hand) takes the first that can, without a fall back.
 */
export function startingChoice(choices: MeetingChoice[], preferred: MeetingDefault | null): { choice: MeetingChoice | null; fellBack: MeetingChoice | null } {
  const first = choices.find((item) => item.ok) ?? null
  if (preferred === null || preferred === 'none') {
    return { choice: first, fellBack: null }
  }
  const wanted = choices.find((item) => item.app === preferred) ?? null
  if (wanted !== null && wanted.ok) {
    return { choice: wanted, fellBack: null }
  }
  return { choice: first, fellBack: wanted }
}

/** The time `requestedAt` stands for, or NaN. */
function requestedAt(request: ConferenceRequest): number {
  return Date.parse(request.requestedAt)
}

/** A pending request older than {@link MEETING_PENDING_MS} (or with an unreadable time) reads as failed. */
function pendingTooLong(request: ConferenceRequest, now: number): boolean {
  const at = requestedAt(request)
  return !Number.isFinite(at) || now - at > MEETING_PENDING_MS
}

/**
 * Where a link that was asked for stands. `now` is the server's time as the client knows it (ServerClock), so a
 * device clock that is off does not end the wait early.
 */
export function requestState(event: Pick<SyncedCalendarEvent, 'conference' | 'conferenceRequest'>, now: number): 'none' | 'creating' | 'failed' {
  const request = event.conferenceRequest ?? null
  if (event.conference !== null || request === null) {
    return 'none'
  }
  if (request.status === 'failed' || pendingTooLong(request, now)) {
    return 'failed'
  }
  return 'creating'
}

/** "Making the Teams link" while it is made, "Could not make the Teams link" once it failed. */
export function requestTitle(request: ConferenceRequest, now: number): string {
  const short = namesOf(request.provider).short
  return request.status === 'failed' || pendingTooLong(request, now) ? `Could not make the ${short} link` : `Making the ${short} link`
}

/** The hint under a link that was asked for and is still being made. */
export const CREATING_HINT = 'The event is saved. This usually takes a few seconds.'

/** Why a requested link is not there, under "Could not make the ... link". */
export function failureHint(request: ConferenceRequest, now: number): string {
  const names = namesOf(request.provider)
  if (request.status === 'pending') {
    return pendingTooLong(request, now) ? `The event is saved without a link. ${names.company} did not answer in time.` : CREATING_HINT
  }
  switch (request.reason) {
    case 'unreachable':
      return `The event is saved without a link. ${names.company} did not answer in time.`
    case 'not_supported':
      return `The event is saved without a link. ${names.app} is not available for this calendar.`
    default:
      // The server reports a failure without a reason as refused.
      return `The event is saved without a link. ${names.company} refused to make it.`
  }
}

/** The line of state 12, on an event someone else organizes: "Microsoft Teams, added by Kim Visser. ...". */
export function addedByText(conference: Conference, ownLink: string | null, organizer: string): string {
  return `${conferenceLabel(conference, ownLink)}, added by ${organizer}. Only the organizer can change it.`
}

export type MeetingRow = {
  kind: 'off' | 'no_app' | 'ready' | 'own' | 'creating' | 'created' | 'failed' | 'reconnect' | 'wrong_calendar' | 'wrong_account' | 'removed'
  title: string
  hint: string
  tone: 'plain' | 'warn' | 'error'
  icon: 'camera' | 'spinner' | 'warn' | 'error'
}

export interface MeetingRowInput {
  /** The switch is on (the user switched it on, or a guest was added). */
  on: boolean
  /** "Remove meeting link" on a saved event that had one, not saved yet. */
  removed: boolean
  /** The app the row uses: picked in the menu, or from {@link startingChoice}. */
  chosen: MeetingChoice | null
  /** The calendar's default when it could not be used, from {@link startingChoice}. */
  fellBack: MeetingChoice | null
  /** The user picked {@link chosen} in this editor session. */
  explicit: boolean
  /** {@link meetingChoices} for the event's calendar now. */
  choices: MeetingChoice[]
  calendar: SyncedCalendar | undefined
  account: MeetingAccount | null
  preferences: MeetingPreferences
  /** Guests on the event as the editor has it. */
  guests: number
  /** The saved event (the series' master for a series), or null for a new one. */
  event: SyncedCalendarEvent | null
  /** The server's time as the client knows it. */
  now: number
}

const TITLE = 'Meeting link'

function row(kind: MeetingRow['kind'], title: string, hint: string, tone: MeetingRow['tone'] = 'plain', icon: MeetingRow['icon'] = 'camera'): MeetingRow {
  return { kind, title, hint, tone, icon }
}

function guestCount(guests: number): string {
  return guests === 1 ? '1 guest' : `${guests} guests`
}

function ownHint(guests: number): string {
  return guests > 0 ? `Your own link is added to the invitation for ${guestCount(guests)} when you save.` : 'Your own link is added to the invitation when you save.'
}

/** "Connect Google Meet, Microsoft Teams, Zoom or your own link once.", without Zoom when the server has none. */
function noAppHint(preferences: MeetingPreferences): string {
  const apps = preferences.apps.includes('zoom') ? 'Google Meet, Microsoft Teams, Zoom or your own link' : 'Google Meet, Microsoft Teams or your own link'
  return `No meeting app connected yet. Connect ${apps} once.`
}

/** "{calendar} is a {kind} calendar" as the end of a sentence, or nothing when the calendar is not known. */
function calendarIs(calendar: SyncedCalendar | undefined): string {
  return calendar === undefined ? 'this is another kind of calendar' : `${calendar.name} is ${calendarKind(calendar)}`
}

/** The amber and red states for an app that cannot make the link, or null when the row asks to connect an app. */
function problemRow(problem: MeetingChoice, input: MeetingRowInput): MeetingRow | null {
  const address = input.account?.emailAddress ?? ''
  switch (problem.problem) {
    case 'reconnect': {
      const saved = input.event !== null && input.event.conference === null
      const hint = saved ? `The permission for ${address} expired. The event is saved without a link.` : `The permission for ${address} expired.`
      return row('reconnect', `Reconnect ${problem.label} to add a link`, hint, 'warn', 'warn')
    }
    case 'other_calendar': {
      // Only an app the user picked follows the event to a calendar it cannot serve; a default just falls back.
      if (!input.explicit) {
        return null
      }
      const how = problem.app === 'meet' ? 'A Meet link is made through a Google calendar event' : 'A Teams link is made through a Microsoft 365 calendar event'
      return row('wrong_calendar', `${problem.label} cannot make a link for this event`, `${how}, and ${calendarIs(input.calendar)}.`, 'warn', 'warn')
    }
    case 'unsupported':
      if (problem.app === 'teams') {
        return row('wrong_account', 'Teams cannot make a link with this account', `Teams links need a Microsoft 365 work or school account. ${address} cannot make them.`, 'warn', 'warn')
      }
      // A Google calendar on which the organization switched Meet off: the states board has no row for it.
      return row('wrong_calendar', `${problem.label} cannot make a link for this event`, problem.via, 'warn', 'warn')
    default:
      return null
  }
}

/**
 * The "Meeting link" row of the event editor: one of the board's states 1 to 11, with its title, hint, tone and
 * icon. State 12 (an event someone else organizes) is not the editor's: see {@link addedByText}.
 */
export function meetingRow(input: MeetingRowInput): MeetingRow {
  const { event, preferences, guests } = input

  // A Teams meeting on a Microsoft 365 event stays whatever the row was told: never "Removed", never another app.
  if (event !== null && event.conference !== null && cannotRemoveMeeting(input.calendar?.source, event.conference)) {
    return row('created', TITLE, createdHint(event.conference, input))
  }

  if (input.removed) {
    return row('removed', TITLE, guests > 0 ? 'Removed. When you save, guests get an update without the link.' : 'Removed. The link goes when you save.')
  }

  // A link asked for on the saved event, until the user picks something else in this session.
  if (event !== null && !input.explicit) {
    const request = event.conferenceRequest ?? null
    const state = requestState(event, input.now)
    if (request !== null && state === 'creating') {
      return row('creating', requestTitle(request, input.now), CREATING_HINT, 'plain', 'spinner')
    }
    if (request !== null && state === 'failed') {
      return row('failed', requestTitle(request, input.now), failureHint(request, input.now), 'error', 'error')
    }
    if (event.conference !== null && input.on) {
      return row('created', TITLE, createdHint(event.conference, input))
    }
  }

  if (!input.on) {
    // Only when a first guest would switch it on: the guests switch, a default that is not "none", an app that can.
    const promised =
      preferences.addWithGuests && guests === 0 && defaultMeetingApp(input.calendar, input.account, preferences) !== 'none' && input.choices.some((item) => item.ok)
    return row('off', TITLE, promised ? 'No meeting link. Tresso switches this on when you add a guest.' : 'No meeting link. People meet at the location.')
  }

  const chosen = input.chosen
  if (chosen !== null && chosen.ok) {
    const prefix = fellBackPrefix(input)
    if (chosen.app === 'own') {
      return row('own', TITLE, prefix + ownHint(guests))
    }
    const made = guests > 0 ? `Tresso makes the ${chosen.short} link when you save and adds it to the invitation for ${guestCount(guests)}.` : `Tresso makes the ${chosen.short} link when you save.`
    return row('ready', TITLE, prefix + made)
  }

  const problem = chosen ?? input.fellBack
  const amber = problem === null ? null : problemRow(problem, input)
  return amber ?? row('no_app', TITLE, noAppHint(preferences))
}

/** "{App}, the default for {calendar}, needs to be reconnected. " before the hint of a row that fell back. */
function fellBackPrefix(input: MeetingRowInput): string {
  const fellBack = input.fellBack
  if (fellBack === null || input.explicit) {
    return ''
  }
  const whose = input.calendar === undefined ? 'your default' : `the default for ${input.calendar.name}`
  return fellBack.problem === 'reconnect' ? `${fellBack.label}, ${whose}, needs to be reconnected. ` : `${fellBack.label}, ${whose}, cannot make a link here. `
}

/** State 6: who made the saved link, or the own link's hint. */
function createdHint(conference: Conference, input: MeetingRowInput): string {
  const ownLink = input.preferences.ownLink
  if (ownLink !== null && ownLink !== '' && conference.url === ownLink) {
    return ownHint(input.guests)
  }
  // Only Meet on a Google calendar and Teams on a Microsoft one are made by the calendar's account.
  const source = input.calendar?.source
  const madeByAccount = (conference.provider === 'meet' && source === 'google') || (conference.provider === 'teams' && source === 'microsoft')
  const address = input.account?.emailAddress ?? null
  if (!madeByAccount || address === null) {
    // A pasted link, or one from elsewhere: the calendar's account did not make it.
    return input.guests > 0 ? 'It is in the invitation.' : 'It is saved with the event.'
  }
  return input.guests > 0 ? `Made with ${address}. It is in the invitation.` : `Made with ${address}.`
}
