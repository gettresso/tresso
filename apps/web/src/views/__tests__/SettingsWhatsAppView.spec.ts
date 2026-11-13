import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import type { BridgeState, WhatsAppConfig } from '@/platform/whatsapp'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import { BRIDGE_PROBLEMS, BUILD_COMMAND, COPY_BODY, COPY_TITLE, GROUPS_WOULD_GO, LEFT_OUT_KEPT, REMOVE_BODY, REMOVE_TITLE } from '@/components/chat/whatsappTexts'
import type { SyncedChatAccount } from '@tresso/core'
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

    // No smart inboxes; Notify me is there, off by default; "Only this Mac" is the place, "All my devices" can be chosen.
    expect(wrapper.text()).not.toContain('Sort into smart inboxes')
    expect(wrapper.text()).not.toContain('Your chats will show')
    expect(wrapper.get('label[for="wa-notify"]').text()).toBe('Notify me')
    expect(wrapper.get('#wa-notify-note').text()).toBe('Desktop notifications for new WhatsApp messages on this Mac.')
    expect(wrapper.get<HTMLInputElement>('#wa-notify').element.checked).toBe(false)
    expect(wrapper.get('#wa-groups-note').text()).toBe('Group chats can be busy. Leave chats out one by one from the chat itself.')
    expect(wrapper.find('[aria-labelledby="wa-left-out"]').exists()).toBe(false)
    expect(wrapper.get<HTMLSelectElement>('#wa-place').element.disabled).toBe(false)
    expect(wrapper.get<HTMLSelectElement>('#wa-place').element.value).toBe('local')
    expect(wrapper.get<HTMLOptionElement>('#wa-place option[value="all"]').element.disabled).toBe(false)
    expect(wrapper.get('#wa-place-note').text()).toBe('All my devices: this Mac copies chats to your Tresso server so web and mobile show them. Only this Mac: chats never leave this computer.')
    expect(wrapper.text()).not.toContain('later version')
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

  describe('where messages live', () => {
    const ACCOUNT: SyncedChatAccount = {
      id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4aa0',
      channel: 'whatsapp',
      address: null,
      displayName: null,
      relayDeviceId: CONFIG.deviceId,
      relayDeviceName: "Kim's MacBook Pro",
      relayOnline: true,
      relayOfflineSince: null,
      bridge: 'running',
      link: 'linked',
      linkedAt: null,
      loopbackOnly: true,
      includeGroups: true,
      notify: false,
    }

    it('asks before copying the chats to the server, and switches only on Copy', async () => {
      const switchMode = vi.spyOn(wa, 'switchMode').mockResolvedValue(true)
      const wrapper = open()
      const select = wrapper.get<HTMLSelectElement>('#wa-place')

      await select.setValue('all')
      // The saved place shows until the user answered.
      expect(select.element.value).toBe('local')
      const confirm = wrapper.get('[role="alertdialog"]')
      expect(confirm.get('#wa-mode-title').text()).toBe(COPY_TITLE)
      expect(COPY_TITLE).toBe('Copy your WhatsApp chats to your Tresso server? Web and mobile will show them.')
      expect(confirm.get('#wa-mode-body').text()).toBe(`${COPY_BODY} ${LEFT_OUT_KEPT}`)
      expect(LEFT_OUT_KEPT).toBe('Chats you left out stay out on every device: Tresso keeps only their WhatsApp address on your server, sealed, to recognise them.')
      await flushPromises()
      expect(document.activeElement?.textContent).toBe('Cancel')
      expect(confirm.findAll('button').map((button) => button.text())).toEqual(['Copy', 'Cancel'])

      await confirm.findAll('button')[1]!.trigger('click')
      expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
      expect(switchMode).not.toHaveBeenCalled()

      await select.setValue('all')
      await wrapper.get('[role="alertdialog"]').findAll('button')[0]!.trigger('click')
      await flushPromises()
      expect(switchMode).toHaveBeenCalledWith('all', { copy: true, keepGroups: false })
      expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    })

    it('asks before removing the chats from the server, saying what goes', async () => {
      const switchMode = vi.spyOn(wa, 'switchMode').mockResolvedValue(true)
      wa.config = { ...CONFIG, mode: 'all' }
      wa.serverAccount = ACCOUNT
      const wrapper = open()
      expect(row(wrapper, 'Relaying Mac')).toMatchObject({ value: "Kim's MacBook Pro, this Mac", ok: true })
      expect(wrapper.text()).toContain('Disconnecting removes your WhatsApp chats from your Tresso server and from every device.')

      await wrapper.get<HTMLSelectElement>('#wa-place').setValue('local')
      const confirm = wrapper.get('[role="alertdialog"]')
      expect(confirm.get('#wa-mode-title').text()).toBe(REMOVE_TITLE)
      expect(REMOVE_TITLE).toBe('Remove your WhatsApp chats from your Tresso server? Web and mobile will stop showing them.')
      expect(confirm.get('#wa-mode-body').text()).toBe(REMOVE_BODY)
      expect(confirm.findAll('button').map((button) => button.text())).toEqual(['Remove', 'Cancel'])
      await confirm.findAll('button')[0]!.trigger('click')
      expect(switchMode).toHaveBeenCalledWith('local', { copy: false, keepGroups: false })
    })

    it('names the Mac that relays, with Use this Mac instead', async () => {
      const useThisMac = vi.spyOn(wa, 'useThisMac').mockResolvedValue(true)
      wa.config = { ...CONFIG, mode: 'all' }
      wa.serverAccount = { ...ACCOUNT, relayDeviceId: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f', relayDeviceName: 'Office iMac', relayOnline: false, relayOfflineSince: '2026-11-12T09:00:00Z' }
      const wrapper = open()
      const relay = row(wrapper, 'Relaying Mac')
      expect(relay).toMatchObject({ value: 'Office iMac, offline, last heard from 1 hour ago', ok: false })
      // Group chats and taking chats back in are for the Mac that reads the bridge.
      expect(wrapper.get<HTMLSelectElement>('#wa-groups').element.disabled).toBe(true)
      expect(wrapper.get('#wa-groups-note').text()).toContain('Change this on the Mac that relays WhatsApp.')
      await relay.element.get('button').trigger('click')
      expect(relay.element.get('button').text()).toBe('Use this Mac instead')
      expect(useThisMac).toHaveBeenCalled()
    })

    it('offers a Mac in "Only this Mac" to relay for every device instead, asking to copy first', async () => {
      const switchMode = vi.spyOn(wa, 'switchMode').mockResolvedValue(true)
      wa.serverAccount = { ...ACCOUNT, relayDeviceId: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f', relayDeviceName: 'Office iMac' }
      const wrapper = open()
      const relay = row(wrapper, 'Relaying Mac')
      expect(relay.value).toBe("Kim's MacBook Pro, this Mac")
      expect(relay.text).toContain('Your other devices show WhatsApp through Office iMac, online now.')
      await relay.element.get('button').trigger('click')
      expect(wrapper.get('#wa-mode-title').text()).toBe(COPY_TITLE)
      await wrapper.get('[role="alertdialog"]').findAll('button')[0]!.trigger('click')
      expect(switchMode).toHaveBeenCalledWith('all', { copy: true, keepGroups: false })
    })

    it('leads a Mac not connected to the connect dialog to take the relay over', async () => {
      wa.config = null
      wa.serverAccount = { ...ACCOUNT, relayDeviceId: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f', relayDeviceName: 'Office iMac' }
      const wrapper = open()
      expect(wrapper.text()).toContain('Your WhatsApp chats are on your Tresso server, relayed by Office iMac.')
      const link = wrapper.findAll('a').find((anchor) => anchor.text() === 'Use this Mac instead')!
      expect(link.attributes('href')).toBe('/settings/whatsapp/connect?mode=all')
    })

    it('says a switch under way, the replies carried over and the messages the server refused, in counts', async () => {
      wa.config = { ...CONFIG, mode: 'all' }
      wa.serverAccount = ACCOUNT
      wa.modeSwitch = { to: 'all', accountId: null, copy: true }
      wa.carried = [{ jid: '31612345678@s.whatsapp.net', text: 'Secret', id: null }]
      wa.carryCounts = { lost: 1, cancelled: 0, unsure: 0, notSent: 0 }
      wa.serverRefused = 2
      const wrapper = open()
      expect(wrapper.text()).toContain('Moving your WhatsApp chats to your Tresso server.')
      expect(wrapper.get<HTMLSelectElement>('#wa-place').element.disabled).toBe(true)
      expect(wrapper.text()).toContain('1 reply written on this Mac before the switch goes to your Tresso server once its chat is there.')
      expect(wrapper.text()).toContain('could not be carried over')
      expect(wrapper.text()).toContain('2 messages could not be copied to your Tresso server')
      expect(wrapper.text()).not.toContain('Secret')
    })

    it('asks whether to relay when a WhatsApp number is not known, and takes over with that yes', async () => {
      const useThisMac = vi.spyOn(wa, 'useThisMac').mockResolvedValue(true)
      wa.config = { ...CONFIG, mode: 'all' }
      wa.serverAccount = { ...ACCOUNT, relayDeviceId: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f' }
      wa.askNumber = 'take-over'
      wa.error = 'Tresso cannot tell whether this Mac is linked to the same WhatsApp number as your Tresso server.'
      const wrapper = open()
      const ask = wrapper.get('[aria-labelledby="wa-number-title"]')
      expect(ask.text()).toContain('Tresso cannot tell whether')
      expect(wrapper.find('.form-error').exists()).toBe(false)
      await ask.findAll('button')[0]!.trigger('click')
      expect(useThisMac).toHaveBeenCalledWith({ number: true, keepGroups: false })
    })

    it('offers to stay on "Only this Mac" while a switch cannot finish', async () => {
      const stayLocal = vi.spyOn(wa, 'stayLocal').mockResolvedValue(true)
      wa.modeSwitch = { to: 'all', accountId: null, copy: true }
      wa.switchFailing = true
      const wrapper = open()
      const button = wrapper.findAll('button').find((candidate) => candidate.text() === 'Stay on Only this Mac')!
      await button.trigger('click')
      expect(stayLocal).toHaveBeenCalled()
    })

    it('says what became of replies not carried over until it is dismissed, and names those not sent in the confirmation', async () => {
      const dismiss = vi.spyOn(wa, 'dismissCarryCounts').mockResolvedValue()
      vi.spyOn(wa, 'notCarried').mockResolvedValue(2)
      wa.carryCounts = { lost: 0, cancelled: 1, unsure: 0, notSent: 0 }
      const wrapper = open()
      expect(wrapper.text()).toContain('1 reply was cancelled on another device and was not sent.')
      await wrapper.findAll('button').find((candidate) => candidate.text() === 'Dismiss')!.trigger('click')
      expect(dismiss).toHaveBeenCalled()

      await wrapper.get<HTMLSelectElement>('#wa-place').setValue('all')
      await flushPromises()
      expect(wrapper.get('[role="alertdialog"]').text()).toContain('2 replies on this Mac that were not sent are not carried over: they go with the chats on this Mac.')
    })

    it('shows the server account\'s settings in "All my devices", not this Mac\'s config', () => {
      wa.config = { ...CONFIG, mode: 'all', includeGroups: true, notify: false }
      wa.serverAccount = { ...ACCOUNT, includeGroups: false, notify: true }
      const wrapper = open()
      expect(wrapper.get<HTMLSelectElement>('#wa-groups').element.value).toBe('direct')
      expect(wrapper.get<HTMLInputElement>('#wa-notify').element.checked).toBe(true)
    })

    it('says how long the relay waits when the server asked it to', () => {
      wa.config = { ...CONFIG, mode: 'all' }
      wa.serverAccount = ACCOUNT
      wa.importState = 'done'
      wa.relayFailing = 'store'
      wa.relayPauseMs = 10 * 60_000
      const wrapper = open()
      expect(wrapper.get('.import-failing').text()).toBe('Your Tresso server asked Tresso to wait; it tries again in about 10 minutes.')
    })

    it('says before a takeover that the group chats would go, and keeps them when asked', async () => {
      const useThisMac = vi.spyOn(wa, 'useThisMac').mockResolvedValue(true)
      wa.config = { ...CONFIG, mode: 'all', includeGroups: false }
      wa.serverAccount = { ...ACCOUNT, relayDeviceId: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f', relayDeviceName: 'Office iMac', includeGroups: true }
      const wrapper = open()
      await row(wrapper, 'Relaying Mac').element.get('button').trigger('click')
      expect(useThisMac).not.toHaveBeenCalled()
      const confirm = wrapper.get('[aria-labelledby="wa-takeover-title"]')
      expect(confirm.text()).toContain(GROUPS_WOULD_GO)
      expect(GROUPS_WOULD_GO).toBe('Group chats will be removed from your Tresso server, because this Mac leaves groups out.')
      await confirm.get('input[type="checkbox"]').setValue(true)
      await confirm.findAll('button')[0]!.trigger('click')
      expect(useThisMac).toHaveBeenCalledWith({ keepGroups: true })
    })

    it('says when WhatsApp was disconnected on another device', () => {
      wa.config = null
      wa.notice = 'WhatsApp was disconnected from your Tresso server, so Tresso disconnected it on this Mac too. WhatsApp itself, the bridge and its own message store on this Mac stay as they are.'
      const wrapper = open()
      expect(wrapper.get('.notice').text()).toBe(wa.notice)
    })
  })
})
