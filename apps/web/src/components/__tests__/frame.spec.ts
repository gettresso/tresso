import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import FrameCapsule from '../FrameCapsule.vue'
import FrameTitle from '../FrameTitle.vue'
import FrameTools from '../FrameTools.vue'
import { FRAME_STRIP, resizeCursor, useSidebarActive, widthForKey } from '../frame'

describe('the sidebar edge by keyboard', () => {
  it('moves 10 per arrow, and Home and End go to the narrowest and widest', () => {
    expect(widthForKey(220, 'ArrowRight')).toBe(230)
    expect(widthForKey(220, 'ArrowUp')).toBe(230)
    expect(widthForKey(220, 'ArrowLeft')).toBe(210)
    expect(widthForKey(220, 'ArrowDown')).toBe(210)
    expect(widthForKey(295, 'ArrowRight')).toBe(300)
    expect(widthForKey(195, 'ArrowLeft')).toBe(190)
    expect(widthForKey(220, 'Home')).toBe(190)
    expect(widthForKey(220, 'End')).toBe(300)
    expect(widthForKey(220, 'Enter')).toBeNull()
  })

  it('shows the resize cursor that says which way the edge can still go', () => {
    expect(resizeCursor(190)).toBe('e-resize')
    expect(resizeCursor(220)).toBe('col-resize')
    expect(resizeCursor(300)).toBe('w-resize')
  })
})

describe('the focus of the sidebar', () => {
  function harness() {
    let active!: ReturnType<typeof useSidebarActive>
    const Host = defineComponent({
      setup() {
        const sidebar = ref<HTMLElement | null>(null)
        active = useSidebarActive(sidebar)
        return () =>
          h('div', [
            h('nav', { ref: sidebar }, [h('a', { href: '#', class: 'row' }, 'Inbox')]),
            h('button', { class: 'toggle', 'data-frame-neutral': '' }, 'Hide sidebar'),
            h('main', [h('button', { class: 'content' }, 'Archive')]),
          ])
      },
    })
    const wrapper = mount(Host, { attachTo: document.body })
    return { wrapper, active: () => active.value }
  }

  it('is the sidebar\'s after a click or focus in it, the content\'s after one there, and the toggle changes nothing', async () => {
    const { wrapper, active } = harness()
    window.dispatchEvent(new Event('focus'))
    expect(active()).toBe(false)

    wrapper.get('.row').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(active()).toBe(true)
    wrapper.get('.toggle').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(active()).toBe(true)
    ;(wrapper.get('.content').element as HTMLElement).focus()
    expect(active()).toBe(false)
    ;(wrapper.get('.row').element as HTMLElement).focus()
    expect(active()).toBe(true)
  })

  it('turns grey while the window is in the back, also with the keyboard focus in the sidebar', async () => {
    const { wrapper, active } = harness()
    window.dispatchEvent(new Event('focus'))
    ;(wrapper.get('.row').element as HTMLElement).focus()
    expect(active()).toBe(true)
    window.dispatchEvent(new Event('blur'))
    expect(active()).toBe(false)
    window.dispatchEvent(new Event('focus'))
    expect(active()).toBe(true)
  })
})

describe('a view\'s title and toolbar', () => {
  /** A view with scoped styles, as the real ones: its title and actions with its own attributes. */
  const View = defineComponent({
    __scopeId: 'data-v-view',
    setup() {
      return () =>
        h('header', { class: 'header' }, [
          h(FrameTitle, { id: 'view-title', class: 'title', title: 'Inbox' }, () => 'Inbox'),
          h(FrameTools, () => [h(FrameCapsule, () => [h('button', { class: 'button icon', 'aria-label': 'Previous' })])]),
        ])
    },
  })

  it('stay where they are with nothing added in the browser: the same h1 and the same buttons', () => {
    const html = mount(View).html()
    expect(html).toBe(
      ['<header data-v-view="" class="header">', '  <h1 data-v-view="" id="view-title" class="title" title="Inbox">Inbox</h1><button data-v-view="" class="button icon" aria-label="Previous"></button>', '</header>'].join('\n'),
    )
  })

  it('go into the title strip in the desktop shell, the actions in a capsule', async () => {
    const wrapper = mount(View, { global: { provide: { [FRAME_STRIP as symbol]: true } } })
    await nextTick()
    const teleports = wrapper.findAll('teleport-stub')
    expect(teleports.map((teleport) => teleport.attributes('to'))).toEqual(['#frame-title', '#frame-tools'])
    expect(teleports[0]!.get('h1').attributes()).toMatchObject({ id: 'view-title', title: 'Inbox' })
    expect(teleports[1]!.get('.frame-tools-group > .frame-capsule > button').attributes('aria-label')).toBe('Previous')
  })

  it('can be a title of the strip only: nothing in the browser, a paragraph in the strip where the view keeps its h1', async () => {
    const Triage = defineComponent({ setup: () => () => h('header', [h(FrameTitle, { framedOnly: true, tag: 'p' }, () => 'Triage'), h('h1', 'Subject')]) })
    expect(mount(Triage).findAll('h1, p').map((element) => element.text())).toEqual(['Subject'])
    const framed = mount(Triage, { global: { provide: { [FRAME_STRIP as symbol]: true } } })
    await nextTick()
    expect(framed.get('teleport-stub').attributes('to')).toBe('#frame-title')
    expect(framed.get('teleport-stub > p').text()).toBe('Triage')
  })
})
