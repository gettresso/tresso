import { describe, expect, it } from 'vitest'
import { SqliteMailStore, serverClaimKey, serverCursorKey, type ChangePage } from '@tresso/core'
import { memorySql } from '@tresso/core/testing/sql'
import { carriesChats } from '@/stores/mail'
import {
  SERVER_ACCOUNT,
  historyAt,
  readCarriedReplies,
  readModeSwitch,
  readServerHistory,
  removeServerState,
  resetServerCursor,
  serverHistoryKey,
} from '@/stores/whatsappServer'

const ACCOUNT = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4aa0'

describe('what the desktop keeps for "All my devices"', () => {
  it('reads a switch mark, and nothing it cannot read', () => {
    expect(readModeSwitch(JSON.stringify({ to: 'all', accountId: null }))).toEqual({ to: 'all', accountId: null })
    expect(readModeSwitch(JSON.stringify({ to: 'all', accountId: ACCOUNT }))).toEqual({ to: 'all', accountId: ACCOUNT })
    expect(readModeSwitch(JSON.stringify({ to: 'local', accountId: ACCOUNT, removed: true, cleared: true }))).toEqual({ to: 'local', accountId: ACCOUNT, removed: true, cleared: true })
    // Cleared only counts once removed.
    expect(readModeSwitch(JSON.stringify({ to: 'local', accountId: ACCOUNT, removed: false, cleared: true }))).toEqual({ to: 'local', accountId: ACCOUNT, removed: false, cleared: false })
    expect(readModeSwitch(JSON.stringify({ to: 'local', accountId: null }))).toBeNull()
    expect(readModeSwitch('{')).toBeNull()
    expect(readModeSwitch(null)).toBeNull()
  })

  it('reads carried replies, dropping entries it cannot read', () => {
    const id = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51'
    expect(readCarriedReplies(JSON.stringify([{ jid: 'a@s.whatsapp.net', text: 'Hi', id }, { jid: 1 }, { jid: 'b@s.whatsapp.net', text: 'Yo', id: 'nope' }]))).toEqual([
      { jid: 'a@s.whatsapp.net', text: 'Hi', id },
      { jid: 'b@s.whatsapp.net', text: 'Yo', id: null },
    ])
    expect(readCarriedReplies('nope')).toEqual([])
  })

  it('resets the server cursor to the first row with live batches, marking first, and keeps the claim', async () => {
    const store = await SqliteMailStore.open(await memorySql())
    await resetServerCursor(store, ACCOUNT, { jid: 'a@s.whatsapp.net', at: 1_000 })
    // No cursor: the first import reads everything, nothing to mark.
    expect(await store.chatMeta(serverHistoryKey(ACCOUNT))).toBeNull()

    await store.setChatMeta(serverCursorKey(ACCOUNT), JSON.stringify({ storeId: 's', rowid: 40, firstImport: null }))
    await store.setChatMeta(serverClaimKey(ACCOUNT), JSON.stringify({ id: 'r', token: 't', result: null }))
    await resetServerCursor(store, ACCOUNT, { jid: 'a@s.whatsapp.net', at: 1_000 })
    await resetServerCursor(store, ACCOUNT, { jid: null, at: 2_000 })
    expect(JSON.parse((await store.chatMeta(serverCursorKey(ACCOUNT)))!)).toEqual({ storeId: 's', rowid: 0, firstImport: null })
    const history = readServerHistory(await store.chatMeta(serverHistoryKey(ACCOUNT)))
    expect(history).toEqual({ scopes: [{ jid: 'a@s.whatsapp.net', at: 1_000 }, { jid: null, at: 2_000 }], throughRowid: 40 })
    expect(await store.chatMeta(serverClaimKey(ACCOUNT))).not.toBeNull()

    expect(historyAt(history, { jid: 'a@s.whatsapp.net', kind: 'direct' })).toBe(1_000)
    expect(historyAt(history, { jid: 'g@g.us', kind: 'group' })).toBe(2_000)
    expect(historyAt(history, { jid: 'b@s.whatsapp.net', kind: 'direct' })).toBeNull()

    await store.setChatMeta(SERVER_ACCOUNT, ACCOUNT)
    await removeServerState(store, ACCOUNT)
    for (const key of [serverCursorKey(ACCOUNT), serverClaimKey(ACCOUNT), serverHistoryKey(ACCOUNT), SERVER_ACCOUNT]) {
      expect(await store.chatMeta(key)).toBeNull()
    }
  })

  it('tells a delta page that changed chats from one that did not', () => {
    const page = (extra: Partial<ChangePage>) => ({ cursor: 1, hasMore: false, deleted: [], ...extra }) as unknown as ChangePage
    expect(carriesChats(page({}))).toBe(false)
    expect(carriesChats(page({ chats: [] }))).toBe(false)
    expect(carriesChats(page({ chatMessages: [{} as never] }))).toBe(true)
    expect(carriesChats(page({ deleted: [{ type: 'chatOutgoing', id: 'x' }] }))).toBe(true)
    expect(carriesChats(page({ deleted: [{ type: 'message', id: 'x' }] }))).toBe(false)
  })
})
