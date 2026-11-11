import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SenderAvatar from '../SenderAvatar.vue'

describe('SenderAvatar', () => {
  it('takes its colours from a tint class, so the dark theme can give it deep fills', () => {
    const wrapper = mount(SenderAvatar, { props: { sender: { address: 'lisa@company.example', name: 'Lisa Bakker' } } })

    expect(wrapper.text()).toBe('LB')
    expect(wrapper.classes().some((name) => /^tint-[0-4]$/.test(name))).toBe(true)
    expect(wrapper.attributes('style')).not.toContain('background')
  })

  it('gives the same sender the same tint', () => {
    const tint = (address: string) => mount(SenderAvatar, { props: { sender: { address, name: null } } }).classes().find((name) => name.startsWith('tint-'))

    expect(tint('Lisa@Company.example')).toBe(tint('lisa@company.example'))
  })
})
