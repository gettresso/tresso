import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { bridgeQr } from '@tresso/core'
import { QR_SIZE_25, QR_SIZE_57 } from '@tresso/core/testing/qr'
import type { BridgeState } from '@/platform/whatsapp'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import { BRIDGE_PROBLEMS, BUILD_COMMAND, RISK_CONFIRM, RISK_TEXT } from '@/components/chat/whatsappTexts'
import ConnectWhatsApp from '../ConnectWhatsApp.vue'

const STOPPED: BridgeState = { process: 'stopped', port: null, loopbackOnly: null, link: 'unknown', qr: null, error: null }
const RUNNING: BridgeState = { process: 'owned', port: 8741, loopbackOnly: true, link: 'unknown', qr: null, error: null }
const GOOD = { found: true, built: true, hasStore: false, safe: true }

function rows(lines: readonly string[]): string[] {
  return bridgeQr(lines).map((row) => row.map((dark) => (dark ? '1' : '0')).join(''))
}

/** The checks, in order: their titles and statuses as shown. */
function checks(wrapper: VueWrapper): { title: string; status: string; text: string }[] {
  return wrapper.findAll('.checks li').map((item) => ({ title: item.get('.title').text(), status: item.get('.status').text(), text: item.text() }))
}

function primary(wrapper: VueWrapper) {
  return wrapper.get('.footer button')
}

describe('ConnectWhatsApp', () => {
  let wa: ReturnType<typeof useWhatsAppRelayStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    wa = useWhatsAppRelayStore()
    wa.available = true
    wa.configLoaded = true
    wa.bridge = STOPPED
  })

  function open() {
    return mount(ConnectWhatsApp, { attachTo: document.body })
  }

  it('starts with every check open, the risk to confirm, and only "Only this Mac" to choose', () => {
    const wrapper = open()

    expect(wrapper.get('h1').text()).toBe('Connect WhatsApp')
    expect(wrapper.get('dialog').attributes('aria-labelledby')).toBe('wa-title')
    expect(checks(wrapper).map(({ title, status }) => [title, status])).toEqual([
      ['whatsapp-mcp found', 'Choose the folder'],
      ['Bridge running', 'Not started'],
      ['Linked to your phone', 'Not linked'],
      ['Recent chats read', 'Waiting'],
    ])
    expect(wrapper.text()).toContain('The folder with whatsapp-bridge. Tresso starts the bridge from here and reads the messages it stores.')
    expect(wrapper.text()).toContain('Tresso reads chats from the last 30 days now and every new message after that.')
    expect(wrapper.text()).toContain(RISK_TEXT)
    expect(wrapper.get('.confirm').text()).toBe(RISK_CONFIRM)
    expect(wrapper.text()).toContain('No folder chosen')

    const radios = wrapper.findAll<HTMLInputElement>('input[type="radio"]')
    expect(radios.map((radio) => [radio.element.value, radio.element.checked, radio.element.disabled])).toEqual([
      ['local', true, false],
      ['all', false, true],
    ])
    expect(wrapper.get('.places').text()).toContain('Coming in a later version.')
    expect(wrapper.get('.install').attributes('href')).toBe('https://github.com/gettresso/whatsapp-mcp')
    expect(primary(wrapper).text()).toBe('Connect WhatsAppEnter')
    expect(primary(wrapper).attributes('disabled')).toBeDefined()
  })

  it('shows what the folder check found, with the build command when the bridge is not built', async () => {
    const wrapper = open()
    wa.folder = '/Users/kim/whatsapp-mcp'
    wa.inspection = { found: false, built: false, hasStore: false, safe: true }
    await flushPromises()
    expect(wrapper.get('.path').text()).toBe('~/whatsapp-mcp')
    expect(checks(wrapper)[0]!.status).toBe('Not found')

    wa.inspection = { found: true, built: false, hasStore: false, safe: true }
    await flushPromises()
    expect(checks(wrapper)[0]!.status).toBe('Found, not built yet')
    expect(wrapper.get('.command').text()).toBe(BUILD_COMMAND)

    wa.inspection = { found: true, built: true, hasStore: false, safe: false }
    await flushPromises()
    expect(checks(wrapper)[0]!.status).toBe('Found, not safe to start')

    wa.inspection = GOOD
    await flushPromises()
    expect(checks(wrapper)[0]!.status).toBe('Found')
    expect(wrapper.findAll('.checks li')[0]!.classes()).toContain('done')

    const choose = vi.spyOn(wa, 'chooseFolder').mockResolvedValue(true)
    await wrapper.get('.field-row button').trigger('click')
    expect(choose).toHaveBeenCalled()
  })

  it('starts the bridge only after the risk was confirmed', async () => {
    const start = vi.spyOn(wa, 'start').mockResolvedValue(true)
    wa.folder = '/Users/kim/whatsapp-mcp'
    wa.inspection = GOOD
    const wrapper = open()
    const button = () => wrapper.findAll('.checks li')[1]!.get('button')

    expect(button().text()).toBe('Start the bridge')
    expect(button().attributes('disabled')).toBeDefined()
    expect(wrapper.get('#wa-start-hint').text()).toBe('Confirm the risk above to start the bridge.')
    expect(button().attributes('aria-describedby')).toBe('wa-start-hint')

    await wrapper.get('.confirm input').setValue(true)
    expect(wa.riskAccepted).toBe(true)
    expect(button().attributes('disabled')).toBeUndefined()
    await button().trigger('click')
    expect(start).toHaveBeenCalled()

    // Once the bridge was started the confirmation stays as it is.
    wa.bridgeStarted = true
    await flushPromises()
    expect(wrapper.get<HTMLInputElement>('.confirm input').element.disabled).toBe(true)
  })

  it('names each state of the bridge, each failure with what to do and Start again', async () => {
    wa.folder = '/Users/kim/whatsapp-mcp'
    wa.inspection = GOOD
    wa.riskAccepted = true
    wa.bridgeStarted = true
    const wrapper = open()
    const bridge = () => wrapper.findAll('.checks li')[1]!

    wa.bridge = { ...RUNNING, port: null }
    await flushPromises()
    expect(bridge().get('.status').text()).toBe('Starting')
    expect(bridge().find('button').exists()).toBe(false)

    wa.bridge = RUNNING
    await flushPromises()
    expect(bridge().get('.status').text()).toBe('Running on this Mac')
    expect(bridge().classes()).toContain('done')

    wa.bridge = STOPPED
    await flushPromises()
    expect(bridge().get('.status').text()).toBe('Stopped')
    expect(bridge().get('button').text()).toBe('Start again')

    for (const failure of ['not_built', 'exited', 'port_busy', 'unprotected', 'unsafe'] as const) {
      wa.bridge = { ...STOPPED, error: failure }
      await flushPromises()
      expect(bridge().get('.status').text()).toBe(BRIDGE_PROBLEMS[failure].status)
      expect(bridge().text()).toContain(BRIDGE_PROBLEMS[failure].detail)
      expect(bridge().find('.command').exists()).toBe(failure === 'not_built' || failure === 'unprotected')
      expect(bridge().get('button').text()).toBe('Start again')
      expect(wrapper.get('[role="status"]').text()).toBe(`The bridge is not running: ${BRIDGE_PROBLEMS[failure].status}.`)
    }
  })

  it('shows the code to scan, a new one in place of the old, and a new code after it expired', async () => {
    const start = vi.spyOn(wa, 'start').mockResolvedValue(true)
    wa.folder = '/Users/kim/whatsapp-mcp'
    wa.inspection = GOOD
    wa.riskAccepted = true
    wa.bridgeStarted = true
    wa.bridge = { ...RUNNING, link: 'waiting_for_scan' }
    const wrapper = open()
    const link = () => wrapper.findAll('.checks li')[2]!
    expect(link().get('.status').text()).toBe('Waiting for the code')

    wa.bridge = { ...RUNNING, link: 'waiting_for_scan', qr: rows(QR_SIZE_25) }
    await flushPromises()
    expect(link().get('.status').text()).toBe('Scan the code')
    expect(link().get('svg').attributes('aria-label')).toBe('QR code to scan with WhatsApp on your phone')
    expect(link().get('svg').attributes('viewBox')).toBe('0 0 33 33')
    expect(link().text()).toContain('Scan this code with WhatsApp > Linked devices on your phone. WhatsApp can ask you to link again, often after about 20 days.')
    expect(wrapper.get('[role="status"]').text()).toBe('A code to scan is shown.')

    wa.bridge = { ...RUNNING, link: 'waiting_for_scan', qr: rows(QR_SIZE_57) }
    await flushPromises()
    expect(link().findAll('svg')).toHaveLength(1)
    expect(link().get('svg').attributes('viewBox')).toBe('0 0 65 65')

    wa.bridge = { ...STOPPED, link: 'unlinked' }
    await flushPromises()
    expect(link().get('.status').text()).toBe('Code expired')
    expect(link().find('svg').exists()).toBe(false)
    expect(wrapper.get('[role="status"]').text()).toBe('The code expired.')
    await link().get('button').trigger('click')
    expect(start).toHaveBeenCalled()

    wa.bridge = { ...RUNNING, link: 'linked' }
    wa.identity = { number: '31698765432', name: 'Kim Visser' }
    await flushPromises()
    expect(link().get('.status').text()).toBe('Linked as Kim Visser, +31698765432')
    expect(wrapper.get('[role="status"]').text()).toBe('Linked as Kim Visser, +31698765432.')
  })

  it('connects with Enter once the first three checks are done, then shows the import and Done', async () => {
    const connect = vi.spyOn(wa, 'connect').mockImplementation(async () => {
      wa.config = { folder: '/Users/kim/whatsapp-mcp', mode: 'local', deviceId: 'd', deviceName: 'Mac', linkedAt: null, importSince: '2026-10-13T10:00:00.000Z', includeGroups: true, notify: false, leftOut: [] }
      return true
    })
    wa.folder = '/Users/kim/whatsapp-mcp'
    wa.inspection = GOOD
    wa.riskAccepted = true
    wa.bridgeStarted = true
    wa.bridge = { ...RUNNING, link: 'waiting_for_scan' }
    const wrapper = open()
    expect(primary(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.get('dialog').trigger('keydown', { key: 'Enter' })
    expect(connect).not.toHaveBeenCalled()

    wa.bridge = { ...RUNNING, link: 'linked' }
    await flushPromises()
    expect(primary(wrapper).attributes('disabled')).toBeUndefined()
    await wrapper.get('dialog').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(connect).toHaveBeenCalledTimes(1)

    const imported = () => wrapper.findAll('.checks li')[3]!
    wa.importState = 'reading'
    wa.progress = { chats: 3, stored: 120, known: 0, leftOut: 0, refused: 0, skipped: { not_a_chat: 0, groups_off: 0, left_out: 0, before_import: 0, no_time: 0, bad_time: 0, bad_id: 0, nothing_to_show: 0 }, firstImport: true }
    await flushPromises()
    expect(imported().get('.status').text()).toBe('Reading')
    expect(imported().text()).toContain('120 messages from 3 chats so far.')
    expect(wrapper.get('[role="status"]').text()).toBe('Reading your recent chats.')

    wa.importState = 'stuck'
    wa.stuckRefused = 4
    await flushPromises()
    expect(imported().get('.status').text()).toBe('Stuck')
    expect(imported().text()).toContain('4 messages could not be stored')
    expect(wrapper.get('[role="status"]').text()).toBe('Reading your chats is stuck.')

    wa.importState = 'done'
    wa.chatCount = 214
    await flushPromises()
    expect(imported().get('.status').text()).toBe('214 chats, 30 days')
    expect(imported().classes()).toContain('done')
    expect(wrapper.get('[role="status"]').text()).toBe('Your recent chats are in.')

    expect(wrapper.get('.later').text()).toBe('Your chats will show in Tresso in a later version.')
    expect(primary(wrapper).text()).toBe('Done')
    await primary(wrapper).trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('shows a failure as an alert and closes with Close or Escape', async () => {
    const wrapper = open()
    wa.error = 'WhatsApp works in Tresso for Mac only.'
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('WhatsApp works in Tresso for Mac only.')

    await wrapper.get('button[aria-label="Close"]').trigger('click')
    await wrapper.get('dialog').trigger('cancel')
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('gives focus back to what opened it', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const wrapper = open()
    wrapper.unmount()
    await flushPromises()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('keeps Connect off while the risk is not confirmed, also when everything else is done', async () => {
    const connect = vi.spyOn(wa, 'connect').mockResolvedValue(true)
    wa.folder = '/Users/kim/whatsapp-mcp'
    wa.inspection = GOOD
    wa.bridge = { ...RUNNING, link: 'linked' }
    const wrapper = open()
    expect(primary(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.get('dialog').trigger('keydown', { key: 'Enter' })
    expect(connect).not.toHaveBeenCalled()
    expect(wrapper.find('.later').exists()).toBe(false)

    await wrapper.get('.confirm input').setValue(true)
    expect(primary(wrapper).attributes('disabled')).toBeUndefined()
  })
})
