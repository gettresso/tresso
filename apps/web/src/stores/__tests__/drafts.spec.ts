import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChangePage, SyncedDraft } from '@tresso/core'
import { deleteMailDatabase, type Draft } from '@/mail/db'
import { useComposeStore } from '../compose'
import { useMailStore } from '../mail'

/** The realtime connection of the last start, so a test can say when it connects (again). */
const realtime = vi.hoisted(() => ({ connected: null as (() => void) | null }))

vi.mock('@tresso/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@tresso/core')>()
  class RealtimeClient {
    constructor(options: { onConnected: () => void }) {
      realtime.connected = options.onConnected
    }
    start(): void {}
    async stop(): Promise<void> {}
  }
  return { ...core, RealtimeClient }
})

function page(cursor: number, extra: Partial<ChangePage> = {}): ChangePage {
  return { cursor, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [], ...extra }
}

const account = { id: 'work', emailAddress: 'kim@company.example', displayName: 'Kim', provider: 'imap', status: 'active' as const, statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null }

describe('drafts across devices', () => {
  /** The server's drafts, by id. */
  let server: Map<string, SyncedDraft>
  let pages: ChangePage[]
  /** No request reaches the server. */
  let offline: boolean
  const requests: { method: string; path: string; body: Record<string, unknown> | undefined }[] = []

  beforeEach(async () => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    server = new Map()
    offline = false
    requests.length = 0
    pages = [page(1, { mailAccounts: [account] })]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (offline) {
          throw new TypeError('Failed to fetch')
        }
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
        requests.push({ method, path: url.pathname, body })
        const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
        if (url.pathname === '/api/v1/sync/changes') {
          const since = Number(url.searchParams.get('since'))
          return json(pages.find((p) => p.cursor > since) ?? page(since))
        }
        const match = /^\/api\/v1\/drafts(?:\/(.+))?$/.exec(url.pathname)
        if (match) {
          const id = match[1] ?? String(body?.draftId)
          const stored = server.get(id)
          if (method === 'GET') return stored ? json(stored) : json({ detail: 'Draft not found.' }, 404)
          if (method === 'DELETE') {
            server.delete(id)
            return new Response(null, { status: 204 })
          }
          if (method === 'PUT' && !stored) return json({ detail: 'Draft not found.' }, 404)
          if (method === 'PUT' && stored && body?.expectedVersion !== stored.version) return json({ detail: 'The draft changed on another device.' }, 409)
          const saved = { ...(body as unknown as SyncedDraft), id, version: (stored?.version ?? 0) + 1, updatedAt: new Date().toISOString() }
          server.set(id, saved)
          return json(saved, method === 'POST' ? 201 : 200)
        }
        if (url.pathname === '/api/v1/outgoing-messages') {
          if (body?.draftId) server.delete(String(body.draftId))
          return json({ id: 'o1', mailAccountId: 'work', status: 'scheduled', subject: body?.subject, recipients: { to: [], cc: [], bcc: [] }, sendAt: new Date().toISOString(), sentAt: null, lastError: null, inReplyToMessageId: null }, 201)
        }
        return json({ detail: 'unavailable' }, 503)
      }),
    )
    await useMailStore().start('drafts-user')
  })

  afterEach(async () => {
    await useMailStore().stop()
    await deleteMailDatabase('drafts-user')
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  async function local(id: string): Promise<Draft | null> {
    return useMailStore().draft(id)
  }

  it('creates the draft on the server, then updates it on the version it builds on', async () => {
    const compose = useComposeStore()
    compose.openNew()
    const id = compose.draft!.id

    compose.update({ subject: 'First' })
    await compose.close()
    await vi.waitFor(async () => expect((await local(id))?.version).toBe(1))
    expect(requests.find((r) => r.method === 'POST')?.body).toMatchObject({ draftId: id, subject: 'First' })

    await compose.openDraft(id)
    compose.update({ subject: 'Second' })
    compose.close()
    await vi.waitFor(async () => expect((await local(id))?.version).toBe(2))
    expect(requests.find((r) => r.method === 'PUT')?.body).toMatchObject({ expectedVersion: 1, subject: 'Second' })
    expect((await local(id))?.pendingSave).toBe(false)
  })

  it("never overwrites edits made here with another device's version, and lets the user choose", async () => {
    const compose = useComposeStore()
    const mail = useMailStore()
    compose.openNew()
    const id = compose.draft!.id
    compose.update({ subject: 'Mine' })
    compose.close()
    await vi.waitFor(async () => expect((await local(id))?.version).toBe(1))

    // Another device saves version 2.
    const theirs = { ...server.get(id)!, subject: 'Theirs', version: 2 }
    server.set(id, theirs)
    await compose.openDraft(id)
    compose.update({ subject: 'Mine again' })
    compose.close()
    await vi.waitFor(async () => expect((await local(id))?.remoteVersion).toBe(2))
    expect((await local(id))?.subject).toBe('Mine again')

    // The delta brings their version: still not applied over the unsaved edits.
    pages.push(page(2, { drafts: [theirs] }))
    await mail.syncNow()
    expect((await local(id))?.subject).toBe('Mine again')

    await compose.openDraft(id)
    await compose.resolveConflict('mine')
    expect(server.get(id)?.subject).toBe('Mine again')
    expect(server.get(id)?.version).toBe(3)
  })

  it('takes the other version when asked', async () => {
    const compose = useComposeStore()
    compose.openNew()
    const id = compose.draft!.id
    compose.update({ subject: 'Mine' })
    compose.close()
    await vi.waitFor(async () => expect((await local(id))?.version).toBe(1))
    server.set(id, { ...server.get(id)!, subject: 'Theirs', version: 2 })
    await compose.openDraft(id)
    compose.update({ subject: 'Mine again' })
    compose.close()
    await vi.waitFor(async () => expect((await local(id))?.remoteVersion).toBe(2))

    await compose.openDraft(id)
    await compose.resolveConflict('theirs')

    expect(compose.draft?.subject).toBe('Theirs')
    expect(await local(id)).toMatchObject({ subject: 'Theirs', version: 2, pendingSave: false, remoteVersion: null })
  })

  it('a draft deleted on another device becomes a new draft when edited here', async () => {
    const compose = useComposeStore()
    compose.openNew()
    const id = compose.draft!.id
    compose.update({ subject: 'Keep going' })
    compose.close()
    await vi.waitFor(async () => expect((await local(id))?.version).toBe(1))
    server.delete(id)

    await compose.openDraft(id)
    compose.update({ subject: 'Still writing' })
    compose.close()

    await vi.waitFor(() => expect(server.get(id)?.subject).toBe('Still writing'))
    expect(requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/drafts')).toHaveLength(2)
  })

  it('sends with the draft, which the server takes away', async () => {
    const compose = useComposeStore()
    compose.openNew([{ address: 'anna@finance.example', name: 'Anna' }])
    const id = compose.draft!.id
    compose.update({ subject: 'Go' })

    await compose.send()

    expect(requests.find((r) => r.path === '/api/v1/outgoing-messages')?.body).toMatchObject({ draftId: id })
    expect(server.has(id)).toBe(false)
    expect((await local(id))?.outgoingId).toBe('o1')
  })
  it('uploads a draft whose upload failed once the connection is back', async () => {
    const compose = useComposeStore()
    compose.openNew()
    const id = compose.draft!.id
    offline = true

    compose.update({ subject: 'Written offline' })
    await compose.close()
    await vi.waitFor(async () => expect((await local(id))?.subject).toBe('Written offline'))
    expect((await local(id))?.pendingSave).toBe(true)

    offline = false
    realtime.connected!()

    await vi.waitFor(async () => expect(await local(id)).toMatchObject({ pendingSave: false, version: 1 }))
    expect(server.get(id)).toMatchObject({ subject: 'Written offline' })
  })

  it('uploads a draft whose upload failed after the first pull that works again', async () => {
    const compose = useComposeStore()
    const mail = useMailStore()
    compose.openNew()
    const id = compose.draft!.id
    offline = true

    compose.update({ subject: 'Written offline' })
    await compose.close()
    await vi.waitFor(async () => expect((await local(id))?.subject).toBe('Written offline'))
    await mail.syncNow()
    expect(mail.syncState).toBe('error')

    offline = false
    await mail.syncNow()

    await vi.waitFor(async () => expect(await local(id)).toMatchObject({ pendingSave: false, version: 1 }))
  })
})
