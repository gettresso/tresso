import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { BulkActionState } from '@tresso/core'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import { config } from '@/config'
import { useAuthStore } from '@/stores/auth'
import { failedPollDelay, LOST_TRACK, useBulkStore } from '../bulk'

function state(override: Partial<BulkActionState>): BulkActionState {
  return {
    id: 'b1',
    action: 'archive',
    folderId: null,
    scope: { in: 'smartInbox', smartInboxId: 's1', mailAccountId: null, sender: null, before: null, largerThan: null },
    status: 'running',
    conversations: 0,
    changed: 0,
    unrestorable: 0,
    restored: 0,
    canUndo: false,
    error: null,
    waitingSince: null,
    createdAt: '2026-10-20T10:00:00+00:00',
    finishedAt: null,
    ...override,
  }
}

const me = { id: 'user-1', email: 'kim@company.example', displayName: 'Kim', createdAt: '2026-01-01T00:00:00+00:00' }

/** The server said who is signed in, as App.vue has it load at start. */
function signedInAs(id: string): void {
  useAuthStore().me = { ...me, id }
}

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1]
}

describe('bulk store', () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  let replies: Record<string, BulkActionState[]>
  let refuse: string | null
  /** Polls of the action that fail as if offline, before the server answers again. */
  let failPolls: number

  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    refuse = null
    failPolls = 0
    replies = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        requests.push({ method, path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        if (method === 'GET' && url.pathname.startsWith('/api/v1/bulk-actions/') && failPolls > 0) {
          failPolls -= 1
          throw new TypeError('Failed to fetch')
        }
        if (refuse !== null) {
          return new Response(JSON.stringify({ detail: refuse }), { status: 422 })
        }
        if (url.pathname === '/api/v1/bulk-selection') {
          return new Response(JSON.stringify({ conversations: 12, messages: 14, mailAccountIds: ['work'] }))
        }
        const next = replies[`${method} ${url.pathname}`]?.shift()
        return new Response(JSON.stringify(next), { status: method === 'POST' ? 202 : 200 })
      }),
    )
    vi.spyOn(useMailStore(), 'syncNow').mockResolvedValue()
    signedInAs('user-1')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('counts a scope before acting on it', async () => {
    expect(await useBulkStore().count({ in: 'smartInbox', smartInboxId: 's1', olderThanDays: 30 })).toEqual({ conversations: 12, messages: 14, mailAccountIds: ['work'] })
    expect(requests[0]?.path).toBe('/api/v1/bulk-selection?in=smartInbox&smartInboxId=s1&olderThanDays=30')
  })

  it('follows an action until it is done, then pulls and offers the undo', async () => {
    replies['POST /api/v1/bulk-actions'] = [state({})]
    replies['GET /api/v1/bulk-actions/b1'] = [state({ conversations: 200 }), state({ status: 'done', conversations: 312, changed: 330, canUndo: true })]
    const bulk = useBulkStore()
    const compose = useComposeStore()

    const done = bulk.start({ in: 'smartInbox', smartInboxId: 's1', action: 'archive' })
    await vi.advanceTimersByTimeAsync(0)
    expect(bulk.progress).toBe('Archiving: 0 conversations done')
    await vi.advanceTimersByTimeAsync(500)
    expect(bulk.progress).toBe('Archiving: 200 conversations done')
    await vi.advanceTimersByTimeAsync(1000)

    expect((await done)?.status).toBe('done')
    expect(bulk.running).toBeNull()
    expect(useMailStore().syncNow).toHaveBeenCalledOnce()
    expect(requests[0]).toEqual({ method: 'POST', path: '/api/v1/bulk-actions', body: { in: 'smartInbox', smartInboxId: 's1', action: 'archive' } })
    const notice = last(compose.notices)
    expect(notice?.text).toBe('Archived: 312 conversations.')
    expect(notice?.action?.label).toBe('Undo')

    replies['POST /api/v1/bulk-actions/b1/undo'] = [state({ status: 'undoing' })]
    replies['GET /api/v1/bulk-actions/b1'] = [state({ status: 'undone', restored: 330 })]
    notice?.action?.run()
    await vi.advanceTimersByTimeAsync(600)
    expect(requests.map((request) => `${request.method} ${request.path}`).slice(-2)).toEqual(['POST /api/v1/bulk-actions/b1/undo', 'GET /api/v1/bulk-actions/b1'])
    expect(last(compose.notices)?.text).toBe('Put back 330 messages.')
  })

  it('stops an action under way and still offers the undo', async () => {
    replies['POST /api/v1/bulk-actions'] = [state({})]
    replies['POST /api/v1/bulk-actions/b1/cancel'] = [state({ status: 'failed', conversations: 200, changed: 210, canUndo: true, error: 'You stopped it. What was done stays done, and can be undone.' })]
    replies['GET /api/v1/bulk-actions/b1'] = [state({ status: 'failed', conversations: 200, changed: 210, canUndo: true, error: 'You stopped it. What was done stays done, and can be undone.' })]
    const bulk = useBulkStore()

    const done = bulk.start({ in: 'inbox', action: 'archive' })
    await vi.advanceTimersByTimeAsync(0)
    await bulk.cancel()
    await vi.advanceTimersByTimeAsync(500)

    expect((await done)?.status).toBe('failed')
    expect(requests.map((request) => `${request.method} ${request.path}`)).toContain('POST /api/v1/bulk-actions/b1/cancel')
    const notice = last(useComposeStore().notices)
    expect(notice?.text).toBe('Stopped after 200 conversations: You stopped it. What was done stays done, and can be undone.')
    expect(notice?.action?.label).toBe('Undo')
  })

  it('is not busy again when the answer to a stop comes after the action ended', async () => {
    replies['POST /api/v1/bulk-actions'] = [state({})]
    replies['GET /api/v1/bulk-actions/b1'] = [state({ status: 'done', conversations: 3, changed: 3, canUndo: true })]
    let answer: (response: Response) => void = () => undefined
    const fetch = vi.mocked(globalThis.fetch)
    const respond = fetch.getMockImplementation()!
    fetch.mockImplementation(async (input, init) =>
      String(input).endsWith('/cancel') ? new Promise<Response>((resolve) => (answer = resolve)) : respond(input, init),
    )
    const bulk = useBulkStore()

    const done = bulk.start({ in: 'inbox', action: 'archive' })
    await vi.advanceTimersByTimeAsync(0)
    const stopping = bulk.cancel()
    await vi.advanceTimersByTimeAsync(500)
    await done
    expect(bulk.busy).toBe(false)

    answer(new Response(JSON.stringify(state({ status: 'failed', conversations: 3, error: 'You stopped it.' }))))
    await stopping

    expect(bulk.running).toBeNull()
    expect(bulk.busy).toBe(false)
  })

  it('offers no undo when nothing could be put back', async () => {
    replies['POST /api/v1/bulk-actions'] = [state({ status: 'done', conversations: 2, changed: 2, unrestorable: 2, canUndo: true })]

    await useBulkStore().start({ in: 'inbox', action: 'trash' })

    expect(last(useComposeStore().notices)?.action).toBeUndefined()
  })

  it('starts once however quickly it is asked twice', async () => {
    replies['POST /api/v1/bulk-actions'] = [state({ status: 'done' })]
    const bulk = useBulkStore()

    const first = bulk.start({ in: 'inbox', action: 'archive' })
    expect(bulk.busy).toBe(true)
    expect(await bulk.start({ in: 'inbox', action: 'archive' })).toBeNull()
    await first

    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    expect(bulk.busy).toBe(false)
  })

  it('runs one at a time', async () => {
    replies['POST /api/v1/bulk-actions'] = [state({})]
    replies['GET /api/v1/bulk-actions/b1'] = [state({ status: 'done' })]
    const bulk = useBulkStore()

    const first = bulk.start({ in: 'inbox', action: 'markRead' })
    await vi.advanceTimersByTimeAsync(0)
    expect(await bulk.start({ in: 'inbox', action: 'archive' })).toBeNull()
    expect(last(useComposeStore().notices)?.text).toBe('Another bulk action is still under way. Try again once it is done.')
    await vi.advanceTimersByTimeAsync(500)
    await first
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  })

  it('says why the server refused it', async () => {
    refuse = 'action: kim@home.example has no Archive folder.'

    expect(await useBulkStore().start({ in: 'inbox', action: 'archive' })).toBeNull()

    expect(last(useComposeStore().notices)).toMatchObject({ text: 'action: kim@home.example has no Archive folder.', tone: 'error' })
    expect(useMailStore().syncNow).not.toHaveBeenCalled()
  })
  it('keeps following an action when a poll fails, and still offers the undo', async () => {
    replies['POST /api/v1/bulk-actions'] = [state({})]
    replies['GET /api/v1/bulk-actions/b1'] = [state({ conversations: 200 }), state({ status: 'done', conversations: 312, changed: 330, canUndo: true })]
    const bulk = useBulkStore()
    const compose = useComposeStore()

    const done = bulk.start({ in: 'smartInbox', smartInboxId: 's1', action: 'archive' })
    await vi.advanceTimersByTimeAsync(500)
    failPolls = 1
    await vi.advanceTimersByTimeAsync(1000)
    expect(bulk.busy).toBe(true)
    expect(bulk.progress).toBe('Archiving: 200 conversations done')
    await vi.advanceTimersByTimeAsync(2000)

    expect((await done)?.status).toBe('done')
    expect(useMailStore().syncNow).toHaveBeenCalledOnce()
    expect(compose.notices.some((notice) => notice.tone === 'error')).toBe(false)
    expect(last(compose.notices)).toMatchObject({ text: 'Archived: 312 conversations.', action: { label: 'Undo' } })
    expect(sessionStorage.getItem('tresso.bulkAction')).toBeNull()
  })

  it('stops following after many failed polls in a row, says so, and still pulls', async () => {
    replies['POST /api/v1/bulk-actions'] = [state({})]
    failPolls = 10
    const bulk = useBulkStore()
    const notify = vi.spyOn(useComposeStore(), 'notify')

    const done = bulk.start({ in: 'inbox', action: 'archive' })
    await vi.advanceTimersByTimeAsync(10 * 30_000)

    expect(await done).toBeNull()
    expect(bulk.busy).toBe(false)
    expect(useMailStore().syncNow).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledExactlyOnceWith({ text: LOST_TRACK, tone: 'error' })
  })

  it('follows an action again after a reload of the tab, to its result and its undo', async () => {
    replies['POST /api/v1/bulk-actions'] = [state({})]
    replies['GET /api/v1/bulk-actions/b1'] = [state({ conversations: 200 })]
    const done = useBulkStore().start({ in: 'smartInbox', smartInboxId: 's1', action: 'move', folderId: 'f1' }, 'Receipts')
    await vi.advanceTimersByTimeAsync(500)
    expect(JSON.parse(sessionStorage.getItem('tresso.bulkAction')!)).toEqual({ id: 'b1', undo: false, folderName: 'Receipts', server: config.apiUrl, userId: 'user-1' })
    void done

    // The page loads again: new stores, the action still kept in the tab.
    setActivePinia(createPinia())
    vi.spyOn(useMailStore(), 'syncNow').mockResolvedValue()
    replies['GET /api/v1/bulk-actions/b1'] = [state({ action: 'move', folderId: 'f1', status: 'done', conversations: 312, changed: 330, canUndo: true })]
    const bulk = useBulkStore()
    // Nothing is asked before the server said who is signed in.
    await vi.advanceTimersByTimeAsync(0)
    expect(bulk.busy).toBe(false)
    signedInAs('user-1')
    await vi.advanceTimersByTimeAsync(0)

    expect(bulk.busy).toBe(false)
    expect(useMailStore().syncNow).toHaveBeenCalledOnce()
    expect(last(useComposeStore().notices)).toMatchObject({ action: { label: 'Undo' } })
    expect(last(useComposeStore().notices)?.text).toContain('312')
    expect(sessionStorage.getItem('tresso.bulkAction')).toBeNull()
  })
  /** An action kept in the tab, as a page that is reloaded finds it. */
  function keptInTab(kept: Record<string, unknown>): void {
    sessionStorage.setItem('tresso.bulkAction', JSON.stringify({ id: 'b1', undo: false, folderName: null, server: config.apiUrl, userId: 'user-1', ...kept }))
    setActivePinia(createPinia())
    vi.spyOn(useMailStore(), 'syncNow').mockResolvedValue()
  }

  it('does not follow an action kept for another user or another server', async () => {
    for (const other of [{ userId: 'user-2' }, { server: 'https://elsewhere.example' }]) {
      keptInTab(other)
      useBulkStore()
      signedInAs('user-1')
      await vi.advanceTimersByTimeAsync(0)

      expect(requests).toEqual([])
      expect(sessionStorage.getItem('tresso.bulkAction')).toBeNull()
    }
  })

  it('drops a kept entry it cannot read', async () => {
    sessionStorage.setItem('tresso.bulkAction', '{not json')
    setActivePinia(createPinia())
    useBulkStore()
    signedInAs('user-1')
    await vi.advanceTimersByTimeAsync(0)

    expect(requests).toEqual([])
    expect(sessionStorage.getItem('tresso.bulkAction')).toBeNull()
  })

  it('lets go of a kept action the server no longer knows, without a word', async () => {
    keptInTab({})
    const notify = vi.spyOn(useComposeStore(), 'notify')
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ detail: 'Not found.' }), { status: 404 }))
    const bulk = useBulkStore()
    signedInAs('user-1')
    await vi.advanceTimersByTimeAsync(0)

    expect(bulk.busy).toBe(false)
    expect(notify).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('tresso.bulkAction')).toBeNull()
  })

  it('stops following at a sign-out, at once and without a word', async () => {
    replies['POST /api/v1/bulk-actions'] = [state({})]
    const bulk = useBulkStore()
    const notify = vi.spyOn(useComposeStore(), 'notify')

    const done = bulk.start({ in: 'inbox', action: 'archive' })
    await vi.advanceTimersByTimeAsync(0)
    expect(bulk.busy).toBe(true)
    useAuthStore().tokens = null
    await vi.advanceTimersByTimeAsync(0)

    expect(await done).toBeNull()
    expect(bulk.busy).toBe(false)
    expect(bulk.progress).toBeNull()
    expect(notify).not.toHaveBeenCalled()
    expect(useMailStore().syncNow).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('tresso.bulkAction')).toBeNull()
    expect(requests.filter((request) => request.method === 'GET')).toEqual([])
  })

  it('waits a second after the first failed poll, doubling up to half a minute', () => {
    expect([1, 2, 3, 5, 6, 10].map(failedPollDelay)).toEqual([1000, 2000, 4000, 16_000, 30_000, 30_000])
  })
  it('ends the wait between polls when the store goes', async () => {
    replies['POST /api/v1/bulk-actions'] = [state({})]
    const bulk = useBulkStore()
    const notify = vi.spyOn(useComposeStore(), 'notify')
    const done = bulk.start({ in: 'inbox', action: 'archive' })
    await vi.advanceTimersByTimeAsync(0)

    bulk.$dispose()

    expect(await done).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(notify).not.toHaveBeenCalled()
  })
  it("leaves the next session's start alone when a request of the session before answers late", async () => {
    let answerOld!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => (answerOld = resolve)))
    const bulk = useBulkStore()
    const notify = vi.spyOn(useComposeStore(), 'notify')
    const old = bulk.start({ in: 'inbox', action: 'archive' })
    await vi.advanceTimersByTimeAsync(0)

    // Signed out and in again (the desktop app does not reload), and the next user starts one of their own.
    const auth = useAuthStore()
    const tokens = auth.tokens
    auth.tokens = null
    await vi.advanceTimersByTimeAsync(0)
    auth.tokens = tokens
    let answerNew!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => (answerNew = resolve)))
    const next = bulk.start({ in: 'inbox', action: 'markRead' })
    await vi.advanceTimersByTimeAsync(0)

    answerOld(new Response(JSON.stringify({ detail: 'Gone.' }), { status: 503 }))
    expect(await old).toBeNull()
    expect(bulk.busy).toBe(true)
    expect(bulk.progress).toBe('Starting…')
    expect(notify).not.toHaveBeenCalled()

    answerNew(new Response(JSON.stringify(state({ status: 'done', changed: 3 })), { status: 202 }))
    await next
    expect(bulk.busy).toBe(false)
  })
})
