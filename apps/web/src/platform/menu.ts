import { watch } from 'vue'
import type { Router } from 'vue-router'
import { askView, forgetViewRequests } from '@/components/viewRequests'

/**
 * The actions of the desktop app's menu bar that act in the web client (apps/desktop/src-tauri/src/menu.rs, which a
 * test keeps to this list). The shell sends each as the `menu` event with its name.
 */
export const MENU_ACTIONS = ['new-message', 'new-event', 'new-todo', 'settings', 'find', 'view-inbox', 'view-triage', 'view-todos', 'view-calendar', 'view-search', 'reload'] as const

export type MenuAction = (typeof MENU_ACTIONS)[number]

/** The event the shell sends the actions on (MENU_EVENT in menu.rs). */
export const MENU_EVENT = 'menu'

export function isMenuAction(value: unknown): value is MenuAction {
  return typeof value === 'string' && (MENU_ACTIONS as readonly string[]).includes(value)
}

/** What the actions call: the router and the existing store actions. */
export interface MenuTargets {
  router: Pick<Router, 'push'>
  /** compose.openNew */
  newMessage(): void
  /** Whether someone is signed in and may use the app; the menu's items follow it. */
  signedIn(): boolean
  /** Loads the app again once the draft is saved and nothing is on its way (updates.reloadApp). */
  reload(): Promise<void>
}

/**
 * Runs one action of the menu bar. Only Reload acts while nobody is signed in; the others do nothing then (the shell
 * disables them too).
 */
export async function runMenuAction(action: MenuAction, targets: MenuTargets): Promise<void> {
  if (action === 'reload') {
    await targets.reload()
    return
  }
  if (!targets.signedIn()) {
    return
  }
  switch (action) {
    case 'new-message':
      targets.newMessage()
      return
    case 'new-event':
      // The calendar opens its editor once it is on screen (at once when it is).
      askView('newEvent')
      await targets.router.push({ name: 'calendar' })
      return
    case 'new-todo':
      askView('quickAddTodo')
      await targets.router.push({ name: 'todos' })
      return
    case 'settings':
      await targets.router.push({ name: 'settings-accounts' })
      return
    case 'find':
      // The search field on screen takes the focus; where there is none, the search page opens with its own.
      if (!askView('focusSearch')) {
        await targets.router.push({ name: 'search' })
      }
      return
    case 'view-inbox':
      await targets.router.push({ name: 'unified' })
      return
    case 'view-triage':
      await targets.router.push({ name: 'triage' })
      return
    case 'view-todos':
      await targets.router.push({ name: 'todos' })
      return
    case 'view-calendar':
      await targets.router.push({ name: 'calendar' })
      return
    case 'view-search':
      await targets.router.push({ name: 'search' })
      return
  }
}

/** The shell's side: hearing its events and telling it whether the items may act. */
export interface MenuShell {
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>
  invoke(command: 'menu_state', args: { signedIn: boolean }): Promise<unknown>
}

/**
 * The bridge to the desktop app's menu bar (desktop only): runs its actions, and enables the items that act in the
 * web client while someone is signed in, through the one command `menu_state`. Returns the function that stops it.
 */
export async function startMenuBridge(targets: MenuTargets, shell: MenuShell, onError: (error: unknown) => void = (error) => console.error('A menu action failed', error)): Promise<() => void> {
  const unlisten = await shell.listen(MENU_EVENT, ({ payload }) => {
    if (isMenuAction(payload)) {
      runMenuAction(payload, targets).catch(onError)
    }
  })
  const stopWatching = watch(
    () => targets.signedIn(),
    (signedIn) => {
      if (!signedIn) {
        forgetViewRequests()
      }
      shell.invoke('menu_state', { signedIn }).catch(onError)
    },
    { immediate: true },
  )
  return () => {
    unlisten()
    stopWatching()
  }
}
