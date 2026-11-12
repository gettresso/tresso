import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import FrameTitle from '@/components/FrameTitle.vue'
import { useAuthStore } from '@/stores/auth'
import { useBatchesStore } from '@/stores/batches'
import { useFrameStore } from '@/stores/frame'

// The desktop app on macOS: the frame and the glass are on.
vi.mock('@/platform/frame', async (original) => ({ ...(await original<typeof import('@/platform/frame')>()), framed: true }))
vi.mock('@/platform/vibrancy', () => ({ vibrant: true }))
const invoke = vi.hoisted(() => vi.fn<(command: string, args?: unknown) => Promise<unknown>>(async () => ({ supported: true })))
vi.mock('@tauri-apps/api/core', async (original) => ({ ...(await original<typeof import('@tauri-apps/api/core')>()), invoke }))

const AppShell = (await import('@/views/AppShell.vue')).default

/** This test's own localStorage (Node's stands in for the page's in these tests and needs a file). */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
}

/** A pointer event as jsdom can make one (it has no PointerEvent): the left button at this x. */
async function pointer(element: Element, type: string, clientX: number): Promise<void> {
  element.dispatchEvent(new MouseEvent(type, { button: 0, clientX, bubbles: true }))
  await nextTick()
}

const Inbox = defineComponent({ setup: () => () => h('section', { class: 'screen' }, [h(FrameTitle, () => 'Unified Inbox')]) })

async function shell() {
  useAuthStore().tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        component: AppShell,
        children: [
          { path: '', name: 'unified', component: Inbox },
          { path: 'accounts/:accountId', name: 'account', component: Inbox },
          { path: 'smart/:smartInboxId', name: 'smart-inbox', component: Inbox },
          { path: 'batches', name: 'batches', component: Inbox },
          { path: 'cleanup', name: 'cleanup', component: Inbox },
          { path: 'brief', name: 'brief', component: Inbox },
          { path: 'todos', name: 'todos', component: Inbox },
          { path: 'waiting', name: 'waiting', component: Inbox },
          { path: 'calendar', name: 'calendar', component: Inbox },
          { path: 'triage', name: 'triage', component: Inbox },
          { path: 'drafts', name: 'drafts', component: Inbox },
          { path: 'outbox', name: 'outbox', component: Inbox },
          { path: 'settings/accounts', name: 'settings-accounts', component: Inbox },
          { path: 'settings/accounts/new', name: 'settings-accounts-new', component: Inbox },
          { path: 'settings/smart-inboxes/:smartInboxId', name: 'settings-smart-inbox', component: Inbox },
        ],
      },
    ],
  })
  await router.push('/')
  const wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('the shell in the desktop frame', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.stubGlobal('localStorage', memoryStorage())
    invoke.mockClear()
    document.documentElement.className = ''
    setActivePinia(createPinia())
    vi.spyOn(useBatchesStore(), 'load').mockResolvedValue()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lays the sidebar out as the spec\'s column, at the default width, with the title strip over the screens', async () => {
    const wrapper = await shell()
    const app = wrapper.get('.app')
    expect(app.classes()).toEqual(['app', 'frame-shell'])
    expect(app.attributes('style')).toContain('--frame-sidebar-width: 220px')
    expect(app.attributes('style')).toContain('--frame-column: 220px')
    expect(document.documentElement.classList.contains('frame-shell')).toBe(true)
    const nav = wrapper.get('nav.sidebar')
    expect(nav.attributes('id')).toBe('frame-sidebar')
    expect(nav.attributes('inert')).toBeUndefined()
    // The strip, which moves the window on macOS, with the screen's title in it.
    const strip = wrapper.get('.stage > .frame-strip')
    expect(strip.attributes('data-tauri-drag-region')).toBe('deep')
    expect(strip.find('#frame-title').exists() && strip.find('#frame-tools').exists()).toBe(true)
    expect(wrapper.get('.screen teleport-stub').attributes('to')).toBe('#frame-title')
    expect(wrapper.find('.frame-sidebar-drag[data-tauri-drag-region]').exists()).toBe(true)
  })

  it('hides and shows the sidebar with its toggle, keeps that on this device, and takes the hidden one out of reach', async () => {
    const wrapper = await shell()
    const toggle = wrapper.get('button.frame-toggle')
    expect(toggle.attributes()).toMatchObject({ 'aria-label': 'Sidebar', 'aria-expanded': 'true', 'aria-controls': 'frame-sidebar' })
    expect(toggle.get('svg').attributes('width')).toBe('24')

    await toggle.trigger('click')
    expect(wrapper.get('.app').classes()).toContain('collapsed')
    expect(wrapper.get('.app').attributes('style')).toContain('--frame-column: 0px')
    expect(wrapper.get('nav.sidebar').attributes('inert')).toBeDefined()
    expect(toggle.attributes()).toMatchObject({ 'aria-label': 'Sidebar', 'aria-expanded': 'false' })
    expect(wrapper.find('[role="separator"]').exists()).toBe(false)
    expect(JSON.parse(localStorage.getItem('tresso.sidebar')!)).toEqual({ width: 220, shown: false })

    // View > Show Sidebar does the same through the store.
    useFrameStore().toggle()
    await nextTick()
    expect(wrapper.get('.app').classes()).not.toContain('collapsed')
    expect(toggle.attributes('aria-expanded')).toBe('true')
  })

  it('sets the width with the edge\'s keys and by dragging it, within 190 to 300, and keeps it', async () => {
    const wrapper = await shell()
    const edge = wrapper.get('[role="separator"]')
    expect(edge.attributes()).toMatchObject({ tabindex: '0', 'aria-label': 'Sidebar width', 'aria-orientation': 'vertical', 'aria-valuemin': '190', 'aria-valuemax': '300', 'aria-valuenow': '220' })

    await edge.trigger('keydown', { key: 'ArrowRight' })
    expect(edge.attributes('aria-valuenow')).toBe('230')
    await edge.trigger('keydown', { key: 'End' })
    expect(edge.attributes('aria-valuenow')).toBe('300')
    expect(edge.attributes('style')).toContain('w-resize')
    await edge.trigger('keydown', { key: 'Home' })
    expect(edge.attributes('aria-valuenow')).toBe('190')
    expect(JSON.parse(localStorage.getItem('tresso.sidebar')!)).toEqual({ width: 190, shown: true })

    await pointer(edge.element, 'pointerdown', 200)
    expect(wrapper.get('.app').classes()).toContain('resizing')
    await pointer(edge.element, 'pointermove', 260)
    expect(edge.attributes('aria-valuenow')).toBe('250')
    // Not kept while the drag is under way.
    expect(JSON.parse(localStorage.getItem('tresso.sidebar')!).width).toBe(190)
    await pointer(edge.element, 'pointermove', 900)
    expect(edge.attributes('aria-valuenow')).toBe('300')
    await pointer(edge.element, 'pointerup', 900)
    expect(wrapper.get('.app').classes()).not.toContain('resizing')
    expect(wrapper.get('.app').attributes('style')).toContain('--frame-sidebar-width: 300px')
    expect(JSON.parse(localStorage.getItem('tresso.sidebar')!)).toEqual({ width: 300, shown: true })
  })

  it('scrolls only the rows: the title band above and the sync status below stay in the card', async () => {
    const wrapper = await shell()
    const nav = wrapper.get('nav.sidebar')
    const children = [...nav.element.children].map((child) => child.className)
    expect(children).toEqual([expect.stringContaining('frame-scroll'), expect.stringContaining('sync-status')])
    const scroller = nav.get('.frame-scroll')
    expect(scroller.find('.profile').exists() && scroller.find('.compose').exists() && scroller.find('.item.settings').exists()).toBe(true)
    expect(scroller.find('.sync-status').exists()).toBe(false)
  })

  it('moves the focus to the toggle when the sidebar or its edge had it and the sidebar is hidden (⌃⌘S)', async () => {
    const wrapper = await shell()
    const toggle = wrapper.get('button.frame-toggle').element as HTMLElement
    ;(wrapper.get('nav.sidebar .item').element as HTMLElement).focus()
    useFrameStore().toggle()
    await nextTick()
    expect(document.activeElement).toBe(toggle)

    useFrameStore().toggle()
    await nextTick()
    ;(wrapper.get('[role="separator"]').element as HTMLElement).focus()
    useFrameStore().toggle()
    await nextTick()
    expect(document.activeElement).toBe(toggle)

    // Focus elsewhere stays where it is.
    useFrameStore().toggle()
    await nextTick()
    const content = document.createElement('button')
    document.body.append(content)
    content.focus()
    useFrameStore().toggle()
    await nextTick()
    expect(document.activeElement).toBe(content)
    content.remove()
  })

  it('starts at the width and state kept on this device', async () => {
    localStorage.setItem('tresso.sidebar', JSON.stringify({ width: 260, shown: false }))
    setActivePinia(createPinia())
    vi.spyOn(useBatchesStore(), 'load').mockResolvedValue()
    const wrapper = await shell()
    expect(wrapper.get('.app').classes()).toContain('collapsed')
    expect(wrapper.get('.app').attributes('style')).toContain('--frame-sidebar-width: 260px')
  })

  it('gives the selected row the accent while the sidebar is used, and the grey once the content is', async () => {
    const wrapper = await shell()
    window.dispatchEvent(new Event('focus'))
    const nav = wrapper.get('nav.sidebar')
    nav.get('.item').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(nav.classes()).toContain('active')
    wrapper.get('.screen').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(nav.classes()).not.toContain('active')
  })

  it('reports the card for the glass, and removes it when the sidebar is hidden or the shell goes', async () => {
    const wrapper = await shell()
    const glassCalls = () => invoke.mock.calls.filter(([command]) => command === 'set_glass').map(([, args]) => (args as { rects: { id: string }[] }).rects)
    expect(glassCalls()[0]).toEqual([expect.objectContaining({ id: 'sidebar', radius: 18 })])
    await vi.waitFor(() => expect(document.documentElement.classList.contains('liquid-glass')).toBe(true))

    document.documentElement.classList.add('reduce-transparency')
    await vi.waitFor(() => expect(glassCalls()[glassCalls().length - 1]).toEqual([]))
    document.documentElement.classList.remove('reduce-transparency')
    await vi.waitFor(() => expect(glassCalls()[glassCalls().length - 1]).toHaveLength(1))

    // Signed out: the glass goes and the card is drawn solid again; signed in, it stays solid until the shell answers.
    let answer: (value: unknown) => void = () => {}
    invoke.mockImplementation(async (command: string) => (command === 'set_glass' ? new Promise((resolve) => (answer = resolve)) : undefined))
    useAuthStore().tokens = null
    await flushPromises()
    answer({ supported: true })
    await vi.waitFor(() => expect(document.documentElement.classList.contains('liquid-glass')).toBe(false))
    expect(glassCalls()[glassCalls().length - 1]).toEqual([])
    useAuthStore().tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 }
    await flushPromises()
    expect(glassCalls()[glassCalls().length - 1]).toHaveLength(1)
    expect(document.documentElement.classList.contains('liquid-glass')).toBe(false)
    answer({ supported: true })
    await vi.waitFor(() => expect(document.documentElement.classList.contains('liquid-glass')).toBe(true))
    invoke.mockImplementation(async () => ({ supported: true }))

    wrapper.unmount()
    expect(glassCalls()[glassCalls().length - 1]).toEqual([])
    expect(document.documentElement.classList.contains('frame-shell')).toBe(false)
  })
})
