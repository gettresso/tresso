import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import type { BridgeState, WhatsAppConfig } from '@/platform/whatsapp'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import { BRIDGE_PROBLEMS, BUILD_COMMAND } from '@/components/chat/whatsappTexts'
import SettingsWhatsAppView from '../SettingsWhatsAppView.vue'

const NOW = Date.parse('2026-11-12T10:00:00Z')
const STOPPED: BridgeState = { process: 'stopped', port: null, loopbackOnly: null, link: 'unknown', qr: null, error: null }
const LINKED: BridgeState = { process: 'owned', port: 8741, loopbackOnly: true, link: 'linked', qr: null, error: null }
const CONFIG: WhatsAppConfig = {
  folder: '/Users/kim/whatsapp-mcp',
  mode: 'local',
  deviceId: '0193a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b',
  deviceName: "Kim's MacBook Pro",
  linkedAt: '2026-10-26T09:00:00.000Z',
  importSince: '2026-10-13T10:00:00.000Z',
  includeGroups: true,
  notify: false,
  leftOut: [],
}

/** A row of the Connection section by its label: what it says and its action. */
function row(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('.row').find((candidate) => candidate.get('.label').text() === label)
  if (found === undefined) {
    throw new Error(`No row ${label}`)
  }
  return { value: found.get('.value').text(), ok: found.get('.dot').classes().includes('ok'), text: found.text(), element: found }
}

describe('SettingsWhatsAppView', () => {
  let wa: ReturnType<typeof useWhatsAppRelayStore>
  let router: Router

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
    setActivePinia(createPinia())
    wa = useWhatsAppRelayStore()
    wa.available = true
    wa.configLoaded = true
    wa.config = CONFIG
    wa.bridge = LINKED
    wa.identity = { number: '31698765432', name: 'Kim Visser' }
    wa.deviceName = "Kim's MacBook Pro"
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/accounts', name: 'settings-accounts', component: { template: '<p>Accounts</p>' } },
        { path: '/settings/whatsapp', name: 'settings-whatsapp', component: SettingsWhatsAppView },
        { path: '/settings/whatsapp/connect', name: 'settings-whatsapp-connect', component: SettingsWhatsAppView },
      ],
    })
    await router.push('/settings/whatsapp')
    return () => vi.useRealTimers()
  })

  function open() {
    return mount(SettingsWhatsAppView, { global: { plugins: [router] }, attachTo: document.body })
  }

  it('shows the connection as the board does, for "Only this Mac"', () => {
    wa.lastMessageAt = '2026-11-12T09:58:00.000Z'
    const wrapper = open()

    expect(wrapper.get('h2').text()).toBe('WhatsApp')
    expect(wrapper.get('.line').text()).toBe("+31698765432, through whatsapp-mcp on Kim's MacBook Pro")
    expect(wrapper.get('.pill').text()).toBe('Connected')
    expect(wrapper.get('a[aria-label="Back to accounts"]').attributes('href')).toBe('/settings/accounts')
    expect(row(wrapper, 'Relaying Mac')).toMatchObject({ value: "Kim's MacBook Pro, this Mac", ok: true })
    expect(row(wrapper, 'whatsapp-mcp')).toMatchObject({ value: '~/whatsapp-mcp, bridge started by Tresso', ok: true })
    expect(row(wrapper, 'whatsapp-mcp').element.get('button').text()).toBe('Change folder')
    expect(row(wrapper, 'Bridge')).toMatchObject({ value: 'Running, last message 2 minutes ago', ok: true })
    expect(row(wrapper, 'Linked to phone')).toMatchObject({ value: 'Linked 17 days ago. WhatsApp can ask you to link again.', ok: true })

    // No smart inboxes and "All my devices" not yet; Notify me is there, off by default.
    expect(wrapper.text()).not.toContain('Sort into smart inboxes')
    expect(wrapper.text()).not.toContain('Your chats will show')
    expect(wrapper.get('label[for="wa-notify"]').text()).toBe('Notify me')
    expect(wrapper.get('#wa-notify-note').text()).toBe('Desktop notifications for new WhatsApp messages on this Mac.')
    expect(wrapper.get<HTMLInputElement>('#wa-notify').element.checked).toBe(false)
    expect(wrapper.get('#wa-groups-note').text()).toBe('Group chats can be busy. Leave chats out one by one from the chat itself.')
    expect(wrapper.find('[aria-labelledby="wa-left-out"]').exists()).toBe(false)
    expect(wrapper.get<HTMLSelectElement>('#wa-place').element.disabled).toBe(true)
    expect(wrapper.get<HTMLOptionElement>('#wa-place option[value="all"]').element.disabled).toBe(true)
    expect(wrapper.get<HTMLSelectElement>('#wa-groups').element.value).toBe('all')
    expect(wrapper.text()).toContain('Disconnecting removes the WhatsApp chats Tresso copied. WhatsApp itself, the bridge and its own message store on this Mac stay as they are.')
  })

  it('shows each state of the bridge with its action', async () => {
    const start = vi.spyOn(wa, 'start').mockResolvedValue(true)
    const wrapper = open()

    expect(row(wrapper, 'Bridge').value).toBe('Running, no messages yet')

    wa.bridge = { ...LINKED, loopbackOnly: false }
    await flushPromises()
    expect(row(wrapper, 'Bridge')).toMatchObject({ value: 'Running, open to your network on port 8741', ok: false })
    expect(row(wrapper, 'Bridge').element.get('a').text()).toBe('Show how to close it')
    expect(row(wrapper, 'Bridge').element.get('a').attributes('href')).toBe('https://github.com/gettresso/tresso/blob/main/docs/whatsapp-bridge.md#closing-the-bridges-port')

    wa.bridge = { ...LINKED, port: null, link: 'unknown' }
    await flushPromises()
    expect(row(wrapper, 'Bridge').value).toBe('Starting')
    expect(wrapper.get('.pill').text()).toBe('Starting')

    wa.bridge = STOPPED
    await flushPromises()
    expect(row(wrapper, 'Bridge')).toMatchObject({ value: 'Stopped', ok: false })
    expect(row(wrapper, 'whatsapp-mcp')).toMatchObject({ value: '~/whatsapp-mcp, bridge not running', ok: false })
    expect(wrapper.get('.pill').text()).toBe('Bridge stopped')
    expect(row(wrapper, 'Linked to phone').value).toBe('Not known while the bridge is stopped.')
    await row(wrapper, 'Bridge').element.get('button').trigger('click')
    expect(start).toHaveBeenCalled()

    for (const failure of ['not_built', 'exited', 'port_busy', 'unprotected', 'unsafe'] as const) {
      wa.bridge = { ...STOPPED, error: failure }
      await flushPromises()
      expect(row(wrapper, 'Bridge').value).toBe(BRIDGE_PROBLEMS[failure].status)
      expect(row(wrapper, 'Bridge').text).toContain(BRIDGE_PROBLEMS[failure].detail)
      expect(row(wrapper, 'Bridge').element.find('.command').exists()).toBe(failure === 'not_built' || failure === 'unprotected')
      expect(row(wrapper, 'Bridge').element.get('button').text()).toBe('Start again')
    }
    expect(BUILD_COMMAND).toBe('cd whatsapp-bridge && go build -o whatsapp-bridge .')
  })

  it('shows each state of the link, and the code when it needs one', async () => {
    const wrapper = open()

    wa.config = { ...CONFIG, linkedAt: null }
    await flushPromises()
    expect(row(wrapper, 'Linked to phone').value).toBe('Linked.')
    expect(wrapper.find('#wa-link').exists()).toBe(false)
    await row(wrapper, 'Linked to phone').element.get('button').trigger('click')
    expect(wrapper.get('#wa-link').text()).toContain('Linked. To link another phone')

    wa.bridge = { ...LINKED, link: 'waiting_for_scan', qr: Array.from({ length: 29 }, () => '0'.repeat(29)) }
    wa.identity = null
    await flushPromises()
    expect(wrapper.get('.pill').text()).toBe('Not linked')
    expect(row(wrapper, 'Linked to phone')).toMatchObject({ value: 'Not linked. Nothing comes in or goes out.', ok: false })
    expect(wrapper.get('#wa-link svg').attributes('aria-label')).toBe('QR code to scan with WhatsApp on your phone')
    expect(wrapper.get('.line').text()).toBe("Through whatsapp-mcp on Kim's MacBook Pro")

    wa.bridge = { ...STOPPED, link: 'unlinked' }
    await flushPromises()
    expect(wrapper.get('.pill').text()).toBe('Not linked')
    expect(wrapper.get('#wa-link').text()).toContain('Show a new code')
  })

  it('tells the first import, counts only, and a stuck one', async () => {
    const wrapper = open()
    wa.importState = 'reading'
    wa.progress = { chats: 3, stored: 120, known: 0, leftOut: 0, refused: 0, skipped: { not_a_chat: 0, groups_off: 0, left_out: 0, before_import: 0, no_time: 0, bad_time: 0, bad_id: 0, nothing_to_show: 0 }, firstImport: true }
    await flushPromises()
    const since = new Date('2026-10-13T10:00:00.000Z').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    expect(wrapper.get('.import').text()).toBe(`Bringing in your chats since ${since}.120 messages from 3 chats so far.`)
    expect(wrapper.get('[role="status"]').text()).toBe('Bringing in your recent chats.')

    wa.importState = 'stuck'
    wa.stuckRefused = 2
    await flushPromises()
    expect(wrapper.get('.import').text()).toContain('Bringing in your chats is stuck.')
    expect(wrapper.get('.import').text()).toContain('2 messages could not be stored')

    wa.importState = 'done'
    wa.relayFailing = 'read'
    await flushPromises()
    expect(wrapper.find('.import').exists()).toBe(false)
    expect(wrapper.get('.import-failing').text()).toBe('Reading WhatsApp messages failed just now. Tresso tries again in a moment.')
    expect(wrapper.get('[role="status"]').text()).toBe('Your recent chats are in.')
  })

  it('asks before disconnecting, says what stays, and disconnects', async () => {
    const disconnect = vi.spyOn(wa, 'disconnect').mockResolvedValue(true)
    const wrapper = open()

    await wrapper.get('.disconnect > button').trigger('click')
    const confirm = wrapper.get('[role="alertdialog"]')
    expect(confirm.get('#wa-disconnect-title').text()).toBe('Disconnect WhatsApp?')
    expect(confirm.text()).toContain('It deletes nothing in your whatsapp-mcp folder: the bridge and its own message store stay there.')
    await flushPromises()
    expect(document.activeElement?.textContent).toBe('Cancel')

    await confirm.findAll('button')[1]!.trigger('click')
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(disconnect).not.toHaveBeenCalled()

    await wrapper.get('.disconnect > button').trigger('click')
    await wrapper.get('[role="alertdialog"] button').trigger('click')
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('asks before removing the group chats, and turns them on without asking', async () => {
    const groups = vi.spyOn(wa, 'setIncludeGroups').mockResolvedValue(true)
    const wrapper = open()

    await wrapper.get('#wa-groups').setValue('direct')
    expect(groups).not.toHaveBeenCalled()
    expect(wrapper.get('#wa-groups-title').text()).toBe('Remove the group chats Tresso copied?')
    expect(wrapper.get<HTMLSelectElement>('#wa-groups').element.value).toBe('all')
    await wrapper.get('[role="alertdialog"] .button-danger').trigger('click')
    expect(groups).toHaveBeenCalledWith(false)

    wa.config = { ...CONFIG, includeGroups: false }
    await flushPromises()
    await wrapper.get('#wa-groups').setValue('all')
    expect(groups).toHaveBeenLastCalledWith(true)
  })

  it('shows the disconnect waiting, with Cancel off and the pill following', async () => {
    let finish!: (done: boolean) => void
    vi.spyOn(wa, 'disconnect').mockImplementation(() => {
      wa.busy = 'disconnect'
      return new Promise((resolve) => (finish = resolve))
    })
    const wrapper = open()
    await wrapper.get('.disconnect > button').trigger('click')
    await wrapper.get('[role="alertdialog"] .button-danger').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alertdialog"] .button-danger').text()).toBe('Disconnecting…')
    expect(wrapper.get<HTMLButtonElement>('[role="alertdialog"] .button-quiet').element.disabled).toBe(true)
    expect(wrapper.get('.pill').text()).toBe('Disconnecting')
    expect(wrapper.get('.waiting').text()).toBe('Disconnecting… A reply being sent goes out first; this can take up to two minutes.')
    wa.busy = null
    finish(true)
  })

  it('offers to connect while not connected, and shows the dialog over itself on its address', async () => {
    wa.config = null
    wa.bridge = STOPPED
    const wrapper = open()
    expect(wrapper.get('.line').text()).toBe('Not connected')
    const link = wrapper.get('a.button-primary')
    expect(link.text()).toBe('Connect WhatsApp')
    expect(link.attributes('href')).toBe('/settings/whatsapp/connect')
    expect(wrapper.find('dialog').exists()).toBe(false)

    await router.push('/settings/whatsapp/connect')
    await flushPromises()
    expect(wrapper.get('dialog h1').text()).toBe('Connect WhatsApp')

    const cancel = vi.spyOn(wa, 'cancel').mockResolvedValue(true)
    await wrapper.get('dialog button[aria-label="Close"]').trigger('click')
    await flushPromises()
    expect(cancel).toHaveBeenCalled()
    expect(router.currentRoute.value.name).toBe('settings-whatsapp')
    expect(wrapper.find('dialog').exists()).toBe(false)
  })

  it('turns Notify me on and off through the store', async () => {
    const setNotify = vi.spyOn(wa, 'setNotify').mockResolvedValue(true)
    const wrapper = open()
    await wrapper.get('#wa-notify').setValue(true)
    expect(setNotify).toHaveBeenCalledWith(true)
    wa.config = { ...CONFIG, notify: true }
    await flushPromises()
    expect(wrapper.get<HTMLInputElement>('#wa-notify').element.checked).toBe(true)
    await wrapper.get('#wa-notify').setValue(false)
    expect(setNotify).toHaveBeenLastCalledWith(false)
  })

  it('lists the chats left out, and takes one back in', async () => {
    const takeBackIn = vi.spyOn(wa, 'takeBackIn').mockResolvedValue(true)
    wa.config = { ...CONFIG, leftOut: ['31612345678@s.whatsapp.net', '120363000000000001@g.us'] }
    const wrapper = open()
    await flushPromises()
    const section = wrapper.get('[aria-labelledby="wa-left-out"]')
    expect(section.get('h3').text()).toBe('Chats left out')
    // The copy does not name them here (no chats store data): the number, and a group's kind.
    expect(section.findAll('.left-name').map((name) => name.text())).toEqual(['+31612345678', 'Group'])
    await section.findAll('button')[0]!.trigger('click')
    expect(takeBackIn).toHaveBeenCalledWith('31612345678@s.whatsapp.net')
  })

  it('leads Done of the connect dialog to the WhatsApp list', async () => {
    router.addRoute({ path: '/whatsapp', name: 'whatsapp', component: { template: '<p>Chats</p>' } })
    vi.spyOn(wa, 'cancel').mockResolvedValue(true)
    await router.push('/settings/whatsapp/connect')
    const wrapper = open()
    await flushPromises()
    wrapper.findComponent({ name: 'ConnectWhatsApp' }).vm.$emit('done')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('whatsapp')
  })
})
