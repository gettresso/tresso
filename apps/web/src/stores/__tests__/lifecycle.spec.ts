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
  afterOpen: null as ((store: MailStore) => void | Promise<void>) | null,
  /** Removing a copy fails with this, as when the desktop shell refuses while a read still uses it. */
  deleteFails: null as Error | null,
  /** The copies the device lists (IndexedDB databases), as copiesOnDevice reports them. */
  onDevice: [] as { userId: string; name: string }[],
  /** What each close was asked to wait for. */
  closeOptions: [] as ({ waitMs?: number } | undefined)[],
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
    await copies.afterOpen?.(store)
    const close = store.close.bind(store)
    store.close = async (options) => {
      copies.closeOptions.push(options)
      await copies.holdClose.get(userId)
      await close(options)
      copies.closed.push(userId)
    }
    return store
  },
  mailCopyName: (userId: string) => copies.names.get(userId) ?? `copy-${userId}`,
  // As the desktop shell does: a copy that is still open cannot be removed.
  copiesOnDevice: async () => copies.onDevice,
  deleteMailStore: async (userId: string, name: string) => {
    if (copies.deleteFails !== null) {
      throw copies.deleteFails
    }
    copies.deletedNames.push(name)
    const open = copies.opening.filter((id) => id === userId).length - copies.closed.filter((id) => id === userId).length
    if (open > 0) {
      throw new Error('The mail copy is still open.')
    }
    copies.deleted.push(userId)
  },
}))

const { KEPT_SAVE_LIMIT_MS, STILL_CHECKING, useMailStore } = await import('../mail')

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
    copies.deleteFails = null
    copies.onDevice = []
    copies.closeOptions = []
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

  it('closes a kept copy after a few seconds when writing the last draft into it never finishes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mail = useMailStore()
    await mail.start('anna')
    // Storage that never answers the write of the draft on screen.
    mail.beforeKeptCopyCloses(() => new Promise<void>(() => undefined), () => undefined)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth.tokens', newValue: null }))
      await vi.advanceTimersByTimeAsync(KEPT_SAVE_LIMIT_MS - 1)
      expect(copies.closed).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(copies.closed).toEqual(['anna']))
    expect(mail.ready).toBe(false)
    // The close itself is bounded the same way: on the desktop it waits for writes under way, which may never answer.
    expect(copies.closeOptions).toEqual([{ waitMs: KEPT_SAVE_LIMIT_MS }])
  })

  it('opens and syncs the copy of the same user who signs in again while the last draft is still being written', async () => {
    const { useAuthStore } = await import('../auth')
    const auth = useAuthStore()
    const mail = useMailStore()
    await mail.start('anna')
    let written!: () => void
    mail.beforeKeptCopyCloses(() => new Promise<void>((resolve) => (written = resolve)), () => undefined)

    window.dispatchEvent(new StorageEvent('storage', { key: 'auth.tokens', newValue: null }))
    await vi.waitFor(() => expect(written).toBeDefined())
    // Anna signs in again (another tab, or the desktop window) before the write finished.
    auth.tokens = { accessToken: 'token-2', refreshToken: null, expiresAt: Date.now() + 3_600_000 }
    const starting = mail.start('anna')
    written()
    await starting

    // The half-closed copy was closed, and her copy opened afresh and syncing; no late close shuts it.
    expect(copies.closed).toEqual(['anna'])
    expect(copies.opened).toEqual(['anna', 'anna'])
    await vi.waitFor(() => expect(mail.synced).toBe(true))
    expect(mail.ready).toBe(true)
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

  it('marks a copy that could not be removed at a sign-out, says so, and removes it at the next start', async () => {
    vi.stubGlobal('location', { ...window.location, assign: vi.fn<(url: string) => void>() })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { useAuthStore } = await import('../auth')
    const auth = useAuthStore()
    const mail = useMailStore()
    await mail.start('anna')
    copies.deleteFails = new Error('The mail copy is still in use.')

    await auth.signOut()

    expect(auth.isAuthenticated).toBe(false)
    expect(copies.deleted).toEqual([])
    expect(mail.removalError).toBe('Your mail could not be removed from this device (The mail copy is still in use.). Tresso removes it the next time it starts.')
    expect(JSON.parse(localStorage.getItem('tresso.mail.copies')!)).toEqual([{ userId: 'anna', name: 'copy-anna', remove: true }])

    // The next start of the signed-out app, with nothing using the copy any more.
    setActivePinia(createPinia())
    copies.deleteFails = null
    const next = useMailStore()
    await next.removeLeftCopies()

    expect(copies.deleted).toEqual(['anna'])
    expect(next.removalError).toBeNull()
    expect(localStorage.getItem('tresso.mail.copies')).toBeNull()
  })

  it('does not remove a marked copy its user opened again meanwhile', async () => {
    localStorage.setItem('tresso.mail.copies', JSON.stringify([{ userId: 'anna', name: 'copy-anna', remove: true }]))
    const mail = useMailStore()
    // Anna signs in again and her copy opens, which unmarks it, before the retry gets to it.
    await mail.start('anna')

    await mail.removeLeftCopies()

    expect(copies.deleted).toEqual([])
    expect(JSON.parse(localStorage.getItem('tresso.mail.copies')!)).toEqual([{ userId: 'anna', name: 'copy-anna' }])
  })

  it('looks into a copy that is not open before a sign-out removes it, so its unsaved drafts are asked about', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mail = useMailStore()
    await mail.start('anna')
    // Another tab upgraded the copy (or reading it failed): it is closed here, and a sign-out would still remove it.
    copies.closedElsewhere.get('anna')!('upgraded')
    await vi.waitFor(() => expect(mail.ready).toBe(false))
    // What the copy holds on disk: a draft written offline, and one the server has.
    copies.afterOpen = async (store) => {
      await store.saveDraft(draft('d1', { pendingSave: true }))
      await store.saveDraft(draft('d2', { pendingSave: false }))
    }

    expect((await mail.unsavedDrafts()).map((d) => d.id)).toEqual(['d1'])
    // Looked into and closed again.
    expect(copies.closed.filter((id) => id === 'anna')).toHaveLength(2)
  })

  it('stops waiting for the drafts to reach the server after 15 seconds, and says which are still not there', async () => {
    const mail = useMailStore()
    await mail.start('anna')
    await mail.saveDraft(draft('d1', { pendingSave: true }))
    // The server takes the upload and never answers.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        new URL(String(input)).pathname.startsWith('/api/v1/drafts') ? new Promise<Response>(() => undefined) : new Response(JSON.stringify(page(0))),
      ),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let left: string[] | null = null
      void mail.saveUnsavedDrafts(15_000).then((drafts) => (left = drafts.map((d) => d.id)))
      await vi.advanceTimersByTimeAsync(14_999)
      expect(left).toBeNull()

      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(left).toEqual(['d1']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a copy kept on purpose (an expired session) alone at the start of the signed-out app', async () => {
    const mail = useMailStore()
    await mail.start('anna')
    await mail.stop()

    await mail.removeLeftCopies()

    expect(copies.deleted).toEqual([])
    expect(JSON.parse(localStorage.getItem('tresso.mail.copies')!)).toEqual([{ userId: 'anna', name: 'copy-anna' }])
  })

  it('removes copies an earlier release left without listing them, once the server confirmed another user', async () => {
    // Copies from before the list: Anna's (another user) and Ben's own, which stays for him.
    copies.onDevice = [
      { userId: 'anna', name: 'copy-anna' },
      { userId: 'ben', name: 'copy-ben' },
    ]
    const mail = useMailStore()
    await mail.start('ben')

    await mail.removeOtherUsersCopies('ben')

    expect(copies.deleted).toEqual(['anna'])
    expect(copies.deletedNames).not.toContain('copy-ben')
    expect(JSON.parse(localStorage.getItem('tresso.mail.copies')!)).toEqual([{ userId: 'ben', name: 'copy-ben' }])
  })

  it("does not remove the copy of an expired session when the next user signs out before the server confirmed them", async () => {
    vi.stubGlobal('location', { ...window.location, assign: vi.fn<(url: string) => void>() })
    const { useAuthStore } = await import('../auth')
    const auth = useAuthStore()
    const mail = useMailStore()
    // Anna's copy opened before the server answered (the desktop app at launch), then her session expired.
    await mail.start('anna', { confirmed: false })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ title: 'Unauthorized' }, { status: 401 })))
    await expect(auth.api('/api/v1/me')).rejects.toThrow('Your session has expired.')
    await vi.waitFor(() => expect(copies.closed).toEqual(['anna']))

    // Ben signs in in the same window and signs out before /me answered: no copy of his was opened yet.
    auth.tokens = { accessToken: 'ben-token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }
    await auth.signOut()

    expect(copies.deleted).toEqual([])
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

  it('pulls nothing when the browser goes online or the tab shows again while the copy is not confirmed', async () => {
    const mail = useMailStore()
    await mail.start('anna', { confirmed: false })

    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(fetch).not.toHaveBeenCalled()
    expect(mail.live).toBe(false)
  })
})
