import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import type { ChangePage, HandedOver, SyncedHandOver, SyncedMessage, SyncedSmartInbox, SyncedThread } from '@tresso/core'
import { deleteMailDatabase } from '@/mail/db'
import { useCalendarStore } from '@/stores/calendar'
import { useComposeStore } from '@/stores/compose'
import { useHandOversStore } from '@/stores/handOvers'
import { useMailStore } from '@/stores/mail'
import EventEditor from '@/components/calendar/EventEditor.vue'
import TriageView from '../TriageView.vue'

const USER = 'triage-user'
const account = { id: 'work', emailAddress: 'kim@company.example', displayName: 'Work', provider: 'imap', status: 'active' as const, statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null }
const folders = [
  { id: 'inbox', mailAccountId: 'work', name: 'INBOX', displayName: 'Inbox', role: 'inbox' as const },
  { id: 'archive', mailAccountId: 'work', name: 'Archive', displayName: 'Archive', role: 'archive' as const },
]

function smartInbox(id: string, builtin: SyncedSmartInbox['builtin'], verdict: SyncedSmartInbox['verdict'], position: number): SyncedSmartInbox {
  return { id, builtin, name: id === 'invoices' ? 'Invoices' : id, instructions: '', includeSenders: [], excludeSenders: [], verdict, autoCreateTodo: false, position }
}

function thread(id: string, subject: string, at: string, smartInboxId: string | null, classificationReason: string | null): SyncedThread {
  return { id, mailAccountId: 'work', subject, messageCount: 1, lastMessageAt: at, smartInboxId, verdict: smartInboxId === null ? null : 'do', classificationReason }
}

function message(id: string, threadId: string, subject: string, at: string, seen: boolean): SyncedMessage {
  return {
    id,
    mailAccountId: 'work',
    threadId,
    folderIds: ['inbox'],
    subject,
    from: { address: `${id}@partner.example`, name: `Sender ${id}` },
    recipients: { to: [{ address: 'kim@company.example', name: null }], cc: [], bcc: [], replyTo: [] },
    snippet: '',
    sentAt: null,
    receivedAt: at,
    flags: { seen, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    smartInboxId: null,
    verdict: null,
    summary: null,
    calendarMethod: null,
    attachmentScan: null,
  }
}

function page(cursor: number, extra: Partial<ChangePage> = {}): ChangePage {
  return { cursor, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [], ...extra }
}

function todo(id: string, messageId: string) {
  return { id, title: 'Charged twice', notes: '', dueDate: null, dueTime: null, durationMinutes: null, completedAt: null, position: 0, source: 'manual', messageId, threadId: 't1', createdAt: '2026-10-19T10:00:00Z', updatedAt: '2026-10-19T10:00:00Z' }
}

const handed: HandedOver = {
  handOver: { id: 'h1', mailAccountId: 'work', messageId: 'm1', threadId: 't1', subject: 'Charged twice', delegate: { address: 'lisa@company.example', name: 'Lisa' }, note: '', dueAt: '2026-10-23T15:00:00Z', state: 'open', forwardId: 'f1', overdueAt: null, notifiedAt: null, notifiedChannels: [], notifiedSilently: false, nudgedAt: null, lastNudgeId: null, replyMessageId: null, createdAt: '2026-10-20T08:00:00Z', closedAt: null, updatedAt: '2026-10-20T08:00:00Z' } satisfies SyncedHandOver,
  forwardId: 'f1',
  draftId: 'd1',
  until: 0,
}

const invoice = thread('t1', 'Charged twice', '2026-10-19T10:00:00Z', 'invoices', 'include_list')
const decided = thread('t2', 'Already placed', '2026-10-19T09:00:00Z', 'todo', 'user')
const lunch = thread('t3', 'Lunch', '2026-10-19T08:00:00Z', null, null)

describe('TriageView', () => {
  type Request = { method: string; path: string; body: unknown }
  /** This test's requests; a decision of an earlier test that still runs writes to that test's own log. */
  let requests: Request[]
  /** Requests made so far, and those still waiting for their answer. */
  let started = 0
  let inFlight = 0
  let threads: SyncedThread[]
  /** Later pages of the delta, in order: the first one after cursor 1 has cursor 2, and so on. */
  let later: ChangePage[]
  let router: Router
  let mounted: VueWrapper | null
  /** While set, the classification PUT waits for it before the server answers. */
  let holdPut: Promise<void> | null
  /** While set, the first page of the delta waits for it (a new browser on a slow connection). */
  let holdFirstPull: Promise<void> | null
  /** While set, every later page waits for it (a reload on a slow connection). */
  let holdLaterPulls: Promise<void> | null
  /** The server's answer to a DELETE of a placement. */
  let releaseStatus: number
  let placements: number
  /** Whether the next todo request finds one already (another email of the conversation has an open todo). */
  let todoExists: boolean
  /** What the newest email (m1) carries besides the defaults: a text, a calendar invitation. */
  let firstMessage: Partial<SyncedMessage>
  /** While set, the invitation answer waits for it before the server answers. */
  let holdResponse: Promise<void> | null

  beforeEach(async () => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    const log: Request[] = []
    requests = log
    threads = [invoice, decided, lunch]
    later = []
    mounted = null
    holdPut = null
    holdFirstPull = null
    holdLaterPulls = null
    releaseStatus = 204
    placements = 0
    todoExists = false
    firstMessage = {}
    holdResponse = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        started += 1
        inFlight += 1
        try {
          return await answer(input, init)
        } finally {
          inFlight -= 1
        }
      }),
    )
    async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.pathname === '/api/v1/sync/changes') {
        const since = Number(url.searchParams.get('since'))
        if (since === 0) {
          if (holdFirstPull !== null) {
            await holdFirstPull
          }
          return json(
            page(1, {
              mailAccounts: [account],
              folders,
              smartInboxes: [smartInbox('todo', 'todo', 'do', 0), smartInbox('spam', 'spam', 'none', 1), smartInbox('invoices', null, 'know', 2)],
              threads,
              messages: [{ ...message('m1', 't1', 'Charged twice', '2026-10-19T10:00:00Z', false), ...firstMessage }, message('m2', 't2', 'Already placed', '2026-10-19T09:00:00Z', true), message('m3', 't3', 'Lunch', '2026-10-19T08:00:00Z', true)],
            }),
          )
        }
        if (holdLaterPulls !== null) {
          await holdLaterPulls
        }
        return json(later.find((candidate) => candidate.cursor === since + 1) ?? page(since))
      }
      if (method !== 'GET') {
        log.push({ method, path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      }
      if (url.pathname.endsWith('/classification') && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { smartInboxId: string; verdict: string }
        if (holdPut !== null) {
          await holdPut
        }
        return json({ threadId: url.pathname.split('/')[4], smartInboxId: body.smartInboxId, verdict: body.verdict, reason: 'user', senderRule: null, placementId: `p${++placements}` })
      }
      if (url.pathname.endsWith('/classification') && method === 'DELETE') {
        if (releaseStatus === 409) {
          return json({ detail: 'This conversation was moved again since; that choice stays.' }, 409)
        }
        // The rules place it where it was; the pull after the undo brings that.
        serverChange({ threads: [invoice] })
        return new Response(null, { status: 204 })
      }
      if (/^\/api\/v1\/messages\/[^/]+\/todo$/.test(url.pathname)) {
        const messageId = url.pathname.split('/')[4]
        return json({ ...todo(`todo-${messageId}`, messageId!), made: !todoExists })
      }
      if (url.pathname.startsWith('/api/v1/todos/') && method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/api/v1/message-actions') {
        return json({ changed: 1 })
      }
      if (url.pathname === '/api/v1/messages/m1/invitation') {
        return json(invitationOf())
      }
      if (/^\/api\/v1\/calendar-events\/[^/]+\/response$/.test(url.pathname)) {
        if (holdResponse !== null) {
          await holdResponse
        }
        return json({})
      }
      if (url.pathname.endsWith('/body')) {
        return json({ id: url.pathname.split('/')[4], html: null, text: 'Hello', hasRemoteContent: false, remoteContentLoaded: false, attachments: [] })
      }
      return json({ detail: 'unavailable' }, 503)
    }
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'unified', component: { template: '<div />' } },
        { path: '/triage', name: 'triage', component: TriageView },
        { path: '/calendar/:view?/:date?', name: 'calendar', component: { template: '<div />' } },
      ],
    })
    await router.push('/triage')
  })

  afterEach(async () => {
    // Decisions and undos a test left running finish first, so none of their requests reach the next test.
    for (let quiet = 0; quiet < 3; ) {
      const before = started
      await settle()
      quiet = inFlight === 0 && started === before ? quiet + 1 : 0
    }
    mounted?.unmount()
    await useMailStore().stop()
    await deleteMailDatabase(USER)
    vi.unstubAllGlobals()
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  /** A change on the server (another device, new mail), in the next page of the delta. */
  function serverChange(extra: Partial<ChangePage>): void {
    later.push(page(later.length + 2, extra))
  }

  /** Mounts the view while the copy opens, without waiting for anything. */
  function mountStarting() {
    const started = useMailStore().start(USER)
    const wrapper = mount(TriageView, { global: { plugins: [router] }, attachTo: document.body })
    mounted = wrapper
    return { wrapper, started }
  }

  /** Mounts the view and waits until the round shows. */
  async function mountView() {
    const { wrapper, started } = mountStarting()
    await started
    await until(() => expect(wrapper.find('#triage-subject, #triage-done').exists()).toBe(true))
    return wrapper
  }

  /** Waits as long as a loaded machine may need for a decision's requests and the reads after them. */
  function until(check: () => void | Promise<void>) {
    return vi.waitFor(check, { timeout: 4000 })
  }

  function press(key: string, target: EventTarget = window): void {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }

  function hold(): () => void {
    let open!: () => void
    holdPut = new Promise((resolve) => {
      open = () => {
        holdPut = null
        resolve()
      }
    })
    return open
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await flushPromises()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  function invitationOf() {
    return {
      id: 'i1',
      method: 'REQUEST',
      kind: 'new',
      uid: 'u1',
      recurrenceId: null,
      sequence: 0,
      summary: 'Quarterly planning',
      description: '',
      location: '',
      allDay: false,
      start: { dateTime: '2026-10-28T10:00:00', timeZone: 'Europe/Amsterdam' },
      end: { dateTime: '2026-10-28T11:00:00', timeZone: 'Europe/Amsterdam' },
      recurrence: null,
      organizer: { address: 'lisa@partner.example', name: 'Lisa' },
      attendees: [],
      conference: null,
      eventId: 'e1',
      selfResponse: 'needs-action',
      canRespond: true,
      conflicts: [],
      canApply: false,
    }
  }

  const subject = (wrapper: VueWrapper) => wrapper.find('#triage-subject').text()
  const bodies = () => requests.map((request) => request.body)

  it('walks the waiting conversations newest first, leaving out the ones the user placed', async () => {
    const wrapper = await mountView()

    expect(subject(wrapper)).toBe('Charged twice')
    expect(wrapper.get('.position').text()).toBe('1 of 2')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuemax')).toBe('2')
    expect(wrapper.get('.smart-inbox').text()).toBe('Invoices')
  })

  it('starts only once the first pull brought what the server has', async () => {
    let arrive!: () => void
    holdFirstPull = new Promise((resolve) => {
      arrive = resolve
    })
    const { wrapper } = mountStarting()
    await until(() => expect(useMailStore().ready).toBe(true))
    await settle()

    expect(wrapper.find('#triage-done').exists()).toBe(false)
    expect(wrapper.text()).toContain('Loading your mail')

    arrive()
    await until(() => expect(wrapper.find('#triage-subject').exists()).toBe(true))
    expect(subject(wrapper)).toBe('Charged twice')
  })

  it('after a reload, starts from what the server has, with mail that came in while away first', async () => {
    const first = await mountView()
    first.unmount()
    mounted = null
    await useMailStore().stop()
    serverChange({ threads: [thread('t4', 'New offer', '2026-10-20T08:00:00Z', 'invoices', 'direct')], messages: [message('m4', 't4', 'New offer', '2026-10-20T08:00:00Z', false)] })
    let arrive!: () => void
    holdLaterPulls = new Promise((resolve) => {
      arrive = resolve
    })

    const { wrapper } = mountStarting()
    await until(() => expect(useMailStore().ready).toBe(true))
    await settle()
    expect(wrapper.find('#triage-subject').exists()).toBe(false)

    holdLaterPulls = null
    arrive()
    await until(() => expect(wrapper.find('#triage-subject').exists()).toBe(true))
    expect(subject(wrapper)).toBe('New offer')
    expect(wrapper.get('.position').text()).toBe('1 of 3')
  })

  it('D marks the conversation to do, for this conversation only, reads it and makes its todo', async () => {
    const wrapper = await mountView()

    press('d')
    await until(() => expect(subject(wrapper)).toBe('Lunch'))
    await until(() => expect(requests).toHaveLength(3))

    expect(requests).toEqual([
      { method: 'PUT', path: '/api/v1/threads/t1/classification', body: { smartInboxId: 'invoices', verdict: 'do', remember: false } },
      { method: 'POST', path: '/api/v1/message-actions', body: { messageIds: ['m1'], action: 'markRead' } },
      { method: 'POST', path: '/api/v1/messages/m1/todo', body: { perConversation: true } },
    ])
    expect(wrapper.get('.position').text()).toBe('2 of 2')
    expect(wrapper.get('.count.do').text()).toBe('1')
    await until(() => expect(useComposeStore().notices.map((notice) => notice.text)).toContain('Marked as to do.'))
  })

  it('takes D, K and Z pressed in quick succession in order, dropping none', async () => {
    const wrapper = await mountView()
    const answer = hold()

    press('d')
    // Keys wait for the email they are for; Z while both still save.
    await until(() => expect(subject(wrapper)).toBe('Lunch'))
    press('k')
    press('z')
    await until(() => expect(wrapper.find('.saving').exists()).toBe(true))
    answer()
    await until(() => expect(requests).toHaveLength(5))

    expect(bodies()).toEqual([
      { smartInboxId: 'invoices', verdict: 'do', remember: false },
      { messageIds: ['m1'], action: 'markRead' },
      { perConversation: true },
      { messageIds: ['m3'], action: 'archive' },
      { messageIds: ['m3'], action: 'move', folderId: 'inbox', fromFolderId: 'archive' },
    ])
    await until(() => expect(subject(wrapper)).toBe('Lunch'))
    expect(wrapper.get('.count.do').text()).toBe('1')
    expect(wrapper.get('.count.know').text()).toBe('0')
  })

  it('H opens the hand-over dialog and places the conversation only once it was handed over', async () => {
    const wrapper = await mountView()
    const handOvers = useHandOversStore()
    let handOver!: (handed: HandedOver | null) => void
    const opened = vi.spyOn(handOvers, 'handOverAndWait').mockReturnValue(
      new Promise((resolve) => {
        handOver = resolve
      }),
    )

    await wrapper.get('button.decision.delegate').trigger('click')
    await until(() => expect(opened.mock.calls[0]?.[0].map((message: SyncedMessage) => message.id)).toEqual(['m1']))
    await until(() => expect(subject(wrapper)).toBe('Lunch'))
    expect(requests).toEqual([])

    handOver(handed)
    await until(() => expect(requests[0]).toEqual({ method: 'PUT', path: '/api/v1/threads/t1/classification', body: { smartInboxId: 'invoices', verdict: 'delegate', remember: false } }))
    await until(() => expect(wrapper.get('.count.delegate').text()).toBe('1'))
  })

  it('places nothing and shows the conversation again when the hand-over dialog is closed', async () => {
    const wrapper = await mountView()
    vi.spyOn(useHandOversStore(), 'handOverAndWait').mockResolvedValue(null)

    press('h')
    await settle()

    await until(() => expect(subject(wrapper)).toBe('Charged twice'))
    expect(requests).toEqual([])
    expect(wrapper.get('.count.delegate').text()).toBe('0')
  })

  it('undo takes the hand-over back before the placement', async () => {
    const wrapper = await mountView()
    const handOvers = useHandOversStore()
    vi.spyOn(handOvers, 'handOverAndWait').mockResolvedValue(handed)
    const takeBack = vi.spyOn(handOvers, 'takeBack').mockImplementation(async () => {
      requests.push({ method: 'TAKE BACK', path: 'h1', body: undefined })
      return 'undone'
    })
    press('h')
    await until(() => expect(requests).toHaveLength(2))

    press('z')
    await until(() => expect(subject(wrapper)).toBe('Charged twice'))

    expect(takeBack).toHaveBeenCalledWith(handed)
    expect(requests.slice(2).map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /api/v1/message-actions',
      'TAKE BACK h1',
      'DELETE /api/v1/threads/t1/classification?placementId=p1',
    ])
  })

  it('says when undo could only withdraw the hand-over because the forward had left', async () => {
    await mountView()
    const handOvers = useHandOversStore()
    vi.spyOn(handOvers, 'handOverAndWait').mockResolvedValue(handed)
    vi.spyOn(handOvers, 'takeBack').mockResolvedValue('withdrawn')
    press('h')
    await until(() => expect(requests).toHaveLength(2))

    press('z')

    await until(() => expect(useComposeStore().notices.map((notice) => notice.text)).toContain('Lisa has the forward already; the hand-over is withdrawn, so nothing waits on them any more.'))
  })

  it('keeps the placement when the hand-over cannot be taken back', async () => {
    const wrapper = await mountView()
    const handOvers = useHandOversStore()
    vi.spyOn(handOvers, 'handOverAndWait').mockResolvedValue(handed)
    vi.spyOn(handOvers, 'takeBack').mockRejectedValue(new Error('The hand-over could not be taken back, so it still stands: You are offline.'))
    press('h')
    await until(() => expect(requests).toHaveLength(2))

    press('z')
    await until(() => expect(useComposeStore().notices.map((notice) => notice.text)).toContain('This could not be undone: The hand-over could not be taken back, so it still stands: You are offline.'))

    expect(requests.filter((request) => request.method === 'DELETE')).toEqual([])
    expect(wrapper.get('.count.delegate').text()).toBe('1')
  })

  it('keeps going when the hand-over cannot be opened', async () => {
    const wrapper = await mountView()
    vi.spyOn(useHandOversStore(), 'handOverAndWait').mockRejectedValue(new Error('This conversation no longer exists.'))

    press('h')
    await until(() => expect(useComposeStore().notices.map((notice) => notice.text)).toContain('This conversation no longer exists.'))
    await until(() => expect(subject(wrapper)).toBe('Charged twice'))

    press('k')
    await until(() => expect(subject(wrapper)).toBe('Lunch'))
  })

  it('puts a conversation in no smart inbox in Todo', async () => {
    const wrapper = await mountView()
    press('j')
    await until(() => expect(subject(wrapper)).toBe('Lunch'))

    press('d')

    await until(() => expect(requests[0]?.body).toEqual({ smartInboxId: 'todo', verdict: 'do', remember: false }))
  })

  it('K archives and reads it; Z puts back exactly that', async () => {
    const wrapper = await mountView()

    press('k')
    await until(() => expect(subject(wrapper)).toBe('Lunch'))
    await until(() => expect(requests).toHaveLength(2))
    expect(bodies()).toEqual([
      { messageIds: ['m1'], action: 'archive' },
      { messageIds: ['m1'], action: 'markRead' },
    ])
    expect(wrapper.get('.count.know').text()).toBe('1')

    requests.length = 0
    press('z')
    await until(() => expect(subject(wrapper)).toBe('Charged twice'))
    await until(() => expect(requests).toHaveLength(2))

    expect(bodies()).toEqual([
      { messageIds: ['m1'], action: 'move', folderId: 'inbox', fromFolderId: 'archive' },
      { messageIds: ['m1'], action: 'markUnread' },
    ])
    expect(wrapper.get('.count.know').text()).toBe('0')
    expect(wrapper.get('.position').text()).toBe('1 of 2')
  })

  it('undo takes a do back: unread again, the todo it made removed, then the placement by its id', async () => {
    const wrapper = await mountView()
    press('d')
    await until(() => expect(useComposeStore().notices.map((notice) => notice.text)).toContain('Marked as to do.'))
    requests.length = 0

    useComposeStore().notices.find((candidate) => candidate.text === 'Marked as to do.')?.action?.run()
    await until(() => expect(subject(wrapper)).toBe('Charged twice'))
    await until(() => expect(requests).toHaveLength(3))

    expect(requests).toEqual([
      { method: 'POST', path: '/api/v1/message-actions', body: { messageIds: ['m1'], action: 'markUnread' } },
      { method: 'DELETE', path: '/api/v1/todos/todo-m1', body: undefined },
      { method: 'DELETE', path: '/api/v1/threads/t1/classification?placementId=p1', body: undefined },
    ])
    expect(wrapper.get('.count.do').text()).toBe('0')
  })

  it('leaves the open todo the conversation had when a do is undone', async () => {
    const wrapper = await mountView()
    todoExists = true
    press('d')
    await until(() => expect(requests).toHaveLength(3))
    requests.length = 0

    press('z')
    await until(() => expect(subject(wrapper)).toBe('Charged twice'))
    await until(() => expect(requests).toHaveLength(2))

    expect(requests.map((request) => `${request.method} ${request.path.split('?')[0]}`)).toEqual(['POST /api/v1/message-actions', 'DELETE /api/v1/threads/t1/classification'])
  })

  it("leaves a later decision on the same conversation alone when an old notice's undo is used", async () => {
    const wrapper = await mountView()
    press('d')
    await until(() => expect(useComposeStore().notices.map((notice) => notice.text)).toContain('Marked as to do.'))
    const first = useComposeStore().notices.find((candidate) => candidate.text === 'Marked as to do.')!.action!
    press('z')
    await until(() => expect(subject(wrapper)).toBe('Charged twice'))
    press('k')
    await until(() => expect(useComposeStore().notices.map((notice) => notice.text)).toContain('Noted and archived.'))
    requests.length = 0

    first.run()
    await settle()

    expect(requests).toEqual([])
    expect(wrapper.get('.count.know').text()).toBe('1')
  })

  it('leaves a choice made again elsewhere where it is and says so', async () => {
    const wrapper = await mountView()
    press('d')
    await until(() => expect(requests).toHaveLength(3))
    releaseStatus = 409

    press('z')
    await until(() => expect(useComposeStore().notices.map((notice) => notice.text)).toContain('Undone, but this conversation was moved again since, so it stays where it was moved.'))

    expect(subject(wrapper)).toBe('Lunch')
    expect(wrapper.get('.count.do').text()).toBe('1')
  })

  it('follows changes from another device during the round: decided mail drops out, new mail joins', async () => {
    const wrapper = await mountView()
    serverChange({
      threads: [{ ...lunch, smartInboxId: 'todo', verdict: 'do', classificationReason: 'user' }, thread('t4', 'New offer', '2026-10-20T08:00:00Z', 'invoices', 'direct')],
      messages: [message('m4', 't4', 'New offer', '2026-10-20T08:00:00Z', false)],
    })
    await useMailStore().syncNow()
    await until(() => expect(wrapper.get('.position').text()).toBe('1 of 2'))

    press('k')
    await until(() => expect(subject(wrapper)).toBe('New offer'))
    expect(wrapper.get('.position').text()).toBe('2 of 2')
  })

  it('moves focus to the next conversation after a decision, and to the summary at the end', async () => {
    const wrapper = await mountView()
    const button = wrapper.get('button.decision.know').element as HTMLButtonElement
    button.focus()

    await wrapper.get('button.decision.know').trigger('click')
    await until(() => expect(subject(wrapper)).toBe('Lunch'))
    await until(() => expect(document.activeElement?.id).toBe('triage-subject'))

    press('k')
    await until(() => expect(document.activeElement?.id).toBe('triage-done'))
  })

  it('skips without changing anything and ends with a summary', async () => {
    const wrapper = await mountView()

    press('j')
    await until(() => expect(subject(wrapper)).toBe('Lunch'))
    press('k')
    await until(() => expect(wrapper.find('#triage-done').exists()).toBe(true))
    await until(() => expect(requests).toHaveLength(1))

    expect(wrapper.get('#triage-done').text()).toBe('All triaged')
    expect(wrapper.text()).toContain('0 to do, 0 handed over, 1 noted.')
    expect(requests.map((request) => (request.body as { action: string }).action)).toEqual(['archive'])
  })

  it('does not take shortcuts while the user types', async () => {
    const wrapper = await mountView()
    const field = document.createElement('input')
    document.body.appendChild(field)

    press('d', field)
    press('k', field)
    await settle()

    expect(requests).toEqual([])
    expect(subject(wrapper)).toBe('Charged twice')
  })

  it('says so when nothing waits', async () => {
    threads = [decided]
    const wrapper = await mountView()

    expect(wrapper.get('#triage-done').text()).toBe('Nothing to triage')
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
  })

  it('Escape leaves triage', async () => {
    await mountView()

    press('Escape')
    await until(() => expect(router.currentRoute.value.name).toBe('unified'))
  })

  it('answers an invitation with Y and puts the email away, the answer sent', async () => {
    firstMessage = { calendarMethod: 'REQUEST' }
    const wrapper = await mountView()
    await until(() => expect(wrapper.find('.answer').exists()).toBe(true))
    expect(wrapper.get('.answer-label').text()).toContain('Quarterly planning')

    press('y')
    await until(() => expect(subject(wrapper)).toBe('Lunch'))
    await until(() => expect(requests).toHaveLength(3))

    expect(requests[0]).toMatchObject({ method: 'POST', path: '/api/v1/calendar-events/e1/response', body: { response: 'accepted' } })
    expect(bodies().slice(1)).toEqual([
      { messageIds: ['m1'], action: 'archive' },
      { messageIds: ['m1'], action: 'markRead' },
    ])
    expect(useComposeStore().notices.map((notice) => notice.text)).toContain('Quarterly planning: Going. Undo brings the email back; the answer stays sent.')
  })

  it('offers no answer for an email without an invitation, and leaves Y alone there', async () => {
    const wrapper = await mountView()
    press('y')
    await settle()

    expect(wrapper.find('.answer').exists()).toBe(false)
    expect(subject(wrapper)).toBe('Charged twice')
    expect(requests).toEqual([])
  })

  it('adds an email that proposes a time to the calendar, filled in, and puts it away once saved', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // Monday 26 October 2026, 15:04 in Amsterdam.
    vi.setSystemTime(new Date('2026-10-26T14:04:00Z'))
    firstMessage = { subject: 'Re: Lunch on Thursday?', snippet: 'Hey Kim, lunch on Thursday at 12:30? The usual place.' }
    threads = [{ ...invoice, subject: 'Re: Lunch on Thursday?' }, decided, lunch]
    try {
      const wrapper = await mountView()
      useCalendarStore().zone = 'Europe/Amsterdam'

      press('a')
      await until(() => expect(wrapper.findComponent(EventEditor).exists()).toBe(true))
      const target = wrapper.findComponent(EventEditor).props('target')
      expect(target).toMatchObject({
        kind: 'new',
        allDay: false,
        prefill: { summary: 'Lunch on Thursday', attendees: [{ address: 'm1@partner.example', name: 'Sender m1', role: 'required' }], notify: false },
      })
      expect(target.kind === 'new' && new Date(target.start).toISOString()).toBe('2026-10-29T11:30:00.000Z')

      wrapper.findComponent(EventEditor).vm.$emit('saved')
      await until(() => expect(subject(wrapper)).toBe('Lunch'))
      await until(() => expect(requests).toHaveLength(2))
      expect(bodies()).toEqual([
        { messageIds: ['m1'], action: 'archive' },
        { messageIds: ['m1'], action: 'markRead' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds the decisions while an answer goes out, so it never puts away the email after it', async () => {
    firstMessage = { calendarMethod: 'REQUEST' }
    let release!: () => void
    holdResponse = new Promise((resolve) => (release = resolve))
    const wrapper = await mountView()
    await until(() => expect(wrapper.find('.answer').exists()).toBe(true))

    press('y')
    await until(() => expect(requests).toHaveLength(1))
    press('j')
    press('k')
    await settle()
    expect(subject(wrapper)).toBe('Charged twice')
    expect(wrapper.find('.decision').attributes('disabled')).toBeDefined()

    release()
    await until(() => expect(subject(wrapper)).toBe('Lunch'))
    await until(() => expect(requests).toHaveLength(3))
    expect(bodies().slice(1)).toEqual([
      { messageIds: ['m1'], action: 'archive' },
      { messageIds: ['m1'], action: 'markRead' },
    ])
  })

  it('answers an invitation instead of copying it: no Add to calendar there', async () => {
    firstMessage = { calendarMethod: 'REQUEST' }
    const wrapper = await mountView()
    await until(() => expect(wrapper.find('.answer').exists()).toBe(true))

    press('a')
    await settle()
    expect(wrapper.findComponent(EventEditor).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Add to calendar')
  })
})
