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

const ROW_ITEMS = [
  { id: 'remove', label: 'Remove account', danger: true },
  { id: 'rename', label: 'Rename' },
  { id: 'signin', label: 'Sign in again' },
  { id: 'pause', label: 'Pause syncing' },
]

/** The three-dot More button of an account row, with its danger item passed first on purpose. */
function mountMore(items = ROW_ITEMS) {
  return mount(MenuButton, {
    props: { variant: 'more', label: 'More for kim@company.example', menuLabel: 'More for kim@company.example', items },
    attachTo: document.body,
    global: { stubs: { teleport: false } },
  })
}

function menuItems(): HTMLButtonElement[] {
  return [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
}

function press(key: string): void {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('MenuButton as the More button of a row', () => {
  it('shows only the three dots and is named by its label', () => {
    const view = mountMore()

    const button = view.get('button')
    expect(button.attributes('aria-label')).toBe('More for kim@company.example')
    expect(button.attributes('aria-haspopup')).toBe('menu')
    expect(button.attributes('aria-expanded')).toBe('false')
    expect(button.classes()).toContain('more')
    expect(button.text()).toBe('')
    expect(button.get('svg').attributes('aria-hidden')).toBe('true')
  })

  it('keeps the text button as it was when no variant is given', () => {
    const view = mountMenu()

    const button = view.get('button')
    expect(button.text()).toBe('Move')
    expect(button.attributes('aria-label')).toBeUndefined()
    expect(button.classes()).not.toContain('more')
  })

  it('puts a danger item last, in red, under a rule', async () => {
    const view = mountMore()
    await view.get('button').trigger('click')
    await nextTick()

    expect(view.get('button').attributes('aria-expanded')).toBe('true')
    expect(menu()!.getAttribute('aria-label')).toBe('More for kim@company.example')
    const children = [...menu()!.children]
    expect(children.map((child) => child.textContent)).toEqual(['Rename', 'Sign in again', 'Pause syncing', '', 'Remove account'])
    expect(children[3]!.getAttribute('role')).toBe('separator')
    expect(children[4]!.classList.contains('danger')).toBe(true)
    expect(menuItems().filter((item) => item.classList.contains('danger')).map((item) => item.textContent)).toEqual(['Remove account'])
  })

  it('draws no rule without a danger item, nor when every item is one', async () => {
    const plain = mountMenu()
    await plain.get('button').trigger('click')
    await nextTick()
    expect(menu()!.querySelector('[role="separator"]')).toBeNull()
    plain.unmount()

    const onlyDanger = mountMore([{ id: 'remove', label: 'Remove account', danger: true }])
    await onlyDanger.get('button').trigger('click')
    await nextTick()
    expect(menu()!.querySelector('[role="separator"]')).toBeNull()
    expect(menuItems().map((item) => item.className)).toEqual(['item danger'])
  })

  it('walks the items with the arrow keys past the rule, chooses the danger item, and gives focus back', async () => {
    const view = mountMore()
    await view.get('button').trigger('click')
    await nextTick()
    expect(document.activeElement?.textContent).toBe('Rename')

    press('ArrowUp')
    expect(document.activeElement?.textContent).toBe('Remove account')
    press('ArrowDown')
    expect(document.activeElement?.textContent).toBe('Rename')
    press('End')
    expect(document.activeElement?.textContent).toBe('Remove account')
    press('ArrowUp')
    expect(document.activeElement?.textContent).toBe('Pause syncing')
    press('Home')
    expect(document.activeElement?.textContent).toBe('Rename')

    press('Escape')
    await nextTick()
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(view.get('button').element)

    await view.get('button').trigger('click')
    await nextTick()
    menuItems().find((item) => item.textContent === 'Remove account')!.click()
    await nextTick()
    expect(view.emitted('choose')).toEqual([['remove']])
  })
})
