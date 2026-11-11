import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Address } from '@tresso/core'
import type { Contact } from '@/mail/db'
import { useMailStore } from '@/stores/mail'
import RecipientField from '../RecipientField.vue'

function mountField(initial: Address[] = []) {
  setActivePinia(createPinia())
  const updates: Address[][] = []
  const wrapper = mount(RecipientField, {
    props: { label: 'To', modelValue: initial, 'onUpdate:modelValue': (value: Address[]) => updates.push(value) },
  })
  return { wrapper, updates }
}

describe('RecipientField', () => {
  it('turns typed addresses into recipients on Enter', async () => {
    const { wrapper, updates } = mountField()

    await wrapper.get('input').setValue('anna@finance.example')
    await wrapper.get('input').trigger('keydown', { key: 'Enter' })

    expect(updates[updates.length - 1]).toEqual([{ address: 'anna@finance.example', name: null }])
  })

  it('splits a pasted list and skips duplicates', async () => {
    const { wrapper, updates } = mountField([{ address: 'anna@finance.example', name: 'Anna' }])

    await wrapper.get('input').trigger('paste', { clipboardData: { getData: () => 'Anna <ANNA@finance.example>, Pieter <pieter@company.example>' } })

    expect(updates[updates.length - 1]).toEqual([
      { address: 'anna@finance.example', name: 'Anna' },
      { address: 'pieter@company.example', name: 'Pieter' },
    ])
  })

  it('removes the last recipient with Backspace in an empty field', async () => {
    const { wrapper, updates } = mountField([{ address: 'anna@finance.example', name: null }, { address: 'pieter@company.example', name: null }])

    await wrapper.get('input').trigger('keydown', { key: 'Backspace' })

    expect(updates[updates.length - 1]).toEqual([{ address: 'anna@finance.example', name: null }])
  })

  it('marks addresses that cannot be right', () => {
    const { wrapper } = mountField([{ address: 'anna@', name: null }])

    expect(wrapper.get('.chip').classes()).toContain('wrong')
  })

  it('closes an open suggestion list on Escape without letting the key reach what holds the field', async () => {
    const { wrapper } = mountField()
    useMailStore().suggestContacts = vi.fn<(query: string) => Promise<Contact[]>>(async () => [{ key: 'lisa@company.example', address: 'lisa@company.example', name: 'Lisa Bakker', lastSeen: 0, messages: 1 }])
    const parent = vi.fn<(event: KeyboardEvent) => void>()
    wrapper.element.addEventListener('keydown', parent)

    await wrapper.get('input').setValue('lis')
    await flushPromises()
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true)
    await wrapper.get('input').trigger('keydown', { key: 'Escape' })

    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    expect(parent).not.toHaveBeenCalled()

    // With the list closed, the next Escape is for the dialog or window around the field.
    await wrapper.get('input').trigger('keydown', { key: 'Escape' })
    expect(parent).toHaveBeenCalledTimes(1)
  })
})
