import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { linkText, meetingChoices, type MeetingAccount, type MeetingChoice, type MeetingPreferences, type MeetingRow } from '@tresso/core'
import { calendar } from '@tresso/core/testing'
import MeetingLinkRow from '../calendar/MeetingLinkRow.vue'

const WORK = calendar('work', 'm365', { source: 'microsoft', name: 'Work', conferenceProviders: ['teams'] })
const ACCOUNT: MeetingAccount = { id: 'm365', emailAddress: 'kim@company.example', provider: 'microsoft', status: 'active', calendarStatus: 'active' }
const PREFS: MeetingPreferences = { ownLink: 'https://meet.company.example/kim', addWithGuests: true, defaults: {}, defaultOther: null, disabled: [], apps: ['meet', 'teams', 'own'] }
const CHOICES = meetingChoices(WORK, ACCOUNT, PREFS)
const TEAMS = CHOICES.find((choice) => choice.app === 'teams')!
const TEAMS_URL = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0'

function row(kind: MeetingRow['kind'], extra: Partial<MeetingRow> = {}): MeetingRow {
  return { kind, title: 'Meeting link', hint: 'A hint.', tone: 'plain', icon: 'camera', ...extra }
}

function mountRow(props: { row: MeetingRow; on?: boolean; chosen?: MeetingChoice | null; link?: { provider: 'teams' | 'other'; url: string } | null; locked?: boolean; removable?: boolean; choices?: MeetingChoice[] }) {
  return mount(MeetingLinkRow, {
    props: {
      row: props.row,
      choices: props.choices ?? CHOICES,
      chosen: props.chosen === undefined ? TEAMS : props.chosen,
      defaultApp: 'teams',
      calendarName: 'Work',
      on: props.on ?? true,
      link: props.link ?? null,
      locked: props.locked ?? false,
      removable: props.removable ?? false,
      busy: false,
      error: null,
    },
    attachTo: document.body,
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the meeting link row', () => {
  it('shows the switch alone while off, labelled by the title', () => {
    const wrapper = mountRow({ row: row('off', { hint: 'No meeting link. People meet at the location.' }), on: false })
    const toggle = wrapper.get('[role="switch"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    expect(document.getElementById(toggle.attributes('aria-labelledby')!)?.textContent).toBe('Meeting link')
    expect(document.getElementById(toggle.attributes('aria-describedby')!)?.textContent).toBe('No meeting link. People meet at the location.')
    expect(wrapper.find('[aria-haspopup="menu"]').exists()).toBe(false)
    wrapper.get('[role="switch"]').trigger('click')
    expect(wrapper.emitted('toggle')).toHaveLength(1)
  })

  it('shows the chosen app and opens the menu on it, marking the choice, the default and what cannot be used', async () => {
    const wrapper = mountRow({ row: row('ready') })
    const app = wrapper.get('button[aria-haspopup="menu"]')
    expect(app.text()).toBe('Microsoft Teams')
    await app.trigger('click')
    const menu = wrapper.get('[role="menu"]')
    expect(menu.attributes('aria-label')).toBe('Meeting app')
    expect(menu.text()).toContain('Make the link with')
    const items = menu.findAll('[role="menuitemradio"]')
    expect(items.map((item) => item.get('.label').text())).toEqual(['Microsoft TeamsDefault for Work', 'Google Meet', 'My own link'])
    expect(items[0]!.attributes('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(items[0]!.element)
    // Meet cannot make a link on a Microsoft calendar: listed, disabled, with the reason.
    expect(items[1]!.attributes('aria-disabled')).toBe('true')
    expect(items[1]!.get('.via').text()).toBe('Only for events on a Google calendar. Work is a Microsoft 365 calendar.')
    await items[1]!.trigger('click')
    expect(wrapper.emitted('pick')).toBeUndefined()
    await items[2]!.trigger('click')
    expect(wrapper.emitted('pick')).toEqual([['own']])
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(app.element)
  })

  it('moves through the menu with the keyboard and closes it with Escape', async () => {
    const wrapper = mountRow({ row: row('ready') })
    const app = wrapper.get('button[aria-haspopup="menu"]')
    await app.trigger('click')
    const all = () => wrapper.findAll('[role="menuitemradio"], [role="menuitem"]').map((item) => item.element)
    const menu = wrapper.get('[role="menu"]')
    await menu.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(all()[1])
    await menu.trigger('keydown', { key: 'End' })
    expect(document.activeElement?.textContent).toBe('Connect another app in Settings')
    await menu.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(all()[0])
    await menu.trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(all()[0])
    await menu.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(app.element)
  })

  it('removes the link and goes to Settings from the menu', async () => {
    const wrapper = mountRow({ row: row('created'), link: { provider: 'teams', url: TEAMS_URL }, removable: true })
    await wrapper.get('button[aria-haspopup="menu"]').trigger('click')
    await wrapper.findAll('[role="menuitem"]')[0]!.trigger('click')
    expect(wrapper.emitted('remove')).toHaveLength(1)
    await wrapper.get('button[aria-haspopup="menu"]').trigger('click')
    await wrapper.findAll('[role="menuitem"]')[1]!.trigger('click')
    expect(wrapper.emitted('settings')).toHaveLength(1)
  })

  it('shows the link with Copy link and Join once it is there', () => {
    const wrapper = mountRow({ row: row('created', { hint: 'Made with kim@company.example.' }), link: { provider: 'teams', url: TEAMS_URL } })
    expect(wrapper.get('.link').text()).toBe(linkText(TEAMS_URL))
    expect(wrapper.get('.link').attributes('title')).toBe(TEAMS_URL)
    expect(wrapper.get('.copy-link').text()).toBe('Copy link')
    expect(wrapper.get('a').text()).toBe('Join with Microsoft Teams')
  })

  it('keeps a Teams meeting Microsoft made: no switch, no other app, no removal', async () => {
    const wrapper = mountRow({ row: row('created'), link: { provider: 'teams', url: TEAMS_URL }, locked: true, removable: false })
    expect(wrapper.get('[role="switch"]').attributes('disabled')).toBeDefined()
    await wrapper.get('button[aria-haspopup="menu"]').trigger('click')
    expect(wrapper.get('.kept').text()).toBe('Microsoft keeps a Teams meeting on its event. To meet elsewhere, delete this event and make a new one.')
    for (const item of wrapper.findAll('[role="menuitemradio"]')) {
      expect(item.attributes('aria-disabled')).toBe('true')
    }
    const remove = wrapper.findAll('[role="menuitem"]')[0]!
    expect(remove.attributes('aria-disabled')).toBe('true')
    await remove.trigger('click')
    expect(wrapper.emitted('remove')).toBeUndefined()
  })

  it('has no controls while the link is made', () => {
    const wrapper = mountRow({ row: row('creating', { title: 'Making the Teams link', icon: 'spinner' }) })
    expect(wrapper.find('[role="switch"]').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.find('.spinner').exists()).toBe(true)
  })

  it('offers Retry, another app and leaving without a link when it failed', async () => {
    const wrapper = mountRow({ row: row('failed', { title: 'Could not make the Teams link', tone: 'error', icon: 'error' }), on: false })
    const buttons = wrapper.findAll('.actions button')
    expect(buttons.map((button) => button.text())).toEqual(['Retry', 'Use another app', 'Leave without a link'])
    await buttons[0]!.trigger('click')
    await buttons[2]!.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    expect(wrapper.emitted('leave')).toHaveLength(1)
    await buttons[1]!.trigger('click')
    expect(wrapper.find('[role="menu"]').exists()).toBe(true)
    expect(wrapper.classes()).toContain('error')
  })

  it('offers to reconnect, and the apps that work after a calendar change', async () => {
    const reconnect = mountRow({ row: row('reconnect', { tone: 'warn', icon: 'warn' }) })
    await reconnect.get('.actions .button-primary').trigger('click')
    expect(reconnect.emitted('reconnect')).toHaveLength(1)

    const google = calendar('home', 'gmail', { source: 'google', name: 'Home', conferenceProviders: ['meet'] })
    const homeChoices = meetingChoices(google, { ...ACCOUNT, id: 'gmail', provider: 'gmail', emailAddress: 'kim@gmail.example' }, PREFS)
    const wrong = mountRow({ row: row('wrong_calendar', { tone: 'warn', icon: 'warn' }), choices: homeChoices, chosen: homeChoices.find((choice) => choice.app === 'teams')! })
    const buttons = wrong.findAll('.actions button')
    expect(buttons.map((button) => button.text())).toEqual(['Use Google Meet', 'Use my own link'])
    await buttons[0]!.trigger('click')
    await buttons[1]!.trigger('click')
    expect(wrong.emitted('pick')).toEqual([['meet'], ['own']])
  })

  it('asks to connect an app, and undoes a removal', async () => {
    // State 2 shows the switch off, also when the first guest switched the row on.
    expect(mountRow({ row: row('no_app'), on: true, chosen: null }).get('[role="switch"]').attributes('aria-checked')).toBe('false')
    const none = mountRow({ row: row('no_app'), on: false, chosen: null })
    await none.get('.actions button').trigger('click')
    expect(none.emitted('settings')).toHaveLength(1)
    const removed = mountRow({ row: row('removed'), on: false })
    await removed.get('.actions button').trigger('click')
    expect(removed.emitted('undo')).toHaveLength(1)
  })

  it('announces its state politely and keeps the focus in the row when a button goes away', async () => {
    const wrapper = mountRow({ row: row('failed', { title: 'Could not make the Teams link', tone: 'error', icon: 'error' }), on: false })
    expect(wrapper.get('.text').attributes('aria-live')).toBe('polite')
    const retry = wrapper.get('.actions .button-primary')
    ;(retry.element as HTMLButtonElement).focus()
    await retry.trigger('click')
    await wrapper.setProps({ row: row('creating', { title: 'Making the Teams link', icon: 'spinner' }) })
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('.meeting-row').element)

    const removed = mountRow({ row: row('removed'), on: false })
    const undo = removed.get('.actions button')
    ;(undo.element as HTMLButtonElement).focus()
    await undo.trigger('click')
    await removed.setProps({ row: row('created'), on: true, link: { provider: 'teams', url: TEAMS_URL } })
    await flushPromises()
    expect(document.activeElement).toBe(removed.get('button[aria-haspopup="menu"]').element)
  })

  it('ties the line Microsoft keeps to the items it disables', async () => {
    const wrapper = mountRow({ row: row('created'), link: { provider: 'teams', url: TEAMS_URL }, locked: true })
    await wrapper.get('button[aria-haspopup="menu"]').trigger('click')
    const id = wrapper.get('.kept').attributes('id')
    for (const item of wrapper.findAll('[role="menuitemradio"]')) {
      expect(item.attributes('aria-describedby')).toBe(id)
    }
    expect(wrapper.findAll('[role="menuitem"]')[0]!.attributes('aria-describedby')).toBe(id)
  })
})
