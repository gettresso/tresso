import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import type { ChangePage, SyncedMessage, SyncedOutgoingMessage } from '@tresso/core'
import { deleteMailDatabase } from '@/mail/db'
import { UNDO_SECONDS, useComposeStore } from '../compose'
import { useMailStore } from '../mail'
import { useAuthStore } from '../auth'

const desktop = vi.hoisted(() => ({ isDesktop: false, opened: [] as string[] }))

vi.mock('@/platform/desktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/desktop')>()),
  get isDesktop() {
    return desktop.isDesktop
  },
  openInBrowser: async (url: string) => {
    desktop.opened.push(url)
  },
}))

const original: SyncedMessage = {
  id: 'm1',
  mailAccountId: 'work',
  threadId: 't1',
  folderIds: ['inbox'],
  subject: 'Q4 budget',
  from: { address: 'anna@finance.example', name: 'Anna' },
  recipients: { to: [{ address: 'kim@company.example', name: 'Kim' }], cc: [{ address: 'pieter@company.example', name: null }], bcc: [], replyTo: [] },
  snippet: 'Approve?',
  sentAt: null,
  receivedAt: '2026-10-19T08:00:00Z',
  flags: { seen: true, flagged: false, answered: false, draft: false },
  hasAttachments: false,
  attachmentScan: null,
  smartInboxId: null,
  verdict: null,
  summary: null,
  calendarMethod: null,
}

function outgoing(status: SyncedOutgoingMessage['status'], lastError: string | null = null): SyncedOutgoingMessage {
  return { id: 'o1', mailAccountId: 'work', status, subject: 'Re: Q4 budget', recipients: { to: [{ address: 'anna@finance.example', name: 'Anna' }], cc: [], bcc: [] }, sendAt: new Date().toISOString(), sentAt: null, lastError, inReplyToMessageId: 'm1' }
}

function page(cursor: number, extra: Partial<ChangePage> = {}): ChangePage {
  return { cursor, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [], ...extra }
}

describe('compose store', () => {
  let pages: ChangePage[]
  /** The server refuses the session's token. */
  let expired: boolean
  /** The answer to a send, when a test holds it back. */
  let heldSend: Promise<Response> | null
  const requests: { method: string; path: string; body: unknown }[] = []

  beforeEach(async () => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    expired = false
    heldSend = null
    pages = [
      page(1, {
        mailAccounts: [
          { id: 'work', emailAddress: 'kim@company.example', displayName: 'Kim', provider: 'imap', status: 'active', statusDetail: null, lastSyncedAt: null, defaultSignatureId: 's1', calendarStatus: 'unknown' as const, calendarStatusDetail: null },
        ],
        signatures: [{ id: 's1', name: 'Work', html: '<p>Kim Visser</p>', updatedAt: '2026-10-19T08:00:00Z' }],
      }),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        requests.push({ method, path: url.pathname, body: init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined })
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
        if (expired) return json({ detail: 'Invalid token.' }, 401)
        if (url.pathname === '/api/v1/sync/changes') {
          const since = Number(url.searchParams.get('since'))
          return json(pages.find((p) => p.cursor > since) ?? page(since))
        }
        if (url.pathname === '/api/v1/messages/m1/body') return json({ id: 'm1', html: '<p>Can you approve?</p>', text: null, hasRemoteContent: false, remoteContentLoaded: false, attachments: [] })
        if (url.pathname === '/api/v1/outgoing-messages') return heldSend ?? json(outgoing('scheduled'), 201)
        if (url.pathname === '/api/v1/outgoing-messages/o1/cancel') return json(outgoing('cancelled'))
        if (url.pathname === '/api/v1/drafts' && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return json({ ...body, id: body.draftId, version: 1, updatedAt: '2026-10-19T08:00:00Z', attachments: [] }, 201)
        }
        const upload = /^\/api\/v1\/drafts\/([^/]+)\/attachments$/.exec(url.pathname)
        if (upload !== null && method === 'POST') {
          if (!(init?.body instanceof FormData)) return json({ detail: 'Send the file as multipart/form-data.' }, 422)
          const file = init.body.get('file') as File
          return json({ id: 'f1', filename: file.name, contentType: file.type, size: file.size, scanStatus: 'pending', url: 'https://api.example.test/f1' }, 201)
        }
        const draft = /^\/api\/v1\/drafts\/([^/]+)$/.exec(url.pathname)
        if (draft !== null && method === 'GET') {
          return json({ id: draft[1], version: 2, updatedAt: '2026-10-19T08:00:00Z', attachments: [{ id: 'f1', filename: 'notes.txt', contentType: 'text/plain', size: 8, scanStatus: 'pending', inline: false, contentId: null, url: 'https://api.example.test/f1?signed' }] })
        }
        return json({ detail: 'unavailable' }, 503)
      }),
    )
    await useMailStore().start('compose-user')
  })

  afterEach(async () => {
    await useMailStore().stop()
    await deleteMailDatabase('compose-user')
    vi.unstubAllGlobals()
    vi.useRealTimers()
    sessionStorage.clear()
  })

  it('prefills a reply all with recipients, subject and the quoted original', async () => {
    const compose = useComposeStore()

    await compose.openReply(original, 'replyAll')

    expect(compose.draft).toMatchObject({ kind: 'replyAll', mailAccountId: 'work', subject: 'Re: Q4 budget', inReplyToMessageId: 'm1' })
    expect(compose.draft?.to.map((a) => a.address)).toEqual(['anna@finance.example'])
    expect(compose.draft?.cc.map((a) => a.address)).toEqual(['pieter@company.example'])
    expect(compose.draft?.html).toBe('')
    expect(compose.draft?.quoteHtml).toContain('<blockquote><p>Can you approve?</p></blockquote>')
  })

  it('sends the text, then the default signature, then the quote', async () => {
    const compose = useComposeStore()
    await compose.openReply(original, 'reply')
    expect(compose.draft?.signatureId).toBe('s1')
    compose.update({ html: '<p>Approved.</p>' })

    await compose.send()

    const post = requests.find((r) => r.method === 'POST' && r.path === '/api/v1/outgoing-messages')
    const html = (post?.body as { html?: string } | undefined)?.html ?? ''
    expect(html.indexOf('<p>Approved.</p>')).toBe(0)
    expect(html.indexOf('<p>Kim Visser</p>')).toBeGreaterThan(0)
    expect(html.indexOf('<p>Kim Visser</p>')).toBeLessThan(html.indexOf('<blockquote>'))
  })

  it('keeps a reply opened from reactive message data when it is closed unchanged', async () => {
    const compose = useComposeStore()
    const mail = useMailStore()
    // Screens hand over messages from reactive state; IndexedDB refuses proxies.
    await compose.openReply(reactive(structuredClone(original)), 'replyAll')
    const id = compose.draft!.id

    compose.close()

    await vi.waitFor(async () => expect(await mail.draft(id)).toMatchObject({ subject: 'Re: Q4 budget', kind: 'replyAll' }))
  })

  it('attaches a file to a draft it puts on the server first, sending it as multipart', async () => {
    const compose = useComposeStore()
    compose.openNew()
    const id = compose.draft!.id

    await compose.attach([new File(['Q4 notes'], 'notes.txt', { type: 'text/plain' })])

    expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/api/v1/drafts', `/api/v1/drafts/${id}/attachments`])
    const form = requests.find((r) => r.path.endsWith('/attachments'))?.body
    expect(form).toBeInstanceOf(FormData)
    expect(((form as FormData).get('file') as File).name).toBe('notes.txt')
    expect(compose.draft?.attachments).toEqual([{ id: 'f1', filename: 'notes.txt', contentType: 'text/plain', size: 8, scanStatus: 'pending', inline: false, contentId: null }])
    expect(compose.attaching).toEqual([])
  })

  it("opens a draft's file in a new tab that cannot reach back, and says so when the browser blocks the tab", async () => {
    const compose = useComposeStore()
    compose.openNew()
    await compose.attach([new File(['Q4 notes'], 'notes.txt', { type: 'text/plain' })])
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn<() => void>() }
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)

    await compose.openAttachment('f1')

    expect(open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(tab.opener).toBeNull()
    expect(tab.location.href).toBe('https://api.example.test/f1?signed')

    open.mockReturnValue(null)
    const before = window.location.href
    await compose.openAttachment('f1')
    expect(window.location.href).toBe(before)
    expect(compose.notices[compose.notices.length - 1]).toMatchObject({ tone: 'error', text: 'The file could not be opened: the browser blocked the new tab.' })
    open.mockRestore()
  })

  it("opens a draft's file in the browser in the desktop app, without asking for a window first", async () => {
    const compose = useComposeStore()
    compose.openNew()
    await compose.attach([new File(['Q4 notes'], 'notes.txt', { type: 'text/plain' })])
    const open = vi.spyOn(window, 'open')
    desktop.isDesktop = true
    desktop.opened = []

    try {
      await compose.openAttachment('f1')
    } finally {
      desktop.isDesktop = false
    }

    expect(open).not.toHaveBeenCalled()
    expect(desktop.opened).toEqual(['https://api.example.test/f1?signed'])
    expect(compose.notices.filter((notice) => notice.tone === 'error')).toEqual([])
    open.mockRestore()
  })

  it('refuses to send without recipients', async () => {
    const compose = useComposeStore()
    compose.openNew()

    await compose.send()

    expect(compose.error).toBe('Add at least one recipient.')
    expect(requests.some((r) => r.method === 'POST')).toBe(false)
  })

  it('sends after the undo window and brings the draft back on undo', async () => {
    const compose = useComposeStore()
    await compose.openReply(original, 'reply')
    const before = Date.now()

    await compose.send()
    expect(compose.error).toBeNull()

    const post = requests.find((r) => r.method === 'POST' && r.path === '/api/v1/outgoing-messages')
    if (post === undefined) throw new Error('Nothing was posted.')
    expect(post.body).toMatchObject({ mailAccountId: 'work', subject: 'Re: Q4 budget', inReplyToMessageId: 'm1', to: [{ address: 'anna@finance.example', name: 'Anna' }] })
    const sendAt = Date.parse((post.body as { sendAt: string }).sendAt)
    expect(sendAt - before).toBeGreaterThanOrEqual(UNDO_SECONDS * 1000 - 50)
    expect(compose.draft).toBeNull()
    expect(compose.undoable?.outgoingId).toBe('o1')

    await compose.undo()

    expect(requests.some((r) => r.path === '/api/v1/outgoing-messages/o1/cancel')).toBe(true)
    expect(compose.draft).toMatchObject({ subject: 'Re: Q4 budget', outgoingId: null })
  })

  it('announces a failure once and removes the draft once sent', async () => {
    const compose = useComposeStore()
    const mail = useMailStore()
    await compose.openReply(original, 'reply')
    await compose.send()
    const draftId = (await mail.drafts())[0]!.id

    pages.push(page(2, { outgoingMessages: [outgoing('failed', 'The outgoing mail server refused the recipient.')] }))
    await mail.syncNow()
    await compose.followUp()
    await compose.followUp()

    const failures = compose.notices.filter((n) => n.tone === 'error')
    expect(failures).toHaveLength(1)
    expect(failures[0]!.text).toBe('"Re: Q4 budget" was not sent. The outgoing mail server refused the recipient.')
    expect(await mail.draft(draftId)).not.toBeNull()
    expect(await compose.draftFor('o1')).not.toBeNull()

    pages.push(page(3, { outgoingMessages: [outgoing('sent')] }))
    await mail.syncNow()
    await compose.followUp()

    expect(await mail.draft(draftId)).toBeNull()
  })
  it('lets go of the draft on screen when the user signs out, so whoever signs in next does not get it', async () => {
    const compose = useComposeStore()
    compose.openNew([{ address: 'anna@finance.example', name: 'Anna' }])
    compose.update({ subject: 'Private' })
    compose.minimized = true

    const auth = useAuthStore()
    auth.sessionEnd = 'signedOut'
    auth.tokens = null
    await vi.waitFor(() => expect(compose.draft).toBeNull())

    expect(compose.minimized).toBe(false)
  })

  it('keeps what was typed since the last autosave in the copy when the session expires, then lets the draft go', async () => {
    const compose = useComposeStore()
    const mail = useMailStore()
    const auth = useAuthStore()
    compose.openNew([{ address: 'anna@finance.example', name: 'Anna' }])
    const id = compose.draft!.id
    // Typed a moment ago: the autosave waits for typing to stop and has not run yet.
    compose.update({ subject: 'Half written', html: '<p>Typed just before the session ended</p>' })
    expired = true

    // The server refuses the token and there is no refresh token: the session ends as expired.
    await expect(auth.api('/api/v1/me')).rejects.toThrow('Your session has expired.')
    await vi.waitFor(() => expect(compose.draft).toBeNull())
    expect(auth.sessionEnd).toBe('expired')
    await vi.waitFor(() => expect(mail.ready).toBe(false))

    // The same user signs in again: the copy was kept, with the text.
    await mail.start('compose-user')
    expect(await mail.draft(id)).toMatchObject({ subject: 'Half written', html: '<p>Typed just before the session ended</p>', pendingSave: true })
  })

  it('keeps the id of a send whose session ended while it was under way, as the server may have queued the message', async () => {
    const compose = useComposeStore()
    const mail = useMailStore()
    let answer!: (response: Response) => void
    heldSend = new Promise((resolve) => (answer = resolve))
    compose.openNew([{ address: 'anna@finance.example', name: 'Anna' }])
    compose.update({ subject: 'Queued or not' })
    const id = compose.draft!.id
    // Keeps the copy open after the session ended, until the answer was handled.
    let release!: () => void
    mail.beforeKeptCopyCloses(() => new Promise<void>((resolve) => (release = resolve)))

    const sending = compose.send()
    await vi.waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.path === '/api/v1/outgoing-messages')).toBe(true))
    const attempt = (requests.find((r) => r.path === '/api/v1/outgoing-messages')!.body as { outgoingId: string }).outgoingId
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth.tokens', newValue: null }))
    await vi.waitFor(() => expect(release).toBeDefined())
    // The server did queue it; the answer comes after the session ended and is dropped.
    answer(new Response(JSON.stringify(outgoing('scheduled')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    await sending
    release()
    await vi.waitFor(() => expect(mail.ready).toBe(false))

    // Signed in again: the draft still carries the send's id, so Send again cannot queue the message a second time.
    await mail.start('compose-user')
    expect(await mail.draft(id)).toMatchObject({ sendAttemptId: attempt })
  })

  it('keeps what was typed in the copy when the session ended in another tab', async () => {
    const compose = useComposeStore()
    const mail = useMailStore()
    compose.openNew([{ address: 'anna@finance.example', name: 'Anna' }])
    const id = compose.draft!.id
    compose.update({ subject: 'Typed here', html: '<p>Still typing</p>' })

    // The other tab's session expired: its storage event reaches this one.
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth.tokens', newValue: null }))
    await vi.waitFor(() => expect(compose.draft).toBeNull())
    expect(useAuthStore().sessionEnd).toBe('elsewhere')
    await vi.waitFor(() => expect(mail.ready).toBe(false))

    await mail.start('compose-user')
    expect(await mail.draft(id)).toMatchObject({ subject: 'Typed here', html: '<p>Still typing</p>' })
  })

  it('keeps the open draft, in the new copy, when another tab removed the copy under this one', async () => {
    const compose = useComposeStore()
    const mail = useMailStore()
    compose.openNew([{ address: 'anna@finance.example', name: 'Anna' }])
    const id = compose.draft!.id
    const pulls = mail.pulls

    await deleteMailDatabase('compose-user')
    await vi.waitFor(() => expect(mail.pulls).toBeGreaterThan(pulls))
    compose.update({ subject: 'Still here', html: '<p>Typed after the copy was replaced</p>' })
    await compose.saveNow()

    expect(await mail.draft(id)).toMatchObject({ subject: 'Still here', html: '<p>Typed after the copy was replaced</p>' })
    await compose.send()
    expect(compose.error).toBeNull()
    expect(requests.some((r) => r.method === 'POST' && r.path === '/api/v1/outgoing-messages')).toBe(true)
  })
})
