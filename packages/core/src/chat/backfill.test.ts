import { beforeEach, describe, expect, it } from 'vitest'
import { memorySql } from '../store/memorySql'
import { SqliteMailStore } from '../store/sqlite'
import { firstPage } from '../store/contract'
import { backfillChats, CHAT_BACKFILL } from './backfill'

describe('backfillChats', () => {
  let store: SqliteMailStore
  let asked: number

  beforeEach(async () => {
    store = await SqliteMailStore.open(await memorySql())
    await store.apply(firstPage)
    asked = 0
  })

  const answer = (accounts: unknown[]) => async () => {
    asked += 1
    return accounts
  }

  it('does nothing for a copy that is not marked, not even ask', async () => {
    expect(await backfillChats(store, answer([{ id: 'acct' }]))).toBe('none')
    expect(asked).toBe(0)
    expect(await store.cursor()).toBe(10)
  })

  it('clears the mark without syncing again when the server holds no chat account', async () => {
    await store.setChatMeta(CHAT_BACKFILL, '1')

    expect(await backfillChats(store, answer([]))).toBe('no-chats')

    expect(asked).toBe(1)
    expect(await store.chatMeta(CHAT_BACKFILL)).toBeNull()
    expect(await store.cursor()).toBe(10)
  })

  it('syncs again from the start and clears the mark when the server holds a chat account', async () => {
    await store.setChatMeta(CHAT_BACKFILL, '1')

    expect(await backfillChats(store, answer([{ id: 'acct' }]))).toBe('resync')

    expect(await store.chatMeta(CHAT_BACKFILL)).toBeNull()
    expect(await store.cursor()).toBe(0)
    // And only once: the next start asks nothing.
    expect(await backfillChats(store, answer([{ id: 'acct' }]))).toBe('none')
    expect(asked).toBe(1)
  })

  it('keeps the mark for the next start when the request fails', async () => {
    await store.setChatMeta(CHAT_BACKFILL, '1')
    const offline = () => Promise.reject(new TypeError('Failed to fetch'))
    const serverError = () => Promise.reject(Object.assign(new Error('Internal'), { status: 500 }))

    expect(await backfillChats(store, offline)).toBe('later')
    expect(await backfillChats(store, serverError)).toBe('later')

    expect(await store.chatMeta(CHAT_BACKFILL)).toBe('1')
    expect(await store.cursor()).toBe(10)
  })

  it('takes a 403 (a token without chat access) as no chats', async () => {
    await store.setChatMeta(CHAT_BACKFILL, '1')
    const forbidden = () => Promise.reject(Object.assign(new Error('Forbidden'), { status: 403 }))

    expect(await backfillChats(store, forbidden)).toBe('no-chats')

    expect(await store.chatMeta(CHAT_BACKFILL)).toBeNull()
    expect(await store.cursor()).toBe(10)
  })
})
