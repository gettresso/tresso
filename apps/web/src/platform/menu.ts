import { watch } from 'vue'
import type { Router } from 'vue-router'
import { askView, forgetViewRequests } from '@/components/viewRequests'
import type { ConversationCommands } from '@/mail/openConversation'

/**
 * The Message menu's actions. They act on the conversation open in the reading pane, through its own actions, and on
 * nothing while none is open (the shell disables them then too).
 */
export const MESSAGE_ACTIONS = ['reply', 'reply-all', 'forward', 'archive', 'move-to-trash', 'move-to', 'toggle-read', 'toggle-flag'] as const

export type MessageMenuAction = (typeof MESSAGE_ACTIONS)[number]

/**
 * The Message menu's actions whose shortcut also edits text (⌘⌫ deletes to the start of the line, ⇧⌘U underlines in
 * the composer): the shell disables them while text is edited (`Typing::Waits` in menu.rs), and they do nothing then.
 */
export const TEXT_KEY_ACTIONS: readonly MessageMenuAction[] = ['move-to-trash', 'toggle-read']

/**
 * The actions of the desktop app's menu bar that act in the web client (apps/desktop/src-tauri/src/menu.rs, which a
 * test keeps to this list). The shell sends each as the `menu` event with its name.
 */
export const MENU_ACTIONS = [
  'new-message',
  'new-event',
  'new-todo',
  'settings',
  'find',
  'view-inbox',
  'view-triage',
  'view-todos',
  'view-calendar',
  'view-search',
  'toggle-sidebar',
  'reload',
  'get-new-mail',
  'go-brief',
  'go-waiting',
  'go-drafts',
  'go-cleanup',
  'go-batches',
  ...MESSAGE_ACTIONS,
] as const

export type MenuAction = (typeof MENU_ACTIONS)[number]

/** The event the shell sends the actions on (MENU_EVENT in menu.rs). */
export const MENU_EVENT = 'menu'

export function isMenuAction(value: unknown): value is MenuAction {
  return typeof value === 'string' && (MENU_ACTIONS as readonly string[]).includes(value)
}

function isMessageAction(action: MenuAction): action is MessageMenuAction {
  return (MESSAGE_ACTIONS as readonly string[]).includes(action)
}

/** Mailbox's places, by the route each opens: the sidebar's fixed places that View does not list. */
const PLACES: Record<'go-brief' | 'go-waiting' | 'go-drafts' | 'go-cleanup' | 'go-batches', string> = {
  'go-brief': 'brief',
  'go-waiting': 'waiting',
  'go-drafts': 'drafts',
  'go-cleanup': 'cleanup',
  'go-batches': 'batches',
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
  /** Hides or shows the sidebar (the frame store's toggle). */
  toggleSidebar(): void
  /** Whether the sidebar shows; View > Hide Sidebar or Show Sidebar is named after it. */
  sidebarShown(): boolean
  /** Pulls what changed on the server now (the mail store's syncNow). */
  getNewMail(): Promise<void>
  /** The conversation open in the reading pane while it has the user's attention (openConversation); null otherwise. */
  conversation(): ConversationCommands | null
  /** Whether a text field or the compose window has the focus (platform/editing.ts). */
  editing(): boolean
}

/**
 * Runs one action of the menu bar. Only Reload acts while nobody is signed in; the others do nothing then (the shell
 * disables them too). The Message menu's do nothing while no conversation is open, and those whose shortcut edits text
 * nothing while text is edited.
 */
export async function runMenuAction(action: MenuAction, targets: MenuTargets): Promise<void> {
  if (action === 'reload') {
    await targets.reload()
    return
  }
  if (!targets.signedIn()) {
    return
  }
  if (isMessageAction(action)) {
    await runMessageAction(action, targets)
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
    case 'toggle-sidebar':
      targets.toggleSidebar()
      return
    case 'get-new-mail':
      await targets.getNewMail()
      return
    case 'go-brief':
    case 'go-waiting':
    case 'go-drafts':
    case 'go-cleanup':
    case 'go-batches':
      await targets.router.push({ name: PLACES[action] })
      return
  }
}

/** The Message menu: the open conversation's own actions, as its buttons and keys run them. */
async function runMessageAction(action: MessageMenuAction, targets: MenuTargets): Promise<void> {
  const open = targets.conversation()
  if (open === null || (TEXT_KEY_ACTIONS.includes(action) && targets.editing())) {
    return
  }
  switch (action) {
    case 'reply':
      await open.reply('reply')
      return
    case 'reply-all':
      await open.reply('replyAll')
      return
    case 'forward':
      await open.reply('forward')
      return
    case 'archive':
      await open.archive()
      return
    case 'move-to-trash':
      await open.trash()
      return
    case 'move-to':
      await open.chooseFolder()
      return
    case 'toggle-read':
      await open.toggleRead()
      return
    case 'toggle-flag':
      await open.toggleFlag()
      return
  }
}

/** What `menu_state` gets: the arguments of the command in menu.rs (a type, so it is Tauri's plain `InvokeArgs`). */
export type MenuState = {
  signedIn: boolean
  sidebarShown: boolean
  editing: boolean
  /** The open conversation, as the Message menu's titles need it; null while none is open (or nobody is signed in). */
  message: { read: boolean; flagged: boolean } | null
}

/** The state the menu's items follow, read from the targets (reactive where they are). */
export function menuState(targets: MenuTargets): MenuState {
  const signedIn = targets.signedIn()
  const open = signedIn ? targets.conversation() : null
  return {
    signedIn,
    sidebarShown: targets.sidebarShown(),
    editing: targets.editing(),
    message: open === null ? null : { read: open.read(), flagged: open.flagged() },
  }
}

/** The shell's side: hearing its events and telling it whether the items may act. */
export interface MenuShell {
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>
  invoke(command: 'menu_state', args: MenuState): Promise<unknown>
}

/**
 * The bridge to the desktop app's menu bar (desktop only): runs its actions, enables the items that act in the web
 * client while someone is signed in (the Message menu's while a conversation is open), and names the items whose
 * titles follow the state, through the one command `menu_state`. The command goes once per change of what it says:
 * changes in one tick go together, and a change that ends where it began (a conversation reloaded by a sync, the focus
 * moving from one field to the next) sends nothing. Returns the function that stops it.
 */
export async function startMenuBridge(targets: MenuTargets, shell: MenuShell, onError: (error: unknown) => void = (error) => console.error('A menu action failed', error)): Promise<() => void> {
  const unlisten = await shell.listen(MENU_EVENT, ({ payload }) => {
    if (isMenuAction(payload)) {
      runMenuAction(payload, targets).catch(onError)
    }
  })
  let sent: string | null = null
  let signedInBefore: boolean | null = null
  const stopWatching = watch(
    () => menuState(targets),
    (state) => {
      // A request still waiting for its view is dropped at a sign-out (and when the app starts signed out).
      if (!state.signedIn && signedInBefore !== false) {
        forgetViewRequests()
      }
      signedInBefore = state.signedIn
      const key = JSON.stringify(state)
      if (key === sent) {
        return
      }
      sent = key
      shell.invoke('menu_state', state).catch(onError)
    },
    { immediate: true },
  )
  return () => {
    unlisten()
    stopWatching()
  }
}
