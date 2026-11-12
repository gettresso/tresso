import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { CHAT_BACKFILL, SqliteMailStore, type ChangePage, type MailStore } from '@tresso/core'
import { memorySql } from '@tresso/core/testing/sql'

const copies = vi.hoisted(() => ({ store: null as SqliteMailStore | null }))

vi.mock('@/mail/store', () => ({
  // A copy brought to the version with chats in place: synced up to cursor 5 and marked to check for chats once.
  openMailStore: async (): Promise<MailStore> => {
    const store = await SqliteMailStore.open(await memorySql())
    await store.apply(page(5))
    await store.setChatMeta(CHAT_BACKFILL, '1')
    copies.store = store
    return store
  },
  mailCopyName: (userId: string) => `copy-${userId}`,
  copiesOnDevice: async () => [],
  deleteMailStore: async () => undefined,
}))

const { useMailStore } = await import('../mail')

function page(cursor: number): ChangePage {
  return { cursor, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [] }
}

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

/** Lets a test answer a request when it says so. */
function held<T>() {
  let answer!: (value: T) => void
  const answered = new Promise<T>((resolve) => (answer = resolve))
  return { answered, answer }
}

describe('the chat check after the update that added chats', () => {
  /** The `since` of every page asked for, in order. */
  let pulls: number[]
  let chatAccounts: () => Promise<Response>

  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    copies.store = null
    pulls = []
    chatAccounts = async () => new Response('[]')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname === '/api/v1/sync/changes') {
          const since = Number(url.searchParams.get('since'))
          pulls.push(since)
          return new Response(JSON.stringify(page(since === 0 ? 9 : since)))
        }
        if (url.pathname === '/api/v1/chat-accounts') {
          return chatAccounts()
        }
        return new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503 })
      }),
    )
  })

  afterEach(async () => {
    await useMailStore().stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('goes on from the cursor when the server holds no chat account, and clears the mark', async () => {
    const mail = useMailStore()

    await mail.start('anna')
    await vi.waitFor(async () => expect(await copies.store!.chatMeta(CHAT_BACKFILL)).toBeNull())

    expect(pulls).toEqual([5])
    expect(await copies.store!.cursor()).toBe(5)
  })

  it('pulls from the start when the server holds a chat account', async () => {
    chatAccounts = async () => new Response(JSON.stringify([{ id: 'acct' }]))
    const mail = useMailStore()

    await mail.start('anna')
    await vi.waitFor(() => expect(pulls).toContain(0))

    expect(pulls[0]).toBe(5)
    await vi.waitFor(async () => expect(await copies.store!.cursor()).toBe(9))
    expect(await copies.store!.chatMeta(CHAT_BACKFILL)).toBeNull()
  })

  it('does not hold back the mail while the check hangs', async () => {
    chatAccounts = () => new Promise<Response>(() => undefined)
    const mail = useMailStore()

    await mail.start('anna')

    expect(pulls).toEqual([5])
    expect(mail.synced).toBe(true)
    expect(await copies.store!.chatMeta(CHAT_BACKFILL)).toBe('1')
  })

  it('pulls from the start when a chat account is reported while the first pull runs', async () => {
    const answer = held<Response>()
    chatAccounts = () => answer.answered
    const firstPage = held<void>()
    const fetchStub = vi.mocked(fetch)
    const plain = fetchStub.getMockImplementation()!
    fetchStub.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v1/sync/changes' && pulls.length === 0) {
        pulls.push(Number(url.searchParams.get('since')))
        await firstPage.answered
        return new Response(JSON.stringify(page(6)))
      }
      return plain(input, init)
    })
    const mail = useMailStore()

    const starting = mail.start('anna')
    await vi.waitFor(() => expect(pulls).toEqual([5]))
    answer.answer(new Response(JSON.stringify([{ id: 'acct' }])))
    await vi.waitFor(async () => expect(await copies.store!.chatMeta(CHAT_BACKFILL)).toBeNull())
    firstPage.answer()
    await starting

    await vi.waitFor(() => expect(pulls).toEqual([5, 0]))
    // The page of the pull that began before the resync moved no cursor; the one from the start did.
    await vi.waitFor(async () => expect(await copies.store!.cursor()).toBe(9))
  })

  it('says nothing and starts no pull when the user signs out while the check runs', async () => {
    const answer = held<Response>()
    chatAccounts = () => answer.answered
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const mail = useMailStore()

    await mail.start('anna')
    await mail.stop()
    answer.answer(new Response(JSON.stringify([{ id: 'acct' }])))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(pulls).toEqual([5])
    expect(logged).not.toHaveBeenCalled()
  })
})
