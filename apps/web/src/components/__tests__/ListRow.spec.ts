import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { compileStyle, parse } from 'vue/compiler-sfc'
import ListRow from '@/components/ListRow.vue'
import source from '@/components/ListRow.vue?raw'

/** The declarations of every rule for one selector in the row's own style block, as the build compiles it. */
function rule(selector: string): string {
  const { descriptor } = parse(source)
  const css = descriptor.styles.map((style) => compileStyle({ source: style.content, filename: 'ListRow.vue', id: 'data-v-test', scoped: style.scoped }).code).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
  // Vue scopes the last part of a selector.
  const scoped = `${selector}[data-v-test]`
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((found) => found[1]!.split(',').some((head) => head.trim() === scoped)).map((found) => found[2]!)
  if (bodies.length === 0) {
    throw new Error(`no rule for ${selector}`)
  }
  return bodies.join('\n')
}

describe('ListRow', () => {
  it('puts each slot in its place: mark, title over line, meta, action, and what belongs to the row below it', () => {
    const view = mount(ListRow, {
      slots: {
        mark: '<i class="logo" />',
        title: 'Kim Visser',
        line: 'kim@company.example',
        meta: 'Synced 13:01',
        action: '<button type="button">More</button>',
        default: '<p class="below">Calendar access is off</p>',
      },
    })

    const row = view.get('.list-row')
    expect(row.attributes('role')).toBe('listitem')
    const main = row.get('.main')
    expect([...main.element.children].map((child) => child.className)).toEqual(['mark', 'text', 'meta', 'action'])
    expect(main.find('.mark .logo').exists()).toBe(true)
    expect(main.get('.text .title').text()).toBe('Kim Visser')
    expect(main.get('.text .line').text()).toBe('kim@company.example')
    expect(main.get('.meta').text()).toBe('Synced 13:01')
    expect(main.get('.action button').text()).toBe('More')
    // The row's own content comes after the row line, not inside it.
    expect(row.element.lastElementChild?.className).toBe('below')
    expect(main.find('.below').exists()).toBe(false)
  })

  it('leaves out the parts that were not given', () => {
    const view = mount(ListRow, { slots: { title: 'WhatsApp' } })

    expect(view.get('.title').text()).toBe('WhatsApp')
    expect(view.find('.mark').exists()).toBe(false)
    expect(view.find('.line').exists()).toBe(false)
    expect(view.find('.meta').exists()).toBe(false)
    expect(view.find('.action').exists()).toBe(false)
  })

  it('is a plain list item: not a control and no tab stop of its own', () => {
    const view = mount(ListRow, { slots: { title: 'Kim Visser' } })

    expect(view.element.tagName).toBe('DIV')
    expect(view.get('.list-row').attributes('tabindex')).toBeUndefined()
    expect(view.find('button, a, [tabindex]').exists()).toBe(false)
  })

  it('cuts a long title and line to one line with an ellipsis, and lets the text column shrink', () => {
    for (const part of ['.title', '.line']) {
      const body = rule(part)
      expect(body).toMatch(/white-space:\s*nowrap/)
      expect(body).toMatch(/overflow:\s*hidden/)
      expect(body).toMatch(/text-overflow:\s*ellipsis/)
    }
    expect(rule('.text')).toMatch(/min-width:\s*0/)
    expect(rule('.text')).toMatch(/flex:\s*1/)
    expect(rule('.main')).toMatch(/min-width:\s*0/)
    // The parts at the ends keep their size; only the text gives way.
    for (const part of ['.mark', '.meta', '.action']) {
      expect(rule(part)).toMatch(/flex-shrink:\s*0/)
    }
    expect(rule('.meta')).toMatch(/white-space:\s*nowrap/)
  })

  it('has the sizes of the board: 14 by 16 padding, 12 between parts, 36 high, a hairline between rows', () => {
    expect(rule('.list-row')).toMatch(/padding:\s*14px 16px/)
    expect(rule('.list-row')).toMatch(/gap:\s*12px/)
    expect(rule('.main')).toMatch(/gap:\s*12px/)
    expect(rule('.main')).toMatch(/min-height:\s*36px/)
    expect(rule('.list-row + .list-row')).toMatch(/border-top:\s*1px solid var\(--line\)/)
    expect(rule('.title')).toMatch(/font-size:\s*14px;\s*line-height:\s*20px;\s*font-weight:\s*600/)
    expect(rule('.line')).toMatch(/font-size:\s*13px;\s*line-height:\s*19px;\s*color:\s*var\(--ink-2\)/)
    expect(rule('.meta')).toMatch(/font-size:\s*12px;\s*line-height:\s*16px;\s*color:\s*var\(--ink-2\)/)
  })
})
