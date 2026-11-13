import { beforeEach, describe, expect, it } from 'vitest'
import { chat, chatAccount, chatOutgoing } from '../store/contract'
import { memorySql } from '../store/memorySql'
import { SqliteMailStore } from '../store/sqlite'
import { CHAT_REPLY_MAX } from './format'
import {
  LOCAL_CHAT_ACCOUNT,
  LOCAL_CURSOR,
  LocalChatBackend,
  LocalChatError,
  cancelLocalReply,
  localChatId,
  queueLocalReply,
  recordLocalAttachment,
  removeLocalChats,
  removeLocalGroupChats,
  resetLocalCursor,
  retryLocalReply,
  setLocalChatAccount,
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
    const firstImport = { through: 40, ranFor: 120_000, quietFor: 9_000 }
    await backend.setCursor({ storeId: 's1', rowid: 12, firstImport })
    expect(await backend.cursor()).toEqual({ storeId: 's1', rowid: 12, firstImport })

    for (const unreadable of ['12', '{"storeId":"s1","rowid":12,"firstImportThrough":40}', '{"storeId":"s1","rowid":12,"firstImport":{"through":"40"}}', '{"storeId":"s1","rowid":12,"firstImport":{"through":40,"startedAt":1,"quietSince":1}}']) {
      await store.setChatMeta(LOCAL_CURSOR, unreadable)
      expect(await backend.cursor()).toEqual({ storeId: '', rowid: 0, firstImport: null })
    }
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

      expect(claimed).toEqual({ id: '0193a000-0000-7000-8000-000000000001', chatId: localChatId(DIRECT), chatJid: DIRECT, text: 'first', token: new Date(NOW).toISOString() })
      const row = (await store.chat(localChatId(DIRECT)))!.outgoing[0]!
      expect(row).toMatchObject({ status: 'sending', claimedAt: new Date(NOW).toISOString() })
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
      expect((await backend.claimNext())).toBeNull()
    })

    it('lets a sent result of the same claim win over unconfirmed, as the server does, and no other claim', async () => {
      const id = '0193a000-0000-7000-8000-000000000001'
      await queueLocalReply(store, localChatId(DIRECT), 'hi', id, NOW)
      const claimed = (await backend.claimNext())!
      // The app restarted while the old relay still held the result: the new start settled the reply as unconfirmed.
      await new LocalChatBackend(store, config, identity, () => now).prepare()

      await backend.report({ ...claimed, token: 'another claim' }, { sent: true })
      expect((await store.chat(localChatId(DIRECT)))!.outgoing.map((row) => [row.status, row.error])).toEqual([['failed', 'unconfirmed']])
      await backend.report(claimed, { sent: false, error: 'refused' })
      expect((await store.chat(localChatId(DIRECT)))!.outgoing.map((row) => [row.status, row.error])).toEqual([['failed', 'unconfirmed']])
      await backend.report(claimed, { sent: true })
      expect((await store.chat(localChatId(DIRECT)))!.outgoing.map((row) => [row.status, row.error])).toEqual([['sent', null]])

      // Try again ends a claim: a late result of the old one changes nothing.
      const other = '0193a000-0000-7000-8000-000000000002'
      await queueLocalReply(store, localChatId(DIRECT), 'again', other, NOW)
      const second = (await backend.claimNext())!
      await backend.report(second, { sent: false, error: 'unconfirmed' })
      await retryLocalReply(store, localChatId(DIRECT), other)
      await backend.report(second, { sent: true })
      expect((await store.chat(localChatId(DIRECT)))!.outgoing.find((row) => row.id === other)).toMatchObject({ status: 'waiting', claimedAt: null })
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
      // Sending goes on with the next one.
      expect((await backend.claimNext())?.text).toBe('later')
    })

    it('settles every reply of this account found sending, whatever wrote it', async () => {
      await store.putChatOutgoing([
        chatOutgoing('0193a000-0000-7000-8000-000000000001', localChatId(DIRECT), LOCAL_CHAT_ACCOUNT, { status: 'sending', claimedAt: iso(-1) }),
        chatOutgoing('0193a000-0000-7000-8000-000000000002', localChatId(GROUP), LOCAL_CHAT_ACCOUNT, { status: 'sending', claimedAt: iso(-1) }),
      ])
      expect(await backend.claimNext()).toBeNull()

      await new LocalChatBackend(store, config, identity, () => now).prepare()

      expect((await store.sendingOutgoingHere()).length).toBe(0)
      expect((await store.chat(localChatId(GROUP)))!.outgoing.map((row) => [row.status, row.error])).toEqual([['failed', 'unconfirmed']])
    })

    it('fails a waiting reply whose chat id names no chat, so it holds up nothing', async () => {
      // A row no relay version writes: its chat id has no JID in it.
      await store.putChats([chat('wa:broken', LOCAL_CHAT_ACCOUNT, { jid: '31600000000@s.whatsapp.net' })])
      await store.putChatOutgoing([chatOutgoing('0193a000-0000-7000-8000-000000000000', 'wa:broken', LOCAL_CHAT_ACCOUNT, { createdAt: iso(-60) })])
      await queueLocalReply(store, localChatId(DIRECT), 'next', '0193a000-0000-7000-8000-000000000001', NOW)

      expect((await backend.claimNext())?.text).toBe('next')
      expect((await store.chat('wa:broken'))!.outgoing.map((row) => [row.status, row.error])).toEqual([['failed', 'refused']])
    })

    it('queues a reply once per id, and refuses empty, too long, left out and unknown chats', async () => {
      const id = '0193a000-0000-7000-8000-000000000001'
      const first = await queueLocalReply(store, localChatId(DIRECT), '  hi\n\n', id, NOW)
      expect(await queueLocalReply(store, localChatId(DIRECT), 'hi again', id, NOW + 5)).toEqual(first)
      expect(first).toMatchObject({ text: 'hi', status: 'waiting', chatAccountId: LOCAL_CHAT_ACCOUNT, createdAt: new Date(NOW).toISOString() })

      const refused = (promise: Promise<unknown>) => promise.then(() => null, (error: LocalChatError) => error.code)
      expect(await refused(queueLocalReply(store, localChatId(DIRECT), '  \n ', 'x1', NOW))).toBe('empty')
      expect(await refused(queueLocalReply(store, localChatId(DIRECT), 'x'.repeat(CHAT_REPLY_MAX + 1), 'x2', NOW))).toBe('too_long')
      expect(await refused(queueLocalReply(store, localChatId(DIRECT), 'a\u0007b', 'x7', NOW))).toBe('control')
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
    await backend.setCursor({ storeId: 's1', rowid: 3, firstImport: null })
    await store.putChatAccount(chatAccount('acct'))

    await removeLocalChats(store)

    expect((await store.chatAccounts()).map((account) => account.id)).toEqual(['acct'])
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, DIRECT)).toBeNull()
    expect(await store.chatMeta(LOCAL_CURSOR)).toBeNull()
    await expect(backend.ingest([direct], [incoming('A2', DIRECT, -5)], false)).rejects.toBeInstanceOf(ChatRelayStopped)
    await expect(backend.setCursor({ storeId: 's1', rowid: 4, firstImport: null })).rejects.toBeInstanceOf(ChatRelayStopped)
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

  it('keeps the bridge state and Notify me on the account row, which a later prepare keeps', async () => {
    const stored = await setLocalChatAccount(store, { bridge: 'stopped', link: 'linked', linkedAt: iso(-60), loopbackOnly: true, notify: true })

    expect(stored).toMatchObject({ bridge: 'stopped', link: 'linked', linkedAt: iso(-60), loopbackOnly: true, notify: true })
    await new LocalChatBackend(store, config, identity, () => now).prepare()
    expect((await store.chatAccounts())[0]).toMatchObject({ bridge: 'stopped', link: 'linked', notify: true })

    // Without the row (before the relay's first round) nothing is made.
    await removeLocalChats(store)
    expect(await setLocalChatAccount(store, { notify: false })).toBeNull()
    expect(await store.chatAccounts()).toEqual([])
  })

  it('removes the group chats but a left-out one, and resets the cursor for a new first import', async () => {
    const group: IncomingChat = { jid: GROUP, name: 'Family', kind: 'group' }
    const other = '120363000000000002@g.us'
    await backend.ingest(
      [direct, group, { jid: other, name: 'Club', kind: 'group' }],
      [incoming('A1', DIRECT, -10), incoming('G1', GROUP, -9, { sender: { id: '31611111111', name: 'Mom' } }), incoming('C1', other, -8, { sender: { id: '31622222222', name: null } })],
      false,
    )
    await setLocalChatState(store, localChatId(other), { leftOut: true })
    await backend.setCursor({ storeId: 's1', rowid: 9, firstImport: null })

    expect(await removeLocalGroupChats(store)).toBe(1)

    expect((await store.chats()).map(({ chat }) => chat.jid)).toEqual([DIRECT])
    expect(await store.chatByJid(LOCAL_CHAT_ACCOUNT, other)).toMatchObject({ leftOut: true })
    expect(await store.chat(localChatId(GROUP))).toBeNull()

    await resetLocalCursor(store)
    expect(await backend.cursor()).toBeNull()
  })

  it('records a file that went out as a sent reply, once per id, never for a chat left out', async () => {
    await backend.ingest([direct], [incoming('A1', DIRECT, -10)], false)
    const id = '0193a000-0000-7000-8000-0000000000f1'

    const row = await recordLocalAttachment(store, localChatId(DIRECT), ' plan\u202E.pdf ', id, NOW)
    expect(row).toMatchObject({ id, status: 'sent', text: 'File: plan.pdf', sentAt: iso(0), createdAt: iso(0), error: null })
    expect(await recordLocalAttachment(store, localChatId(DIRECT), 'other.pdf', id, NOW + 60_000)).toEqual(row)
    const stored = (await store.chat(localChatId(DIRECT)))!
    expect(stored.outgoing).toEqual([row])
    expect(stored.chat.lastMessageAt).toBe(iso(0))
    // Nothing the relay sends: it is no waiting reply.
    expect(await backend.claimNext()).toBeNull()

    await expect(recordLocalAttachment(store, localChatId(DIRECT), '\u200B', 'x2', NOW)).rejects.toMatchObject({ code: 'empty' })
    await setLocalChatState(store, localChatId(DIRECT), { leftOut: true })
    await expect(recordLocalAttachment(store, localChatId(DIRECT), 'a.pdf', 'x3', NOW)).rejects.toMatchObject({ code: 'left_out' })
    await expect(recordLocalAttachment(store, localChatId(GROUP), 'a.pdf', 'x4', NOW)).rejects.toMatchObject({ code: 'no_chat' })
  })
})
