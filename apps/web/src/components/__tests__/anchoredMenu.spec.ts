import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useAnchoredMenu } from '@/components/anchoredMenu'

function rect(top: number, left: number, width: number, height: number): DOMRect {
  return { top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }
}

/** A button at the given place and a 200 by 150 menu, in a 1000 by 800 window. */
async function openAt(buttonRect: DOMRect, align: 'start' | 'end' = 'start') {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
  let placement!: ReturnType<typeof useAnchoredMenu>
  const open = ref(false)
  const wrapper = mount(
    defineComponent(() => {
      const button = ref<HTMLElement | null>(null)
      const menu = ref<HTMLElement | null>(null)
      placement = useAnchoredMenu(button, menu, open, align)
      return () => [h('button', { ref: button }), open.value ? h('div', { ref: menu }) : null]
    }),
    { attachTo: document.body },
  )
  wrapper.get('button').element.getBoundingClientRect = () => buttonRect
  open.value = true
  await nextTick()
  const menu = wrapper.find('div').element as HTMLElement
  Object.defineProperty(menu, 'offsetHeight', { configurable: true, value: 150 })
  Object.defineProperty(menu, 'offsetWidth', { configurable: true, value: 200 })
  await nextTick()
  await nextTick()
  return { placement, wrapper }
}

describe('useAnchoredMenu', () => {
  it('opens a menu below its button, against the window, so no scrolling list cuts it off', async () => {
    const { placement, wrapper } = await openAt(rect(100, 300, 80, 30))

    expect(placement.above.value).toBe(false)
    expect(placement.style.value).toMatchObject({ position: 'fixed', top: '134px', left: '300px' })
    wrapper.unmount()
  })

  it('opens above when the room below is too small, and lines up with the end edge when asked', async () => {
    const { placement, wrapper } = await openAt(rect(740, 700, 80, 30), 'end')

    expect(placement.above.value).toBe(true)
    expect(placement.style.value).toMatchObject({ position: 'fixed', top: `${740 - 4 - 150}px`, left: `${780 - 200}px` })
    wrapper.unmount()
  })

  it('stays inside the window at its edges', async () => {
    const { placement, wrapper } = await openAt(rect(100, 950, 40, 30))

    expect(placement.style.value.left).toBe(`${1000 - 200 - 8}px`)
    wrapper.unmount()
  })

  it('keeps a menu that opens above clear of the macOS title bar strip, which drags the window', async () => {
    document.documentElement.style.setProperty('--titlebar', '38px')
    try {
      // A tall button from 180 down to 780: no room below, so the menu opens above, where the strip ends at 38.
      const { placement, wrapper } = await openAt(rect(180, 300, 80, 600))

      expect(placement.above.value).toBe(true)
      expect(placement.style.value).toMatchObject({ top: `${38 + 8}px`, '--menu-room': `${180 - 4 - 38 - 8}px` })
      wrapper.unmount()
    } finally {
      document.documentElement.style.removeProperty('--titlebar')
    }
  })

  it('uses the plain window margin where there is no title bar strip', async () => {
    const { placement, wrapper } = await openAt(rect(180, 300, 80, 600))

    expect(placement.style.value).toMatchObject({ top: `${180 - 4 - 150}px`, '--menu-room': `${180 - 4 - 8}px` })
    wrapper.unmount()
  })
})
