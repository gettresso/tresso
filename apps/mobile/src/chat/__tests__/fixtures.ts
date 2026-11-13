import { SqliteMailStore, type SyncedChat, type SyncedChatAccount, type SyncedChatMessage, type SyncedChatOutgoing } from '@tresso/core'
import { memorySql } from '@tresso/core/testing/sql'

/** Kim's WhatsApp on the server, relayed by her Mac; online unless a test says otherwise. */
export function account(extra: Partial<SyncedChatAccount> = {}): SyncedChatAccount {
  return {
    id: '0193a1c2-0000-7000-8000-00000000a001',
    channel: 'whatsapp',
    address: '31698765432',
    displayName: 'Kim Visser',
    relayDeviceId: '0193a1c2-7b1e-7c3a-9f00-1b2c3d4e5f60',
    relayDeviceName: "Kim's MacBook Pro",
    relayOnline: true,
    relayOfflineSince: null,
    bridge: 'running',
    link: 'linked',
    linkedAt: null,
    loopbackOnly: true,
    includeGroups: true,
    notify: false,
    ...extra,
  }
}

export function chat(id: string, extra: Partial<SyncedChat> = {}): SyncedChat {
  return {
    id,
    chatAccountId: account().id,
    jid: '31612345678@s.whatsapp.net',
    kind: 'direct',
    name: 'Bram Visser',
    lastMessageAt: '2026-11-13T10:14:00.000Z',
    readThrough: '2026-11-13T09:58:00.000Z',
    archivedThrough: null,
    leftOut: false,
    ...extra,
  }
}

export function message(id: string, chatId: string, sentAt: string, extra: Partial<SyncedChatMessage> = {}): SyncedChatMessage {
  return {
    id,
    chatId,
    chatAccountId: account().id,
    waId: `wa-${id}`,
    fromMe: false,
    sender: null,
    text: `Text of ${id}`,
    sentAt,
    mediaKind: null,
    mediaName: null,
    mediaSize: null,
    ...extra,
  }
}

export function reply(id: string, chatId: string, extra: Partial<SyncedChatOutgoing> = {}): SyncedChatOutgoing {
  return {
    id,
    chatId,
    chatAccountId: account().id,
    text: `Reply ${id}`,
    status: 'waiting',
    error: null,
    createdAt: '2026-11-13T10:31:00.000Z',
    claimedAt: null,
    sentAt: null,
    ...extra,
  }
}

/** A copy on sql.js with the account, these chats, messages and replies. */
export async function copyWith(rows: { account?: SyncedChatAccount | null; chats?: SyncedChat[]; messages?: SyncedChatMessage[]; outgoing?: SyncedChatOutgoing[] } = {}): Promise<SqliteMailStore> {
  const store = await SqliteMailStore.open(await memorySql())
  if (rows.account !== null) {
    await store.putChatAccount(rows.account ?? account())
  }
  await store.putChats(rows.chats ?? [])
  await store.putChatMessages(rows.messages ?? [])
  await store.putChatOutgoing(rows.outgoing ?? [])
  return store
}

/** A promise and the functions that settle it, for a request a test answers when it wants. */
export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
