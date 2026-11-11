import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { HandOverError, UnscannedFilesError, type HandOverInput, type SyncedMessage } from '@tresso/core'
import { useHandOversStore } from '@/stores/handOvers'
import type { Contact } from '@/mail/db'
import { useMailStore } from '@/stores/mail'
import HandOverDialog from '../HandOverDialog.vue'

const message: SyncedMessage = {
  id: 'm1',
  mailAccountId: 'work',
  threadId: 't1',
  folderIds: ['inbox'],
  subject: 'Invoice question',
  from: { address: 'reservations@duinzicht.example', name: 'Hotel Duinzicht' },
  recipients: { to: [], cc: [], bcc: [], replyTo: [] },
  snippet: '',
  sentAt: null,
  receivedAt: '2026-10-19T16:40:00Z',
  flags: { seen: true, flagged: false, answered: false, draft: false },
  hasAttachments: false,
  smartInboxId: null,
  verdict: 'delegate',
  summary: null,
  calendarMethod: null,
  attachmentScan: null,
}

/** Form validation runs asynchronously; let it finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('HandOverDialog', () => {
  let handOvers: ReturnType<typeof useHandOversStore>
  let handOver: ReturnType<typeof vi.fn<(message: SyncedMessage, input: HandOverInput) => Promise<void>>>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // Monday 20 October 2026, morning: today, tomorrow and Friday are offered.
    vi.setSystemTime(new Date(2026, 9, 20, 9, 0))
    setActivePinia(createPinia())
    handOvers = useHandOversStore()
    handOver = vi.fn<(message: SyncedMessage, input: HandOverInput) => Promise<void>>(async () => {})
    handOvers.handOver = handOver
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function mountDialog() {
    return mount(HandOverDialog, { props: { message }, attachTo: document.body })
  }

  async function chooseLisa(wrapper: ReturnType<typeof mountDialog>): Promise<void> {
    const input = wrapper.get('input[role="combobox"], .recipients input')
    await input.setValue('Lisa Bakker <lisa@company.example>')
    await input.trigger('keydown', { key: 'Enter' })
  }

  it('says what is handed over and offers today, tomorrow, Friday and a date of choice', () => {
    const wrapper = mountDialog()

    expect(wrapper.text()).toContain('Invoice question, from Hotel Duinzicht')
    expect(wrapper.findAll('.choice-label').map((label) => label.text())).toEqual(['Today', 'Tomorrow', 'Friday', 'Pick a date'])
    wrapper.unmount()
  })

  it('asks who to hand it over to', async () => {
    const wrapper = mountDialog()

    await wrapper.get('form').trigger('submit')
    await settle()

    expect(wrapper.text()).toContain('Choose who to hand it over to.')
    expect(handOver).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('hands it over with the note, due at the end of the chosen day', async () => {
    const wrapper = mountDialog()
    await chooseLisa(wrapper)
    await wrapper.get('textarea').setValue('Can you check the double charge?')
    await wrapper.findAll('input[name="due"]')[2]!.setValue(true)
    await settle()

    expect(wrapper.get('button[type="submit"]').text()).toBe('Hand over to Lisa')
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(handOver).toHaveBeenCalledTimes(1)
    const [handed, input] = handOver.mock.calls[0]!
    expect(handed.id).toBe('m1')
    expect(input.delegate).toEqual({ address: 'lisa@company.example', name: 'Lisa Bakker' })
    expect(input.note).toBe('Can you check the double charge?')
    expect(input.dueAt).toEqual(new Date(2026, 9, 23, 17, 0))
    expect(input.dueLabel).toContain('23')
    wrapper.unmount()
  })

  it('needs a day ahead when the user picks one', async () => {
    const wrapper = mountDialog()
    await chooseLisa(wrapper)
    await wrapper.findAll('input[name="due"]')[3]!.setValue(true)
    await settle()
    await wrapper.get('input[type="date"]').setValue('2026-10-19')

    await wrapper.get('form').trigger('submit')
    await settle()

    expect(wrapper.text()).toContain('Pick a day that is still ahead.')
    expect(handOver).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows why handing over failed and keeps the form', async () => {
    handOver.mockRejectedValueOnce(new HandOverError('The forward could not be sent.'))
    const wrapper = mountDialog()
    await chooseLisa(wrapper)

    await wrapper.get('form').trigger('submit')
    await settle()

    expect(wrapper.get('[role="alert"]').text()).toBe('The forward could not be sent.')
    expect(wrapper.find('textarea').exists()).toBe(true)
    wrapper.unmount()
  })

  it('forwards once when Cmd+Enter is pressed again while the first is on its way', async () => {
    let finish!: () => void
    handOver.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
    const wrapper = mountDialog()
    await chooseLisa(wrapper)

    await wrapper.get('dialog').trigger('keydown', { key: 'Enter', metaKey: true })
    await wrapper.get('dialog').trigger('keydown', { key: 'Enter', metaKey: true })
    await settle()
    await wrapper.get('dialog').trigger('keydown', { key: 'Enter', ctrlKey: true })
    await settle()

    expect(handOver).toHaveBeenCalledTimes(1)
    finish()
    wrapper.unmount()
  })

  it('lets a day be picked from today on, in the local calendar', () => {
    const wrapper = mountDialog()

    return wrapper.findAll('input[name="due"]')[3]!.setValue(true).then(() => {
      expect(wrapper.get('input[type="date"]').attributes('min')).toBe('2026-10-20')
      wrapper.unmount()
    })
  })

  it('asks before handing over files that could not be scanned, and hands them over once confirmed', async () => {
    handOver.mockRejectedValueOnce(new UnscannedFilesError('invoice.pdf could not be scanned. Send it anyway?'))
    const wrapper = mountDialog()
    await chooseLisa(wrapper)

    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.get('.unscanned').text()).toContain('invoice.pdf could not be scanned.')
    expect(handOver.mock.calls[0]![1].acceptUnscanned).toBe(false)

    await wrapper.get('.unscanned button').trigger('click')
    await settle()

    expect(handOver).toHaveBeenCalledTimes(2)
    expect(handOver.mock.calls[1]![1].acceptUnscanned).toBe(true)
    wrapper.unmount()
  })

  it('closes on Escape', async () => {
    const close = vi.spyOn(handOvers, 'close')
    const wrapper = mountDialog()

    // A browser turns Escape in a modal dialog into its cancel event.
    await wrapper.get('dialog').trigger('cancel')

    expect(close).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('stays open while the hand-over is on its way, even on Escape', async () => {
    let finish!: () => void
    handOver.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
    const close = vi.spyOn(handOvers, 'close')
    const wrapper = mountDialog()
    await chooseLisa(wrapper)

    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('dialog').trigger('cancel')

    expect(close).not.toHaveBeenCalled()
    finish()
    wrapper.unmount()
  })

  it('comes back when the browser closes it while the hand-over is on its way, and cancels when it is not', async () => {
    let finish!: () => void
    handOver.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
    const close = vi.spyOn(handOvers, 'close')
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
    const showModal = vi.fn<() => void>()
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { value: showModal, configurable: true, writable: true })
    try {
      const wrapper = mountDialog()
      await chooseLisa(wrapper)
      await wrapper.get('form').trigger('submit')
      await settle()

      // Chromium closes a modal dialog itself on a second Escape.
      await wrapper.get('dialog').trigger('close')
      expect(showModal).toHaveBeenCalledTimes(2)
      expect(close).not.toHaveBeenCalled()

      finish()
      await settle()
      await wrapper.get('dialog').trigger('close')
      expect(close).toHaveBeenCalled()
      wrapper.unmount()
    } finally {
      if (original) {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original)
      } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal
      }
    }
  })

  it('opens as a modal dialog, so the page behind takes no focus', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
    const showModal = vi.fn<() => void>()
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { value: showModal, configurable: true, writable: true })
    try {
      const wrapper = mountDialog()
      expect(showModal).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    } finally {
      if (original) {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original)
      } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal
      }
    }
  })

  it('keeps the note when Escape closes the suggestion list', async () => {
    const close = vi.spyOn(handOvers, 'close')
    useMailStore().suggestContacts = vi.fn<(query: string) => Promise<Contact[]>>(async () => [{ key: 'lisa@company.example', address: 'lisa@company.example', name: 'Lisa Bakker', lastSeen: 0, messages: 1 }])
    const wrapper = mountDialog()
    await wrapper.get('textarea').setValue('Can you check the double charge?')

    await wrapper.get('input[role="combobox"]').setValue('lis')
    await settle()
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true)
    await wrapper.get('input[role="combobox"]').trigger('keydown', { key: 'Escape' })

    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(wrapper.get('textarea').element.value).toBe('Can you check the double charge?')
    wrapper.unmount()
  })
})
