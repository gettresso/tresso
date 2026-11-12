import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { forgetViewRequests, onViewRequest } from '@/components/viewRequests'
import { MENU_ACTIONS, MENU_EVENT, runMenuAction, startMenuBridge, type MenuAction, type MenuShell } from '../menu'

function targets(signedIn = true) {
  const state = ref(signedIn)
  const sidebar = ref(true)
  return {
    state,
    sidebar,
    router: { push: vi.fn<(to: { name: string }) => Promise<undefined>>(async () => undefined) },
    newMessage: vi.fn<() => void>(),
    reload: vi.fn<() => Promise<void>>(async () => undefined),
    signedIn: () => state.value,
    toggleSidebar: vi.fn<() => void>(() => {
      sidebar.value = !sidebar.value
    }),
    sidebarShown: () => sidebar.value,
  }
}

function shell() {
  let handler: ((event: { payload: unknown }) => void) | null = null
  const unlisten = vi.fn<() => void>()
  const fake: MenuShell & { send(payload: unknown): void; unlisten: typeof unlisten } = {
    listen: vi.fn<MenuShell['listen']>(async (event, listener) => {
      expect(event).toBe(MENU_EVENT)
      handler = listener
      return unlisten
    }),
    invoke: vi.fn<MenuShell['invoke']>(async () => undefined),
    send: (payload) => handler?.({ payload }),
    unlisten,
  }
  return fake
}

describe('the menu bar bridge', () => {
  afterEach(() => {
    forgetViewRequests()
  })

  it('takes every action of the menu bar to its route or store action', async () => {
    const routes: [MenuAction, string][] = [
      ['settings', 'settings-accounts'],
      ['view-inbox', 'unified'],
      ['view-triage', 'triage'],
      ['view-todos', 'todos'],
      ['view-calendar', 'calendar'],
      ['view-search', 'search'],
      ['new-event', 'calendar'],
      ['new-todo', 'todos'],
      ['find', 'search'],
    ]
    for (const [action, name] of routes) {
      const to = targets()
      await runMenuAction(action, to)
      expect(to.router.push).toHaveBeenCalledWith({ name })
      forgetViewRequests()
    }
    const to = targets()
    await runMenuAction('new-message', to)
    expect(to.newMessage).toHaveBeenCalledOnce()
    expect(to.router.push).not.toHaveBeenCalled()
    // Every action is covered above.
    const reloading = targets()
    await runMenuAction('reload', reloading)
    expect(reloading.reload).toHaveBeenCalledOnce()
    const hiding = targets()
    await runMenuAction('toggle-sidebar', hiding)
    expect(hiding.toggleSidebar).toHaveBeenCalledOnce()
    expect(hiding.router.push).not.toHaveBeenCalled()
    expect(new Set([...routes.map(([action]) => action), 'new-message', 'reload', 'toggle-sidebar'])).toEqual(new Set(MENU_ACTIONS))
  })

  it('asks the calendar for a new event and the to-dos for their quick add, once they are on screen', async () => {
    const to = targets()
    await runMenuAction('new-event', to)
    await runMenuAction('new-todo', to)

    const newEvent = vi.fn<() => void>()
    const quickAdd = vi.fn<() => void>()
    const stopEvent = onViewRequest('newEvent', newEvent)
    const stopTodo = onViewRequest('quickAddTodo', quickAdd)
    expect(newEvent).toHaveBeenCalledOnce()
    expect(quickAdd).toHaveBeenCalledOnce()

    // On screen already: at once, and only once.
    await runMenuAction('new-event', to)
    expect(newEvent).toHaveBeenCalledTimes(2)
    stopEvent()
    stopTodo()
  })

  it('focuses the search field on screen for Find, and opens the search page where there is none', async () => {
    const focus = vi.fn<() => void>()
    const stop = onViewRequest('focusSearch', focus)
    const to = targets()

    await runMenuAction('find', to)

    expect(focus).toHaveBeenCalledOnce()
    expect(to.router.push).not.toHaveBeenCalled()
    stop()

    await runMenuAction('find', to)
    expect(to.router.push).toHaveBeenCalledWith({ name: 'search' })
  })

  it('does nothing while nobody is signed in, except Reload, which saves first (updates.reloadApp)', async () => {
    const to = targets(false)
    for (const action of MENU_ACTIONS) {
      await runMenuAction(action, to)
    }
    expect(to.router.push).not.toHaveBeenCalled()
    expect(to.newMessage).not.toHaveBeenCalled()
    expect(to.toggleSidebar).not.toHaveBeenCalled()
    expect(to.reload).toHaveBeenCalledOnce()
  })

  it('runs what the shell sends, ignores what it does not know, and stops listening when stopped', async () => {
    const to = targets()
    const desktop = shell()
    const stop = await startMenuBridge(to, desktop)

    desktop.send('view-calendar')
    desktop.send('format-disk')
    desktop.send(42)
    await nextTick()

    expect(to.router.push).toHaveBeenCalledTimes(1)
    expect(to.router.push).toHaveBeenCalledWith({ name: 'calendar' })
    stop()
    expect(desktop.unlisten).toHaveBeenCalledOnce()
  })

  it('enables the items while someone is signed in and disables them at a sign-out, through one command', async () => {
    const to = targets(false)
    const desktop = shell()
    const stop = await startMenuBridge(to, desktop)
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: false, sidebarShown: true })

    to.state.value = true
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: true, sidebarShown: true })

    // A request still waiting for its view is dropped at the sign-out.
    await runMenuAction('new-event', to)
    to.state.value = false
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: false, sidebarShown: true })
    const newEvent = vi.fn<() => void>()
    onViewRequest('newEvent', newEvent)()
    expect(newEvent).not.toHaveBeenCalled()
    stop()
  })

  it('names View > Hide Sidebar after the sidebar: Ctrl+Cmd+S hides it, and the item then says Show Sidebar', async () => {
    const to = targets()
    const desktop = shell()
    const stop = await startMenuBridge(to, desktop)
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: true, sidebarShown: true })

    desktop.send('toggle-sidebar')
    await nextTick()
    expect(to.toggleSidebar).toHaveBeenCalledOnce()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: true, sidebarShown: false })

    // The toggle in the window changes it too; the menu follows.
    to.sidebar.value = true
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: true, sidebarShown: true })
    stop()
  })
})
