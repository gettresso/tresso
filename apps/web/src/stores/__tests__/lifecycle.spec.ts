import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { SqliteMailStore, type ChangePage, type MailStore } from '@tresso/core'
import { memorySql } from '@tresso/core/testing/sql'

/** Lets a test hold an open or a close until it says so. */
function gate() {
  let open!: () => void
  const passed = new Promise<void>((resolve) => {
    open = resolve
  })
  return { passed, open }
}

const copies = vi.hoisted(() => ({
  opening: [] as string[],
  opened: [] as string[],
  closed: [] as string[],
  deleted: [] as string[],
  holdOpen: new Map<string, Promise<void>>(),
  holdClose: new Map<string, Promise<void>>(),
  /** The name each user's copy has now; the server chosen on the sign-in screen changes it. */
  names: new Map<string, string>(),
  deletedNames: [] as string[],
}))

vi.mock('@/mail/store', () => ({
  openMailStore: async (userId: string): Promise<MailStore> => {
    copies.opening.push(userId)
    await copies.holdOpen.get(userId)
    const store = await SqliteMailStore.open(await memorySql())
    copies.opened.push(userId)
    const close = store.close.bind(store)
    store.close = async () => {
      await copies.holdClose.get(userId)
      await close()
      copies.closed.push(userId)
    }
    return store
  },
  mailCopyName: (userId: string) => copies.names.get(userId) ?? `copy-${userId}`,
  // As the desktop shell does: a copy that is still open cannot be removed.
  deleteMailStore: async (userId: string, name: string) => {
    copies.deletedNames.push(name)
    const open = copies.opening.filter((id) => id === userId).length - copies.closed.filter((id) => id === userId).length
    if (open > 0) {
      throw new Error('The mail copy is still open.')
    }
    copies.deleted.push(userId)
  },
}))

const { useMailStore } = await import('../mail')

function page(since: number): ChangePage {
  return { cursor: since, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [] }
}

describe('the mail copy across sign-out and sign-in', () => {
  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    copies.opening = []
    copies.opened = []
    copies.closed = []
    copies.deleted = []
    copies.holdOpen.clear()
    copies.holdClose.clear()
    copies.names.clear()
    copies.deletedNames = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname === '/api/v1/sync/changes') {
          return new Response(JSON.stringify(page(Number(url.searchParams.get('since')))))
        }
        return new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503 })
      }),
    )
  })

  afterEach(async () => {
    await useMailStore().stop()
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('keeps the next user signed in when the previous copy finishes closing late, and removes their copy on their sign-out', async () => {
    const mail = useMailStore()
    await mail.start('anna')
    const closing = gate()
    copies.holdClose.set('anna', closing.passed)

    const forgetting = mail.forget()
    await mail.start('ben')
    closing.open()
    await forgetting

    expect(copies.deleted).toEqual(['anna'])
    expect(mail.ready).toBe(true)
    await mail.forget()
    expect(copies.deleted).toEqual(['anna', 'ben'])
  })

  it('removes the copy of the server signed out from, though another server is chosen while it closes', async () => {
    const mail = useMailStore()
    copies.names.set('anna', 'copy-anna-cloud')
    await mail.start('anna')
    const closing = gate()
    copies.holdClose.set('anna', closing.passed)

    const forgetting = mail.forget()
    copies.names.set('anna', 'copy-anna-staging')
    closing.open()
    await forgetting

    expect(copies.deletedNames).toEqual(['copy-anna-cloud'])
  })

  it('removes a copy that was still opening when the user was signed out', async () => {
    const mail = useMailStore()
    const opening = gate()
    copies.holdOpen.set('anna', opening.passed)

    const starting = mail.start('anna')
    await vi.waitFor(() => expect(copies.opening).toEqual(['anna']))
    const forgetting = mail.forget()
    opening.open()
    await starting
    await forgetting

    expect(copies.closed).toEqual(['anna'])
    expect(copies.deleted).toEqual(['anna'])
    expect(mail.ready).toBe(false)
  })

  it('does not report the failure of an open that was overtaken', async () => {
    const mail = useMailStore()
    const opening = gate()
    copies.holdOpen.set('anna', opening.passed.then(() => Promise.reject(new Error('disk full'))))

    const starting = mail.start('anna')
    await vi.waitFor(() => expect(copies.opening).toEqual(['anna']))
    await mail.start('ben')
    opening.open()

    await expect(starting).resolves.toBeUndefined()
    expect(mail.ready).toBe(true)
  })

  it('opens nothing for a sign-in overtaken by a sign-out while the previous copy was still closing', async () => {
    const mail = useMailStore()
    await mail.start('anna')
    const closing = gate()
    copies.holdClose.set('anna', closing.passed)

    const starting = mail.start('ben')
    const forgetting = mail.forget()
    closing.open()
    await starting
    await forgetting

    expect(copies.opened).toEqual(['anna'])
    expect(mail.ready).toBe(false)
  })

  it('closes a copy whose opening was overtaken by another sign-in', async () => {
    const mail = useMailStore()
    const opening = gate()
    copies.holdOpen.set('anna', opening.passed)

    const first = mail.start('anna')
    await vi.waitFor(() => expect(copies.opening).toEqual(['anna']))
    await mail.start('ben')
    opening.open()
    await first

    expect(copies.opened.sort()).toEqual(['anna', 'ben'])
    expect(copies.closed).toEqual(['anna'])
    expect(mail.ready).toBe(true)
    await mail.forget()
    expect(copies.deleted).toEqual(['ben'])
  })
})
