import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { SqliteMailStore, type ChangePage, type MailStore } from '@tresso/core'
import { draft } from '@tresso/core/testing'
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
  /** What each opened copy calls when another tab or the browser closes it. */
  closedElsewhere: new Map<string, (reason: 'deleted' | 'upgraded' | 'terminated') => void>(),
  /** Changes the store a test opens, e.g. to make a read fail. */
  afterOpen: null as ((store: MailStore) => void) | null,
}))

vi.mock('@/mail/store', () => ({
  openMailStore: async (userId: string, onClosedElsewhere?: (reason: 'deleted' | 'upgraded' | 'terminated') => void): Promise<MailStore> => {
    copies.opening.push(userId)
    if (onClosedElsewhere) {
      copies.closedElsewhere.set(userId, onClosedElsewhere)
    }
    try {
      await copies.holdOpen.get(userId)
    } catch (error) {
      // An open that failed holds nothing open.
      copies.opening.splice(copies.opening.lastIndexOf(userId), 1)
      throw error
    }
    const store = await SqliteMailStore.open(await memorySql())
    copies.opened.push(userId)
    copies.afterOpen?.(store)
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

const { STILL_CHECKING, useMailStore } = await import('../mail')

// The browser's local storage, kept in memory.
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

function page(since: number): ChangePage {
  return { cursor: since, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [] }
}

describe('the mail copy across sign-out and sign-in', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
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
    copies.closedElsewhere.clear()
    copies.afterOpen = null
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

  it('keeps the copy, with drafts that never reached the server, when the session expires', async () => {
    const { useAuthStore } = await import('../auth')
    const auth = useAuthStore()
    const mail = useMailStore()
    await mail.start('anna')
    // The server no longer accepts the token, and there is no refresh token to renew it with.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ title: 'Unauthorized' }, { status: 401 })))

    await expect(auth.api('/api/v1/me')).rejects.toThrow('Your session has expired.')

    await vi.waitFor(() => expect(copies.closed).toEqual(['anna']))
    expect(auth.isAuthenticated).toBe(false)
    expect(copies.deleted).toEqual([])
    expect(JSON.parse(localStorage.getItem('tresso.mail.copies')!)).toEqual([{ userId: 'anna', name: 'copy-anna' }])
  })

  it('removes the copy when the user signs out', async () => {
    vi.stubGlobal('location', { ...window.location, assign: vi.fn<(url: string) => void>() })
    const { useAuthStore } = await import('../auth')
    const auth = useAuthStore()
    const mail = useMailStore()
    await mail.start('anna')

    await auth.signOut()

    expect(copies.deleted).toEqual(['anna'])
    expect(localStorage.getItem('tresso.mail.copies')).toBeNull()
  })

  it('keeps the copy of a session that ended in another tab, which removes it itself on a sign-out', async () => {
    const { useAuthStore } = await import('../auth')
    const auth = useAuthStore()
    const mail = useMailStore()
    await mail.start('anna')

    window.dispatchEvent(new StorageEvent('storage', { key: 'auth.tokens', newValue: null }))

    await vi.waitFor(() => expect(copies.closed).toEqual(['anna']))
    expect(auth.isAuthenticated).toBe(false)
    expect(copies.deleted).toEqual([])
  })

  it('removes the copy an expired session left behind once the server confirmed another user, and keeps it for the same user', async () => {
    const mail = useMailStore()
    await mail.start('anna')
    await mail.removeOtherUsersCopies('anna')
    await mail.stop()
    await mail.start('anna')
    await mail.removeOtherUsersCopies('anna')
    expect(copies.deleted).toEqual([])
    await mail.stop()

    await mail.start('ben')
    expect(copies.deleted).toEqual([])
    await mail.removeOtherUsersCopies('ben')

    expect(copies.deleted).toEqual(['anna'])
    expect(JSON.parse(localStorage.getItem('tresso.mail.copies')!)).toEqual([{ userId: 'ben', name: 'copy-ben' }])
  })

  it('never removes the copy of the signed-in user for a remembered id that /me then contradicts', async () => {
    const mail = useMailStore()
    // Ben is signed in here, with unsent drafts in his copy.
    await mail.start('ben')
    await mail.stop()

    // A copy opens for an id remembered from before, ahead of /me.
    await mail.start('anna')
    expect(copies.deleted).toEqual([])
    // /me answers: it is Ben. Anna's copy is still open, Ben's is his.
    await mail.removeOtherUsersCopies('ben')
    expect(copies.deleted).toEqual([])
    await mail.stop()
    await mail.start('ben')
    await mail.removeOtherUsersCopies('ben')

    expect(copies.deleted).toEqual(['anna'])
    expect(copies.deletedNames).not.toContain('copy-ben')
  })

  it('does not open a new copy when the copy was removed by a sign-out in another tab whose storage event is still to come', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { useAuthStore } = await import('../auth')
    const auth = useAuthStore()
    const mail = useMailStore()
    await mail.start('anna')

    // The other tab cleared the shared sign-in and then removed the copy; this tab hears of the copy first.
    localStorage.removeItem('auth.tokens')
    copies.closedElsewhere.get('anna')!('deleted')

    await vi.waitFor(() => expect(auth.isAuthenticated).toBe(false))
    await vi.waitFor(() => expect(copies.closed).toEqual(['anna']))
    expect(copies.opening).toEqual(['anna'])
    expect(auth.sessionEnd).toBe('elsewhere')
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
  it('opens the copy when the same user is started again after the open failed', async () => {
    const mail = useMailStore()
    copies.holdOpen.set('anna', Promise.reject(new Error('IndexedDB refused')))

    await expect(mail.start('anna')).rejects.toThrow('IndexedDB refused')
    expect(mail.ready).toBe(false)
    copies.holdOpen.delete('anna')
    await mail.start('anna')

    expect(copies.opened).toEqual(['anna'])
    expect(mail.ready).toBe(true)
  })
  it('removes the copy of a start that could not open it, once the user signs out', async () => {
    const mail = useMailStore()
    copies.holdOpen.set('anna', Promise.reject(new Error('IndexedDB refused')))
    await expect(mail.start('anna')).rejects.toThrow('IndexedDB refused')

    await mail.forget()

    expect(copies.deletedNames).toEqual(['copy-anna'])
  })

  it('removes the copy of a start that could not read it, once the user signs out', async () => {
    const mail = useMailStore()
    const failingRead = vi.fn<MailStore['mailAccounts']>(async () => {
      throw new Error('The copy could not be read.')
    })
    copies.afterOpen = (store) => {
      store.mailAccounts = failingRead
    }
    await expect(mail.start('anna')).rejects.toThrow('The copy could not be read.')
    expect(copies.closed).toEqual(['anna'])
    expect(mail.ready).toBe(false)

    await mail.forget()

    expect(copies.deleted).toEqual(['anna'])
  })
  it('pulls nothing, and counts no pull, while no copy is syncing', async () => {
    const mail = useMailStore()

    await mail.syncNow()

    expect(mail.pulls).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('only reads a copy started unconfirmed, and keeps it current once the same user is confirmed', async () => {
    const mail = useMailStore()

    await mail.start('anna', { confirmed: false })
    expect(mail.ready).toBe(true)
    expect(fetch).not.toHaveBeenCalled()

    await mail.start('anna', { confirmed: true })
    expect(copies.opened).toEqual(['anna'])
    expect(mail.synced).toBe(true)
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/api/v1/sync/changes'))).toBe(true)
  })

  it('removes a copy opened before the server answered at a sign-out: its id came with the tokens signed out', async () => {
    const mail = useMailStore()
    await mail.start('anna', { confirmed: false })

    await mail.forget()

    expect(copies.closed).toEqual(['anna'])
    expect(copies.deleted).toEqual(['anna'])
  })

  it('sends nothing for a copy whose user is not confirmed, and keeps what is done with its drafts here', async () => {
    const mail = useMailStore()
    await mail.start('anna', { confirmed: false })
    const copy = mail.currentStore()!
    await copy.changeDraft('kept', () => draft('kept', { subject: 'Written offline', pendingSave: true }))
    await copy.changeDraft('thrown', () => draft('thrown', { subject: 'Thrown away', pendingSave: true }))

    await mail.uploadPendingDrafts()
    await expect(mail.uploadDraft('kept')).rejects.toThrow(STILL_CHECKING)
    await mail.deleteDraftEverywhere('thrown')
    await expect(mail.send({ mailAccountId: 'work', to: [{ address: 'kim@example.test', name: null }], cc: [], bcc: [], subject: 'Hi', html: '<p>Hi</p>' })).rejects.toThrow(STILL_CHECKING)
    expect(fetch).not.toHaveBeenCalled()
    expect((await mail.drafts()).map((kept) => kept.id)).toEqual(['kept'])

    await mail.start('anna', { confirmed: true })
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).endsWith('/api/v1/drafts') && init?.method === 'POST')).toBe(true))
    const uploaded = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/api/v1/drafts')).map(([, init]) => JSON.parse(String(init?.body)) as { draftId: string })
    expect(uploaded.map((body) => body.draftId)).toEqual(['kept'])
  })

  it('tries a pull that failed again by itself, and clears "Sync stopped" once one works', async () => {
    let failures = 1
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname === '/api/v1/sync/changes') {
          if (failures-- > 0) {
            return new Response(JSON.stringify({ detail: 'Bad gateway' }), { status: 502 })
          }
          return new Response(JSON.stringify(page(Number(url.searchParams.get('since')))))
        }
        return new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503 })
      }),
    )
    const mail = useMailStore()

    await mail.start('anna')
    expect(mail.syncState).toBe('error')

    // No realtime event comes: the engine's own retry pulls again.
    await vi.waitFor(() => expect(mail.syncState).toBe('idle'), { timeout: 5_000 })
    expect(mail.syncError).toBeNull()
  })
})
