import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { bridgeQr } from '@tresso/core'
import { QR_SIZE_25, QR_SIZE_57 } from '@tresso/core/testing/qr'
import type { BridgeFailure, BridgeState, WhatsAppConfig } from '@/platform/whatsapp'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import { ASK_COPY_BODY, ASK_COPY_TITLE, FAILURES, PLACE_ALL_NOTE, PLACE_LOCAL_NOTE, REMOVE_TITLE, RISK_CONFIRM, RISK_TEXT } from '@/components/chat/whatsappTexts'
import ConnectWhatsApp from '../ConnectWhatsApp.vue'

const STOPPED: BridgeState = { process: 'stopped', port: null, loopbackOnly: null, link: 'unknown', qr: null, error: null }
const STARTING: BridgeState = { process: 'owned', port: null, loopbackOnly: null, link: 'unknown', qr: null, error: null }
const LINKED: BridgeState = { process: 'owned', port: 8741, loopbackOnly: true, link: 'linked', qr: null, error: null }
/** Words the dialog never says: Tresso for Mac carries its own link to WhatsApp. */
const UNSAID = /whatsapp-mcp|bridge|folder|\bport\b|install whatsapp|terminal/i

function rows(lines: readonly string[]): string[] {
  return bridgeQr(lines).map((row) => row.map((dark) => (dark ? '1' : '0')).join(''))
}

function config(mode: 'local' | 'all' = 'local'): WhatsAppConfig {
  return { mode, deviceId: 'd', deviceName: 'Mac', linkedAt: null, importSince: '2026-10-13T10:00:00.000Z', includeGroups: true, notify: false, leftOut: [], moved: false }
}

function primary(wrapper: VueWrapper) {
  return wrapper.get('.footer button')
}

function status(wrapper: VueWrapper): string {
  return wrapper.get('p.visually-hidden[role="status"]').text()
}

describe('ConnectWhatsApp', () => {
  let wa: ReturnType<typeof useWhatsAppRelayStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    wa = useWhatsAppRelayStore()
    wa.available = true
    wa.configLoaded = true
    wa.bridge = STOPPED
    wa.userId = 'u1'
  })

  function open(mode?: 'local' | 'all') {
    const wrapper = mount(ConnectWhatsApp, { attachTo: document.body, props: mode === undefined ? {} : { mode } })
    // jsdom has no modal dialogs: open it as showModal would, so what is inside can take focus.
    wrapper.get('dialog').element.setAttribute('open', '')
    return wrapper
  }

  /** The store's start, as the shell answers it: a code on its way. */
  function starts() {
    return vi.spyOn(wa, 'start').mockImplementation(async () => {
      wa.bridge = STARTING
      return true
    })
  }

  /** The store's connect: the config is saved and the reading begins. */
  function connects(mode: 'local' | 'all' = 'local') {
    return vi.spyOn(wa, 'connect').mockImplementation(async (where) => {
      wa.config = config(where ?? mode)
      wa.importState = 'reading'
      return true
    })
  }

  async function toTheCode(wrapper: VueWrapper): Promise<void> {
    await wrapper.get('.confirm input').setValue(true)
    await primary(wrapper).trigger('click')
    await flushPromises()
  }

  it('starts with the risk, 500 px wide, and nothing starts before the box is ticked', async () => {
    const start = starts()
    const wrapper = open()
    expect(wrapper.get('h1').text()).toBe('Connect WhatsApp')
    expect(wrapper.get('.lead').text()).toBe('Read and answer your WhatsApp chats next to your mail.')
    expect(wrapper.get('.eyebrow').text()).toBe('Tresso for Mac')
    // The real WhatsApp mark.
    expect(wrapper.get('.logo .provider-mark').classes()).toContain('whatsapp')
    expect(wrapper.get('#wa-risk').text()).toBe(RISK_TEXT)
    expect(wrapper.get('.confirm').text()).toBe(RISK_CONFIRM)
    expect(wrapper.get('.confirm input').attributes('aria-describedby')).toBe('wa-risk')
    expect(primary(wrapper).text()).toBe('Show QR code')
    expect(wrapper.findAll('.footer button')).toHaveLength(1)
    expect(wrapper.text()).not.toMatch(UNSAID)

    expect(primary(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.get('dialog').trigger('keydown', { key: 'Enter' })
    await primary(wrapper).trigger('click')
    expect(start).not.toHaveBeenCalled()

    await wrapper.get('.confirm input').setValue(true)
    expect(primary(wrapper).attributes('disabled')).toBeUndefined()
    await wrapper.get('dialog').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('shows getting a code, the code, and The code expired with Show a new code', async () => {
    const start = starts()
    const wrapper = open()
    await toTheCode(wrapper)
    expect(wrapper.get('h1').text()).toBe('Scan this code with your phone')
    expect(wrapper.get('.tile.empty').text()).toBe('Getting a code…')
    expect(wrapper.findAll('.steps li').map((step) => step.text())).toEqual([
      '1Open WhatsApp on your phone.',
      '2Go to Settings, then Linked devices.',
      '3Tap Link a device and scan this code.',
    ])
    expect(status(wrapper)).toBe('Getting a code.')
    // No button while the phone is the next step.
    expect(wrapper.find('.footer').exists()).toBe(false)

    wa.bridge = { ...STARTING, link: 'waiting_for_scan', qr: rows(QR_SIZE_25) }
    await flushPromises()
    const code = wrapper.get('.tile.code svg')
    expect(code.attributes('aria-label')).toBe('QR code to scan with WhatsApp on your phone')
    expect(code.attributes('viewBox')).toBe('0 0 33 33')
    expect(wrapper.get('.renews').text()).toBe('The code renews by itself.')
    expect(status(wrapper)).toBe('A code to scan is shown.')

    // A new code takes the old one's place, without a word.
    wa.bridge = { ...STARTING, link: 'waiting_for_scan', qr: rows(QR_SIZE_57) }
    await flushPromises()
    expect(wrapper.findAll('.tile.code svg')).toHaveLength(1)
    expect(wrapper.get('.tile.code svg').attributes('viewBox')).toBe('0 0 65 65')

    wa.bridge = { ...STOPPED, link: 'unlinked' }
    await flushPromises()
    expect(wrapper.get('.tile.empty').text()).toContain('The code expired')
    expect(wrapper.get('.tile.empty').text()).toContain('Nobody scanned it for three minutes.')
    expect(status(wrapper)).toBe('The code expired.')
    await wrapper.get('.tile.empty button').trigger('click')
    expect(start).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toMatch(UNSAID)
  })

  it('connects once the phone linked, shows the reading, and Done leaves it', async () => {
    starts()
    const connect = connects()
    const wrapper = open()
    await toTheCode(wrapper)
    wa.identity = { number: '31612345678', name: 'Kim Visser' }
    wa.bridge = LINKED
    await flushPromises()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenLastCalledWith('local', { number: false })
    expect(wrapper.get('h1').text()).toBe('Linked to +31612345678')
    expect(wrapper.get('.lead').text()).toBe('Kim Visser')
    expect(wrapper.get('.progress').text()).toBe('Reading chats from the last 30 days…')
    expect(status(wrapper)).toBe('Linked. Reading your recent chats.')
    const places = wrapper.findAll('[role="radio"]')
    expect(places.map((place) => [place.get('.strong').text(), place.get('.quiet').text(), place.attributes('aria-checked')])).toEqual([
      ['Only this Mac', PLACE_LOCAL_NOTE, 'true'],
      ['All my devices', PLACE_ALL_NOTE, 'false'],
    ])

    wa.importState = 'done'
    await flushPromises()
    expect(wrapper.get('.progress').text()).toBe('Chats read')
    expect(status(wrapper)).toBe('Linked. Your recent chats are in.')

    expect(primary(wrapper).text()).toBe('Done')
    await primary(wrapper).trigger('click')
    expect(wrapper.emitted('done')).toHaveLength(1)
    await wrapper.get('dialog').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('done')).toHaveLength(2)
    expect(wrapper.emitted('close')).toBeUndefined()
    // A later change of the state never connects twice.
    wa.bridge = { ...LINKED, port: 9000 }
    await flushPromises()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).not.toMatch(UNSAID)
  })

  it('asks before All my devices copies the chats, and Done waits for the answer', async () => {
    starts()
    connects()
    const switchMode = vi.spyOn(wa, 'switchMode').mockImplementation(async (to) => {
      wa.config = config(to)
      return true
    })
    const wrapper = open()
    await toTheCode(wrapper)
    wa.bridge = LINKED
    await flushPromises()
    const place = (index: number) => wrapper.findAll('[role="radio"]')[index]!

    await place(1).trigger('click')
    await flushPromises()
    const ask = wrapper.get('[role="alertdialog"]')
    expect(ask.get('#wa-ask-title').text()).toBe(ASK_COPY_TITLE)
    expect(ask.get('#wa-ask-body').text()).toBe(ASK_COPY_BODY)
    expect(ask.findAll('button').map((button) => button.text())).toEqual(['Copy', 'Cancel'])
    // The question is open: All my devices shows as picked, and Done waits.
    expect(place(1).attributes('aria-checked')).toBe('true')
    expect(primary(wrapper).attributes('disabled')).toBeDefined()

    await ask.findAll('button')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(place(0).attributes('aria-checked')).toBe('true')
    expect(switchMode).not.toHaveBeenCalled()
    expect(primary(wrapper).attributes('disabled')).toBeUndefined()

    await place(1).trigger('click')
    await flushPromises()
    await wrapper.get('[role="alertdialog"]').findAll('button')[0]!.trigger('click')
    await flushPromises()
    expect(switchMode).toHaveBeenLastCalledWith('all', { copy: true })
    expect(place(1).attributes('aria-checked')).toBe('true')

    // Back to Only this Mac removes them from the server: asked too.
    await place(0).trigger('click')
    await flushPromises()
    expect(wrapper.get('#wa-ask-title').text()).toBe(REMOVE_TITLE)
    await wrapper.get('[role="alertdialog"]').findAll('button')[0]!.trigger('click')
    await flushPromises()
    expect(switchMode).toHaveBeenLastCalledWith('local', { copy: false })
    expect(place(0).attributes('aria-checked')).toBe('true')
  })

  it('takes the relay over without asking while another Mac relays the chats on the server', async () => {
    starts()
    const connect = connects('all')
    wa.serverAccount = { id: 'a', channel: 'whatsapp', address: null, displayName: null, relayDeviceId: 'other', relayDeviceName: 'Office iMac', relayOnline: true, relayOfflineSince: null, bridge: 'running', link: 'linked', linkedAt: null, loopbackOnly: true, includeGroups: true, notify: false }
    const wrapper = open('all')
    await toTheCode(wrapper)
    wa.bridge = LINKED
    await flushPromises()
    // No yes to copying was given: the store relays only the account that holds the chats already.
    expect(connect).toHaveBeenLastCalledWith('all', { number: false })
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(wrapper.findAll('[role="radio"]')[1]!.attributes('aria-checked')).toBe('true')
    wrapper.unmount()
  })

  it('connects on this Mac only when it was opened to take over but no Mac relays any more (a link is no consent)', async () => {
    starts()
    const connect = connects()
    const wrapper = open('all')
    await toTheCode(wrapper)
    wa.bridge = LINKED
    await flushPromises()
    expect(connect).toHaveBeenLastCalledWith('local', { number: false })
    expect(wrapper.findAll('[role="radio"]')[0]!.attributes('aria-checked')).toBe('true')
    wrapper.unmount()
  })

  it('asks whether to relay when a WhatsApp number is not known, and connects with that yes', async () => {
    starts()
    const connect = vi.spyOn(wa, 'connect').mockImplementation(async () => {
      wa.askNumber = 'connect'
      wa.error = 'Tresso cannot tell whether this Mac is linked to the same WhatsApp number as your Tresso server.'
      return false
    })
    wa.serverAccount = { id: 'a', channel: 'whatsapp', address: null, displayName: null, relayDeviceId: 'other', relayDeviceName: 'Office iMac', relayOnline: false, relayOfflineSince: null, bridge: 'running', link: 'linked', linkedAt: null, loopbackOnly: true, includeGroups: true, notify: false }
    const wrapper = open('all')
    await toTheCode(wrapper)
    wa.bridge = LINKED
    await flushPromises()
    const ask = wrapper.findAll('[role="alertdialog"]').find((dialog) => dialog.text().includes('Relay from this Mac'))!
    expect(ask.text()).toContain('Tresso cannot tell whether this Mac is linked')
    await ask.findAll('button')[0]!.trigger('click')
    await flushPromises()
    expect(connect).toHaveBeenLastCalledWith('all', { number: true })
    wrapper.unmount()
  })

  it('shows every failure as one pattern: a title, one sentence, one button that starts again', async () => {
    const start = starts()
    const wrapper = open()
    await toTheCode(wrapper)
    for (const failure of ['missing', 'store', 'offline', 'pair_failed', 'outdated', 'replaced', 'banned', 'exited', 'logged_out'] as BridgeFailure[]) {
      wa.bridge = { ...STOPPED, link: failure === 'logged_out' ? 'unlinked' : 'unknown', error: failure }
      await flushPromises()
      const alert = wrapper.get('[role="alert"]')
      expect(alert.get('h1').text()).toBe(FAILURES[failure].title)
      expect(alert.get('.lead').text()).toBe(FAILURES[failure].text)
      expect(wrapper.findAll('.footer button').map((button) => button.text())).toEqual([FAILURES[failure].action])
      expect(wrapper.text()).not.toMatch(UNSAID)
    }
    expect(wrapper.get('h1').text()).toBe('This phone signed Tresso out')
    expect(primary(wrapper).text()).toBe('Link again')
    const before = start.mock.calls.length
    await primary(wrapper).trigger('click')
    expect(start).toHaveBeenCalledTimes(before + 1)

    wa.bridge = { ...STOPPED, error: 'exited' }
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe('WhatsApp could not start on this Mac')
    expect(wrapper.get('.lead').text()).toBe('Nothing was linked. Try again in a moment.')
    expect(primary(wrapper).text()).toBe('Try again')
  })

  it('says a start the shell refused in the same pattern', async () => {
    vi.spyOn(wa, 'start').mockImplementation(async () => {
      wa.error = 'WhatsApp works in Tresso for Mac only.'
      return false
    })
    const wrapper = open()
    await toTheCode(wrapper)
    expect(wrapper.get('h1').text()).toBe('WhatsApp could not start on this Mac')
    expect(wrapper.get('.lead').text()).toBe('WhatsApp works in Tresso for Mac only.')
    expect(primary(wrapper).text()).toBe('Try again')
  })

  it('puts focus on the step heading at every step change', async () => {
    starts()
    connects()
    const wrapper = open()
    await toTheCode(wrapper)
    await flushPromises()
    expect(document.activeElement?.tagName).toBe('H1')
    expect(document.activeElement?.textContent).toBe('Scan this code with your phone')
    wa.bridge = LINKED
    await flushPromises()
    expect(document.activeElement?.textContent).toBe('Linked')
    wrapper.unmount()
  })

  it('offers Try again in the linked step whenever WhatsApp is not connected and nothing runs, and says closing unlinks', async () => {
    starts()
    let answers = 0
    const connect = vi.spyOn(wa, 'connect').mockImplementation(async () => {
      answers++
      if (answers === 1) {
        wa.askNumber = 'connect'
        wa.error = 'Tresso cannot tell whether this Mac is linked to the same WhatsApp number as your Tresso server.'
        return false
      }
      wa.config = config()
      return true
    })
    const wrapper = open()
    await toTheCode(wrapper)
    wa.bridge = LINKED
    await flushPromises()
    // Cancel on the number question: no dead end, Try again connects again.
    const ask = wrapper.findAll('[role="alertdialog"]').find((dialog) => dialog.text().includes('Relay from this Mac'))!
    await ask.findAll('button')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Closing now unlinks this Mac from your phone again.')
    expect(primary(wrapper).text()).toBe('Try again')
    expect(primary(wrapper).attributes('disabled')).toBeUndefined()
    await primary(wrapper).trigger('click')
    await flushPromises()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(primary(wrapper).text()).toBe('Done')
    expect(wrapper.text()).not.toContain('Closing now unlinks')
    wrapper.unmount()
  })

  it('connects by itself once the start that was still running finished', async () => {
    let release!: () => void
    vi.spyOn(wa, 'start').mockImplementation(async () => {
      wa.busy = 'start'
      wa.bridge = LINKED
      await new Promise<void>((resolve) => (release = resolve))
      wa.busy = null
      return true
    })
    const connect = connects()
    const wrapper = open()
    await wrapper.get('.confirm input').setValue(true)
    void primary(wrapper).trigger('click')
    await flushPromises()
    expect(connect).not.toHaveBeenCalled()
    release()
    await flushPromises()
    expect(connect).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('never spins forever: a stop from outside, or a code that never comes, ends in Try again', async () => {
    const start = starts()
    const wrapper = open()
    await toTheCode(wrapper)
    expect(wrapper.get('h1').text()).toBe('Scan this code with your phone')
    // Stopped from outside, with no error (a removal finishing elsewhere).
    wa.bridge = STOPPED
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe('WhatsApp could not start on this Mac')
    expect(primary(wrapper).text()).toBe('Try again')
    await primary(wrapper).trigger('click')
    expect(start).toHaveBeenCalledTimes(2)
    wrapper.unmount()

    vi.useFakeTimers()
    try {
      const late = open()
      await late.get('.confirm input').setValue(true)
      await primary(late).trigger('click')
      await flushPromises()
      expect(late.get('.tile.empty').text()).toBe('Getting a code\u2026')
      await vi.advanceTimersByTimeAsync(61_000)
      expect(late.get('h1').text()).toBe('WhatsApp could not start on this Mac')
      expect(primary(late).text()).toBe('Try again')
      late.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers no Try again for a missing part: its one button closes', async () => {
    starts()
    const wrapper = open()
    await toTheCode(wrapper)
    wa.bridge = { ...STOPPED, error: 'missing' }
    await flushPromises()
    expect(primary(wrapper).text()).toBe('Close')
    await primary(wrapper).trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('shows Remove as the danger button, with Cancel the focused answer', async () => {
    starts()
    connects()
    vi.spyOn(wa, 'switchMode').mockImplementation(async (to) => {
      wa.config = config(to)
      return true
    })
    const wrapper = open()
    await toTheCode(wrapper)
    wa.bridge = LINKED
    await flushPromises()
    await wrapper.findAll('[role="radio"]')[1]!.trigger('click')
    await flushPromises()
    await wrapper.get('[role="alertdialog"]').findAll('button')[0]!.trigger('click')
    await flushPromises()
    await wrapper.findAll('[role="radio"]')[0]!.trigger('click')
    await flushPromises()
    const [remove, cancel] = wrapper.get('[role="alertdialog"]').findAll('button')
    expect(remove!.text()).toBe('Remove')
    expect(remove!.classes()).toContain('button-danger')
    expect(document.activeElement).toBe(cancel!.element)
    wrapper.unmount()
  })

  it('makes Enter do what the linked step shows: Try again, nothing during a question, Done only when connected', async () => {
    starts()
    let answers = 0
    const connect = vi.spyOn(wa, 'connect').mockImplementation(async () => {
      answers++
      if (answers === 1) {
        wa.askNumber = 'connect'
        wa.error = 'Tresso cannot tell whether this Mac is linked to the same WhatsApp number as your Tresso server.'
        return false
      }
      if (answers === 2) {
        wa.error = 'Your Tresso server could not be reached.'
        return false
      }
      wa.config = config()
      return true
    })
    const wrapper = open()
    await toTheCode(wrapper)
    wa.bridge = LINKED
    await flushPromises()
    const enter = async () => {
      const focused = document.activeElement as HTMLElement
      expect(focused.tagName).toBe('H1')
      focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushPromises()
    }
    // The number question is open: Enter does nothing (no Done, no unlink).
    expect(wa.askNumber).toBe('connect')
    await enter()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('done')).toBeUndefined()
    // Cancel the question: Try again shows, and Enter is Try again.
    wa.askNumber = null
    wa.error = null
    await flushPromises()
    ;(wrapper.get('h1').element as HTMLElement).focus()
    await enter()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('done')).toBeUndefined()
    // It failed again: still Try again, never Done.
    await enter()
    expect(connect).toHaveBeenCalledTimes(3)
    expect(wa.connected).toBe(true)
    await enter()
    expect(wrapper.emitted('done')).toHaveLength(1)
    wrapper.unmount()
  })

  it('says closing unlinks whenever the phone linked and WhatsApp is not connected, also during a question or a connect', async () => {
    starts()
    let finish!: () => void
    vi.spyOn(wa, 'connect').mockImplementation(async () => {
      wa.busy = 'connect'
      await new Promise<void>((resolve) => (finish = resolve))
      wa.busy = null
      wa.askNumber = 'connect'
      wa.error = 'Tresso cannot tell whether this Mac is linked to the same WhatsApp number as your Tresso server.'
      return false
    })
    const wrapper = open()
    await toTheCode(wrapper)
    wa.bridge = LINKED
    await flushPromises()
    // A connect runs.
    expect(wrapper.text()).toContain('Closing now unlinks this Mac from your phone again.')
    finish()
    await flushPromises()
    // The number question is open.
    expect(wa.askNumber).toBe('connect')
    expect(wrapper.text()).toContain('Closing now unlinks this Mac from your phone again.')
    wrapper.unmount()
  })

  it('waits through a planned restart without calling it a failure', async () => {
    starts()
    const wrapper = open()
    await toTheCode(wrapper)
    wa.bridge = { ...STOPPED, restarting: true }
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe('Scan this code with your phone')
    expect(wrapper.get('.tile.empty').text()).toBe('Getting a code\u2026')
    expect(document.activeElement?.textContent).toBe('Scan this code with your phone')
    wa.bridge = STARTING
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe('Scan this code with your phone')
    wrapper.unmount()
  })

  it('takes back the backstop when a code comes late, covers a start that waits, and shows no expired code before one was shown', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      vi.spyOn(wa, 'start').mockImplementation(async () => {
        wa.busy = 'start'
        await new Promise<void>((resolve) => (release = resolve))
        wa.busy = null
        wa.bridge = STARTING
        return true
      })
      // A relink starts from stopped and unlinked: while the start runs, a loader, not "The code expired".
      wa.bridge = { ...STOPPED, link: 'unlinked' }
      const wrapper = open()
      await wrapper.get('.confirm input').setValue(true)
      void primary(wrapper).trigger('click')
      await flushPromises()
      expect(wrapper.get('.tile.empty').text()).toBe('Getting a code\u2026')
      expect(wrapper.text()).not.toContain('The code expired')
      // The start waits on other work for a minute: the backstop covers it too.
      await vi.advanceTimersByTimeAsync(61_000)
      expect(wrapper.get('h1').text()).toBe('WhatsApp could not start on this Mac')
      // The code comes after all: shown, the backstop's word taken back.
      release()
      await flushPromises()
      expect(wrapper.get('h1').text()).toBe('WhatsApp could not start on this Mac')
      wa.bridge = { ...STARTING, link: 'waiting_for_scan', qr: rows(QR_SIZE_25) }
      await flushPromises()
      expect(wrapper.get('h1').text()).toBe('Scan this code with your phone')
      expect(wrapper.find('.tile.code svg').exists()).toBe(true)
      // Now a code was shown: its time-out is "The code expired".
      wa.bridge = { ...STOPPED, link: 'unlinked' }
      await flushPromises()
      expect(wrapper.text()).toContain('The code expired')
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes with Close or Escape', async () => {
    const wrapper = open()
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
})
