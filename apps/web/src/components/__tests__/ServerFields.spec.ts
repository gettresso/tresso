import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ServerSettings } from '@tresso/core'
import ServerFields from '../ServerFields.vue'

function mountFields(settings: ServerSettings) {
  const updates: ServerSettings[] = []
  const wrapper = mount(ServerFields, {
    props: { protocol: 'smtp', title: 'Outgoing mail', modelValue: settings, 'onUpdate:modelValue': (value: ServerSettings) => updates.push(value) },
  })
  return { wrapper, updates }
}

describe('ServerFields', () => {
  it('moves a usual port along with the security mode', async () => {
    const { wrapper, updates } = mountFields({ host: 'smtp.example.test', port: 465, security: 'tls' })

    await wrapper.get('select').setValue('starttls')

    expect(updates[updates.length - 1]).toEqual({ host: 'smtp.example.test', port: 587, security: 'starttls' })
  })

  it('keeps a custom port', async () => {
    const { wrapper, updates } = mountFields({ host: 'smtp.example.test', port: 2525, security: 'tls' })

    await wrapper.get('select').setValue('starttls')

    expect(updates[updates.length - 1]?.port).toBe(2525)
  })

  it('shows validation messages next to the field', () => {
    const wrapper = mount(ServerFields, {
      props: { protocol: 'imap', title: 'Incoming mail', modelValue: { host: '10.0.0.1', port: 993, security: 'tls' }, errors: { host: 'This server is on a private network.' } },
    })

    expect(wrapper.get('input').attributes('aria-invalid')).toBe('true')
    expect(wrapper.text()).toContain('This server is on a private network.')
  })

  it('names the protocol in the title and offers no unencrypted connection unless the server allows one', () => {
    const wrapper = mount(ServerFields, { props: { protocol: 'imap', title: 'Incoming mail', modelValue: { host: 'imap.example.test', port: 993, security: 'tls' } } })

    expect(wrapper.get('legend').text()).toBe('Incoming mail (IMAP)')
    expect(wrapper.findAll('option').map((option) => option.attributes('value'))).toEqual(['tls', 'starttls'])

    const local = mount(ServerFields, { props: { protocol: 'imap', title: 'Incoming mail', allowUnencrypted: true, modelValue: { host: 'greenmail', port: 3143, security: 'tls' } } })
    expect(local.findAll('option').map((option) => option.attributes('value'))).toEqual(['tls', 'starttls', 'none'])
  })

  it('still shows an unencrypted connection a server has', () => {
    const wrapper = mount(ServerFields, { props: { protocol: 'smtp', title: 'Outgoing mail', modelValue: { host: 'greenmail', port: 3025, security: 'none' } } })

    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('none')
  })

  it('marks the server that failed and says how', () => {
    const wrapper = mount(ServerFields, {
      props: { protocol: 'imap', title: 'Incoming mail', modelValue: { host: 'imap.example.test', port: 993, security: 'tls' }, failed: true, status: { label: 'No answer', tone: 'danger' } },
    })

    expect(wrapper.get('legend .status').text()).toBe('No answer')
    expect(wrapper.findAll('input').map((input) => input.attributes('aria-invalid'))).toEqual(['true', 'true'])
  })
})
