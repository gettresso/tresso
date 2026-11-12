import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChangePage } from '@tresso/core'
import { deleteMailDatabase } from '@/mail/db'
import { useMailStore } from '../mail'

const USER = 'status-user'
const HUB = 'https://hub.example/.well-known/mercure'

function page(cursor: number, hasMore: boolean, latest?: number): ChangePage {
  const changes: ChangePage = { cursor, hasMore, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], unsubscriptions: [], deleted: [] }
  return latest === undefined ? changes : { ...changes, latest }
}

/** Lets a test hold a response until it says so. */
function gate() {
  let open!: () => void
  const passed = new Promise<void>((resolve) => {
    open = resolve
  })
  return { passed, open }
}

/** The hub's event stream, which the test writes to. */
function hubStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) })
  return { response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }), send: (text: string) => controller.enqueue(new TextEncoder().encode(text)) }
}

interface Server {
  /** The `since` of every delta request, in order. */
  pulls: number[]
  /** What happened, in order: 'changes <since>' for each delta request, 'token' and 'hub' for the stream. */
  log: string[]
  /** Answers for the delta, by `since`; the last one repeats. */
  pages: Map<number, ChangePage>
  hold: Map<number, Promise<void>>
  hub: ReturnType<typeof hubStream> | null
  hubAnswers: boolean
  /** The delta answers 502 while set. */
  failChanges: boolean
  /** The signal of the last hub request, which a stop aborts. */
  hubSignal: AbortSignal | null
}

function serve(server: Server) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v1/sync/changes') {
        const since = Number(url.searchParams.get('since'))
        server.pulls.push(since)
        server.log.push(`changes ${since}`)
        await server.hold.get(since)
        if (server.failChanges) {
          return new Response(JSON.stringify({ detail: 'Bad gateway' }), { status: 502 })
        }
        return new Response(JSON.stringify(server.pages.get(since) ?? page(since, false)))
      }
      if (url.pathname === '/api/v1/realtime/token') {
        server.log.push('token')
        return new Response(JSON.stringify({ hubUrl: HUB, topic: 'urn:tresso:user:status-user:changes', token: 'sub', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }))
      }
      if (url.href.startsWith(HUB)) {
        server.log.push('hub')
        server.hubSignal = init?.signal ?? null
        if (!server.hubAnswers) {
          return new Response(null, { status: 502 })
        }
        server.hub = hubStream()
        return server.hub.response
      }
      return new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503 })
    }),
  )
}

describe('the sync status of the mail store', () => {
  let server: Server

  beforeEach(async () => {
    await deleteMailDatabase(USER)
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    server = { pulls: [], log: [], pages: new Map(), hold: new Map(), hub: null, hubAnswers: true, failChanges: false, hubSignal: null }
    serve(server)
  })

  afterEach(async () => {
    await useMailStore().stop()
    await deleteMailDatabase(USER)
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('opens the realtime stream with the first pull, not after it, and says how far the first sync got', async () => {
    const first = gate()
    const second = gate()
    server.hold.set(0, first.passed)
    server.hold.set(500, second.passed)
    server.pages.set(0, page(500, true, 1000))
    server.pages.set(500, page(1000, false, 1000))
    const mail = useMailStore()

    const starting = mail.start(USER)
    await vi.waitFor(() => expect(server.log).toContain('hub'))

    // The stream is being made while the first page is still on its way.
    expect(server.log.slice(0, 3).sort()).toEqual(['changes 0', 'hub', 'token'])
    expect(mail.syncStatus).toMatchObject({ kind: 'firstSync', text: 'Getting your mail…' })

    first.open()
    await vi.waitFor(() => expect(mail.syncStatus.text).toBe('Getting your mail, 50%'))
    expect(mail.syncStatus.fraction).toBe(0.5)
    expect(mail.syncStatus.notice).toContain('still arriving')

    second.open()
    await starting
    await vi.waitFor(() => expect(mail.syncStatus).toMatchObject({ kind: 'live', text: 'Up to date', notice: null }))
    expect(mail.live).toBe(true)
  })

  it('loses no notification that comes during the first pull, and stores no page twice', async () => {
    const first = gate()
    server.hold.set(0, first.passed)
    server.pages.set(0, page(500, false, 500))
    server.pages.set(500, page(700, false, 700))
    const mail = useMailStore()

    const starting = mail.start(USER)
    await vi.waitFor(() => expect(server.hub).not.toBeNull())
    // The hub says the user's changes reached 700 while the first pull still waits for its page.
    server.hub!.send('event: changes\ndata: {"cursor":700}\n\n')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(server.pulls).toEqual([0])

    first.open()
    await starting
    await vi.waitFor(() => expect(server.pulls).toContain(500))

    // One pull at a time, each from where the one before ended: nothing skipped, nothing fetched twice over.
    expect(server.pulls.filter((since) => since === 0)).toEqual([0])
    expect([...server.pulls]).toEqual([...server.pulls].sort((a, b) => a - b))
    expect(await mail.currentStore()!.cursor()).toBe(700)
  })

  it('counts the items of a server that does not say how far it is', async () => {
    const first = gate()
    server.hold.set(500, first.passed)
    server.pages.set(0, { ...page(500, true), threads: [{ id: 't1', mailAccountId: 'a', subject: 'Hi', messageCount: 1, lastMessageAt: '2026-11-12T08:00:00+00:00', smartInboxId: null, verdict: null, classificationReason: null }] })
    const mail = useMailStore()

    const starting = mail.start(USER)
    await vi.waitFor(() => expect(mail.syncStatus.text).toBe('Syncing… 1 item so far'))
    expect(mail.syncStatus.fraction).toBeNull()

    first.open()
    await starting
  })

  it('keeps saying connecting while a stream that was never live retries, and offline when the browser is', async () => {
    server.hubAnswers = false
    const mail = useMailStore()

    await mail.start(USER)
    await vi.waitFor(() => expect(server.log.filter((entry) => entry === 'hub').length).toBeGreaterThan(1), { timeout: 5_000 })
    expect(mail.syncStatus).toMatchObject({ kind: 'connecting', text: 'Connecting…' })

    window.dispatchEvent(new Event('offline'))
    expect(mail.syncStatus.text).toMatch(/^Offline\. Last synced /)
    window.dispatchEvent(new Event('online'))
    expect(mail.syncStatus.kind).not.toBe('offline')
  })

  it('shows the mail kept on this device before the sign-in is confirmed, and says the same as the banner when a pull fails', async () => {
    const mail = useMailStore()
    await mail.start(USER, { confirmed: false })
    expect(mail.syncStatus).toMatchObject({ kind: 'readOnly', text: 'Showing mail kept on this device' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: 'Bad gateway' }), { status: 502 })),
    )
    await mail.start(USER, { confirmed: true })

    expect(mail.syncState).toBe('error')
    expect(mail.syncStatus).toMatchObject({ kind: 'error', text: 'Sync stopped' })
  })

  it('counts a notification at the stored cursor as no pull, but pulls on one after a failure until a pull works', async () => {
    const mail = useMailStore()
    await mail.start(USER)
    await vi.waitFor(() => expect(mail.syncStatus.kind).toBe('live'))
    const synced = mail.syncStatus.text
    const pullsBefore = mail.pulls
    const requests = server.pulls.length

    // Nothing beyond the copy: no request, no pull counted, the copy not noted as synced again.
    server.hub!.send('event: changes\ndata: {"cursor":0}\n\n')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(server.pulls.length).toBe(requests)
    expect(mail.pulls).toBe(pullsBefore)
    expect(mail.syncStatus.text).toBe(synced)

    server.failChanges = true
    await mail.syncNow()
    expect(mail.syncStatus.problem).toBe('Sync stopped: Bad gateway')

    // The same notification now pulls: the copy is not known to be current. Failing again, the failure stays.
    const failed = server.pulls.length
    server.hub!.send('event: changes\ndata: {"cursor":0}\n\n')
    await vi.waitFor(() => expect(server.pulls.length).toBe(failed + 1))
    expect(mail.syncStatus.problem).toBe('Sync stopped: Bad gateway')

    server.failChanges = false
    server.hub!.send('event: changes\ndata: {"cursor":0}\n\n')
    await vi.waitFor(() => expect(mail.syncStatus.problem).toBeNull())
    expect(mail.syncStatus.kind).toBe('live')
  })

  it('stops the stream, applies no page and leaves no copy when the user signs out during the first pull', async () => {
    const first = gate()
    server.hold.set(0, first.passed)
    server.pages.set(0, page(500, false, 500))
    const mail = useMailStore()
    const starting = mail.start(USER)
    await vi.waitFor(() => expect(server.hub).not.toBeNull())
    await vi.waitFor(() => expect(mail.live).toBe(true))

    await mail.forget()

    expect(server.hubSignal?.aborted).toBe(true)
    expect(mail.syncStatus).toMatchObject({ kind: 'closed', text: '', problem: null })
    first.open()
    await starting
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(server.pulls).toEqual([0])
    expect(mail.currentStore()).toBeNull()
    expect(mail.syncStatus).toMatchObject({ kind: 'closed', problem: null })
    expect((await indexedDB.databases()).map((database) => database.name)).not.toContain(`tresso-mail-${USER}`)
  })

  it('says nothing once the copy is closed', async () => {
    const mail = useMailStore()
    await mail.start(USER)

    await mail.stop()

    expect(mail.syncStatus).toMatchObject({ kind: 'closed', text: '' })
  })
})
