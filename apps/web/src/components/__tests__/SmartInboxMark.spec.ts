import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { BuiltinCategory } from '@tresso/core'
import SmartInboxMark from '../SmartInboxMark.vue'

const paths = (builtin: BuiltinCategory | null, name: string) => {
  const smartInbox = { builtin, name }

  return mount(SmartInboxMark, { props: { smartInbox } }).findAll('path').map((path) => path.attributes('d'))
}

describe('SmartInboxMark', () => {
  it('draws a 16 px line icon in the second ink, without a letter or a coloured square', () => {
    const wrapper = mount(SmartInboxMark, { props: { smartInbox: { builtin: 'spam' } } })

    expect(wrapper.element.tagName.toLowerCase()).toBe('svg')
    expect(wrapper.attributes('width')).toBe('16')
    expect(wrapper.attributes('height')).toBe('16')
    expect(wrapper.attributes('stroke')).toBe('currentColor')
    expect(wrapper.attributes('aria-hidden')).toBe('true')
    expect(wrapper.classes()).toEqual(['smart-inbox-icon'])
    expect(wrapper.text()).toBe('')
    expect(wrapper.findAll('path').length).toBeGreaterThan(0)
  })

  it('draws newsletters and a smart inbox the user made with their own icons', () => {
    expect(paths('advertise', 'Newsletters')).toEqual(['M4 5h13v14H6a2 2 0 01-2-2z', 'M17 9h3v8a2 2 0 01-2 2h-1', 'M8 9h5', 'M8 13h5'])
    expect(paths(null, 'Invoices')).toEqual(['M4 5h16l-6 8v5l-4 2v-7z'])
  })

  it('follows the built-in kind, not the name', () => {
    expect(paths(null, 'Spam')).toEqual(paths(null, 'Invoices'))
    expect(paths(null, 'Spam')).not.toEqual(paths('spam', 'Spam'))
  })
})
