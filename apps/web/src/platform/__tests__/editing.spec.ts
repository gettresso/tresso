import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import type { Draft } from '@/mail/db'
import type { ConversationCommands } from '@/mail/openConversation'
import ComposeWindow from '@/components/ComposeWindow.vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { COMPOSE_WINDOW_ATTRIBUTE, followEditing, isEditingText, recheckEditing, recheckEditingOnNavigation } from '../editing'
import { runMenuAction, startMenuBridge, type MenuShell } from '../menu'

const draft: Draft = { id: 'd1', mailAccountId: 'work', to: [], cc: [], bcc: [], subject: 'Hello', html: '<p>Hi</p>', signatureId: null, quoteHtml: '', inReplyToMessageId: null, kind: 'new', version: 0, pendingSave: false, remoteVersion: null, outgoingId: null, noticedStatus: null, updatedAt: 1, attachments: [] }

const { compose } = vi.hoisted(() => ({ compose: { current: null as Record<string, unknown> | null } }))
vi.mock('@/stores/compose', () => ({ useComposeStore: () => compose.current }))

function add<T extends HTMLElement>(element: T, parent: HTMLElement = document.body): T {
  parent.appendChild(element)
  return element
}

function input(type: string): HTMLInputElement {
  const element = document.createElement('input')
  element.type = type
  return element
}

describe('editing text', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('is a text field, a text area, editable content, or anything in the compose window', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const composeWindow = add(document.createElement('section'))
    composeWindow.setAttribute(COMPOSE_WINDOW_ATTRIBUTE, '')
    const sendButton = add(document.createElement('button'), composeWindow)

    const text = ['text', 'search', 'email', 'url', 'password', 'number']
    expect(text.filter((type) => !isEditingText(add(input(type))))).toEqual([])
    expect(isEditingText(add(document.createElement('textarea')))).toBe(true)
    expect(isEditingText(add(editable))).toBe(true)
    expect(isEditingText(sendButton), 'a button of the compose window').toBe(true)

    const notText = ['checkbox', 'radio', 'button', 'submit', 'range', 'file']
    expect(notText.filter((type) => isEditingText(add(input(type))))).toEqual([])
    expect(isEditingText(add(document.createElement('button')))).toBe(false)
    expect(isEditingText(document.body)).toBe(false)
    expect(isEditingText(null)).toBe(false)
  })

  it('marks the compose window as the place where text is edited', () => {
    compose.current = reactive({ draft, minimized: false, savedAt: null, conflict: false, revision: 0, close: vi.fn<() => void>(), resolveConflict: vi.fn<(choice: 'mine' | 'theirs') => void>() })
    const wrapper = mount(ComposeWindow, { global: { stubs: { ComposeForm: { template: '<form class="form"><button type="submit">Send</button></form>' } } }, attachTo: document.body })

    expect(isEditingText(wrapper.get('button[type="submit"]').element)).toBe(true)
    expect(isEditingText(wrapper.get('button[aria-label="Minimize"]').element)).toBe(true)
    wrapper.unmount()
  })

  it('follows the focus: into a field, from field to field, out to a button, and once a focused element went', async () => {
    const field = add(input('text'))
    const other = add(document.createElement('textarea'))
    const button = add(document.createElement('button'))
    const follower = followEditing(document)
    expect(follower.editing.value).toBe(false)

    field.focus()
    expect(follower.editing.value).toBe(true)
    other.focus()
    expect(follower.editing.value).toBe(true)
    button.focus()
    expect(follower.editing.value).toBe(false)

    // A focused field taken out of the page, as the compose window goes: no focus event is promised, a recheck reads it.
    other.focus()
    expect(follower.editing.value).toBe(true)
    other.remove()
    recheckEditing()
    expect(follower.editing.value).toBe(false)

    follower.stop()
    field.focus()
    expect(follower.editing.value, 'stopped').toBe(false)
  })

  it('disables Move to Trash in the shell while a text field or the compose window has the focus, and never runs it then', async () => {
    const field = add(input('text'))
    const composeWindow = add(document.createElement('section'))
    composeWindow.setAttribute(COMPOSE_WINDOW_ATTRIBUTE, '')
    const composeButton = add(document.createElement('button'), composeWindow)
    const elsewhere = add(document.createElement('button'))
    const follower = followEditing(document)
    const trash = vi.fn<() => Promise<void>>(async () => undefined)
    const open = { ready: () => true, read: () => true, flagged: () => false, hasTodo: () => false, settleDo: vi.fn<() => Promise<void>>(), handOver: vi.fn<() => Promise<void>>(), settleNoted: vi.fn<() => Promise<void>>(), makeTodo: vi.fn<() => Promise<void>>(), reply: vi.fn<ConversationCommands['reply']>(), archive: vi.fn<() => Promise<void>>(), trash, chooseFolder: vi.fn<() => Promise<void>>(), toggleRead: vi.fn<() => Promise<void>>(), toggleFlag: vi.fn<() => Promise<void>>() }
    const targets = {
      router: { push: vi.fn<(to: { name: string }) => Promise<undefined>>(async () => undefined) },
      newMessage: vi.fn<() => void>(),
      reload: vi.fn<() => Promise<void>>(async () => undefined),
      signedIn: () => true,
      toggleSidebar: vi.fn<() => void>(),
      sidebarShown: () => true,
      getNewMail: vi.fn<() => Promise<void>>(async () => undefined),
      conversation: () => open,
      editing: () => follower.editing.value,
      outboxWaiting: () => false,
      onScreen: () => true,
    }
    const invoke = vi.fn<MenuShell['invoke']>(async () => undefined)
    const stop = await startMenuBridge(targets, { listen: async () => () => {}, invoke })
    const editingSent = () => invoke.mock.lastCall?.[1].editing

    expect(editingSent()).toBe(false)
    field.focus()
    await nextTick()
    expect(editingSent(), 'a text field').toBe(true)
    await runMenuAction('move-to-trash', targets)
    expect(trash).not.toHaveBeenCalled()

    composeButton.focus()
    await nextTick()
    expect(editingSent(), 'the compose window').toBe(true)
    await runMenuAction('move-to-trash', targets)
    expect(trash).not.toHaveBeenCalled()

    elsewhere.focus()
    await nextTick()
    expect(editingSent()).toBe(false)
    await runMenuAction('move-to-trash', targets)
    expect(trash).toHaveBeenCalledOnce()
    stop()
    follower.stop()
  })

  it('reads the focus again after a navigation, so a field that left with its screen does not keep editing on', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/inbox', component: { template: '<div />' } }] })
    await router.push('/')
    const follower = followEditing(document)
    const stop = recheckEditingOnNavigation(router)
    const search = add(input('search'))
    search.focus()
    expect(follower.editing.value).toBe(true)

    // The screen goes, and its field with it, without a focus event.
    search.remove()
    expect(follower.editing.value, 'no focus event came').toBe(true)
    await router.push('/inbox')
    await nextTick()
    expect(follower.editing.value).toBe(false)
    stop()
    follower.stop()
  })
})
