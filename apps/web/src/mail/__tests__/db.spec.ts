import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { openDB } from 'idb'
import { accounts, chat, chatAccount, chatMessage, chatOutgoing, describeMailStore, page, signature } from '@tresso/core/testing'
import { databaseName, deleteMailDatabase, IndexedDbMailStore } from '../db'

const USER = 'user-1'

describeMailStore(
  'IndexedDB',
  () => IndexedDbMailStore.open(USER),
  async (store) => {
    await store.close()
    await deleteMailDatabase(USER)
  },
)

describe('IndexedDbMailStore', () => {
  afterEach(async () => {
    await deleteMailDatabase(USER)
  })

  it('keeps data per user and deletes it on request', async () => {
    let db = await IndexedDbMailStore.open(USER)
    await db.apply(page({ cursor: 10, mailAccounts: accounts }))
    const other = await IndexedDbMailStore.open('user-2')
    expect(await other.mailAccounts()).toEqual([])
    await other.close()
    await deleteMailDatabase('user-2')

    await db.close()
    await deleteMailDatabase(USER)
    db = await IndexedDbMailStore.open(USER)

    expect(await db.cursor()).toBe(0)
    expect(await db.mailAccounts()).toEqual([])
    await db.close()
  })

  it('takes the chats with it when the copy is deleted at sign-out', async () => {
    const at = '2026-11-12T10:00:00+00:00'
    let db = await IndexedDbMailStore.open(USER)
    await db.apply(
      page({
        cursor: 10,
        chatAccounts: [chatAccount('acct')],
        chats: [chat('anna', 'acct', { lastMessageAt: at })],
        chatMessages: [chatMessage('a1', 'anna', 'acct', at)],
        chatOutgoing: [chatOutgoing('r1', 'anna', 'acct')],
      }),
    )
    await db.setChatMeta('cursor', '812')
    await db.close()

    await deleteMailDatabase(USER)
    db = await IndexedDbMailStore.open(USER)

    expect(await db.chatAccounts()).toEqual([])
    expect(await db.chats()).toEqual([])
    expect(await db.chat('anna')).toBeNull()
    expect(await db.waitingOutgoing()).toEqual([])
    expect(await db.chatMeta('cursor')).toBeNull()
    await db.close()
  })
})

describe('IndexedDbMailStore upgrade from before signatures', () => {
  afterEach(async () => {
    await deleteMailDatabase(USER)
  })

  it('adds signatures to a copy stored before they existed and syncs it again from the start', async () => {
    const old = await openDB(databaseName(USER), 1, {
      upgrade(database) {
        database.createObjectStore('meta')
        database.createObjectStore('mailAccounts', { keyPath: 'id' })
        database.createObjectStore('folders', { keyPath: 'id' }).createIndex('byAccount', 'mailAccountId')
        database.createObjectStore('threads', { keyPath: 'id' }).createIndex('byAccount', 'mailAccountId')
        const messages = database.createObjectStore('messages', { keyPath: 'id' })
        messages.createIndex('byThread', 'threadId')
        messages.createIndex('byAccount', 'mailAccountId')
        messages.createIndex('byFolder', 'folderIds', { multiEntry: true })
        const conversations = database.createObjectStore('conversations', { keyPath: 'threadId' })
        conversations.createIndex('byAccount', 'mailAccountId')
        conversations.createIndex('byInboxDate', ['inbox', 'lastMessageAt'])
        conversations.createIndex('byAccountInboxDate', ['mailAccountId', 'inbox', 'lastMessageAt'])
        conversations.createIndex('byAccountUnreadInbox', ['mailAccountId', 'unreadInbox'])
      },
    })
    const { defaultSignatureId: _, ...withoutDefault } = accounts[0]!
    await old.put('mailAccounts', withoutDefault)
    await old.put('meta', 7, 'cursor')
    old.close()

    const db = await IndexedDbMailStore.open(USER)
    try {
      // Outgoing mail, contacts and signatures only arrive through the delta, so the copy starts over.
      expect(await db.cursor()).toBe(0)
      expect(await db.signatures()).toEqual([])
      expect(await db.mailAccounts()).toEqual([{ ...withoutDefault, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null }])
      await db.apply(page({ cursor: 8, signatures: [signature('sig-work', 'Work')] }))
      expect((await db.signatures()).map((s) => s.id)).toEqual(['sig-work'])
    } finally {
      await db.close()
    }
  })
})
