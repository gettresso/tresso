import { describe, expect, it } from 'vitest'
import { calendar, calendarEvent } from '../store/contract'
import {
  addedByText,
  appLabel,
  canJoin,
  conferenceLabel,
  CREATING_HINT,
  defaultMeetingApp,
  failureHint,
  joinLabel,
  linkText,
  MEETING_PENDING_MS,
  meetingChoices,
  meetingLinkError,
  meetingLinkProblem,
  meetingRow,
  needsReconnect,
  requestState,
  requestTitle,
  startingChoice,
  type MeetingAccount,
  type MeetingChoice,
  type MeetingLinkProblem,
  type MeetingPreferences,
  type MeetingRowInput,
} from './meeting'
import type { Conference, ConferenceRequest, SyncedCalendar } from './types'

const NOW = Date.parse('2026-11-13T09:00:00Z')
const OWN = 'https://meet.company.example/kim'
const TEAMS_URL = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${'N2Q4ZTk5YjAtYzE2Mi00'.repeat(8)}%40thread.v2/0?context=%7b%22Tid%22%3a%22d3b1%22%2c%22Oid%22%3a%22a1b2%22%7d`

const gmail: MeetingAccount = { id: 'gmail', emailAddress: 'kim@gmail.example', provider: 'gmail', status: 'active', calendarStatus: 'active' }
const work: MeetingAccount = { id: 'work', emailAddress: 'kim@company.example', provider: 'microsoft', status: 'active', calendarStatus: 'active' }
const outlook: MeetingAccount = { id: 'outlook', emailAddress: 'kim@outlook.example', provider: 'microsoft', status: 'active', calendarStatus: 'active' }
const dav: MeetingAccount = { id: 'dav', emailAddress: 'kim@fastmail.example', provider: 'imap', status: 'active', calendarStatus: 'active' }

const google = calendar('Personal', 'gmail', { source: 'google', conferenceProviders: ['meet'] })
const googleNoMeet = calendar('Club', 'gmail', { source: 'google', conferenceProviders: [] })
const microsoft = calendar('Work', 'work', { source: 'microsoft', conferenceProviders: ['teams'] })
const microsoftNoTeams = calendar('Home', 'outlook', { source: 'microsoft', conferenceProviders: [] })
const caldav = calendar('Family', 'dav', { source: 'caldav' })
const local = calendar('Side projects', null)

function preferences(extra: Partial<MeetingPreferences> = {}): MeetingPreferences {
  return { ownLink: OWN, addWithGuests: true, defaults: {}, defaultOther: null, disabled: [], apps: ['meet', 'teams', 'own'], ...extra }
}

function pick(choices: MeetingChoice[], app: MeetingChoice['app']): MeetingChoice {
  const found = choices.find((item) => item.app === app)
  if (found === undefined) {
    throw new Error(`no ${app}`)
  }
  return found
}

function request(extra: Partial<ConferenceRequest> = {}): ConferenceRequest {
  return { provider: 'teams', status: 'pending', reason: null, requestedAt: new Date(NOW - 10_000).toISOString(), ...extra }
}

function conference(provider: Conference['provider'], url: string): Conference {
  return { provider, url, id: null, dialIn: null }
}

/** The row for a calendar as the editor computes it: the choices, the starting app and the fall back. */
function rowInput(cal: SyncedCalendar | undefined, account: MeetingAccount | null, extra: Partial<MeetingRowInput> = {}, prefs = preferences()): MeetingRowInput {
  const choices = meetingChoices(cal, account, prefs)
  const start = startingChoice(choices, defaultMeetingApp(cal, account, prefs))
  return { on: true, removed: false, chosen: start.choice, fellBack: start.fellBack, explicit: false, choices, calendar: cal, account, preferences: prefs, guests: 0, event: null, now: NOW, ...extra }
}

describe('app names', () => {
  it('names every app', () => {
    expect(['meet', 'teams', 'zoom', 'own'].map((app) => appLabel(app as MeetingChoice['app']))).toEqual(['Google Meet', 'Microsoft Teams', 'Zoom', 'My own link'])
  })

  it('names the app of an event link, the saved own link first', () => {
    expect(conferenceLabel(conference('teams', TEAMS_URL), OWN)).toBe('Microsoft Teams')
    expect(conferenceLabel(conference('meet', 'https://meet.google.com/abc-defg-hij'), OWN)).toBe('Google Meet')
    expect(conferenceLabel(conference('zoom', 'https://zoom.us/j/1'), OWN)).toBe('Zoom')
    expect(conferenceLabel(conference('webex', 'https://x.webex.com/meet/kim'), OWN)).toBe('Webex')
    expect(conferenceLabel(conference('other', OWN), OWN)).toBe('My own link')
    expect(conferenceLabel(conference('zoom', OWN), OWN)).toBe('My own link')
    expect(conferenceLabel(conference('other', 'https://jitsi.example/room'), OWN)).toBe('Meeting link')
    expect(conferenceLabel(conference('other', OWN), null)).toBe('Meeting link')
    expect(conferenceLabel(conference('other', ''), '')).toBe('Meeting link')
  })

  it('words the Join button per app', () => {
    expect(joinLabel('teams')).toBe('Join with Microsoft Teams')
    expect(joinLabel('meet')).toBe('Join with Google Meet')
    expect(joinLabel('zoom')).toBe('Join with Zoom')
    expect(joinLabel('webex')).toBe('Join with Webex')
    expect(joinLabel('other')).toBe('Join the meeting')
  })

  it('says who added the link on an event someone else organizes', () => {
    expect(addedByText(conference('teams', TEAMS_URL), OWN, 'Sam de Vries')).toBe('Microsoft Teams, added by Sam de Vries. Only the organizer can change it.')
  })
})

describe('link text', () => {
  it('drops the scheme and keeps a short link whole', () => {
    expect(linkText('https://meet.google.com/abc-defg-hij')).toBe('meet.google.com/abc-defg-hij')
    expect(linkText('http://example.com/x')).toBe('example.com/x')
  })

  it('cuts a 250 character Teams link in the middle to the given length', () => {
    expect(TEAMS_URL.length).toBeGreaterThanOrEqual(250)
    const text = linkText(TEAMS_URL)
    expect(text).toHaveLength(44)
    expect(text.startsWith('teams.microsoft.com/l/')).toBe(true)
    expect(text).toContain('\u2026')
    expect(text.endsWith('%22%7d')).toBe(true)
    expect(linkText(TEAMS_URL, 20)).toHaveLength(20)
  })

  it('never splits a character made of two code units', () => {
    const text = linkText(`https://example.com/${'\u{1F600}'.repeat(60)}`, 11)
    expect(Array.from(text)).toHaveLength(11)
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })
})

describe('meeting link check', () => {
  it('takes plain https links', () => {
    for (const link of [OWN, TEAMS_URL, 'https://zoom.us/j/123?pwd=abc', 'https://whereby.com/kim', 'https://meet.example.com:8443/room#x', 'https://b\u00fccher.example/raum', 'https://xn--bcher-kva.example/', 'https://example.com.']) {
      expect(meetingLinkProblem(link), link).toBeNull()
    }
  })

  const refused: [string, MeetingLinkProblem][] = [
    ['', 'empty'],
    [`https://example.com/${'a'.repeat(2048)}`, 'too_long'],
    [' https://example.com/room', 'whitespace'],
    ['https://example.com/room ', 'whitespace'],
    ['https://example.com/room\n', 'whitespace'],
    ['https://example.com/a room', 'whitespace'],
    ['https://example.com/\u00a0room', 'whitespace'],
    ['https://example.com/\u2028', 'whitespace'],
    ['https://example.com/\u0000', 'control'],
    ['https://example.com/\u007f', 'control'],
    ['https://example.com/\u0085', 'control'],
    ['https://exa\u200bmple.com/room', 'control'],
    ['https://example.com/\u202emoc.live', 'control'],
    ['https://example.com/\u2066x', 'control'],
    ['\ufeffhttps://example.com/', 'whitespace'],
    ['https://example.com/\u180e', 'control'],
    ['https://example.com/\u00adroom', 'control'],
    ['http://example.com/room', 'not_https'],
    ['HTTPS://example.com/room', 'not_https'],
    ['javascript:alert(1)//https://example.com', 'not_https'],
    ['JavaScript:alert(document.cookie)', 'not_https'],
    ['data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'not_https'],
    ['file:///etc/passwd', 'not_https'],
    ['//example.com/room', 'not_https'],
    ['example.com/room', 'not_https'],
    ['https:example.com', 'not_https'],
    ['https://kim:secret@example.com/room', 'credentials'],
    ['https://kim@example.com/room', 'credentials'],
    ['https://example.com@evil.example/', 'credentials'],
    ['https://localhost/room', 'no_host'],
    ['https:///room', 'no_host'],
    ['https://', 'no_host'],
    ['https://[::1]/room', 'no_host'],
    ['https://example.com\\@evil.example/', 'invalid'],
    ['https://example.com:0/', 'invalid'],
    ['https://example.com:99999/', 'invalid'],
    ['https://example.com:/', 'invalid'],
    ['https://a:b:c/', 'invalid'],
    ['https://exa_mple.com/', 'invalid'],
    ['https://-example.com/', 'invalid'],
    ['https://example..com/', 'invalid'],
    ['https://<script>.com/', 'invalid'],
  ]
  it.each(refused)('refuses %j as %s', (link, problem) => {
    expect(meetingLinkProblem(link)).toBe(problem)
  })

  it('answers very long input at once without reading it all', () => {
    const huge = `https://example.com/${'a'.repeat(1_000_000)}`
    const started = performance.now()
    expect(meetingLinkProblem(huge)).toBe('too_long')
    expect(performance.now() - started).toBeLessThan(50)
    expect(meetingLinkProblem(`https://${'a.'.repeat(1000)}x`)).toBe(null)
    expect(meetingLinkProblem(`https://${'a'.repeat(64)}.example/`)).toBe('invalid')
  })

  it('explains each problem without repeating the link', () => {
    const problems: MeetingLinkProblem[] = ['empty', 'too_long', 'whitespace', 'control', 'not_https', 'credentials', 'no_host', 'invalid']
    expect(problems.map(meetingLinkError)).toEqual([
      'Paste your room link.',
      'Use a link of at most 2048 characters.',
      'Use a link without spaces, line breaks or hidden characters.',
      'Use a link without spaces, line breaks or hidden characters.',
      'Use a link that starts with https://.',
      'Use a link without a user name or password in it.',
      'Use a link with a full web address, such as https://meet.example.com/room.',
      'Use a link that starts with https://.',
    ])
  })

  it('lets Join open only plain https links', () => {
    expect(canJoin(conference('teams', TEAMS_URL))).toBe(true)
    expect(canJoin(conference('other', 'javascript:alert(1)'))).toBe(false)
    expect(canJoin(conference('other', 'data:text/html,<b>x</b>'))).toBe(false)
    expect(canJoin(conference('other', 'tel:+31201234567'))).toBe(false)
    expect(canJoin(conference('other', 'https://kim:pw@example.com/'))).toBe(false)
  })
})

describe('accounts that need reconnecting', () => {
  it('reads the sign-in and the calendar access', () => {
    expect(needsReconnect(null)).toBe(false)
    expect(needsReconnect(gmail)).toBe(false)
    expect(needsReconnect({ ...gmail, status: 'auth_failed' })).toBe(true)
    expect(needsReconnect({ ...gmail, calendarStatus: 'not_granted' })).toBe(true)
    expect(needsReconnect({ ...gmail, calendarStatus: 'auth_failed' })).toBe(true)
    expect(needsReconnect({ ...gmail, status: 'paused', calendarStatus: 'error' })).toBe(false)
  })
})

describe('which apps a calendar can use', () => {
  it('lists the apps the server offers in the menu order, Zoom only when offered', () => {
    expect(meetingChoices(google, gmail, preferences()).map((item) => item.app)).toEqual(['teams', 'meet', 'own'])
    expect(meetingChoices(google, gmail, preferences({ apps: ['meet', 'teams', 'own', 'zoom'] })).map((item) => item.app)).toEqual(['teams', 'meet', 'own', 'zoom'])
    expect(meetingChoices(google, gmail, preferences({ apps: ['own'] })).map((item) => item.app)).toEqual(['own'])
  })

  it('offers Meet on a Google calendar with Meet, with the account', () => {
    expect(pick(meetingChoices(google, gmail, preferences()), 'meet')).toEqual({ app: 'meet', label: 'Google Meet', short: 'Google Meet', company: 'Google', ok: true, problem: null, via: 'With kim@gmail.example' })
  })

  it('offers Teams on a Microsoft 365 calendar with Teams, with the account', () => {
    expect(pick(meetingChoices(microsoft, work, preferences()), 'teams')).toEqual({ app: 'teams', label: 'Microsoft Teams', short: 'Teams', company: 'Microsoft', ok: true, problem: null, via: 'With kim@company.example' })
  })

  it('says Meet is only for Google calendars, per kind of calendar', () => {
    expect(pick(meetingChoices(microsoft, work, preferences()), 'meet')).toMatchObject({ ok: false, problem: 'other_calendar', via: 'Only for events on a Google calendar. Work is a Microsoft 365 calendar.' })
    expect(pick(meetingChoices(caldav, dav, preferences()), 'meet').via).toBe('Only for events on a Google calendar. Family is a CalDAV calendar.')
    expect(pick(meetingChoices(local, null, preferences()), 'meet').via).toBe('Only for events on a Google calendar. Side projects is a calendar in Tresso.')
    expect(pick(meetingChoices(undefined, null, preferences()), 'meet')).toMatchObject({ problem: 'other_calendar', via: 'Only for events on a Google calendar.' })
  })

  it('says Teams is only for Microsoft 365 calendars, per kind of calendar', () => {
    expect(pick(meetingChoices(google, gmail, preferences()), 'teams')).toMatchObject({ ok: false, problem: 'other_calendar', via: 'Only for events on a Microsoft 365 calendar. Personal is a Google calendar.' })
    expect(pick(meetingChoices(caldav, dav, preferences()), 'teams').via).toBe('Only for events on a Microsoft 365 calendar. Family is a CalDAV calendar.')
    expect(pick(meetingChoices(local, null, preferences()), 'teams').via).toBe('Only for events on a Microsoft 365 calendar. Side projects is a calendar in Tresso.')
  })

  it('asks to reconnect an account that lost its sign-in or calendar access', () => {
    for (const account of [{ ...gmail, status: 'auth_failed' }, { ...gmail, calendarStatus: 'not_granted' }, { ...gmail, calendarStatus: 'auth_failed' }]) {
      expect(pick(meetingChoices(google, account, preferences()), 'meet')).toMatchObject({ ok: false, problem: 'reconnect', via: 'kim@gmail.example needs to be reconnected first.' })
    }
    expect(pick(meetingChoices(microsoft, { ...work, status: 'auth_failed' }, preferences()), 'teams')).toMatchObject({ ok: false, problem: 'reconnect', via: 'kim@company.example needs to be reconnected first.' })
  })

  it('reads reconnecting before a calendar list the lost access left empty', () => {
    expect(pick(meetingChoices(microsoftNoTeams, { ...outlook, calendarStatus: 'not_granted' }, preferences()), 'teams').problem).toBe('reconnect')
  })

  it('says when a Google calendar has no Meet', () => {
    expect(pick(meetingChoices(googleNoMeet, gmail, preferences()), 'meet')).toMatchObject({ ok: false, problem: 'unsupported', via: 'Google Meet is not available for Club.' })
  })

  it('says when a Microsoft account cannot make Teams links', () => {
    expect(pick(meetingChoices(microsoftNoTeams, outlook, preferences()), 'teams')).toMatchObject({
      ok: false,
      problem: 'unsupported',
      via: 'Teams links need a Microsoft 365 work or school account. kim@outlook.example cannot make them.',
    })
  })

  it('says an app the user switched off for the account is not connected, before anything else about it', () => {
    const prefs = preferences({ disabled: [{ app: 'meet', mailAccountId: 'gmail' }, { app: 'teams', mailAccountId: 'work' }] })
    expect(pick(meetingChoices(google, { ...gmail, status: 'auth_failed' }, prefs), 'meet')).toMatchObject({ ok: false, problem: 'off', via: 'Not connected. Connect it in Settings.' })
    expect(pick(meetingChoices(microsoft, work, prefs), 'teams')).toMatchObject({ ok: false, problem: 'off', via: 'Not connected. Connect it in Settings.' })
    // Switched off for another account only.
    expect(pick(meetingChoices(google, gmail, preferences({ disabled: [{ app: 'meet', mailAccountId: 'other' }] })), 'meet').ok).toBe(true)
  })

  it('does not offer Meet or Teams for a provider calendar whose account is not known', () => {
    expect(pick(meetingChoices(google, null, preferences()), 'meet')).toMatchObject({ ok: false, problem: 'not_connected', via: 'Not connected. Connect it in Settings.' })
  })

  it('offers the own link on every calendar once it is saved', () => {
    for (const [cal, account] of [[google, gmail], [microsoft, work], [caldav, dav], [local, null]] as const) {
      expect(pick(meetingChoices(cal, account, preferences()), 'own')).toEqual({
        app: 'own',
        label: 'My own link',
        short: 'My own link',
        company: '',
        ok: true,
        problem: null,
        via: 'meet.company.example/kim, the same room every time',
      })
    }
    expect(pick(meetingChoices(local, null, preferences({ ownLink: null })), 'own')).toMatchObject({ ok: false, problem: 'no_link', via: 'Paste your room link in Settings first.' })
    expect(pick(meetingChoices(local, null, preferences({ ownLink: '' })), 'own').problem).toBe('no_link')
    expect(pick(meetingChoices(local, null, preferences({ ownLink: 'javascript:alert(1)' })), 'own').problem).toBe('no_link')
  })

  it('shows Zoom as not connected yet when the server offers it', () => {
    expect(pick(meetingChoices(caldav, dav, preferences({ apps: ['meet', 'teams', 'own', 'zoom'] })), 'zoom')).toEqual({
      app: 'zoom',
      label: 'Zoom',
      short: 'Zoom',
      company: 'Zoom',
      ok: false,
      problem: 'not_connected',
      via: 'Not connected yet.',
    })
  })
})

describe('default app and fall back', () => {
  it("takes the account's entry, then the one for other calendars, then the natural app", () => {
    expect(defaultMeetingApp(google, gmail, preferences({ defaults: { gmail: 'own' }, defaultOther: 'none' }))).toBe('own')
    expect(defaultMeetingApp(google, gmail, preferences({ defaults: { gmail: 'none' } }))).toBe('none')
    expect(defaultMeetingApp(google, gmail, preferences({ defaults: { work: 'teams' }, defaultOther: 'own' }))).toBe('own')
    expect(defaultMeetingApp(local, null, preferences({ defaultOther: 'none' }))).toBe('none')
    expect(defaultMeetingApp(google, gmail, preferences())).toBe('meet')
    expect(defaultMeetingApp(microsoft, work, preferences())).toBe('teams')
    expect(defaultMeetingApp(caldav, dav, preferences())).toBe('own')
    expect(defaultMeetingApp(local, null, preferences())).toBe('own')
    expect(defaultMeetingApp(caldav, dav, preferences({ ownLink: null }))).toBe('none')
    expect(defaultMeetingApp(undefined, null, preferences())).toBeNull()
    expect(defaultMeetingApp(undefined, null, preferences({ defaultOther: 'own' }))).toBe('own')
  })

  it('does not read entries from the object prototype', () => {
    expect(defaultMeetingApp(calendar('Odd', 'constructor', { source: 'caldav' }), null, preferences())).toBe('own')
  })

  it('starts with the default when it can make a link', () => {
    const choices = meetingChoices(google, gmail, preferences())
    expect(startingChoice(choices, 'meet')).toEqual({ choice: pick(choices, 'meet'), fellBack: null })
    expect(startingChoice(choices, 'own')).toEqual({ choice: pick(choices, 'own'), fellBack: null })
  })

  it('falls back in the order Teams, Meet, own link, Zoom, keeping the default to say why', () => {
    const choices = meetingChoices(google, { ...gmail, status: 'auth_failed' }, preferences())
    expect(startingChoice(choices, 'meet')).toEqual({ choice: pick(choices, 'own'), fellBack: pick(choices, 'meet') })
    const onMicrosoft = meetingChoices(microsoft, work, preferences())
    expect(startingChoice(onMicrosoft, 'meet')).toEqual({ choice: pick(onMicrosoft, 'teams'), fellBack: pick(onMicrosoft, 'meet') })
    expect(startingChoice(onMicrosoft, 'zoom')).toEqual({ choice: pick(onMicrosoft, 'teams'), fellBack: null })
  })

  it('has no app when none can make a link', () => {
    const choices = meetingChoices(caldav, dav, preferences({ ownLink: null }))
    expect(startingChoice(choices, 'own')).toEqual({ choice: null, fellBack: pick(choices, 'own') })
    expect(startingChoice(choices, 'none')).toEqual({ choice: null, fellBack: null })
  })

  it('takes the first app that can when the row is switched on without a default', () => {
    const choices = meetingChoices(microsoft, work, preferences())
    expect(startingChoice(choices, 'none')).toEqual({ choice: pick(choices, 'teams'), fellBack: null })
    expect(startingChoice(choices, null)).toEqual({ choice: pick(choices, 'teams'), fellBack: null })
  })
})

describe('state of a requested link', () => {
  const at = (ms: number): string => new Date(NOW - ms).toISOString()

  it('is none with a conference or without a request', () => {
    expect(requestState({ conference: conference('teams', TEAMS_URL), conferenceRequest: request() }, NOW)).toBe('none')
    expect(requestState({ conference: null, conferenceRequest: null }, NOW)).toBe('none')
    expect(requestState({ conference: null }, NOW)).toBe('none')
  })

  it('is creating up to 120 seconds and failed after', () => {
    expect(MEETING_PENDING_MS).toBe(120_000)
    expect(requestState({ conference: null, conferenceRequest: request({ requestedAt: at(119_000) }) }, NOW)).toBe('creating')
    expect(requestState({ conference: null, conferenceRequest: request({ requestedAt: at(120_000) }) }, NOW)).toBe('creating')
    expect(requestState({ conference: null, conferenceRequest: request({ requestedAt: at(121_000) }) }, NOW)).toBe('failed')
    // A device clock behind the server's: still being made.
    expect(requestState({ conference: null, conferenceRequest: request({ requestedAt: at(-30_000) }) }, NOW)).toBe('creating')
  })

  it('is failed when the server says so, or when the time cannot be read', () => {
    expect(requestState({ conference: null, conferenceRequest: request({ status: 'failed', reason: 'refused' }) }, NOW)).toBe('failed')
    expect(requestState({ conference: null, conferenceRequest: request({ requestedAt: 'soon' }) }, NOW)).toBe('failed')
  })

  it('names what is made and what failed', () => {
    expect(requestTitle(request(), NOW)).toBe('Making the Teams link')
    expect(requestTitle(request({ provider: 'meet' }), NOW)).toBe('Making the Google Meet link')
    expect(requestTitle(request({ provider: 'zoom', requestedAt: at(121_000) }), NOW)).toBe('Could not make the Zoom link')
    expect(requestTitle(request({ status: 'failed', reason: 'refused' }), NOW)).toBe('Could not make the Teams link')
  })

  it('says why it failed', () => {
    expect(failureHint(request({ requestedAt: at(121_000) }), NOW)).toBe('The event is saved without a link. Microsoft did not answer in time.')
    expect(failureHint(request({ status: 'failed', reason: 'unreachable', provider: 'meet' }), NOW)).toBe('The event is saved without a link. Google did not answer in time.')
    expect(failureHint(request({ status: 'failed', reason: 'refused' }), NOW)).toBe('The event is saved without a link. Microsoft refused to make it.')
    expect(failureHint(request({ status: 'failed', reason: null, provider: 'meet' }), NOW)).toBe('The event is saved without a link. Google refused to make it.')
    expect(failureHint(request({ status: 'failed', reason: 'not_supported' }), NOW)).toBe('The event is saved without a link. Microsoft Teams is not available for this calendar.')
    expect(failureHint(request({ status: 'failed', reason: 'not_supported', provider: 'meet' }), NOW)).toBe('The event is saved without a link. Google Meet is not available for this calendar.')
    expect(failureHint(request(), NOW)).toBe(CREATING_HINT)
  })
})

describe('the meeting link row', () => {
  const saved = (extra: Parameters<typeof calendarEvent>[2] = {}) => calendarEvent('e1', microsoft.id, extra)

  it('1: off, promising the link with the first guest only when that will happen', () => {
    expect(meetingRow(rowInput(microsoft, work, { on: false }))).toEqual({
      kind: 'off',
      title: 'Meeting link',
      hint: 'No meeting link. Tresso switches this on when you add a guest.',
      tone: 'plain',
      icon: 'camera',
    })
    expect(meetingRow(rowInput(microsoft, work, { on: false, guests: 2 })).hint).toBe('No meeting link. People meet at the location.')
    expect(meetingRow(rowInput(microsoft, work, { on: false }, preferences({ addWithGuests: false }))).hint).toBe('No meeting link. People meet at the location.')
    expect(meetingRow(rowInput(microsoft, work, { on: false }, preferences({ defaults: { work: 'none' } }))).hint).toBe('No meeting link. People meet at the location.')
  })

  it('2: no app connected yet, with Zoom only when the server offers it', () => {
    const prefs = preferences({ ownLink: null })
    expect(meetingRow(rowInput(caldav, dav, {}, prefs))).toEqual({
      kind: 'no_app',
      title: 'Meeting link',
      hint: 'No meeting app connected yet. Connect Google Meet, Microsoft Teams or your own link once.',
      tone: 'plain',
      icon: 'camera',
    })
    expect(meetingRow(rowInput(caldav, dav, {}, preferences({ ownLink: null, apps: ['meet', 'teams', 'own', 'zoom'] }))).hint).toBe(
      'No meeting app connected yet. Connect Google Meet, Microsoft Teams, Zoom or your own link once.',
    )
    // Meet switched off by the user and no own link.
    expect(meetingRow(rowInput(google, gmail, {}, preferences({ ownLink: null, disabled: [{ app: 'meet', mailAccountId: 'gmail' }] }))).kind).toBe('no_app')
  })

  it('3: on before saving, per number of guests', () => {
    expect(meetingRow(rowInput(microsoft, work))).toEqual({ kind: 'ready', title: 'Meeting link', hint: 'Tresso makes the Teams link when you save.', tone: 'plain', icon: 'camera' })
    expect(meetingRow(rowInput(microsoft, work, { guests: 1 })).hint).toBe('Tresso makes the Teams link when you save and adds it to the invitation for 1 guest.')
    expect(meetingRow(rowInput(google, gmail, { guests: 4 })).hint).toBe('Tresso makes the Google Meet link when you save and adds it to the invitation for 4 guests.')
  })

  it('3: says first that the default could not be used', () => {
    const reconnect = { ...gmail, calendarStatus: 'not_granted' }
    const prefs = preferences({ ownLink: null, defaults: { gmail: 'teams' } })
    // Teams as the default of a Google calendar, with Meet working: falls back to Meet.
    expect(meetingRow(rowInput(google, gmail, { guests: 2 }, prefs)).hint).toBe(
      'Microsoft Teams, the default for Personal, cannot make a link here. Tresso makes the Google Meet link when you save and adds it to the invitation for 2 guests.',
    )
    // Meet needs reconnecting: falls back to the own link (state 4 hint).
    expect(meetingRow(rowInput(google, reconnect))).toEqual({
      kind: 'own',
      title: 'Meeting link',
      hint: 'Google Meet, the default for Personal, needs to be reconnected. Your own link is added to the invitation when you save.',
      tone: 'plain',
      icon: 'camera',
    })
  })

  it('4: on with the own link, per number of guests', () => {
    expect(meetingRow(rowInput(caldav, dav))).toEqual({ kind: 'own', title: 'Meeting link', hint: 'Your own link is added to the invitation when you save.', tone: 'plain', icon: 'camera' })
    expect(meetingRow(rowInput(local, null, { guests: 1 })).hint).toBe('Your own link is added to the invitation for 1 guest when you save.')
    expect(meetingRow(rowInput(local, null, { guests: 3 })).hint).toBe('Your own link is added to the invitation for 3 guests when you save.')
  })

  it('5: creating while the request is young', () => {
    const event = saved({ conferenceRequest: request({ requestedAt: new Date(NOW - 119_000).toISOString() }) })
    expect(meetingRow(rowInput(microsoft, work, { event }))).toEqual({
      kind: 'creating',
      title: 'Making the Teams link',
      hint: 'The event is saved. This usually takes a few seconds.',
      tone: 'plain',
      icon: 'spinner',
    })
  })

  it('6: created, with the account that made it', () => {
    const event = saved({ conference: conference('teams', TEAMS_URL) })
    expect(meetingRow(rowInput(microsoft, work, { event }))).toEqual({ kind: 'created', title: 'Meeting link', hint: 'Made with kim@company.example.', tone: 'plain', icon: 'camera' })
    expect(meetingRow(rowInput(microsoft, work, { event, guests: 3 })).hint).toBe('Made with kim@company.example. It is in the invitation.')
    const own = saved({ conference: conference('other', OWN) })
    expect(meetingRow(rowInput(microsoft, work, { event: own, guests: 2 }))).toMatchObject({ kind: 'created', hint: 'Your own link is added to the invitation for 2 guests when you save.' })
    const pasted = calendarEvent('e2', local.id, { conference: conference('other', 'https://jitsi.example/room') })
    expect(meetingRow(rowInput(local, null, { event: pasted, guests: 1 })).hint).toBe('It is in the invitation.')
    expect(meetingRow(rowInput(local, null, { event: pasted })).hint).toBe('It is saved with the event.')
  })

  it('7: could not create, per reason and after waiting too long', () => {
    const late = saved({ conferenceRequest: request({ requestedAt: new Date(NOW - 121_000).toISOString() }) })
    expect(meetingRow(rowInput(microsoft, work, { event: late }))).toEqual({
      kind: 'failed',
      title: 'Could not make the Teams link',
      hint: 'The event is saved without a link. Microsoft did not answer in time.',
      tone: 'error',
      icon: 'error',
    })
    const refused = saved({ conferenceRequest: request({ provider: 'meet', status: 'failed', reason: 'refused' }) })
    expect(meetingRow(rowInput(google, gmail, { event: refused }))).toMatchObject({ title: 'Could not make the Google Meet link', hint: 'The event is saved without a link. Google refused to make it.' })
    const unsupported = saved({ conferenceRequest: request({ status: 'failed', reason: 'not_supported' }) })
    expect(meetingRow(rowInput(microsoft, work, { event: unsupported })).hint).toBe('The event is saved without a link. Microsoft Teams is not available for this calendar.')
    const unreachable = saved({ conferenceRequest: request({ status: 'failed', reason: 'unreachable' }) })
    expect(meetingRow(rowInput(microsoft, work, { event: unreachable })).hint).toBe('The event is saved without a link. Microsoft did not answer in time.')
  })

  it('7: gives way to an app the user picks after the failure', () => {
    const event = saved({ conferenceRequest: request({ status: 'failed', reason: 'refused' }) })
    const input = rowInput(microsoft, work, { event })
    expect(meetingRow({ ...input, explicit: true, chosen: pick(input.choices, 'own') }).kind).toBe('own')
  })

  it('8: reconnect the chosen app, before saving and on a saved event without a link', () => {
    const lost = { ...work, status: 'auth_failed' }
    const prefs = preferences({ ownLink: null })
    expect(meetingRow(rowInput(microsoft, lost, {}, prefs))).toEqual({
      kind: 'reconnect',
      title: 'Reconnect Microsoft Teams to add a link',
      hint: 'The permission for kim@company.example expired.',
      tone: 'warn',
      icon: 'warn',
    })
    expect(meetingRow(rowInput(microsoft, lost, { event: saved() }, prefs)).hint).toBe('The permission for kim@company.example expired. The event is saved without a link.')
    // Picked by hand while another app could make the link.
    const input = rowInput(google, { ...gmail, calendarStatus: 'not_granted' })
    expect(meetingRow({ ...input, explicit: true, chosen: pick(input.choices, 'meet'), fellBack: null }).kind).toBe('reconnect')
  })

  it('9: the picked app cannot serve the calendar the event moved to', () => {
    const after = rowInput(microsoftNoTeams, outlook, { explicit: true, chosen: pick(meetingChoices(microsoftNoTeams, outlook, preferences()), 'meet') })
    expect(meetingRow(after)).toEqual({
      kind: 'wrong_calendar',
      title: 'Google Meet cannot make a link for this event',
      hint: 'A Meet link is made through a Google calendar event, and Home is a Microsoft 365 calendar.',
      tone: 'warn',
      icon: 'warn',
    })
    const teamsOnDav = rowInput(caldav, dav, { explicit: true, chosen: pick(meetingChoices(caldav, dav, preferences()), 'teams') })
    expect(meetingRow(teamsOnDav).hint).toBe('A Teams link is made through a Microsoft 365 calendar event, and Family is a CalDAV calendar.')
    const teamsOnLocal = rowInput(local, null, { explicit: true, chosen: pick(meetingChoices(local, null, preferences()), 'teams') })
    expect(meetingRow(teamsOnLocal).hint).toBe('A Teams link is made through a Microsoft 365 calendar event, and Side projects is a calendar in Tresso.')
  })

  it('9: a default that cannot serve the calendar falls back instead', () => {
    expect(meetingRow(rowInput(caldav, dav, {}, preferences({ ownLink: null, defaultOther: 'meet', defaults: {} }))).kind).toBe('no_app')
  })

  it('10: Teams cannot make a link with this account', () => {
    const picked = rowInput(microsoftNoTeams, outlook, { explicit: true, chosen: pick(meetingChoices(microsoftNoTeams, outlook, preferences()), 'teams') })
    expect(meetingRow(picked)).toEqual({
      kind: 'wrong_account',
      title: 'Teams cannot make a link with this account',
      hint: 'Teams links need a Microsoft 365 work or school account. kim@outlook.example cannot make them.',
      tone: 'warn',
      icon: 'warn',
    })
    // The natural default with nothing else to fall back to.
    expect(meetingRow(rowInput(microsoftNoTeams, outlook, {}, preferences({ ownLink: null }))).kind).toBe('wrong_account')
  })

  it('a Google calendar without Meet, picked by hand, says Meet is not available there', () => {
    const picked = rowInput(googleNoMeet, gmail, { explicit: true, chosen: pick(meetingChoices(googleNoMeet, gmail, preferences()), 'meet') })
    expect(meetingRow(picked)).toMatchObject({ kind: 'wrong_calendar', title: 'Google Meet cannot make a link for this event', hint: 'Google Meet is not available for Club.' })
  })

  it('11: removed, per guests', () => {
    const event = saved({ conference: conference('teams', TEAMS_URL) })
    expect(meetingRow(rowInput(microsoft, work, { event, removed: true, on: false, guests: 2 }))).toEqual({
      kind: 'removed',
      title: 'Meeting link',
      hint: 'Removed. When you save, guests get an update without the link.',
      tone: 'plain',
      icon: 'camera',
    })
    expect(meetingRow(rowInput(microsoft, work, { event, removed: true, on: false })).hint).toBe('Removed. The link goes when you save.')
  })
})
