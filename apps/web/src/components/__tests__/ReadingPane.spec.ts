import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import type { ChangePage, SyncedMessage, SyncedUnsubscription, SyncedHandOver } from '@tresso/core'
import { todo } from '@tresso/core/testing'
import { deleteMailDatabase } from '@/mail/db'
import { openConversation } from '@/mail/openConversation'
import { runMenuAction, type MenuAction } from '@/platform/menu'
import { useComposeStore } from '@/stores/compose'
import { useHandOversStore } from '@/stores/handOvers'
import { useMailStore } from '@/stores/mail'
import { useSelectionStore } from '@/stores/selection'
import { useTodosStore } from '@/stores/todos'
import ReadingPane from '../ReadingPane.vue'

const account = { id: 'work', emailAddress: 'kim@company.example', displayName: 'Work', provider: 'imap', status: 'active' as const, statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null }
const folders = [
  { id: 'inbox', mailAccountId: 'work', name: 'INBOX', displayName: 'Inbox', role: 'inbox' as const },
  { id: 'sent', mailAccountId: 'work', name: 'Sent', displayName: 'Sent', role: 'sent' as const },
  { id: 'archive', mailAccountId: 'work', name: 'Archive', displayName: 'Archive', role: 'archive' as const },
  { id: 'trash', mailAccountId: 'work', name: 'Trash', displayName: 'Trash', role: 'trash' as const },
  { id: 'projects', mailAccountId: 'work', name: 'Projects', displayName: 'Projects', role: 'custom' as const },
]

function message(id: string, folderIds: string[], receivedAt: string, seen: boolean): SyncedMessage {
  return {
    id,
    mailAccountId: 'work',
    threadId: 't1',
    folderIds,
    subject: 'Offsite plan',
    from: { address: `${id}@example.test`, name: `Sender ${id}` },
    recipients: { to: [], cc: [], bcc: [], replyTo: [] },
    snippet: '',
    sentAt: null,
    receivedAt,
    flags: { seen, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    attachmentScan: null,
    smartInboxId: null,
    verdict: null,
    summary: null,
    calendarMethod: null,
  }
}

function unsubscription(status: SyncedUnsubscription['status'], error: string | null = null): SyncedUnsubscription {
  return { id: 'u1', mailAccountId: 'work', sender: 'm2@example.test', method: 'oneClick', status, error, requestedAt: '2026-10-19T10:00:00Z', completedAt: null }
}

function page(cursor: number, extra: Partial<ChangePage> = {}): ChangePage {
  return { cursor, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [], ...extra }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('ReadingPane actions', () => {
  const actions: Record<string, unknown>[] = []
  let refuse: string | null
  let later: ChangePage | null
  /** While set, pulls after the first fail, as offline. */
  let offline: boolean
  /** Pages after the second, by the cursor they follow. */
  const pages = new Map<number, ChangePage>()
  const unsubscribes: unknown[] = []
  let refuseUnsubscribe: boolean
  /** While set, marking read waits for it before the server answers. */
  let holdMarkRead: Promise<void> | null
  /** Hand-overs in the first page. */
  let handOvers: SyncedHandOver[]
  let router: Router

  beforeEach(async () => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    actions.length = 0
    refuse = null
    later = null
    pages.clear()
    unsubscribes.length = 0
    refuseUnsubscribe = false
    holdMarkRead = null
    offline = false
    handOvers = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.pathname === '/api/v1/sync/changes') {
          const since = Number(url.searchParams.get('since'))
          if (offline && since > 0) {
            throw new TypeError('Failed to fetch')
          }
          const first = page(1, {
            mailAccounts: [account],
            folders,
            threads: [{ id: 't1', mailAccountId: 'work', subject: 'Offsite plan', messageCount: 2, lastMessageAt: '2026-10-19T09:00:00Z', smartInboxId: null, verdict: null, classificationReason: null }],
            messages: [message('m1', ['sent'], '2026-10-19T08:00:00Z', true), message('m2', ['inbox'], '2026-10-19T09:00:00Z', false)],
            handOvers,
          })
          return new Response(JSON.stringify(since === 0 ? first : since === 1 && later !== null ? later : (pages.get(since) ?? page(since))))
        }
        if (url.pathname === '/api/v1/unsubscriptions') {
          unsubscribes.push(JSON.parse(String(init?.body)))
          if (refuseUnsubscribe) {
            return new Response(JSON.stringify({ detail: 'Spam cannot be unsubscribed from.' }), { status: 422 })
          }
          return new Response(JSON.stringify(unsubscription('pending')), { status: 202 })
        }
        if (url.pathname === '/api/v1/message-actions') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          actions.push(body)
          if (body.action === 'markRead' && holdMarkRead !== null) {
            await holdMarkRead
          }
          if (refuse !== null && body.action === refuse) {
            return new Response(JSON.stringify({ detail: 'action: kim@company.example has no Archive folder.' }), { status: 422 })
          }
          return new Response(JSON.stringify({ changed: 1 }))
        }
        return new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503 })
      }),
    )
    await useMailStore().start('pane-user')
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'unified', component: { template: '<div />' } },
        { path: '/inbox/:threadId', name: 'unified-thread', component: { template: '<div />' } },
        { path: '/waiting', name: 'waiting', component: { template: '<div />' } },
        { path: '/triage', name: 'triage', component: { template: '<div />' } },
      ],
    })
    await router.push('/inbox/t1')
  })

  afterEach(async () => {
    await useMailStore().stop()
    await deleteMailDatabase('pane-user')
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  function mountPane() {
    return mount(ReadingPane, { props: { threadId: 't1', backTo: '/' }, global: { plugins: [router] }, attachTo: document.body })
  }

  /** Waits until the pane has read the conversation and its buttons take actions again. */
  async function opened(wrapper: ReturnType<typeof mountPane>): Promise<void> {
    await vi.waitFor(() => expect(actions).toHaveLength(1))
    await vi.waitFor(() => expect(wrapper.get('button[aria-keyshortcuts="E"]').attributes('disabled')).toBeUndefined())
  }

  async function folderIdsOf(id: string): Promise<string[]> {
    const thread = await useMailStore().thread('t1')
    return thread?.messages.find((m) => m.id === id)?.folderIds ?? []
  }

  it('shows a conversation a notification opened before the delta brought it as loading, then the conversation', async () => {
    later = page(2, {
      threads: [{ id: 't2', mailAccountId: 'work', subject: 'Budget review', messageCount: 1, lastMessageAt: '2026-10-19T10:00:00Z', smartInboxId: null, verdict: 'do', classificationReason: null }],
      messages: [{ ...message('m3', ['inbox'], '2026-10-19T10:00:00Z', false), threadId: 't2', subject: 'Budget review' }],
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const syncNow = useMailStore().syncNow
    vi.spyOn(useMailStore(), 'syncNow').mockImplementation(async () => {
      await held
      await syncNow()
    })

    const wrapper = mount(ReadingPane, { props: { threadId: 't2', backTo: '/' }, global: { plugins: [router] }, attachTo: document.body })
    await settle()
    expect(wrapper.text()).toContain('Loading the conversation')
    expect(wrapper.text()).not.toContain('no longer exists')

    release()
    await vi.waitFor(() => expect(wrapper.text()).toContain('Budget review'))
    expect(wrapper.text()).not.toContain('Loading the conversation')
  })

  it('says a conversation could not be loaded when the pull fails, and opens it once a pull works again', async () => {
    offline = true
    later = page(2, {
      threads: [{ id: 't2', mailAccountId: 'work', subject: 'Budget review', messageCount: 1, lastMessageAt: '2026-10-19T10:00:00Z', smartInboxId: null, verdict: 'do', classificationReason: null }],
      messages: [{ ...message('m3', ['inbox'], '2026-10-19T10:00:00Z', false), threadId: 't2', subject: 'Budget review' }],
    })
    const wrapper = mount(ReadingPane, { props: { threadId: 't2', backTo: '/' }, global: { plugins: [router] }, attachTo: document.body })

    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain('could not be loaded: Failed to fetch'))
    expect(wrapper.text()).not.toContain('Loading the conversation')
    expect(wrapper.text()).not.toContain('no longer exists')

    offline = false
    await wrapper.get('[role="alert"] button').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Budget review'))
  })

  it('says a conversation is gone once a pull after opening did not bring it', async () => {
    const wrapper = mount(ReadingPane, { props: { threadId: 't9', backTo: '/' }, global: { plugins: [router] }, attachTo: document.body })

    await vi.waitFor(() => expect(wrapper.text()).toContain('This conversation no longer exists.'))
  })

  it('reads the conversation when it opens', async () => {
    mountPane()
    await vi.waitFor(() => expect(actions).toHaveLength(1))

    expect(actions).toEqual([{ messageIds: ['m2'], action: 'markRead' }])
    expect((await useMailStore().thread('t1'))?.messages.every((m) => m.flags.seen)).toBe(true)
  })

  it('archives the conversation, goes back to the list and can undo it', async () => {
    const wrapper = mountPane()
    await opened(wrapper)
    actions.length = 0

    await wrapper.get('button[aria-keyshortcuts="E"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'))

    expect(actions).toEqual([{ messageIds: ['m1', 'm2'], action: 'archive' }])
    expect(await folderIdsOf('m2')).toEqual(['archive'])
    expect(await folderIdsOf('m1')).toEqual(['sent'])
    expect(router.currentRoute.value.path).toBe('/')

    const notice = useComposeStore().notices.find((n) => n.text === 'Archived.')
    expect(notice?.action?.label).toBe('Undo')
    actions.length = 0
    notice?.action?.run()
    await vi.waitFor(() => expect(actions).toHaveLength(1))
    // Only what moved goes back, from where it went: the Sent copy was never touched.
    expect(actions).toEqual([{ messageIds: ['m2'], action: 'move', folderId: 'inbox', fromFolderId: 'archive' }])
  })

  it('offers a way back to the list, also while the conversation loads', async () => {
    const wrapper = mountPane()
    await opened(wrapper)
    expect(wrapper.get('.actions a[aria-label="Back to the list"]').attributes('href')).toBe('/')

    // The pull that would bring the conversation is still on its way.
    vi.spyOn(useMailStore(), 'syncNow').mockImplementation(() => new Promise<void>(() => {}))
    const loading = mount(ReadingPane, { props: { threadId: 't9', backTo: '/' }, global: { plugins: [router] }, attachTo: document.body })
    await vi.waitFor(() => expect(loading.text()).toContain('Loading the conversation'))
    expect(loading.get('a[aria-label="Back to the list"]').attributes('href')).toBe('/')
  })

  it('shows the three verdicts with their keys, as triage does', async () => {
    const wrapper = mountPane()
    await opened(wrapper)

    // Each label, its key for the screen reader, and the keycap shown.
    expect(wrapper.findAll('.verdict').map((button) => [button.text().split(/\s{2,}|\s(?=\S+$)/)[0], button.attributes('aria-keyshortcuts'), button.find('.shortcut-key').text()])).toEqual([
      ['Do', 'D', 'D'],
      ['Hand over', 'H', 'H'],
      ['Noted', 'K', 'K'],
    ])
  })

  it('settles as Do with D: the conversation gets the do verdict and becomes a todo', async () => {
    const wrapper = mountPane()
    await opened(wrapper)
    useMailStore().smartInboxes = [{ id: 'todo', builtin: 'todo', name: 'To do', instructions: '', includeSenders: [], excludeSenders: [], verdict: 'do', autoCreateTodo: false, position: 0 }]
    const classify = vi.spyOn(useMailStore(), 'classifyThread').mockResolvedValue({ threadId: 't1', smartInboxId: 'todo', verdict: 'do', reason: 'user', senderRule: null, placementId: 'p1' })
    const make = vi.spyOn(useTodosStore(), 'makeFromMessage').mockResolvedValue({ ...todo('td1'), made: true })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))

    await vi.waitFor(() => expect(make).toHaveBeenCalledWith('m2'))
    expect(classify).toHaveBeenCalledWith('t1', 'todo', 'do', { remember: false })
    expect(router.currentRoute.value.path).toBe('/inbox/t1')
  })

  it('makes no todo when the do verdict is refused', async () => {
    const wrapper = mountPane()
    await opened(wrapper)
    useMailStore().smartInboxes = [{ id: 'todo', builtin: 'todo', name: 'To do', instructions: '', includeSenders: [], excludeSenders: [], verdict: 'do', autoCreateTodo: false, position: 0 }]
    vi.spyOn(useMailStore(), 'classifyThread').mockRejectedValue(new Error('The server is unavailable.'))
    const make = vi.spyOn(useTodosStore(), 'makeFromMessage').mockResolvedValue({ ...todo('td1'), made: true })

    await wrapper.get('.verdict.do').trigger('click')

    await vi.waitFor(() => expect(useComposeStore().notices.some((n) => n.text === 'The server is unavailable.')).toBe(true))
    expect(make).not.toHaveBeenCalled()
  })

  it('settles as Noted with K: read, archived, and back to the list', async () => {
    const wrapper = mountPane()
    await opened(wrapper)
    actions.length = 0

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }))
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'))

    expect(actions).toEqual([{ messageIds: ['m1', 'm2'], action: 'archive' }])
    expect(await folderIdsOf('m2')).toEqual(['archive'])
    // Says what K did, with the undo.
    expect(useComposeStore().notices.find((n) => n.text === 'Marked read and archived.')?.action?.label).toBe('Undo')
  })

  it('tells a screen reader which verdict the conversation has', async () => {
    later = page(2, { threads: [{ id: 't1', mailAccountId: 'work', subject: 'Offsite plan', messageCount: 2, lastMessageAt: '2026-10-19T09:00:00Z', smartInboxId: null, verdict: 'delegate', classificationReason: null }] })
    await useMailStore().syncNow()
    const wrapper = mountPane()
    await opened(wrapper)

    await vi.waitFor(() => expect(wrapper.get('.verdict.delegate').attributes('aria-current')).toBe('true'))
    expect(wrapper.get('.verdict.do').attributes('aria-current')).toBeUndefined()
    expect(wrapper.get('.verdict.know').attributes('aria-current')).toBeUndefined()
  })

  it('makes the todo with D when the conversation is Do already, without waiting for the smart inboxes', async () => {
    later = page(2, { threads: [{ id: 't1', mailAccountId: 'work', subject: 'Offsite plan', messageCount: 2, lastMessageAt: '2026-10-19T09:00:00Z', smartInboxId: null, verdict: 'do', classificationReason: null }] })
    await useMailStore().syncNow()
    const wrapper = mountPane()
    await opened(wrapper)
    useMailStore().smartInboxes = []
    const classify = vi.spyOn(useMailStore(), 'classifyThread')
    const make = vi.spyOn(useTodosStore(), 'makeFromMessage').mockResolvedValue({ ...todo('td1'), made: true })

    await wrapper.get('.verdict.do').trigger('click')

    await vi.waitFor(() => expect(make).toHaveBeenCalledWith('m2'))
    expect(classify).not.toHaveBeenCalled()
    expect(useComposeStore().notices.some((n) => n.tone === 'error')).toBe(false)
  })

  it('takes the shortcuts, but not while typing', async () => {
    const wrapper = mountPane()
    await opened(wrapper)
    actions.length = 0

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))
    await vi.waitFor(() => expect(wrapper.get('button[aria-keyshortcuts="S"]').attributes('aria-pressed')).toBe('true'))
    expect(actions).toEqual([{ messageIds: ['m2'], action: 'flag' }])
    expect(wrapper.get('button[aria-keyshortcuts="S"]').attributes('aria-pressed')).toBe('true')

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '#', bubbles: true }))
    await settle()
    expect(actions).toHaveLength(1)
    input.remove()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '#' }))
    await vi.waitFor(() => expect(actions).toHaveLength(2))
    expect(actions[1]).toEqual({ messageIds: ['m1', 'm2'], action: 'trash' })
    expect(await folderIdsOf('m1')).toEqual(['trash'])
  })

  it('moves to a folder of the account from a menu', async () => {
    const wrapper = mountPane()
    await opened(wrapper)
    actions.length = 0

    await wrapper.get('button[aria-haspopup="menu"]').trigger('click')
    const items = wrapper.findAll('[role="menuitem"]')
    expect(items.map((item) => item.text())).toEqual(['Archive', 'Inbox', 'Projects', 'Sent', 'Trash'])
    expect(document.activeElement).toBe(items[0]!.element)
    await wrapper.get('[role="menu"]').trigger('keydown', { key: 'ArrowDown' })
    await wrapper.get('[role="menu"]').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[2]!.element)
    expect(actions, 'browsing the folders moves nothing').toEqual([])

    await items[2]!.trigger('click')
    await vi.waitFor(() => expect(useComposeStore().notices.some((n) => n.text === 'Moved to Projects.')).toBe(true))
    expect(actions).toEqual([{ messageIds: ['m1', 'm2'], action: 'move', folderId: 'projects' }])
  })

  it('puts back with undo what it can, and says what it cannot', async () => {
    // m2 is in Inbox and in Projects: trash takes both copies, and no move puts both back. m1 came from Sent only.
    later = page(2, { messages: [message('m2', ['inbox', 'projects'], '2026-10-19T09:00:00Z', false)] })
    await useMailStore().syncNow()
    const wrapper = mountPane()
    await opened(wrapper)
    actions.length = 0

    await wrapper.get('button[aria-keyshortcuts="#"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'))

    const notice = useComposeStore().notices.find((n) => n.text.startsWith('Moved to Trash.'))
    expect(notice?.text).toBe('Moved to Trash. Undo cannot put one message back.')
    actions.length = 0
    notice?.action?.run()
    await vi.waitFor(() => expect(actions).toEqual([{ messageIds: ['m1'], action: 'move', folderId: 'sent', fromFolderId: 'trash' }]))
  })

  it('archives when asked while the conversation is still being read', async () => {
    let release = () => {}
    holdMarkRead = new Promise((resolve) => (release = resolve))
    const wrapper = mountPane()
    await vi.waitFor(() => expect(wrapper.find('.subject').exists()).toBe(true))
    await vi.waitFor(() => expect(actions).toHaveLength(1))

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }))
    await settle()
    expect(actions.map((a) => a.action), 'the archive waits for the read').toEqual(['markRead'])
    release()

    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'))
    expect(actions.map((a) => a.action)).toEqual(['markRead', 'archive'])
  })

  it('leaves its shortcuts to the list while conversations are selected there', async () => {
    const wrapper = mountPane()
    await opened(wrapper)
    actions.length = 0
    useSelectionStore().toggle('t9')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))
    await settle()

    expect(actions).toEqual([])
  })

  it('ignores a held key and shortcuts meant for the compose window', async () => {
    const wrapper = mountPane()
    await opened(wrapper)
    actions.length = 0

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', repeat: true }))
    useComposeStore().openNew()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))
    await settle()

    expect(actions).toEqual([])
    expect(wrapper.get('button[aria-keyshortcuts="S"]').attributes('aria-pressed')).toBe('false')
  })

  it('puts things back and says why when the server refuses', async () => {
    const wrapper = mountPane()
    await opened(wrapper)
    refuse = 'archive'

    await wrapper.get('button[aria-keyshortcuts="E"]').trigger('click')
    await vi.waitFor(() => expect(useComposeStore().notices.map((n) => n.text)).toContain('action: kim@company.example has no Archive folder.'))

    expect(await folderIdsOf('m2')).toEqual(['inbox'])
    expect(router.currentRoute.value.path).toBe('/inbox/t1')
  })

  describe('the Message menu', () => {
    /** Runs a Message menu item as the desktop bridge does, against the conversation on screen. */
    function menu(action: MenuAction): Promise<void> {
      return runMenuAction(action, {
        router: { push: vi.fn<(to: { name: string }) => Promise<undefined>>(async () => undefined) },
        newMessage: vi.fn<() => void>(),
        reload: vi.fn<() => Promise<void>>(async () => undefined),
        signedIn: () => true,
        toggleSidebar: vi.fn<() => void>(),
        sidebarShown: () => true,
        getNewMail: vi.fn<() => Promise<void>>(async () => undefined),
        conversation: openConversation,
        editing: () => false,
        outboxWaiting: () => false,
        onScreen: () => true,
      })
    }

    it('offers the conversation once it is loaded, as read and not flagged, and nothing once it is gone', async () => {
      expect(openConversation()).toBeNull()
      const wrapper = mountPane()
      await opened(wrapper)

      await vi.waitFor(() => expect(openConversation()?.read()).toBe(true))
      expect(openConversation()?.flagged()).toBe(false)
      wrapper.unmount()
      expect(openConversation()).toBeNull()
    })

    it('archives as the button does: the same request, back to the list, and an undo', async () => {
      const wrapper = mountPane()
      await opened(wrapper)
      actions.length = 0

      await menu('archive')
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'))

      expect(actions).toEqual([{ messageIds: ['m1', 'm2'], action: 'archive' }])
      expect(useComposeStore().notices.find((n) => n.text === 'Archived.')?.action?.label).toBe('Undo')
    })

    it('moves to Trash as # does', async () => {
      const wrapper = mountPane()
      await opened(wrapper)
      actions.length = 0

      await menu('move-to-trash')

      expect(actions).toEqual([{ messageIds: ['m1', 'm2'], action: 'trash' }])
      expect(useComposeStore().notices.find((n) => n.text === 'Moved to Trash.')?.action?.label).toBe('Undo')
    })

    it('flags and unflags as S does, and says which it would do next', async () => {
      const wrapper = mountPane()
      await opened(wrapper)
      actions.length = 0

      await menu('toggle-flag')
      expect(actions).toEqual([{ messageIds: ['m2'], action: 'flag' }])
      await vi.waitFor(() => expect(openConversation()?.flagged()).toBe(true))
      expect(wrapper.get('button[aria-keyshortcuts="S"]').attributes('aria-pressed')).toBe('true')

      await menu('toggle-flag')
      expect(actions[1]).toEqual({ messageIds: ['m2'], action: 'unflag' })
      await vi.waitFor(() => expect(openConversation()?.flagged()).toBe(false))
    })

    it('marks a read conversation unread as U does, back to the list', async () => {
      const wrapper = mountPane()
      await opened(wrapper)
      actions.length = 0

      await menu('toggle-read')

      expect(actions).toEqual([{ messageIds: ['m2'], action: 'markUnread' }])
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'))
    })

    it('reads an unread conversation', async () => {
      // Reading it on open is refused, so it stays unread: the item offers Mark as Read.
      refuse = 'markRead'
      mountPane()
      await vi.waitFor(() => expect(useComposeStore().notices.some((n) => n.tone === 'error')).toBe(true))
      await vi.waitFor(() => expect(openConversation()?.read()).toBe(false))
      refuse = null
      actions.length = 0

      await menu('toggle-read')

      expect(actions).toEqual([{ messageIds: ['m2'], action: 'markRead' }])
      await vi.waitFor(() => expect(openConversation()?.read()).toBe(true))
      expect(router.currentRoute.value.path).toBe('/inbox/t1')
    })

    it('replies, replies to all and forwards the newest message, as its own buttons do', async () => {
      const wrapper = mountPane()
      await opened(wrapper)
      const openReply = vi.spyOn(useComposeStore(), 'openReply').mockResolvedValue()

      await menu('reply')
      await menu('reply-all')
      await menu('forward')

      expect(openReply.mock.calls.map(([message, kind]) => [message.id, kind])).toEqual([
        ['m2', 'reply'],
        ['m2', 'replyAll'],
        ['m2', 'forward'],
      ])
    })

    it('opens the folder menu for Move to…, with the focus on the first folder', async () => {
      const wrapper = mountPane()
      await opened(wrapper)

      await menu('move-to')

      await vi.waitFor(() => expect(wrapper.find('[role="menu"]').exists()).toBe(true))
      expect(document.activeElement).toBe(wrapper.findAll('[role="menuitem"]')[0]!.element)
      expect(actions).toHaveLength(1)
    })

    it('offers nothing while conversations are selected in the list or a hand-over is written, and does nothing then', async () => {
      const wrapper = mountPane()
      await opened(wrapper)
      actions.length = 0

      useSelectionStore().toggle('t9')
      expect(openConversation()).toBeNull()
      await menu('archive')
      useSelectionStore().clear()
      expect(openConversation()).not.toBeNull()

      await wrapper.get('button[aria-keyshortcuts="H"]').trigger('click')
      await vi.waitFor(() => expect(useHandOversStore().handingOver).not.toBeNull())
      expect(openConversation()).toBeNull()
      await menu('toggle-flag')
      await settle()
      expect(actions).toEqual([])
    })

    it('waits while the compose window is open, so Reply cannot swap the draft away and ⌘⌫ cannot trash what is behind it', async () => {
      const wrapper = mountPane()
      await opened(wrapper)
      actions.length = 0
      const openReply = vi.spyOn(useComposeStore(), 'openReply').mockResolvedValue()
      const compose = useComposeStore()
      compose.openNew()
      await vi.waitFor(() => expect(compose.draft).not.toBeNull())

      expect(openConversation()).toBeNull()
      await menu('reply')
      await menu('move-to-trash')
      await menu('archive')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }))
      await settle()
      expect(openReply).not.toHaveBeenCalled()
      expect(actions).toEqual([])

      // Minimized, the conversation has the attention again.
      compose.minimized = true
      expect(openConversation()).not.toBeNull()
      await menu('reply')
      expect(openReply).toHaveBeenCalledOnce()
    })

    it('waits while a modal dialog is open (the unsaved drafts question at a sign-out), for the menu and the keys alike', async () => {
      const wrapper = mountPane()
      await opened(wrapper)
      actions.length = 0
      const question = document.body.appendChild(document.createElement('dialog'))
      question.setAttribute('open', '')
      question.setAttribute('role', 'alertdialog')

      expect(openConversation()).toBeNull()
      await menu('archive')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }))
      await settle()
      expect(actions).toEqual([])

      question.remove()
      const alert = document.body.appendChild(document.createElement('div'))
      alert.setAttribute('role', 'alertdialog')
      expect(openConversation()).toBeNull()
      alert.remove()
      expect(openConversation()).not.toBeNull()
    })

    it('waits while the folder menu is open', async () => {
      const wrapper = mountPane()
      await opened(wrapper)
      actions.length = 0

      await wrapper.get('button[aria-haspopup="menu"]').trigger('click')
      expect(openConversation()).toBeNull()
      await menu('archive')
      await settle()
      expect(actions).toEqual([])
    })

    it('is U right after opening an unread conversation: it waits for the read on opening, then marks it unread', async () => {
      // The read on opening is held before it changes anything, so the conversation is still unread when the item comes.
      const mail = useMailStore()
      const act = mail.act
      let release = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      vi.spyOn(mail, 'act').mockImplementationOnce(async (...args) => {
        await held
        return act(...args)
      })
      const wrapper = mountPane()
      await vi.waitFor(() => expect(wrapper.find('.subject').exists()).toBe(true))
      expect(openConversation()?.read()).toBe(false)

      const toggled = menu('toggle-read')
      await settle()
      expect(actions, 'it waits for the read').toEqual([])
      release()
      await toggled

      expect(actions.map((a) => a.action)).toEqual(['markRead', 'markUnread'])
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'))
    })

    it('settles as Noted, hands over, settles as Do and makes a to-do as K, H, D and T do', async () => {
      const wrapper = mountPane()
      await opened(wrapper)
      useMailStore().smartInboxes = [{ id: 'todo', builtin: 'todo', name: 'To do', instructions: '', includeSenders: [], excludeSenders: [], verdict: 'do', autoCreateTodo: false, position: 0 }]
      const classify = vi.spyOn(useMailStore(), 'classifyThread').mockResolvedValue({ threadId: 't1', smartInboxId: 'todo', verdict: 'do', reason: 'user', senderRule: null, placementId: 'p1' })
      const make = vi.spyOn(useTodosStore(), 'makeFromMessage').mockResolvedValue({ ...todo('td1'), made: true })
      expect(openConversation()?.hasTodo()).toBe(false)

      await menu('make-todo')
      expect(make).toHaveBeenCalledWith('m2')
      await menu('settle-do')
      expect(classify).toHaveBeenCalledWith('t1', 'todo', 'do', { remember: false })

      await menu('hand-over')
      await vi.waitFor(() => expect(useHandOversStore().handingOver?.id).toBe('m2'))
      useHandOversStore().close()

      actions.length = 0
      await menu('settle-noted')
      expect(actions).toEqual([{ messageIds: ['m1', 'm2'], action: 'archive' }])
      expect(useComposeStore().notices.find((n) => n.text === 'Marked read and archived.')?.action?.label).toBe('Undo')
    })
  })

  describe('unsubscribe', () => {
    const offering = { ...message('m2', ['inbox'], '2026-10-19T09:00:00Z', false), unsubscribe: 'oneClick' as const }

    function button(wrapper: ReturnType<typeof mountPane>) {
      return wrapper.find('button[aria-label="Unsubscribe from m2@example.test"]')
    }

    it('offers it, and shows the request pending and then done', async () => {
      later = page(2, { messages: [offering] })
      await useMailStore().syncNow()
      const wrapper = mountPane()
      await opened(wrapper)

      await button(wrapper).trigger('click')
      await vi.waitFor(() => expect(wrapper.find('[role="status"]').exists()).toBe(true))

      expect(unsubscribes).toEqual([{ messageId: 'm2' }])
      expect(button(wrapper).exists()).toBe(false)
      expect(wrapper.get('[role="status"]').text()).toBe('Unsubscribing…')

      // The delta brings the outcome later.
      pages.set(2, page(3, { unsubscriptions: [unsubscription('done')] }))
      await useMailStore().syncNow()
      await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toBe('Unsubscribed'))
      expect(button(wrapper).exists()).toBe(false)
    })

    it('shows where a mailto unsubscribe goes and sends it only once the user says so', async () => {
      later = page(2, { messages: [{ ...offering, unsubscribe: 'mailto' as const, unsubscribeMailto: 'leave@example.test' }] })
      await useMailStore().syncNow()
      const wrapper = mountPane()
      await opened(wrapper)

      await button(wrapper).trigger('click')

      expect(unsubscribes).toEqual([])
      expect(wrapper.text()).toContain('Sends an email saying "unsubscribe" to leave@example.test from your account.')
      await wrapper.get('button[aria-label="Send the unsubscribe email to leave@example.test"]').trigger('click')
      await vi.waitFor(() => expect(unsubscribes).toEqual([{ messageId: 'm2' }]))
    })

    it('says why the last attempt failed and offers it again', async () => {
      later = page(2, { messages: [offering], unsubscriptions: [unsubscription('failed', 'Refused (HTTP 404).')] })
      await useMailStore().syncNow()
      const wrapper = mountPane()
      await opened(wrapper)

      expect(button(wrapper).exists()).toBe(true)
      expect(wrapper.text()).toContain('The last attempt failed: Refused (HTTP 404).')
    })

    it('keeps the button and says why when the server refuses', async () => {
      later = page(2, { messages: [offering] })
      await useMailStore().syncNow()
      refuseUnsubscribe = true
      const wrapper = mountPane()
      await opened(wrapper)

      await button(wrapper).trigger('click')
      await vi.waitFor(() => expect(useComposeStore().notices.map((n) => n.text)).toContain('Spam cannot be unsubscribed from.'))

      await vi.waitFor(() => expect(button(wrapper).attributes('disabled')).toBeUndefined())
      expect(useMailStore().unsubscriptions).toEqual([])
    })

    it('offers nothing for a conversation without an unsubscribe address', async () => {
      const wrapper = mountPane()
      await opened(wrapper)

      expect(wrapper.text()).not.toContain('Unsubscribe')
    })

    it('offers nothing in Spam', async () => {
      later = page(2, {
        smartInboxes: [{ id: 'spam', builtin: 'spam', name: 'Spam', instructions: '', includeSenders: [], excludeSenders: [], verdict: 'none', autoCreateTodo: false, position: 4 }],
        threads: [{ id: 't1', mailAccountId: 'work', subject: 'Offsite plan', messageCount: 2, lastMessageAt: '2026-10-19T09:00:00Z', smartInboxId: 'spam', verdict: null, classificationReason: null }],
        messages: [{ ...offering, smartInboxId: 'spam' }],
      })
      await useMailStore().syncNow()
      const wrapper = mountPane()
      await opened(wrapper)

      expect(wrapper.text()).not.toContain('Unsubscribe')
    })
  })

  describe('handing over', () => {
    const open: SyncedHandOver = {
      id: 'h1',
      mailAccountId: 'work',
      messageId: 'm2',
      threadId: 't1',
      subject: 'Offsite plan',
      delegate: { address: 'lisa@company.example', name: 'Lisa Bakker' },
      note: '',
      dueAt: '2099-10-23T15:00:00Z',
      state: 'open',
      forwardId: 'f1',
      overdueAt: null,
      notifiedAt: null,
      notifiedChannels: [],
      notifiedSilently: false,
      nudgedAt: null,
      lastNudgeId: null,
      replyMessageId: null,
      createdAt: '2026-10-20T08:00:00Z',
      closedAt: null,
      updatedAt: '2026-10-20T08:00:00Z',
    }

    it('opens the hand-over for the newest message from someone else, also with H', async () => {
      const wrapper = mountPane()
      await opened(wrapper)
      const handOvers = useHandOversStore()

      await wrapper.get('button[aria-keyshortcuts="H"]').trigger('click')
      await vi.waitFor(() => expect(handOvers.handingOver?.id).toBe('m2'))
      handOvers.close()

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' }))
      await vi.waitFor(() => expect(handOvers.handingOver?.id).toBe('m2'))
    })

    it('says who it is handed over to, with a nudge and mark done at hand', async () => {
      await useMailStore().stop()
      await deleteMailDatabase('pane-user')
      handOvers = [open, { ...open, id: 'h2', state: 'done', closedAt: '2026-10-21T08:00:00Z' }]
      await useMailStore().start('pane-user')
      const markDone = vi.spyOn(useHandOversStore(), 'markDone').mockResolvedValue(true)
      const wrapper = mountPane()
      await opened(wrapper)

      await vi.waitFor(() => expect(wrapper.findAll('.handed')).toHaveLength(1))
      expect(wrapper.get('.handed').text()).toContain('Handed over to Lisa Bakker, due')
      expect(wrapper.get('.handed a').attributes('href')).toBe('/waiting?nudge=h1')
      await wrapper.get('.handed button').trigger('click')
      expect(markDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'h1' }))
    })
  })
})
