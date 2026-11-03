import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import LogoLoader from '@/components/LogoLoader.vue'

describe('the logo loader', () => {
  it('draws the three parts of the mark and stays out of the way of screen readers', () => {
    const svg = mount(LogoLoader).get('svg')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.findAll('rect').map((part) => part.classes())).toEqual([
      ['bar', 'do'],
      ['bar', 'delegate'],
      ['bar', 'know'],
    ])
  })

  it('takes the size of the text around it unless given one', () => {
    expect(mount(LogoLoader).get('svg').attributes('width')).toBe('1.25em')
    expect(mount(LogoLoader, { props: { size: 12 } }).get('svg').attributes('width')).toBe('12')
  })

  it('draws in the text color on buttons', () => {
    expect(mount(LogoLoader, { props: { tone: 'current' } }).get('svg').classes()).toContain('current')
    expect(mount(LogoLoader).get('svg').classes()).toContain('brand')
  })
})
