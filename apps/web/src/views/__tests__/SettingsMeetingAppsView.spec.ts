import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { MailAccount, MeetingPreferences } from '@tresso/core'
import { calendar } from '@tresso/core/testing'
import { useAccountsStore } from '@/stores/accounts'
import { useMeetingAppsStore } from '@/stores/meetingApps'
import { useCalendarStore, type KeptEditor } from '@/stores/calendar'
import { useMailStore } from '@/stores/mail'
import SettingsMeetingAppsView from '../SettingsMeetingAppsView.vue'

function account(id: string, provider: string, emailAddress: string, displayName: string, extra: Partial<MailAccount> = {}): MailAccount {
  return {
    id,
    emailAddress,
    displayName,
    provider,
    status: 'active',
    statusDetail: null,
    username: null,
    imap: null,
    smtp: null,
    calendarUrl: null,
    calendarStatus: 'active',
    calendarStatusDetail: null,
    lastSyncedAt: null,
    createdAt: '2026-01-01T00:00:00+00:00',
    defaultSignatureId: null,
    ...extra,
  } as MailAccount
}

const GMAIL = account('gmail', 'gmail', 'kim@gmail.example', 'Kim at Google')
const WORK = account('work', 'microsoft', 'kim@company.example', 'Work')
const PERSONAL = account('personal', 'microsoft', 'kim@outlook.example', 'Personal Outlook')
const FASTMAIL = account('fastmail', 'imap', 'kim@fastmail.example', 'Fastmail')

const CALENDARS = [
  calendar('g', 'gmail', { source: 'google', name: 'Kim', isDefault: true, conferenceProviders: ['meet'] }),
  calendar('w', 'work', { source: 'microsoft', name: 'Work', isDefault: true, conferenceProviders: ['teams'] }),
  calendar('p', 'personal', { source: 'microsoft', name: 'Calendar', isDefault: true, conferenceProviders: [] }),
  calendar('f', 'fastmail', { source: 'caldav', name: 'Fastmail', isDefault: true }),
]

function preferences(extra: Partial<MeetingPreferences> = {}): MeetingPreferences {
  return { ownLink: null, addWithGuests: true, defaults: {}, defaultOther: null, disabled: [], apps: ['meet', 'teams', 'own'], ...extra }
}

/** Form events and requests settle over a few ticks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises()
  }
}

describe('Settings, Meeting apps', () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  let stored: MeetingPreferences
  let accounts: MailAccount[]
  let refuse: string | null
  let violations: { propertyPath: string; message: string }[]
  let offline: boolean
  let failRead: boolean
  /** While set, PATCH answers wait for it: a test releases them one by one. */
  let hold: Promise<void> | null

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    stored = preferences()
    accounts = [GMAIL, WORK, PERSONAL, FASTMAIL]
    refuse = null
    violations = []
    offline = false
    failRead = false
    hold = null
    useMailStore().calendars = CALENDARS
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const method = init?.method ?? 'GET'
        const path = new URL(String(input)).pathname
        const body = init?.body ? (JSON.parse(String(init.body)) as Partial<MeetingPreferences>) : undefined
        requests.push({ method, path, body })
        if (offline && method === 'PATCH') {
          throw new TypeError('Failed to fetch')
        }
        if (failRead && method === 'GET' && path === '/api/v1/calendar/meeting-preferences') {
          return new Response(JSON.stringify({ detail: 'The server is busy. Try again in a moment.' }), { status: 503, headers: { 'Content-Type': 'application/problem+json' } })
        }
        if (method === 'PATCH' && hold !== null) {
          await hold
        }
        if (path === '/api/v1/mail-accounts') {
          return new Response(JSON.stringify(accounts))
        }
        if (method === 'PATCH' && refuse !== null) {
          return new Response(JSON.stringify({ detail: refuse, violations }), { status: 422, headers: { 'Content-Type': 'application/problem+json' } })
        }
        if (method === 'PATCH') {
          const patch = body ?? {}
          stored = { ...stored, ...patch, ownLink: patch.ownLink === undefined ? stored.ownLink : patch.ownLink === '' ? null : patch.ownLink }
        }
        return new Response(JSON.stringify(stored))
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  async function page() {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/settings/accounts/new', name: 'settings-accounts-new', component: { template: '<div />' } }, { path: '/calendar', name: 'calendar', component: { template: '<div />' } }] })
    const wrapper = mount(SettingsMeetingAppsView, { global: { plugins: [router] }, attachTo: document.body })
    await settle()
    return wrapper
  }

  const patches = () => requests.filter((request) => request.method === 'PATCH').map((request) => request.body)
  const card = (wrapper: Awaited<ReturnType<typeof page>>, name: string) => wrapper.findAll('article.card').find((item) => item.get('h4').text() === name)!

  it('shows the Meet, Teams and own link cards, with a row per account that can use the app', async () => {
    const wrapper = await page()
    expect(wrapper.text()).toContain('Saved automatically')
    expect(wrapper.findAll('article.card h4').map((item) => item.text())).toEqual(['Google Meet', 'Microsoft Teams', 'My own link'])
    const meet = card(wrapper, 'Google Meet')
    expect(meet.findAll('.row .address').map((item) => item.text())).toEqual(['kim@gmail.example'])
    expect(meet.get('.row .status').text()).toBe('Connected through this Google account')
    expect(meet.get('.pill').text()).toBe('Connected')
    // A Microsoft account whose calendars cannot have Teams is no row.
    const teams = card(wrapper, 'Microsoft Teams')
    expect(teams.findAll('.row .address').map((item) => item.text())).toEqual(['kim@company.example'])
    expect(teams.get('.row .status').text()).toBe('Connected through this Microsoft 365 account')
    expect(teams.get('.limit').text()).toBe('Needs a work or school account. Personal Outlook accounts cannot create Teams meetings for other apps.')
    expect(card(wrapper, 'My own link').get('.pill').text()).toBe('No link yet')
    // V1: no Zoom.
    expect(wrapper.text()).not.toContain('Zoom')
  })

  it('pills an account that needs signing in again, and one that is switched off', async () => {
    accounts = [account('gmail', 'gmail', 'kim@gmail.example', 'Kim', { status: 'auth_failed' }), WORK]
    stored = preferences({ disabled: [{ app: 'teams', mailAccountId: 'work' }] })
    const wrapper = await page()
    const meet = card(wrapper, 'Google Meet')
    expect(meet.get('.pill').text()).toBe('Needs reconnecting')
    expect(meet.get('.row .status').text()).toBe('Permission expired')
    expect(meet.get('.row button').text()).toBe('Reconnect')
    const teams = card(wrapper, 'Microsoft Teams')
    expect(teams.get('.pill').text()).toBe('Not connected')
    expect(teams.get('.row .status').text()).toBe('Not connected')
    expect(teams.get('.row button').text()).toBe('Connect')
  })

  it('switches an app off and on again in Tresso with disabled', async () => {
    const wrapper = await page()
    await card(wrapper, 'Google Meet').get('.row button').trigger('click')
    await settle()
    expect(patches()).toEqual([{ disabled: [{ app: 'meet', mailAccountId: 'gmail' }] }])
    expect(card(wrapper, 'Google Meet').get('.row .status').text()).toBe('Not connected')
    await card(wrapper, 'Google Meet').get('.row button').trigger('click')
    await settle()
    expect(patches()[1]).toEqual({ disabled: [] })
    expect(card(wrapper, 'Google Meet').get('.pill').text()).toBe('Connected')
  })

  it('signs in again for an expired permission, and asks for calendar access to connect', async () => {
    accounts = [account('gmail', 'gmail', 'kim@gmail.example', 'Kim', { calendarStatus: 'auth_failed' }), account('work', 'microsoft', 'kim@company.example', 'Work', { calendarStatus: 'not_granted' })]
    const wrapper = await page()
    const store = useAccountsStore()
    const open = vi.spyOn(store, 'openProviderSignIn').mockResolvedValue('browser')
    await card(wrapper, 'Google Meet').get('.row button').trigger('click')
    await settle()
    expect(open).toHaveBeenLastCalledWith('google', 'gmail', undefined)
    expect(wrapper.text()).toContain('Continue in your browser.')
    const teams = card(wrapper, 'Microsoft Teams')
    expect(teams.get('.row .status').text()).toBe('Not connected. Needs calendar access.')
    await teams.get('.row button').trigger('click')
    await settle()
    expect(open).toHaveBeenLastCalledWith('microsoft', 'work', ['calendar'])
    expect(patches()).toEqual([])
  })

  it('offers to add an account when there is none for an app', async () => {
    accounts = [FASTMAIL]
    const wrapper = await page()
    const meet = card(wrapper, 'Google Meet')
    expect(meet.get('.row').text()).toContain('No Google account yet')
    expect(meet.get('a').text()).toBe('Add an account')
    expect(meet.get('.pill').text()).toBe('Not connected')
  })

  it('saves the own link on blur, refuses a wrong one without a request, and removes it', async () => {
    const wrapper = await page()
    const input = wrapper.get('#own-link')
    await input.setValue('http://meet.example.com/kim')
    await input.trigger('blur')
    await settle()
    expect(wrapper.get('#meeting-error-ownLink').text()).toBe('Use a link that starts with https://.')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(patches()).toEqual([])

    await input.setValue('https://meet.example.com/kim')
    await input.trigger('keydown', { key: 'Enter' })
    await settle()
    expect(patches()).toEqual([{ ownLink: 'https://meet.example.com/kim' }])
    expect(wrapper.find('#meeting-error-ownLink').exists()).toBe(false)
    expect(card(wrapper, 'My own link').get('.pill').text()).toBe('Link set')
    // Blur after Enter sends nothing more.
    await input.trigger('blur')
    await settle()
    expect(patches()).toHaveLength(1)

    await card(wrapper, 'My own link').get('button').trigger('click')
    await settle()
    expect(patches()[1]).toEqual({ ownLink: '' })
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(card(wrapper, 'My own link').get('.pill').text()).toBe('No link yet')
  })

  it('lists per account the apps its calendar can use, with what is missing in brackets, and saves the choice', async () => {
    stored = preferences({ disabled: [{ app: 'meet', mailAccountId: 'gmail' }] })
    const wrapper = await page()
    const options = (id: string) => wrapper.findAll(`#default-${id} option`).filter((option) => option.attributes('disabled') === undefined).map((option) => option.text())
    expect(options('gmail')).toEqual(['Google Meet (connect first)', 'My own link (paste it first)', 'No meeting link'])
    expect(options('work')).toEqual(['Microsoft Teams', 'My own link (paste it first)', 'No meeting link'])
    // A personal Microsoft account: Teams cannot serve it, so it is not listed.
    expect(options('personal')).toEqual(['My own link (paste it first)', 'No meeting link'])
    // Its natural default (Teams) cannot apply there, so nothing is shown as chosen until the user picks.
    expect((wrapper.get('#default-personal').element as HTMLSelectElement).value).toBe('')
    expect(options('other')).toEqual(['My own link (paste it first)', 'No meeting link'])
    expect(wrapper.get('tbody th').text()).toContain('kim@gmail.example, Google')
    expect(wrapper.find('label[for="default-work"]').text()).toBe('Meeting app for Work')
    expect((wrapper.get('#default-work').element as HTMLSelectElement).value).toBe('teams')

    await wrapper.get('#default-work').setValue('none')
    await settle()
    expect(patches()).toEqual([{ defaults: { work: 'none' } }])
    await wrapper.get('#default-other').setValue('none')
    await settle()
    expect(patches()[1]).toEqual({ defaultOther: 'none' })
  })

  it('says which app is not offered for an account and why', async () => {
    const wrapper = await page()
    const lines = wrapper.findAll('.not-offered').map((line) => line.text())
    expect(lines).toContain('Google Meet is not offered for Work: a Meet link is made through a Google calendar event, and Work is a Microsoft 365 calendar.')
    expect(lines).toContain('Microsoft Teams is not offered for Kim at Google: a Teams link is made through a Microsoft 365 calendar event, and Kim at Google is a Google calendar.')
    expect(lines).toContain('Google Meet is not offered for Fastmail: a Meet link is made through a Google calendar event, and Fastmail is a CalDAV calendar.')
  })

  it('switches the guests rule and changes its hint', async () => {
    const wrapper = await page()
    const box = wrapper.get('input[role="switch"]')
    expect(wrapper.get('#guests-hint').text()).toBe('The link switches on when you add the first guest. Events without guests start without one.')
    await box.setValue(false)
    await settle()
    expect(patches()).toEqual([{ addWithGuests: false }])
    expect(wrapper.get('#guests-hint').text()).toBe('Events start without a link. You switch it on per event.')
  })

  it('puts the old value back and says why when a save fails', async () => {
    const wrapper = await page()
    refuse = 'The server could not save this.'
    const box = wrapper.get('input[role="switch"]')
    await box.setValue(false)
    await settle()
    expect((box.element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.text()).toContain('The server could not save this.')

    await wrapper.get('#default-work').setValue('none')
    await settle()
    expect((wrapper.get('#default-work').element as HTMLSelectElement).value).toBe('teams')

    const input = wrapper.get('#own-link')
    await input.setValue('https://meet.example.com/kim')
    await input.trigger('blur')
    await settle()
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('#meeting-error-ownLink').text()).toBe('The server could not save this.')
  })

  it('shows a Zoom choice only when the server offers Zoom', async () => {
    stored = preferences({ apps: ['meet', 'teams', 'own', 'zoom'] })
    const wrapper = await page()
    expect(wrapper.findAll('#default-other option').map((option) => option.text())).toContain('Zoom (connect first)')
    // V1 has no Zoom card: connecting Zoom needs the owner first.
    expect(wrapper.findAll('article.card h4').map((item) => item.text())).not.toContain('Zoom')
  })

  it('shows the field message of a refusal, without the field name in front', async () => {
    const wrapper = await page()
    refuse = 'ownLink: This link does not look right. Check it and paste it again.'
    violations = [{ propertyPath: 'ownLink', message: 'This link does not look right. Check it and paste it again.' }]
    const input = wrapper.get('#own-link')
    await input.setValue('https://meet.example.com/kim')
    await input.trigger('blur')
    await settle()
    expect(wrapper.get('#meeting-error-ownLink').text()).toBe('This link does not look right. Check it and paste it again.')
  })

  it('says in plain words when the server cannot be reached', async () => {
    const wrapper = await page()
    offline = true
    await wrapper.get('input[role="switch"]').setValue(false)
    await settle()
    expect(wrapper.get('#meeting-error-addWithGuests').text()).toBe('Tresso could not reach the server. Check your connection and try again.')
  })

  it('says when the preferences cannot be read', async () => {
    failRead = true
    const wrapper = await page()
    expect(wrapper.get('[role="alert"]').text()).toBe('The server is busy. Try again in a moment.')
  })

  it('reads the preferences on opening, after a failed save, and when the window comes back', async () => {
    const reads = () => requests.filter((request) => request.method === 'GET' && request.path === '/api/v1/calendar/meeting-preferences').length
    const store = useMeetingAppsStore()
    await store.ensureLoaded()
    expect(reads()).toBe(1)
    const wrapper = await page()
    // Read again although the store had them: another tab may have changed them.
    expect(reads()).toBe(2)
    stored = { ...stored, disabled: [{ app: 'meet', mailAccountId: 'gmail' }] }
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(reads()).toBe(3)
    expect(card(wrapper, 'Google Meet').get('.row .status').text()).toBe('Not connected')
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(reads()).toBe(4)
    refuse = 'The mail account is gone.'
    await wrapper.get('#default-work').setValue('none')
    await settle()
    expect(reads()).toBe(5)
  })

  it('sends changes one after the other, each built on the answer before it', async () => {
    const wrapper = await page()
    let release: () => void = () => undefined
    hold = new Promise<void>((resolve) => (release = resolve))
    await card(wrapper, 'Google Meet').get('.row button').trigger('click')
    await card(wrapper, 'Microsoft Teams').get('.row button').trigger('click')
    await flushPromises()
    // The second waits for the first answer.
    expect(patches()).toHaveLength(1)
    hold = null
    release()
    await settle()
    expect(patches()).toEqual([{ disabled: [{ app: 'meet', mailAccountId: 'gmail' }] }, { disabled: [{ app: 'meet', mailAccountId: 'gmail' }, { app: 'teams', mailAccountId: 'work' }] }])
    expect(card(wrapper, 'Google Meet').get('.row .status').text()).toBe('Not connected')
    expect(card(wrapper, 'Microsoft Teams').get('.row .status').text()).toBe('Not connected')
  })

  it('lets Remove win over the typed link that its click blurs', async () => {
    stored = preferences({ ownLink: 'https://meet.example.com/kim' })
    const wrapper = await page()
    const input = wrapper.get('#own-link')
    ;(input.element as HTMLInputElement).focus()
    await input.setValue('https://meet.example.com/other')
    const remove = wrapper.get('button[aria-label="Remove your room link"]')
    await remove.trigger('pointerdown')
    await input.trigger('blur')
    await remove.trigger('click')
    await settle()
    expect(patches()).toEqual([{ ownLink: '' }])
    expect((input.element as HTMLInputElement).value).toBe('')
  })

  it('puts the link back when Remove fails', async () => {
    stored = preferences({ ownLink: 'https://meet.example.com/kim' })
    const wrapper = await page()
    refuse = 'The server could not save this.'
    await wrapper.get('button[aria-label="Remove your room link"]').trigger('click')
    await settle()
    expect((wrapper.get('#own-link').element as HTMLInputElement).value).toBe('https://meet.example.com/kim')
    expect(wrapper.get('#meeting-error-ownLink').text()).toBe('The server could not save this.')
  })

  it('shows a saved app that cannot apply as such, and Not set only when nothing is saved', async () => {
    stored = preferences({ defaults: { personal: 'teams' }, defaultOther: 'meet' })
    const wrapper = await page()
    const personal = wrapper.get('#default-personal')
    expect((personal.element as HTMLSelectElement).value).toBe('teams')
    expect(personal.findAll('option').map((option) => option.text())).toContain('Microsoft Teams (not available here)')
    expect(personal.text()).not.toContain('Not set')
    const other = wrapper.get('#default-other')
    expect((other.element as HTMLSelectElement).value).toBe('meet')
    expect(other.findAll('option').map((option) => option.text())).toContain('Google Meet (not available here)')
  })

  it('names Microsoft accounts by what they can do', async () => {
    const plain = account('plain', 'microsoft', 'kim@contoso.example', 'Contoso')
    const live = account('live', 'microsoft', 'kim@outlook.com', 'Live')
    accounts = [PERSONAL, plain, live]
    useMailStore().calendars = [...CALENDARS, calendar('c', 'plain', { source: 'microsoft', name: 'Contoso', isDefault: true, conferenceProviders: [] }), calendar('l', 'live', { source: 'microsoft', name: 'Live', isDefault: true, conferenceProviders: [] })]
    const wrapper = await page()
    expect(card(wrapper, 'Microsoft Teams').get('.row').text()).toContain('No work or school account yet')
    const kinds = wrapper.findAll('tbody th .status').map((cell) => cell.text())
    expect(kinds).toContain('kim@outlook.com, Outlook')
    expect(kinds).toContain('kim@contoso.example, Microsoft, without Teams')
    expect(kinds).toContain('kim@outlook.example, Microsoft, without Teams')
    accounts = [GMAIL]
    const none = await page()
    expect(card(none, 'Microsoft Teams').get('.row').text()).toContain('No Microsoft 365 account yet')
  })

  it('says why an app is not offered on a calendar of the right kind', async () => {
    useMailStore().calendars = [calendar('g', 'gmail', { source: 'google', name: 'Kim', isDefault: true, conferenceProviders: [] }), ...CALENDARS.slice(1)]
    const wrapper = await page()
    const lines = wrapper.findAll('.not-offered').map((line) => line.text())
    expect(lines).toContain('Microsoft Teams is not offered for Personal Outlook: Teams links need a Microsoft 365 work or school account. kim@outlook.example cannot make them.')
    expect(lines).toContain('Google Meet is not offered for Kim at Google: Google Meet is not available for Kim.')
  })

  it('keys the not offered lines by account, also when two accounts share a name', async () => {
    accounts = [FASTMAIL, account('fastmail2', 'imap', 'kim@fastmail2.example', 'Fastmail')]
    useMailStore().calendars = [...CALENDARS, calendar('f2', 'fastmail2', { source: 'caldav', name: 'Fastmail', isDefault: true })]
    const wrapper = await page()
    expect(wrapper.findAll('.not-offered')).toHaveLength(4)
  })

  it('ties each error to its control and keeps the focus there', async () => {
    const wrapper = await page()
    refuse = 'The server could not save this.'
    const toggle = wrapper.get('input[role="switch"]')
    ;(toggle.element as HTMLInputElement).focus()
    await toggle.setValue(false)
    await settle()
    expect(document.activeElement).toBe(toggle.element)
    expect(toggle.attributes('aria-invalid')).toBe('true')
    expect(toggle.attributes('aria-describedby')).toBe('guests-hint meeting-error-addWithGuests')

    const select = wrapper.get('#default-work')
    await select.setValue('none')
    await settle()
    expect(select.attributes('aria-invalid')).toBe('true')
    expect(document.getElementById(select.attributes('aria-describedby')!)?.textContent).toBe('The server could not save this.')

    const button = card(wrapper, 'Google Meet').get('.row button')
    await button.trigger('click')
    await settle()
    expect(document.getElementById(button.attributes('aria-describedby')!)?.textContent).toBe('The server could not save this.')
  })

  it('asks a Gmail account without calendar access to connect, in the same word everywhere', async () => {
    accounts = [account('gmail', 'gmail', 'kim@gmail.example', 'Kim at Google', { calendarStatus: 'not_granted' })]
    const wrapper = await page()
    expect(card(wrapper, 'Google Meet').get('.row .status').text()).toBe('Not connected. Needs calendar access.')
    expect(card(wrapper, 'Google Meet').get('.row button').text()).toBe('Connect')
    expect(wrapper.findAll('#default-gmail option').map((option) => option.text())).toContain('Google Meet (connect first)')
  })

  it('says when the sign-in cannot start', async () => {
    accounts = [account('gmail', 'gmail', 'kim@gmail.example', 'Kim', { status: 'auth_failed' })]
    const wrapper = await page()
    vi.spyOn(useAccountsStore(), 'openProviderSignIn').mockRejectedValue(new Error('Google sign-in is not available on this server.'))
    await card(wrapper, 'Google Meet').get('.row button').trigger('click')
    await settle()
    expect(card(wrapper, 'Google Meet').get('.error').text()).toBe('Google sign-in is not available on this server.')
  })

  it('reads once for a return to the tab, however many events it fires', async () => {
    let sent = 0
    const reads = () => sent
    await page()
    const before = reads()
    let release: () => void = () => undefined
    hold = new Promise<void>((resolve) => (release = resolve))
    // The mock holds only changes: hold the reads here, counting them as they leave.
    const fetch = globalThis.fetch as ReturnType<typeof vi.fn<typeof globalThis.fetch>>
    const answer = fetch.getMockImplementation()!
    fetch.mockImplementation(async (input, init) => {
      if ((init?.method ?? 'GET') === 'GET' && new URL(String(input)).pathname === '/api/v1/calendar/meeting-preferences') {
        sent++
        if (hold !== null) await hold
      }
      return answer(input, init)
    })
    document.dispatchEvent(new Event('visibilitychange'))
    for (let i = 0; i < 10; i++) window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(reads() - before).toBe(1)
    hold = null
    release()
    await settle()
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(reads() - before).toBe(2)
  })

  it('shows the picked value while its save waits, also when a read lands first', async () => {
    const wrapper = await page()
    let release: () => void = () => undefined
    hold = new Promise<void>((resolve) => (release = resolve))
    const select = wrapper.get('#default-work')
    await select.setValue('none')
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect((select.element as HTMLSelectElement).value).toBe('none')
    const toggle = wrapper.get('input[role="switch"]')
    await toggle.setValue(false)
    await flushPromises()
    expect((toggle.element as HTMLInputElement).checked).toBe(false)
    hold = null
    release()
    await settle()
    expect((select.element as HTMLSelectElement).value).toBe('none')
    expect((toggle.element as HTMLInputElement).checked).toBe(false)
  })

  it('saves a typed link after a press on Remove that was not a click', async () => {
    stored = preferences({ ownLink: 'https://meet.example.com/kim' })
    const wrapper = await page()
    const remove = wrapper.get('button[aria-label="Remove your room link"]')
    await remove.trigger('pointerdown')
    await remove.trigger('pointercancel')
    const input = wrapper.get('#own-link')
    await input.setValue('https://meet.example.com/other')
    await input.trigger('blur')
    await settle()
    expect(patches()).toEqual([{ ownLink: 'https://meet.example.com/other' }])
  })

  it('sends a link typed again while the first one is on its way', async () => {
    const wrapper = await page()
    let release: () => void = () => undefined
    hold = new Promise<void>((resolve) => (release = resolve))
    const input = wrapper.get('#own-link')
    await input.setValue('https://meet.example.com/one')
    await input.trigger('blur')
    await input.trigger('blur')
    await input.setValue('https://meet.example.com/two')
    await input.trigger('blur')
    hold = null
    release()
    await settle()
    expect(patches()).toEqual([{ ownLink: 'https://meet.example.com/one' }, { ownLink: 'https://meet.example.com/two' }])
    expect((input.element as HTMLInputElement).value).toBe('https://meet.example.com/two')
  })

  it('leaves no error from an earlier refused change once a later one is saved', async () => {
    const wrapper = await page()
    let release: () => void = () => undefined
    hold = new Promise<void>((resolve) => (release = resolve))
    const fetch = globalThis.fetch as ReturnType<typeof vi.fn<typeof globalThis.fetch>>
    const answer = fetch.getMockImplementation()!
    // The first change is refused, the second saved: the mock answers them in that order.
    let first = true
    fetch.mockImplementation(async (input, init) => {
      if ((init?.method ?? 'GET') === 'PATCH' && first) {
        first = false
        await hold
        return new Response(JSON.stringify({ detail: 'Refused.' }), { status: 422, headers: { 'Content-Type': 'application/problem+json' } })
      }
      return answer(input, init)
    })
    const select = wrapper.get('#default-work')
    await select.setValue('none')
    await select.setValue('own')
    release()
    await settle()
    expect(wrapper.find('#meeting-error-default-work').exists()).toBe(false)
    expect(select.attributes('aria-invalid')).toBeUndefined()

    first = true
    hold = new Promise<void>((resolve) => (release = resolve))
    const input = wrapper.get('#own-link')
    await input.setValue('https://meet.example.com/three')
    await input.trigger('blur')
    await input.setValue('https://meet.example.com/four')
    await input.trigger('blur')
    release()
    await settle()
    expect(wrapper.find('#meeting-error-ownLink').exists()).toBe(false)
    expect(input.attributes('aria-invalid')).toBeUndefined()
    expect(patches()[patches().length - 1]).toEqual({ ownLink: 'https://meet.example.com/four' })
  })

  it('lets a press on Remove block only the blur of a focused link field', async () => {
    stored = preferences({ ownLink: 'https://meet.example.com/kim' })
    const wrapper = await page()
    const input = wrapper.get('#own-link')
    // Not focused: the press, released elsewhere, leaves nothing behind.
    await wrapper.get('button[aria-label="Remove your room link"]').trigger('pointerdown')
    ;(input.element as HTMLInputElement).focus()
    await input.setValue('https://meet.example.com/other')
    await input.trigger('blur')
    await settle()
    expect(patches()).toEqual([{ ownLink: 'https://meet.example.com/other' }])
  })

  it('offers to go back to an event being written', async () => {
    const plain = await page()
    expect(plain.find('.kept').exists()).toBe(false)
    plain.unmount()

    useCalendarStore().keepEditor({ target: { kind: 'new', start: 0, allDay: false }, values: {} as KeptEditor['values'], link: { on: true, app: null, touched: true, removed: false }, notify: true })
    const wrapper = await page()
    expect(wrapper.get('.kept').text()).toContain('You were writing an event.')
    await wrapper.get('.kept button').trigger('click')
    await settle()
    expect((wrapper.vm.$router.currentRoute.value.name)).toBe('calendar')
  })
})
