import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { MailAccount, MeetingPreferences } from '@tresso/core'
import { calendar } from '@tresso/core/testing'
import { useAccountsStore } from '@/stores/accounts'
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
    calendarStatus: 'ok',
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

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    stored = preferences()
    accounts = [GMAIL, WORK, PERSONAL, FASTMAIL]
    refuse = null
    useMailStore().calendars = CALENDARS
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const method = init?.method ?? 'GET'
        const path = new URL(String(input)).pathname
        const body = init?.body ? (JSON.parse(String(init.body)) as Partial<MeetingPreferences>) : undefined
        requests.push({ method, path, body })
        if (path === '/api/v1/mail-accounts') {
          return new Response(JSON.stringify(accounts))
        }
        if (method === 'PATCH' && refuse !== null) {
          return new Response(JSON.stringify({ detail: refuse }), { status: 422, headers: { 'Content-Type': 'application/problem+json' } })
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
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/settings/accounts/new', name: 'settings-accounts-new', component: { template: '<div />' } }] })
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
    expect(wrapper.get('#own-link-error').text()).toBe('Use a link that starts with https://.')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(patches()).toEqual([])

    await input.setValue('https://meet.example.com/kim')
    await input.trigger('keydown', { key: 'Enter' })
    await settle()
    expect(patches()).toEqual([{ ownLink: 'https://meet.example.com/kim' }])
    expect(wrapper.find('#own-link-error').exists()).toBe(false)
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
    expect(wrapper.get('#own-link-error').text()).toBe('The server could not save this.')
  })

  it('shows a Zoom choice only when the server offers Zoom', async () => {
    stored = preferences({ apps: ['meet', 'teams', 'own', 'zoom'] })
    const wrapper = await page()
    expect(wrapper.findAll('#default-other option').map((option) => option.text())).toContain('Zoom (connect first)')
    // V1 has no Zoom card: connecting Zoom needs the owner first.
    expect(wrapper.findAll('article.card h4').map((item) => item.text())).not.toContain('Zoom')
  })
})
