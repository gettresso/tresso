import { beforeEach, describe, expect, it } from 'vitest'
import { chat, chatAccount, chatOutgoing } from '../store/contract'
import { memorySql } from '../store/memorySql'
import { SqliteMailStore } from '../store/sqlite'
import {
  CHAT_REPLY_MAX,
  LOCAL_CHAT_ACCOUNT,
  LOCAL_CURSOR,
  LOCAL_SENDING,
  LocalChatBackend,
  LocalChatError,
  cancelLocalReply,
  localChatId,
  queueLocalReply,
  removeLocalChats,
  retryLocalReply,
  setLocalChatState,
} from './localBackend'
import { ChatRelayStopped, type IncomingChat, type IncomingMessage } from './relay'

const DIRECT = '31612345678@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'
const NOW = Date.parse('2026-11-12T10:00:00Z')
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()
const identity = { number: '31698765432', name: 'Sam', deviceId: '0193a000-0000-7000-8000-000000000001', deviceName: 'MacBook Air' }
const config = { includeGroups: true, leftOut: [], importSince: 0 }

function incoming(waId: string, chatJid: string, minutes: number, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return { chatJid, waId, fromMe: false, sender: null, text: `Text ${waId}`, sentAt: iso(minutes), media: null, ...extra }
}

const direct: IncomingChat = { jid: DIRECT, name: 'Kim', kind: 'direct' }

describe('LocalChatBackend', () => {
  let store: SqliteMailStore
  let backend: LocalChatBackend
  let now: number

  beforeEach(async () => {
    store = await SqliteMailStore.open(await memorySql())
    now = NOW
    backend = new LocalChatBackend(store, config, identity, () => now)
    await backend.prepare()
  })

  it('makes the account once, keeping what was set on it since', async () => {
    await store.putChatAccount({ ...(await store.chatAccounts())[0]!, link: 'linked', notify: true })
    await new LocalChatBackend(store, config, { ...identity, name: 'Sam V' }, () => now).prepare()

    expect(await store.chatAccounts()).toEqual([
      expect.objectContaining({ id: LOCAL_CHAT_ACCOUNT, channel: 'whatsapp', address: '31698765432', displayName: 'Sam V', link: 'linked', notify: true, relayOnline: true }),
    ])
  })

  it('stores messages under wa: ids, storing one again changes nothing, and keeps the chat state', async () => {
    await backend.ingest([direct], [incoming('A1', DIRECT, -10), incoming('A2', DIRECT, -5)], false)
    await setLocalChatState(store, localChatId(DIRECT), { readThrough: iso(-6), archivedThrough: iso(-5) })

    await backend.ingest([{ ...direct, name: null }], [incoming('A1', DIRECT, -10)], false)

    const stored = (await store.chat(localChatId(DIRECT)))!
    expect(stored.chat).toMatchObject({ id: `wa:${DIRECT}`, chatAccountId: LOCAL_CHAT_ACCOUNT, name: 'Kim', lastMessageAt: iso(-5), readThrough: iso(-6), archivedThrough: iso(-5) })
    expect(stored.messages.map((message) => message.id)).toEqual([`wa:${DIRECT}:A1`, `wa:${DIRECT}:A2`])
  })

  it('marks history read on the first import only, and never moves lastMessageAt back', async () => {
    await backend.ingest([direct], [incoming('A1', DIRECT, -10), incoming('A2', DIRECT, -5)], true)
    expect((await store.chats())[0]).toMatchObject({ unread: 0, chat: { readThrough: iso(-5) } })

    await backend.ingest([direct], [incoming('A0', DIRECT, -20)], false)
    await backend.ingest([direct], [incoming('A3', DIRECT, 1)], false)

    expect((await store.chats())[0]).toMatchObject({ unread: 1, chat: { lastMessageAt: iso(1), readThrough: iso(-5) } })
  })

  it('leaves a chat with unread messages unread during a first import, as the server does', async () => {
    const other = '31687654321@s.whatsapp.net'
    await backend.ingest([direct, { jid: other, name: null, kind: 'direct' }], [incoming('A1', DIRECT, -10), incoming('B1', other, -10)], false)
    await setLocalChatState(store, localChatId(other), { readThrough: iso(-10) })

    await backend.ingest([direct, { jid: other, name: null, kind: 'direct' }], [incoming('A0', DIRECT, -20), incoming('B0', other, -20), incoming('B2', other, -1)], true)

    expect((await store.chat(localChatId(DIRECT)))!.chat.readThrough).toBeNull()
    expect((await store.chat(localChatId(other)))!.chat.readThrough).toBe(iso(-1))
  })

  it('stores nothing for a chat left out in the copy', async () => {
    await backend.ingest([direct], [incoming('A1', DIRECT, -10)], false)
    await setLocalChatState(store, localChatId(DIRECT), { leftOut: true })

    await backend.ingest([direct], [incoming('A2', DIRECT, -5)], false)

    expect(await store.chat(localChatId(DIRECT))).toMatchObject({ chat: { leftOut: true }, messages: [], outgoing: [] })
  })

  it('keeps the cursor with the store it belongs to, and reads an unreadable one as a read from 0', async () => {
    expect(await backend.cursor()).toBeNull()
    await backend.setCursor({ storeId: 's1', rowid: 12, firstImportThrough: 40 })
    expect(await backend.cursor()).toEqual({ storeId: 's1', rowid: 12, firstImportThrough: 40 })

    await store.setChatMeta(LOCAL_CURSOR, '12')

    expect(await backend.cursor()).toEqual({ storeId: '', rowid: 0, firstImportThrough: null })
  })

  describe('replies', () => {
    beforeEach(async () => {
      await backend.ingest([direct, { jid: GROUP, name: 'Family', kind: 'group' }], [incoming('A1', DIRECT, -10), incoming('G1', GROUP, -10)], false)
    })

    it('claims the oldest waiting reply of this account only, marked sending', async () => {
      await store.putChatAccount(chatAccount('acct'))
      await store.putChats([chat('server-chat', 'acct', { jid: DIRECT })])
      await store.putChatOutgoing([chatOutgoing('0193a000-0000-7000-8000-000000000000', 'server-chat', 'acct', { createdAt: iso(-60) })])
      await queueLocalReply(store, localChatId(GROUP), 'second', '0193a000-0000-7000-8000-000000000002', NOW + 2)
      await queueLocalReply(store, localChatId(DIRECT), 'first', '0193a000-0000-7000-8000-000000000001', NOW + 1)

      const claimed = await backend.claimNext()

      expect(claimed).toEqual({ id: '0193a000-0000-7000-8000-000000000001', chatId: localChatId(DIRECT), chatJid: DIRECT, text: 'first', token: null })
      const row = (await store.chat(localChatId(DIRECT)))!.outgoing[0]!
      expect(row).toMatchObject({ status: 'sending', claimedAt: new Date(NOW).toISOString() })
      expect(JSON.parse((await store.chatMeta(LOCAL_SENDING))!)).toEqual({ id: row.id, chatId: localChatId(DIRECT) })
      // One at a time: nothing more until that one is reported.
      expect(await backend.claimNext()).toBeNull()
    })

    it('records the result once: sent moves the chat, a second report changes nothing', async () => {
      await queueLocalReply(store, localChatId(DIRECT), 'hi', '0193a000-0000-7000-8000-000000000001', NOW)
      const claimed = (await backend.claimNext())!
      now = NOW + 60_000

      await backend.report(claimed, { sent: true })
      now = NOW + 120_000
      await backend.report(claimed, { sent: false, error: 'refused' })

      const stored = (await store.chat(localChatId(DIRECT)))!
      expect(stored.outgoing.map((row) => [row.status, row.error, row.sentAt])).toEqual([['sent', null, iso(1)]])
      expect(stored.chat.lastMessageAt).toBe(iso(1))
      expect(await store.chatMeta(LOCAL_SENDING)).toBeNull()
    })

    it('settles a reply found sending at the start as not sent, unconfirmed, and leaves the server rows alone', async () => {
      await store.putChatAccount(chatAccount('acct'))
      await store.putChats([chat('server-chat', 'acct', { jid: DIRECT })])
      // A status a newer server sent, stored as `sending` by the lenient reader: not this device's to settle.
      await store.putChatOutgoing([chatOutgoing('0193a000-0000-7000-8000-00000000000f', 'server-chat', 'acct', { status: 'sending' })])
      await queueLocalReply(store, localChatId(DIRECT), 'hi', '0193a000-0000-7000-8000-000000000001', NOW)
      await queueLocalReply(store, localChatId(DIRECT), 'later', '0193a000-0000-7000-8000-000000000002', NOW + 1)
      await backend.claimNext()

      await new LocalChatBackend(store, config, identity, () => now).prepare()

      expect((await store.chat(localChatId(DIRECT)))!.outgoing.map((row) => [row.text, row.status, row.error])).toEqual([
        ['hi', 'failed', 'unconfirmed'],
        ['later', 'waiting', null],
      ])
      expect((await store.chat('server-chat'))!.outgoing.map((row) => row.status)).toEqual(['sending'])
      expect(await store.chatMeta(LOCAL_SENDING)).toBeNull()
    })

    it('leaves a reply waiting when the crash came before it was marked sending', async () => {
      await queueLocalReply(store, localChatId(DIRECT), 'hi', '0193a000-0000-7000-8000-000000000001', NOW)
      await store.setChatMeta(LOCAL_SENDING, JSON.stringify({ id: '0193a000-0000-7000-8000-000000000001', chatId: localChatId(DIRECT) }))

      await new LocalChatBackend(store, config, identity, () => now).prepare()

      expect((await store.chat(localChatId(DIRECT)))!.outgoing.map((row) => row.status)).toEqual(['waiting'])
      expect(await store.chatMeta(LOCAL_SENDING)).toBeNull()
    })

    it('queues a reply once per id, and refuses empty, too long, left out and unknown chats', async () => {
      const id = '0193a000-0000-7000-8000-000000000001'
      const first = await queueLocalReply(store, localChatId(DIRECT), 'hi', id, NOW)
      expect(await queueLocalReply(store, localChatId(DIRECT), 'hi again', id, NOW + 5)).toEqual(first)
      expect(first).toMatchObject({ status: 'waiting', chatAccountId: LOCAL_CHAT_ACCOUNT, createdAt: new Date(NOW).toISOString() })

      const refused = (promise: Promise<unknown>) => promise.then(() => null, (error: LocalChatError) => error.code)
      expect(await refused(queueLocalReply(store, localChatId(DIRECT), '  \n ', 'x1', NOW))).toBe('empty')
      expect(await refused(queueLocalReply(store, localChatId(DIRECT), 'x'.repeat(CHAT_REPLY_MAX + 1), 'x2', NOW))).toBe('too_long')
      expect(await refused(queueLocalReply(store, localChatId('31600000000@s.whatsapp.net'), 'hi', 'x3', NOW))).toBe('no_chat')
      expect(await refused(queueLocalReply(store, LOCAL_CHAT_ACCOUNT, 'hi', 'x4', NOW))).toBe('no_chat')
      await setLocalChatState(store, localChatId(GROUP), { leftOut: true })
      expect(await refused(queueLocalReply(store, localChatId(GROUP), 'hi', 'x5', NOW))).toBe('left_out')
      expect((await queueLocalReply(store, localChatId(DIRECT), 'x'.repeat(CHAT_REPLY_MAX), 'x6', NOW)).status).toBe('waiting')
    })

    it('cancels a waiting or failed reply, never one going out, and a cancel and a claim never both win', async () => {
      const a = '0193a000-0000-7000-8000-000000000001'
      const b = '0193a000-0000-7000-8000-000000000002'
      await queueLocalReply(store, localChatId(DIRECT), 'a', a, NOW)
      await queueLocalReply(store, localChatId(DIRECT), 'b', b, NOW + 1)

      const [cancelled, claimed] = await Promise.all([cancelLocalReply(store, localChatId(DIRECT), a), backend.claimNext()])

      expect(cancelled.status).toBe('cancelled')
      expect(claimed?.id).toBe(b)
      await expect(cancelLocalReply(store, localChatId(DIRECT), b)).rejects.toMatchObject({ code: 'already_going_out' })
      await backend.report(claimed!, { sent: false, error: 'not_linked' })
      expect((await cancelLocalReply(store, localChatId(DIRECT), b)).status).toBe('cancelled')
      expect(await backend.claimNext()).toBeNull()
      await expect(cancelLocalReply(store, localChatId(DIRECT), 'none')).rejects.toBeInstanceOf(LocalChatError)
    })

    it('tries a failed reply again only on request, and nothing else', async () => {
      const id = '0193a000-0000-7000-8000-000000000001'
      await queueLocalReply(store, localChatId(DIRECT), 'hi', id, NOW)
      await expect(retryLocalReply(store, localChatId(DIRECT), id)).rejects.toMatchObject({ code: 'not_failed' })
      await backend.report((await backend.claimNext())!, { sent: false, error: 'unconfirmed' })

      const again = await retryLocalReply(store, localChatId(DIRECT), id)

      expect(again).toMatchObject({ status: 'waiting', error: null, claimedAt: null })
      expect((await backend.claimNext())?.id).toBe(id)
    })
  })

  it('moves read and archive times forward only, and puts a chat back with archivedThrough null', async () => {
    await backend.ingest([direct], [incoming('A1', DIRECT, -10)], false)
    const id = localChatId(DIRECT)
    await setLocalChatState(store, id, { readThrough: iso(-5), archivedThrough: iso(-5) })

    expect(await setLocalChatState(store, id, { readThrough: iso(-20), archivedThrough: iso(-20) })).toMatchObject({ readThrough: iso(-5), archivedThrough: iso(-5) })
    expect(await store.chats({ inboxOnly: true })).toEqual([])
    await setLocalChatState(store, id, { archivedThrough: null })
    expect((await store.chats({ inboxOnly: true })).map((summary) => summary.chat.id)).toEqual([id])
    await expect(setLocalChatState(store, id, { readThrough: 'soon' })).rejects.toMatchObject({ code: 'not_a_time' })
  })

  it('leaving a chat out removes its messages and replies and keeps the chat, taking it back reads it again', async () => {
    await backend.ingest([direct], [incoming('A1', DIRECT, -10)], false)
    const id = localChatId(DIRECT)
    await queueLocalReply(store, id, 'hi', '0193a000-0000-7000-8000-000000000001', NOW)

    await setLocalChatState(store, id, { leftOut: true })
    expect(await store.chats()).toEqual([])
    expect(await store.chat(id)).toMatchObject({ chat: { leftOut: true }, messages: [], outgoing: [] })
    expect(await backend.claimNext()).toBeNull()

    await setLocalChatState(store, id, { leftOut: false })
    await backend.ingest([direct], [incoming('A2', DIRECT, -5)], false)
    expect((await store.chat(id))?.messages.map((message) => message.waId)).toEqual(['A2'])
  })

  it('removes the chats with the relay values, and a backend made before writes nothing more', async () => {
    await backend.ingest([direct], [incoming('A1', DIRECT, -10)], false)
    await backend.setCursor({ storeId: 's1', rowid: 3, firstImportThrough: null })
    await store.putChatAccount(chatAccount('acct'))

    await removeLocalChats(store)

    expect((await store.chatAccounts()).map((account) => account.id)).toEqual(['acct'])
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, DIRECT)).toBeNull()
    expect(await store.chatMeta(LOCAL_CURSOR)).toBeNull()
    await expect(backend.ingest([direct], [incoming('A2', DIRECT, -5)], false)).rejects.toBeInstanceOf(ChatRelayStopped)
    await expect(backend.setCursor({ storeId: 's1', rowid: 4, firstImportThrough: null })).rejects.toBeInstanceOf(ChatRelayStopped)
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, DIRECT)).toBeNull()

    // A backend made afterwards (connecting again) works.
    const fresh = new LocalChatBackend(store, config, identity, () => now)
    await fresh.prepare()
    await fresh.ingest([direct], [incoming('A2', DIRECT, -5)], false)
    expect((await store.chat(localChatId(DIRECT)))?.messages.map((message) => message.waId)).toEqual(['A2'])
  })

  it('a closed backend writes nothing', async () => {
    backend.close()
    await expect(backend.ingest([direct], [incoming('A1', DIRECT, -10)], false)).rejects.toBeInstanceOf(ChatRelayStopped)
    expect(await store.chats()).toEqual([])
  })

  it('takes a changed group setting onto the account', async () => {
    await backend.configure({ includeGroups: false, leftOut: [DIRECT] })

    expect((await store.chatAccounts())[0]!.includeGroups).toBe(false)
    expect(await backend.settings()).toEqual({ includeGroups: false, leftOut: new Set([DIRECT]), importSince: 0 })
  })
})
