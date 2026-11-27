import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AttentionRow from '@/components/AttentionRow.vue'
import source from '@/components/AttentionRow.vue?raw'

describe('AttentionRow', () => {
  it('says a part that does not work politely, in the warning tone', () => {
    const view = mount(AttentionRow, { props: { tone: 'warning', text: 'Calendar access is off', action: 'Allow' } })

    const row = view.get('.attention')
    expect(row.attributes('role')).toBe('status')
    expect(row.classes()).toContain('warning')
    expect(row.classes()).not.toContain('danger')
    expect(row.get('.text').text()).toBe('Calendar access is off')
    expect(row.get('button').text()).toBe('Allow')
    // The icon is decoration: the text says it all.
    expect(row.get('svg').attributes('aria-hidden')).toBe('true')
  })

  it('says a thing that stopped politely too, in the danger tone: it is there on every page load', () => {
    const view = mount(AttentionRow, { props: { tone: 'danger', text: 'Sign-in expired. New mail is not arriving.', action: 'Sign in again' } })

    const row = view.get('.attention')
    expect(row.attributes('role')).toBe('status')
    expect(view.find('[role="alert"]').exists()).toBe(false)
    expect(row.classes()).toContain('danger')
    expect(row.classes()).not.toContain('warning')
    expect(row.get('button').text()).toBe('Sign in again')
  })

  it('draws a different icon for each tone', () => {
    const warning = mount(AttentionRow, { props: { tone: 'warning', text: 'Calendar access is off' } })
    const danger = mount(AttentionRow, { props: { tone: 'danger', text: 'Sign-in expired. New mail is not arriving.' } })

    expect(warning.get('svg').html()).not.toBe(danger.get('svg').html())
  })

  it('emits act when its button is pressed', async () => {
    const view = mount(AttentionRow, { props: { tone: 'warning', text: 'Calendar access is off', action: 'Allow' } })

    await view.get('button').trigger('click')

    expect(view.emitted('act')).toEqual([[]])
  })

  it('has no button without an action', () => {
    const view = mount(AttentionRow, { props: { tone: 'danger', text: 'Sign-in expired. New mail is not arriving.' } })

    expect(view.find('button').exists()).toBe(false)
    expect(view.get('.attention').classes()).toContain('bare')
  })

  it('colours only the icon and the tint with the tone tokens, and keeps the text in ink', () => {
    const css = source.slice(source.indexOf('<style'))

    expect(css).toMatch(/\.attention\.warning \{\s*background: var\(--warning-soft\);/)
    expect(css).toMatch(/\.attention\.danger \{\s*background: var\(--danger-soft\);/)
    expect(css).toMatch(/\.warning \.icon \{\s*color: var\(--warning\);/)
    expect(css).toMatch(/\.danger \.icon \{\s*color: var\(--danger\);/)
    expect(css).toMatch(/\.text \{[^}]*color: var\(--ink\);/)
  })
})
