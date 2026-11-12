import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { openDB, type IDBPDatabase } from 'idb'
import { CHAT_BACKFILL } from '@tresso/core'
import { accounts, chat, chatAccount, chatMessage, draft, message, page, thread } from '@tresso/core/testing'
import { databaseName, deleteMailDatabase, IndexedDbMailStore } from '../db'

describe('IndexedDbMailStore upgrade to synced drafts', () => {
  it('uploads drafts that were kept on the device before', async () => {
    // A version 3 copy, as the previous build left it: drafts lived only on the device.
    const v3 = await openDB(databaseName('upgrade-drafts'), 3, {
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
        const outgoing = database.createObjectStore('outgoing', { keyPath: 'id' })
        outgoing.createIndex('byAccount', 'mailAccountId')
        outgoing.createIndex('bySendAt', 'sendAt')
        database.createObjectStore('contacts', { keyPath: 'key' }).createIndex('byLastSeen', 'lastSeen')
        database.createObjectStore('drafts', { keyPath: 'id' }).createIndex('byUpdatedAt', 'updatedAt')
        database.createObjectStore('signatures', { keyPath: 'id' })
      },
    })
    const base = { mailAccountId: null, to: [], cc: [], bcc: [], html: '', signatureId: null, quoteHtml: '', inReplyToMessageId: null, kind: 'new', noticedStatus: null, updatedAt: 1 }
    await v3.put('drafts', { ...base, id: 'written', subject: 'Written before', outgoingId: null })
    await v3.put('drafts', { ...base, id: 'sending', subject: 'Being sent', outgoingId: 'o1' })
    await v3.put('meta', 9, 'cursor')
    v3.close()

    const db = await IndexedDbMailStore.open('upgrade-drafts')

    expect(await db.draft('written')).toMatchObject({ subject: 'Written before', version: 0, pendingSave: true, remoteVersion: null })
    expect(await db.draft('sending')).toMatchObject({ version: 0, pendingSave: false, outgoingId: 'o1' })
    expect(await db.cursor()).toBe(0)
    await db.close()
    await deleteMailDatabase('upgrade-drafts')
  })
})

describe('IndexedDbMailStore upgrade', () => {
  it('moves a version 1 copy to version 2 and syncs it again from the start', async () => {
    const legacy = await openDB(databaseName('upgrade-user'), 1, {
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
    await legacy.put('meta', 42, 'cursor')
    legacy.close()

    const db = await IndexedDbMailStore.open('upgrade-user')

    expect(await db.cursor()).toBe(0)
    expect(await db.outbox()).toEqual([])
    expect(await db.drafts()).toEqual([])
    await db.close()
    await deleteMailDatabase('upgrade-user')
  })
})

describe('IndexedDbMailStore upgrade to smart inboxes', () => {
  it('keeps the inboxes working and syncs again to bring the classification', async () => {
    const v4 = await openDB(databaseName('upgrade-smart'), 4, {
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
        const outgoing = database.createObjectStore('outgoing', { keyPath: 'id' })
        outgoing.createIndex('byAccount', 'mailAccountId')
        outgoing.createIndex('bySendAt', 'sendAt')
        database.createObjectStore('contacts', { keyPath: 'key' }).createIndex('byLastSeen', 'lastSeen')
        database.createObjectStore('drafts', { keyPath: 'id' }).createIndex('byUpdatedAt', 'updatedAt')
        database.createObjectStore('signatures', { keyPath: 'id' })
      },
    })
    await v4.put('threads', { id: 't1', mailAccountId: 'work', subject: 'Budget', messageCount: 1, lastMessageAt: '2026-10-19T08:00:00Z' })
    await v4.put('conversations', {
      threadId: 't1',
      mailAccountId: 'work',
      subject: 'Budget',
      snippet: '',
      lastMessageAt: 1,
      messageCount: 1,
      unreadCount: 1,
      flagged: false,
      hasAttachments: false,
      senders: [],
      inbox: 1,
      unreadInbox: 1,
    })
    await v4.put('meta', 30, 'cursor')
    v4.close()

    const db = await IndexedDbMailStore.open('upgrade-smart')

    expect(await db.cursor()).toBe(0)
    expect(await db.smartInboxes()).toEqual([])
    expect(await db.inbox(null, 10)).toEqual([expect.objectContaining({ threadId: 't1', smartInboxId: null, verdict: null, inbox: true, active: true })])
    expect((await db.thread('t1'))?.thread).toMatchObject({ smartInboxId: null, verdict: null, classificationReason: null })
    await db.close()
    await deleteMailDatabase('upgrade-smart')
  })
})

/** The stores and indexes of a version 11 copy: the last shape before chats. */
function createVersion11(database: IDBPDatabase): void {
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
  conversations.createIndex('bySmartInboxDate', ['smartInboxId', 'active', 'lastMessageAt'])
  conversations.createIndex('bySmartInboxUnread', ['smartInboxId', 'unreadActive'])
  conversations.createIndex('byInboxBatchDate', ['inbox', 'batchedAt', 'lastMessageAt'])
  const outgoing = database.createObjectStore('outgoing', { keyPath: 'id' })
  outgoing.createIndex('byAccount', 'mailAccountId')
  outgoing.createIndex('bySendAt', 'sendAt')
  database.createObjectStore('contacts', { keyPath: 'key' }).createIndex('byLastSeen', 'lastSeen')
  database.createObjectStore('drafts', { keyPath: 'id' }).createIndex('byUpdatedAt', 'updatedAt')
  database.createObjectStore('signatures', { keyPath: 'id' })
  database.createObjectStore('smartInboxes', { keyPath: 'id' })
  const todos = database.createObjectStore('todos', { keyPath: 'id' })
  todos.createIndex('byMessage', 'messageId')
  todos.createIndex('byThread', 'threadId')
  database.createObjectStore('unsubscriptions', { keyPath: 'id' }).createIndex('byAccount', 'mailAccountId')
  database.createObjectStore('handOvers', { keyPath: 'id' }).createIndex('byAccount', 'mailAccountId')
  database.createObjectStore('dailyBriefs', { keyPath: 'id' })
  database.createObjectStore('calendars', { keyPath: 'id' }).createIndex('byAccount', 'mailAccountId')
  const events = database.createObjectStore('calendarEvents', { keyPath: 'id' })
  events.createIndex('bySeries', ['calendarId', 'uid'])
  events.createIndex('byCalendar', 'calendarId')
  events.createIndex('bySeriesStart', 'seriesStartsAt')
  events.createIndex('bySeriesEnd', 'seriesEndsAt')
}

describe('IndexedDbMailStore upgrade to chats', () => {
  it('adds the chat stores to a version 11 copy, keeping its mail and its cursor, marked to check for chats', async () => {
    const name = 'upgrade-chats'
    const v11 = await openDB(databaseName(name), 11, { upgrade: (database) => createVersion11(database) })
    await v11.put('mailAccounts', accounts[0]!)
    await v11.put('threads', thread('t1', 'work'))
    await v11.put('messages', message('m1', 't1', 'work', ['work-inbox'], '2026-10-19T08:00:00+00:00'))
    await v11.put('drafts', draft('unsent', { pendingSave: true, version: 3 }))
    await v11.put('meta', 30, 'cursor')
    await v11.put('meta', 1_700_000_000_000, 'syncedAt')
    v11.close()

    const db = await IndexedDbMailStore.open(name)
    try {
      expect(db.afterUpdate).toBe(false)
      expect(await db.mailAccounts()).toEqual([accounts[0]])
      expect((await db.thread('t1'))?.messages.map((m) => m.id)).toEqual(['m1'])
      expect(await db.draft('unsent')).toMatchObject({ pendingSave: true, version: 3 })
      expect(await db.syncedAt()).toBe(1_700_000_000_000)
      expect(await db.chatMeta(CHAT_BACKFILL)).toBe('1')
      expect(await db.cursor()).toBe(30)
      expect(await db.chats()).toEqual([])

      const at = '2026-11-12T10:00:00+00:00'
      await db.apply(page({ cursor: 31, chatAccounts: [chatAccount('acct')], chats: [chat('anna', 'acct', { lastMessageAt: at })], chatMessages: [chatMessage('a1', 'anna', 'acct', at)] }))
      expect((await db.chat('anna'))?.messages.map((m) => m.id)).toEqual(['a1'])
    } finally {
      await db.close()
      await deleteMailDatabase(name)
    }
  })
})
