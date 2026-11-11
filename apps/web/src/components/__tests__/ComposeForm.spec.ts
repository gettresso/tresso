import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SyncedOutgoingMessage } from '@tresso/core'
import type { Draft } from '@/mail/db'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import ComposeForm from '../ComposeForm.vue'

const draft: Draft = { id: 'd1', mailAccountId: 'work', to: [], cc: [], bcc: [], subject: 'Hello', html: '<p>Hi</p>', signatureId: null, quoteHtml: '', inReplyToMessageId: null, kind: 'new', version: 0, pendingSave: false, remoteVersion: null, outgoingId: null, noticedStatus: null, updatedAt: 1, attachments: [] }

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function setup(initial: Draft) {
  setActivePinia(createPinia())
  const mail = useMailStore()
  mail.accounts = [{ id: 'work', emailAddress: 'kim@company.example', displayName: 'Kim', provider: 'imap', status: 'active', statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null }]
  const compose = useComposeStore()
  const send = vi.fn<(sendAt?: Date) => Promise<SyncedOutgoingMessage | null>>(async () => null)
  compose.send = send
  compose.update = vi.fn<(changes: Partial<Draft>) => void>()
  const wrapper = mount(ComposeForm, { props: { draft: initial }, attachTo: document.body, global: { stubs: { RouterLink: true } } })
  return { wrapper, send }
}

describe('ComposeForm', () => {
  it('does not send without recipients and says why', async () => {
    const { wrapper, send } = setup(draft)

    await wrapper.get('form').trigger('submit')
    await settle()

    expect(send).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Add at least one recipient.')
    wrapper.unmount()
  })

  it('sends a valid message', async () => {
    const { wrapper, send } = setup({ ...draft, to: [{ address: 'anna@finance.example', name: 'Anna' }] })

    await wrapper.get('form').trigger('submit')
    await settle()

    expect(send).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('refuses an account-less draft', async () => {
    const { wrapper, send } = setup({ ...draft, mailAccountId: null, to: [{ address: 'anna@finance.example', name: null }] })

    await wrapper.get('form').trigger('submit')
    await settle()

    expect(send).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Choose the account to send from.')
    wrapper.unmount()
  })

  it('closes only the Send later menu on Escape, so the compose window stays', async () => {
    const { wrapper } = setup(draft)
    const parent = vi.fn<(event: KeyboardEvent) => void>()
    wrapper.element.parentElement!.addEventListener('keydown', parent)

    await wrapper.get('.later > button').trigger('click')
    await settle()
    expect(wrapper.find('.later [role="menu"]').exists()).toBe(true)
    // Focus moved to the first choice, so Escape lands in the menu whatever the engine did with the click.
    expect(document.activeElement).toBe(wrapper.find('.later [role="menuitem"]').element)
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()

    expect(wrapper.find('.later [role="menu"]').exists()).toBe(false)
    expect(parent).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(wrapper.get('.later > button').element)
    wrapper.element.parentElement!.removeEventListener('keydown', parent)
    wrapper.unmount()
  })

  it('closes the Send later menu on a press elsewhere', async () => {
    const { wrapper } = setup(draft)

    await wrapper.get('.later > button').trigger('click')
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await settle()

    expect(wrapper.find('.later [role="menu"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
