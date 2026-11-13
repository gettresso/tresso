import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, shallowRef } from 'vue'
import { forgetViewRequests, onViewRequest } from '@/components/viewRequests'
import type { ConversationCommands } from '@/mail/openConversation'
import { MENU_ACTIONS, MENU_EVENT, MESSAGE_ACTIONS, TEXT_KEY_ACTIONS, runMenuAction, startMenuBridge, type MenuAction, type MenuShell } from '../menu'

/** An open conversation's commands, as the reading pane offers them: each a spy, its state in refs. */
function conversation() {
  const read = ref(true)
  const flagged = ref(false)
  const commands = {
    read: () => read.value,
    flagged: () => flagged.value,
    ready: () => true,
    reply: vi.fn<ConversationCommands['reply']>(async () => undefined),
    archive: vi.fn<() => Promise<void>>(async () => undefined),
    trash: vi.fn<() => Promise<void>>(async () => undefined),
    chooseFolder: vi.fn<() => Promise<void>>(async () => undefined),
    toggleRead: vi.fn<() => Promise<void>>(async () => undefined),
    toggleFlag: vi.fn<() => Promise<void>>(async () => undefined),
    hasTodo: () => false,
    settleDo: vi.fn<() => Promise<void>>(async () => undefined),
    handOver: vi.fn<() => Promise<void>>(async () => undefined),
    settleNoted: vi.fn<() => Promise<void>>(async () => undefined),
    makeTodo: vi.fn<() => Promise<void>>(async () => undefined),
  }
  return { readState: read, flaggedState: flagged, commands }
}

type OpenConversation = ReturnType<typeof conversation>['commands']

function targets(signedIn = true) {
  const state = ref(signedIn)
  const sidebar = ref(true)
  const open = shallowRef<OpenConversation | null>(null)
  const typing = ref(false)
  const outbox = ref(false)
  const visible = ref(true)
  return {
    state,
    sidebar,
    open,
    typing,
    outbox,
    visible,
    router: { push: vi.fn<(to: { name: string }) => Promise<undefined>>(async () => undefined) },
    newMessage: vi.fn<() => void>(),
    reload: vi.fn<() => Promise<void>>(async () => undefined),
    signedIn: () => state.value,
    toggleSidebar: vi.fn<() => void>(() => {
      sidebar.value = !sidebar.value
    }),
    sidebarShown: () => sidebar.value,
    getNewMail: vi.fn<() => Promise<void>>(async () => undefined),
    conversation: () => open.value,
    editing: () => typing.value,
    outboxWaiting: () => outbox.value,
    onScreen: () => visible.value,
  }
}

/** Every call a conversation's commands took, by name. */
function callsOf(commands: OpenConversation): Record<string, unknown[][]> {
  return Object.fromEntries(
    (['reply', 'archive', 'trash', 'chooseFolder', 'toggleRead', 'toggleFlag', 'settleDo', 'handOver', 'settleNoted', 'makeTodo'] as const).map((name) => [name, commands[name].mock.calls]).filter(([, calls]) => (calls as unknown[][]).length > 0),
  )
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
    document.body.innerHTML = ''
  })

  it('takes every action of the menu bar to its route or store action', async () => {
    const routes: [MenuAction, string][] = [
      ['go-brief', 'brief'],
      ['go-waiting', 'waiting'],
      ['go-drafts', 'drafts'],
      ['go-cleanup', 'cleanup'],
      ['go-outbox', 'outbox'],
      ['go-batches', 'batches'],
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
    const syncing = targets()
    await runMenuAction('get-new-mail', syncing)
    expect(syncing.getNewMail).toHaveBeenCalledOnce()
    expect(new Set([...routes.map(([action]) => action), 'new-message', 'reload', 'toggle-sidebar', 'get-new-mail', ...MESSAGE_ACTIONS])).toEqual(new Set(MENU_ACTIONS))
  })

  it('takes each Message action to the open conversation\'s own action, and to nothing else', async () => {
    const expected: [MenuAction, Record<string, unknown[][]>][] = [
      ['reply', { reply: [['reply']] }],
      ['reply-all', { reply: [['replyAll']] }],
      ['forward', { reply: [['forward']] }],
      ['archive', { archive: [[]] }],
      ['move-to-trash', { trash: [[]] }],
      ['move-to', { chooseFolder: [[]] }],
      ['toggle-read', { toggleRead: [[]] }],
      ['toggle-flag', { toggleFlag: [[]] }],
      ['settle-do', { settleDo: [[]] }],
      ['hand-over', { handOver: [[]] }],
      ['settle-noted', { settleNoted: [[]] }],
      ['make-todo', { makeTodo: [[]] }],
    ]
    for (const [action, calls] of expected) {
      const to = targets()
      const { commands } = conversation()
      to.open.value = commands
      await runMenuAction(action, to)
      expect({ action, calls: callsOf(commands) }).toEqual({ action, calls })
      expect(to.router.push).not.toHaveBeenCalled()
      expect(to.newMessage).not.toHaveBeenCalled()
    }
    expect(expected.map(([action]) => action)).toEqual([...MESSAGE_ACTIONS])
  })

  it('fires no Message action while no conversation is open, or while nobody is signed in', async () => {
    const none = targets()
    for (const action of MESSAGE_ACTIONS) {
      await runMenuAction(action, none)
    }
    expect(none.router.push).not.toHaveBeenCalled()
    expect(none.newMessage).not.toHaveBeenCalled()

    const signedOut = targets(false)
    const { commands } = conversation()
    signedOut.open.value = commands
    for (const action of MESSAGE_ACTIONS) {
      await runMenuAction(action, signedOut)
    }
    expect(callsOf(commands)).toEqual({})
  })

  it('leaves Move to Trash (⌘⌫) and Mark as Unread (⇧⌘U) to the text while the focus is in text when they arrive', async () => {
    expect(TEXT_KEY_ACTIONS).toEqual(['move-to-trash', 'toggle-read'])
    const to = targets()
    const { commands } = conversation()
    to.open.value = commands
    const field = document.body.appendChild(document.createElement('input'))
    field.focus()

    for (const action of MESSAGE_ACTIONS) {
      await runMenuAction(action, to)
    }
    expect(commands.trash).not.toHaveBeenCalled()
    expect(commands.toggleRead).not.toHaveBeenCalled()
    expect(commands.archive).toHaveBeenCalledOnce()
    expect(commands.toggleFlag).toHaveBeenCalledOnce()
    expect(commands.reply).toHaveBeenCalledTimes(3)

    // The focus is read when the action arrives, not as followed: a followed state that lags (here: still "editing")
    // does not keep the item from acting once the field is gone.
    to.typing.value = true
    field.remove()
    await runMenuAction('move-to-trash', to)
    expect(commands.trash).toHaveBeenCalledOnce()
  })

  it('fires no Message action while the window is not on screen (closed or minimized), and says none is open', async () => {
    const to = targets()
    const { commands } = conversation()
    to.open.value = commands
    to.visible.value = false
    const desktop = shell()
    const stop = await startMenuBridge(to, desktop)

    for (const action of MESSAGE_ACTIONS) {
      await runMenuAction(action, to)
    }
    expect(callsOf(commands)).toEqual({})
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', expect.objectContaining({ message: null }))

    to.visible.value = true
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', expect.objectContaining({ message: { read: true, flagged: false, hasTodo: false } }))
    stop()
  })

  it('enables Mailbox > Outbox while mail waits in it, as the sidebar lists it then', async () => {
    const to = targets()
    const desktop = shell()
    const stop = await startMenuBridge(to, desktop)
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', expect.objectContaining({ outbox: false }))

    to.outbox.value = true
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', expect.objectContaining({ outbox: true }))
    to.state.value = false
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', expect.objectContaining({ signedIn: false, outbox: false }))
    stop()
  })

  it('counts a state as sent only once the shell took it: one refusal is sent again, and after two the next change sends it all', async () => {
    const to = targets()
    const desktop = shell()
    const errors: unknown[] = []
    vi.mocked(desktop.invoke).mockRejectedValueOnce(new Error('busy'))
    const stop = await startMenuBridge(to, desktop, (error) => errors.push(error))
    await vi.waitFor(() => expect(desktop.invoke).toHaveBeenCalledTimes(2))
    expect(vi.mocked(desktop.invoke).mock.calls[1]).toEqual(vi.mocked(desktop.invoke).mock.calls[0])
    expect(errors).toEqual([])

    // Refused twice: said, and the state is not taken as sent.
    vi.mocked(desktop.invoke).mockRejectedValueOnce(new Error('busy')).mockRejectedValueOnce(new Error('still busy'))
    to.sidebar.value = false
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(desktop.invoke).toHaveBeenCalledTimes(4)
    to.sidebar.value = true
    to.sidebar.value = false
    await nextTick()
    // Back where the refused state was: sent again, since the shell never took it.
    await vi.waitFor(() => expect(desktop.invoke).toHaveBeenCalledTimes(5))
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', expect.objectContaining({ sidebarShown: false }))
    stop()
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
    expect(to.getNewMail).not.toHaveBeenCalled()
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
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: false, sidebarShown: true, editing: false, outbox: false, message: null })

    to.state.value = true
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: true, sidebarShown: true, editing: false, outbox: false, message: null })

    // A request still waiting for its view is dropped at the sign-out.
    await runMenuAction('new-event', to)
    to.state.value = false
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: false, sidebarShown: true, editing: false, outbox: false, message: null })
    const newEvent = vi.fn<() => void>()
    onViewRequest('newEvent', newEvent)()
    expect(newEvent).not.toHaveBeenCalled()
    stop()
  })

  it('names View > Hide Sidebar after the sidebar: Ctrl+Cmd+S hides it, and the item then says Show Sidebar', async () => {
    const to = targets()
    const desktop = shell()
    const stop = await startMenuBridge(to, desktop)
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: true, sidebarShown: true, editing: false, outbox: false, message: null })

    desktop.send('toggle-sidebar')
    await nextTick()
    expect(to.toggleSidebar).toHaveBeenCalledOnce()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: true, sidebarShown: false, editing: false, outbox: false, message: null })

    // The toggle in the window changes it too; the menu follows.
    to.sidebar.value = true
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: true, sidebarShown: true, editing: false, outbox: false, message: null })
    stop()
  })

  it('enables the Message menu while a conversation is open, and names its items after the conversation', async () => {
    const to = targets()
    const desktop = shell()
    const stop = await startMenuBridge(to, desktop)
    const open = conversation()

    to.open.value = open.commands
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: true, sidebarShown: true, editing: false, outbox: false, message: { read: true, flagged: false, hasTodo: false } })

    open.flaggedState.value = true
    open.readState.value = false
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: true, sidebarShown: true, editing: false, outbox: false, message: { read: false, flagged: true, hasTodo: false } })

    // Text is edited: the shell disables Move to Trash and Mark as Unread.
    to.typing.value = true
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: true, sidebarShown: true, editing: true, outbox: false, message: { read: false, flagged: true, hasTodo: false } })

    to.open.value = null
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: true, sidebarShown: true, editing: true, outbox: false, message: null })

    // Signed out, an open conversation says nothing.
    to.open.value = open.commands
    to.state.value = false
    await nextTick()
    expect(desktop.invoke).toHaveBeenLastCalledWith('menu_state', { signedIn: false, sidebarShown: true, editing: true, outbox: false, message: null })
    stop()
  })

  it('sends the state only when it changed: one call for the changes of a tick, none for a change that ends where it began', async () => {
    const to = targets()
    const desktop = shell()
    const stop = await startMenuBridge(to, desktop)
    expect(desktop.invoke).toHaveBeenCalledTimes(1)
    const open = conversation()

    // A conversation opens and the focus goes to a field, in one tick: one call.
    to.open.value = open.commands
    to.typing.value = true
    await nextTick()
    expect(desktop.invoke).toHaveBeenCalledTimes(2)

    // The focus moves from one field to the next (out and in again), a sync reloads the same conversation (new
    // commands, same state), the sidebar is toggled twice: nothing to say.
    to.typing.value = false
    to.typing.value = true
    to.open.value = conversation().commands
    to.sidebar.value = false
    to.sidebar.value = true
    await nextTick()
    open.readState.value = false
    open.readState.value = true
    await nextTick()
    expect(desktop.invoke).toHaveBeenCalledTimes(2)

    // Many key presses in a field: no focus change, no call.
    for (let i = 0; i < 20; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    }
    await nextTick()
    expect(desktop.invoke).toHaveBeenCalledTimes(2)

    to.typing.value = false
    await nextTick()
    expect(desktop.invoke).toHaveBeenCalledTimes(3)
    stop()
  })
})
