import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import MenuButton from '@/components/MenuButton.vue'
import { shortcutAllowed } from '@/mail/useMessageActions'

const ITEMS = [
  { id: 'a', label: 'Archive' },
  { id: 'b', label: 'Inbox' },
]

/** With the real Teleport (setup.ts stubs it): the menu lives on the body, outside the button's parent. */
function mountMenu() {
  return mount(MenuButton, {
    props: { label: 'Move', menuLabel: 'Move to', items: ITEMS },
    attachTo: document.body,
    global: { stubs: { teleport: false } },
  })
}

function menu(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="menu"]')
}

describe('MenuButton on the body', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens its menu on the body, out of any glass panel around the button', async () => {
    const view = mountMenu()

    await view.get('button').trigger('click')
    await nextTick()

    expect(menu()).not.toBeNull()
    expect(view.element.contains(menu())).toBe(false)
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
  })

  it('closes on Escape and hands focus back, without the key reaching the shortcuts', async () => {
    const view = mountMenu()
    await view.get('button').trigger('click')
    await nextTick()
    let reached: KeyboardEvent | null = null
    const listen = (event: KeyboardEvent) => (reached = event)
    document.addEventListener('keydown', listen)

    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()
    document.removeEventListener('keydown', listen)

    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(view.get('button').element)
    expect(reached).not.toBeNull()
    expect(shortcutAllowed(reached!, false)).toBe(false)
  })

  it('closes on a press outside, caught before anything at the document can stop it', async () => {
    // As Tauri's drag handling does for the title bar strip, registered before the app is.
    const stop = (event: Event) => event.stopImmediatePropagation()
    document.addEventListener('mousedown', stop)
    const view = mountMenu()
    await view.get('button').trigger('click')
    await nextTick()

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    document.removeEventListener('mousedown', stop)

    expect(menu()).toBeNull()
    expect(view.exists()).toBe(true)
  })

  it('chooses an item from the teleported menu', async () => {
    const view = mountMenu()
    await view.get('button').trigger('click')
    await nextTick()

    menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click()
    await nextTick()

    expect(view.emitted('choose')).toEqual([['b']])
  })
})
