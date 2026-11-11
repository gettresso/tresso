import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import type { ChangePage, SyncedMessage } from '@tresso/core'
import { deleteMailDatabase } from '@/mail/db'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import { useSelectionStore } from '@/stores/selection'
import ConversationList from '../ConversationList.vue'

const DAY = 86_400_000
const accounts = [
  { id: 'work', emailAddress: 'kim@company.example', displayName: 'Work', provider: 'imap', status: 'active' as const, statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null },
  { id: 'home', emailAddress: 'kim@mail.example', displayName: 'Home', provider: 'imap', status: 'active' as const, statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null },
]
const folders = [
  { id: 'inbox', mailAccountId: 'work', name: 'INBOX', displayName: 'Inbox', role: 'inbox' as const },
  { id: 'archive', mailAccountId: 'work', name: 'Archive', displayName: 'Archive', role: 'archive' as const },
  { id: 'trash', mailAccountId: 'work', name: 'Trash', displayName: 'Trash', role: 'trash' as const },
  { id: 'projects', mailAccountId: 'work', name: 'Projects', displayName: 'Projects', role: 'custom' as const },
  { id: 'home-inbox', mailAccountId: 'home', name: 'INBOX', displayName: 'Inbox', role: 'inbox' as const },
]

function message(id: string, threadId: string, account: string, from: string, ageDays: number): SyncedMessage {
  return {
    id,
    mailAccountId: account,
    threadId,
    folderIds: [account === 'work' ? 'inbox' : 'home-inbox'],
    subject: `Subject ${threadId}`,
    from: { address: from, name: null },
    recipients: { to: [], cc: [], bcc: [], replyTo: [] },
    snippet: '',
    sentAt: null,
    receivedAt: new Date(Date.now() - ageDays * DAY).toISOString(),
    flags: { seen: false, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    attachmentScan: null,
    smartInboxId: null,
    verdict: null,
    summary: null,
    calendarMethod: null,
  }
}

// t1, t2 from the newsletter (t2 is older and not in the list on screen), t3 from a colleague, t4 in another account.
const messages = [
  message('m1', 't1', 'work', 'news@shop.example', 1),
  message('m2', 't2', 'work', 'News@Shop.example', 40),
  message('m3', 't3', 'work', 'anna@company.example', 2),
  message('m4', 't4', 'home', 'bob@mail.example', 3),
]

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('bulk actions', () => {
  const actions: Record<string, unknown>[] = []
  let later: ChangePage | null
  let refuse: boolean
  let router: Router

  beforeEach(async () => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    actions.length = 0
    later = null
    refuse = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.pathname === '/api/v1/sync/changes') {
          const since = Number(url.searchParams.get('since'))
          const first: ChangePage = {
            cursor: 1,
            hasMore: false,
            mailAccounts: accounts,
            folders,
            threads: messages.map((m) => ({ id: m.threadId, mailAccountId: m.mailAccountId, subject: m.subject, messageCount: 1, lastMessageAt: m.receivedAt, smartInboxId: null, verdict: null, classificationReason: null })),
            messages,
            outgoingMessages: [],
            signatures: [],
            drafts: [],
            smartInboxes: [],
            calendars: [],
            calendarEvents: [],
            notifications: [],
            eventNotes: [],
            todos: [],
            mailNotifications: [],
            handOvers: [],
            deleted: [],
          }
          const empty = { ...first, cursor: since, mailAccounts: [], folders: [], threads: [], messages: [] }
          return new Response(JSON.stringify(since === 0 ? first : since === 1 && later !== null ? later : empty))
        }
        if (url.pathname === '/api/v1/message-actions') {
          actions.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
          if (refuse) {
            return new Response(JSON.stringify({ detail: 'The mail server is not reachable.' }), { status: 503 })
          }
          return new Response(JSON.stringify({ changed: 1 }))
        }
        return new Response('{}', { status: 404 })
      }),
    )
    await useMailStore().start('bulk-user')
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/inbox/:threadId', name: 'unified-thread', component: { template: '<div />' } }] })
    await router.push('/')
  })

  afterEach(async () => {
    await useMailStore().stop()
    await deleteMailDatabase('bulk-user')
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  /** The list as on screen, with t2 not loaded yet. */
  function mountList() {
    const shown = useMailStore().conversations.filter((c) => c.threadId !== 't2')
    return mount(ConversationList, {
      props: { title: 'Unified Inbox', conversations: shown, selectedThreadId: null, hasMore: true, loading: false, hasAccounts: true, linkTo: (id: string) => `/inbox/${id}` },
      global: { plugins: [router] },
      attachTo: document.body,
    })
  }

  function checkbox(wrapper: ReturnType<typeof mountList>, threadId: string) {
    return wrapper.get(`[aria-label^="Select Subject ${threadId}, from "]`)
  }

  it('says a conversation is unread as part of its link, not only with the dot', async () => {
    const wrapper = mountList()

    const link = wrapper.get('a[href="/inbox/t1"]')
    expect(link.text()).toContain('Unread.')
    expect(link.get('.dot').attributes('aria-hidden')).toBe('true')
  })

  it('selects with checkboxes, a shift click selects a range, and the bar counts them', async () => {
    const wrapper = mountList()
    expect(wrapper.find('[aria-label="Bulk actions"]').exists()).toBe(false)

    await checkbox(wrapper, 't1').trigger('click')
    await checkbox(wrapper, 't4').trigger('click', { shiftKey: true })

    expect([...useSelectionStore().threadIds].sort()).toEqual(['t1', 't3', 't4'])
    expect(wrapper.get('[aria-label="Bulk actions"] [role="status"]').text()).toBe('3 selected')
    expect(wrapper.get('[aria-label="Select all conversations shown"]').attributes('aria-checked')).toBe('true')
  })

  it('archives every message of the selected conversations, with an undo', async () => {
    const wrapper = mountList()
    await checkbox(wrapper, 't1').trigger('click')
    await checkbox(wrapper, 't3').trigger('click')

    await wrapper.get('[aria-label="Bulk actions"] button[aria-keyshortcuts="E"]').trigger('click')
    await vi.waitFor(() => expect(actions).toHaveLength(1))

    expect(actions[0]).toEqual({ messageIds: ['m1', 'm3'], action: 'archive' })
    await vi.waitFor(() => expect(useSelectionStore().active).toBe(false))
    const notice = useComposeStore().notices.find((n) => n.text === 'Archived.')
    expect(notice?.action?.label).toBe('Undo')
  })

  it('selects everything from the same senders, also what is not loaded yet', async () => {
    const wrapper = mountList()
    await checkbox(wrapper, 't1').trigger('click')

    await vi.waitFor(() => expect(wrapper.findAll('button').some((b) => b.text() === 'Select all from this sender')).toBe(true))
    await wrapper.findAll('button').find((b) => b.text() === 'Select all from this sender')!.trigger('click')
    await vi.waitFor(() => expect([...useSelectionStore().threadIds].sort()).toEqual(['t1', 't2']))
  })

  it('selects what is older than an age', async () => {
    const wrapper = mountList()

    await wrapper.findAll('button[aria-haspopup="menu"]')[0]!.trigger('click')
    await wrapper.findAll('[role="menuitem"]').find((item) => item.text() === 'Older than a month')!.trigger('click')

    await vi.waitFor(() => expect([...useSelectionStore().threadIds]).toEqual(['t2']))
  })

  it('notes with K, as triage does: read and archived; and lets go with Escape', async () => {
    const wrapper = mountList()
    await checkbox(wrapper, 't3').trigger('click')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }))
    await vi.waitFor(() =>
      expect(actions).toEqual([
        { messageIds: ['m3'], action: 'markRead' },
        { messageIds: ['m3'], action: 'archive' },
      ]),
    )
    await vi.waitFor(() => expect(useSelectionStore().active).toBe(false))

    await checkbox(wrapper, 't1').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await settle()
    expect(useSelectionStore().active).toBe(false)
    expect(actions).toHaveLength(2)
  })

  it('still marks read without archiving from the Mark read button', async () => {
    const wrapper = mountList()
    await checkbox(wrapper, 't3').trigger('click')

    await vi.waitFor(() => expect(wrapper.findAll('[aria-label="Bulk actions"] button').some((b) => b.text() === 'Mark read')).toBe(true))
    await wrapper.findAll('[aria-label="Bulk actions"] button').find((b) => b.text() === 'Mark read')!.trigger('click')

    await vi.waitFor(() => expect(actions).toEqual([{ messageIds: ['m3'], action: 'markRead' }]))
  })

  it('moves only conversations of one account', async () => {
    const wrapper = mountList()
    await checkbox(wrapper, 't1').trigger('click')
    await checkbox(wrapper, 't4').trigger('click')

    await vi.waitFor(() => expect(wrapper.get('[aria-label="Bulk actions"] button[aria-haspopup="menu"]').attributes('disabled')).toBeDefined())

    await checkbox(wrapper, 't4').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[aria-label="Bulk actions"] button[aria-haspopup="menu"]').attributes('disabled')).toBeUndefined())
  })

  it('keeps the selection when Escape closes a menu, and takes no action keys inside a menu', async () => {
    const wrapper = mountList()
    await checkbox(wrapper, 't1').trigger('click')
    await checkbox(wrapper, 't3').trigger('click')

    const select = wrapper.findAll('button[aria-haspopup="menu"]')[0]!
    await select.trigger('click')
    const menu = wrapper.get('[role="menu"]')
    ;(menu.element.querySelector('[role="menuitem"]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }))
    await settle()
    expect(actions).toEqual([])

    ;(menu.element.querySelector('[role="menuitem"]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect([...useSelectionStore().threadIds].sort()).toEqual(['t1', 't3'])
  })

  it('selects and unselects only what is shown with the select-all box', async () => {
    const wrapper = mountList()
    useSelectionStore().set(['t2'])
    await settle()

    await wrapper.get('[aria-label="Select all conversations shown"]').trigger('click')
    expect([...useSelectionStore().threadIds].sort()).toEqual(['t1', 't2', 't3', 't4'])
    await wrapper.get('[aria-label="Select all conversations shown"]').trigger('click')

    expect([...useSelectionStore().threadIds]).toEqual(['t2'])
  })

  it('reads the selection from the local copy once per change, not again and again', async () => {
    const describe = vi.spyOn(useMailStore(), 'describeThreads')
    mountList()
    useSelectionStore().set(['t2'])
    await settle()
    const asked = describe.mock.calls.length

    await settle()

    expect(asked).toBeGreaterThan(0)
    expect(describe.mock.calls.length, 'nothing changed, so nothing is read again').toBe(asked)
  })

  it('lets go of conversations that left the inbox meanwhile', async () => {
    const wrapper = mountList()
    await checkbox(wrapper, 't1').trigger('click')
    await checkbox(wrapper, 't3').trigger('click')

    // Archived on another device.
    later = { cursor: 2, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [{ ...messages[2]!, folderIds: ['archive'] }], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [] }
    await useMailStore().syncNow()

    await vi.waitFor(() => expect([...useSelectionStore().threadIds]).toEqual(['t1']))
    expect(wrapper.get('[aria-label="Bulk actions"] [role="status"]').text()).toBe('1 selected')
  })

  it('keeps the selection when the server refuses a bulk action', async () => {
    const wrapper = mountList()
    await checkbox(wrapper, 't1').trigger('click')
    await checkbox(wrapper, 't3').trigger('click')
    refuse = true

    await wrapper.get('[aria-label="Bulk actions"] button[aria-keyshortcuts="E"]').trigger('click')
    await vi.waitFor(() => expect(useComposeStore().notices.map((n) => n.text)).toContain('The mail server is not reachable.'))
    await settle()

    expect([...useSelectionStore().threadIds].sort()).toEqual(['t1', 't3'])
  })

  it('selects a range with Shift+Space without the release taking it back', async () => {
    const wrapper = mountList()
    await checkbox(wrapper, 't1').trigger('click')

    const last = checkbox(wrapper, 't4')
    await last.trigger('keydown', { key: ' ', shiftKey: true })
    // Some browsers send a click when Space is let go.
    await last.trigger('click')
    await last.trigger('keyup', { key: ' ' })

    expect([...useSelectionStore().threadIds].sort()).toEqual(['t1', 't3', 't4'])
  })
})
