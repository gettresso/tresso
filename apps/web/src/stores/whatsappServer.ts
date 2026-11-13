import { chatOnlyHere, readRelayCursor, removeServerChatState, serverCursorKey, type MailStore, type SyncedChatAccount } from '@tresso/core'

/*
 * What the desktop keeps in its copy (chat values, MailStore.chatMeta) for the "All my devices" mode, apart from what
 * ServerChatBackend keeps itself (its cursor and its claim). Chat values outlive a rebuild of the copy and go with it at
 * sign-out, as the config does. They hold ids, times and counts; the only text is that of replies carried over from
 * "Only this Mac", which the copy held anyway.
 */

/** A switch between the modes under way; cleared once it is done. See ModeSwitch. */
export const MODE_SWITCH = 'mode-switch'
/** Replies that waited on this Mac when it switched to "All my devices", until they are queued on the server. */
export const CARRIED_REPLIES = 'carried-replies'
/** The server's chat account this Mac knew last: told apart from one removed elsewhere when it is gone from the copy. */
export const SERVER_ACCOUNT = 'server-account'
/** Before the account id: a re-read with live batches under way (ServerHistory). */
export const SERVER_HISTORY_PREFIX = 'server-history:'

export function serverHistoryKey(accountId: string): string {
  return `${SERVER_HISTORY_PREFIX}${accountId}`
}

/**
 * A switch between the modes, kept from its first step until its last, so a crash or a sign-out at any point leaves a
 * state the next start takes up (whatsappRelay `resumeSwitch`).
 * - `to: 'all'`: the account is made (or this Mac takes it over) with this device; `accountId` once the server answered.
 * - `to: 'local'`: the account `accountId` is removed from the server; `removed` once the server confirmed it, `cleared`
 *   once the config says `local` and what this Mac kept for the account went, after which the switch only waits for the
 *   copy to apply the removal before the relay reads the bridge's store anew.
 */
export type ModeSwitch = { to: 'all'; accountId: string | null } | { to: 'local'; accountId: string; removed: boolean; cleared: boolean }

/** A reply that waited on this Mac at the switch to "All my devices"; `id` once one was made for the server's queue. */
export interface CarriedReply {
  /** The chat's JID; its server chat is looked up by it once the delta brought it. */
  jid: string
  text: string
  /** The UUIDv7 it is queued with; null until made (and again after the server found it too old). */
  id: string | null
}

/** What a re-read marks read: one chat by JID, or every group chat (`jid` null), through `at` (epoch ms). */
export interface HistoryScope {
  jid: string | null
  at: number
}

/**
 * A re-read of the bridge's store with live batches (a chat taken back in, groups turned on again): against the server a
 * first-import batch may never follow a live one, so the rows go live and their history is marked read through the
 * scope's `at` by a chat state change once their chats are in the copy.
 */
export interface ServerHistory {
  scopes: HistoryScope[]
  /** The cursor's rowid before the reset: once the relay read past it again, the re-read is done. */
  throughRowid: number
}

/** The moment a chat's history is read through by a re-read under way; null when none is about it. */
export function historyAt(history: ServerHistory | null, chat: { jid: string; kind: string }): number | null {
  let at: number | null = null
  for (const scope of history?.scopes ?? []) {
    if (scope.jid === chat.jid || (scope.jid === null && chat.kind === 'group')) {
      at = Math.max(at ?? scope.at, scope.at)
    }
  }
  return at
}

function parse(value: string | null): unknown {
  if (value === null) {
    return null
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

const ID = /^[0-9a-f-]{36}$/i

export function readModeSwitch(value: string | null): ModeSwitch | null {
  const raw = parse(value) as { to?: unknown; accountId?: unknown; removed?: unknown } | null
  if (raw === null || typeof raw !== 'object') {
    return null
  }
  const accountId = typeof raw.accountId === 'string' && ID.test(raw.accountId) ? raw.accountId : null
  if (raw.to === 'all') {
    return { to: 'all', accountId }
  }
  if (raw.to === 'local' && accountId !== null) {
    const removed = raw.removed === true
    return { to: 'local', accountId, removed, cleared: removed && (raw as { cleared?: unknown }).cleared === true }
  }
  return null
}

export function readCarriedReplies(value: string | null): CarriedReply[] {
  const raw = parse(value)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.flatMap((entry: unknown) => {
    const reply = entry as { jid?: unknown; text?: unknown; id?: unknown } | null
    if (reply === null || typeof reply !== 'object' || typeof reply.jid !== 'string' || typeof reply.text !== 'string') {
      return []
    }
    return [{ jid: reply.jid, text: reply.text, id: typeof reply.id === 'string' && ID.test(reply.id) ? reply.id : null }]
  })
}

export function readServerHistory(value: string | null): ServerHistory | null {
  const raw = parse(value) as { scopes?: unknown; throughRowid?: unknown } | null
  if (raw === null || typeof raw !== 'object' || typeof raw.throughRowid !== 'number' || !Number.isSafeInteger(raw.throughRowid) || !Array.isArray(raw.scopes)) {
    return null
  }
  const scopes = raw.scopes.flatMap((entry: unknown) => {
    const scope = entry as { jid?: unknown; at?: unknown } | null
    if (scope === null || typeof scope !== 'object' || typeof scope.at !== 'number' || !Number.isSafeInteger(scope.at) || (scope.jid !== null && typeof scope.jid !== 'string')) {
      return []
    }
    return [{ jid: scope.jid as string | null, at: scope.at }]
  })
  return scopes.length === 0 ? null : { scopes, throughRowid: raw.throughRowid }
}

export async function setModeSwitch(store: MailStore, value: ModeSwitch | null): Promise<void> {
  await store.setChatMeta(MODE_SWITCH, value === null ? null : JSON.stringify(value))
}

export async function setCarriedReplies(store: MailStore, replies: readonly CarriedReply[]): Promise<void> {
  await store.setChatMeta(CARRIED_REPLIES, replies.length === 0 ? null : JSON.stringify(replies))
}

/** The server's WhatsApp account in the copy; null when the copy holds none. */
export async function serverAccountIn(store: MailStore): Promise<SyncedChatAccount | null> {
  return (await store.chatAccounts()).find((account) => !chatOnlyHere(account.id) && account.channel === 'whatsapp') ?? null
}

/**
 * Makes the relay read the bridge's store again from its first row with live batches, keeping a first import that still
 * runs as it is (the server honours `firstImport` until the relay's first live batch, so it may go on): the cursor
 * keeps its store and its first import and goes back to rowid 0. The mark goes first, so a crash in between leaves the
 * old cursor with a mark that marks read what is already read, never a re-read without the mark. Without a cursor there
 * is nothing to reset: the first import reads everything. Stop the relay first; its claim stays.
 */
export async function resetServerCursor(store: MailStore, accountId: string, scope: HistoryScope): Promise<void> {
  const value = await store.chatMeta(serverCursorKey(accountId))
  const cursor = value === null ? null : readRelayCursor(value)
  if (cursor === null) {
    return
  }
  const before = readServerHistory(await store.chatMeta(serverHistoryKey(accountId)))
  const next: ServerHistory = { scopes: [...(before?.scopes ?? []), scope], throughRowid: Math.max(before?.throughRowid ?? 0, cursor.rowid) }
  await store.setChatMeta(serverHistoryKey(accountId), JSON.stringify(next))
  await store.setChatMeta(serverCursorKey(accountId), JSON.stringify({ ...cursor, rowid: 0 }))
}

/** Everything this Mac keeps for a server account: the backend's cursor and claim, the re-read mark, the account mark. */
export async function removeServerState(store: MailStore, accountId: string): Promise<void> {
  await removeServerChatState(store, accountId)
  await store.setChatMeta(serverHistoryKey(accountId), null)
  if ((await store.chatMeta(SERVER_ACCOUNT)) === accountId) {
    await store.setChatMeta(SERVER_ACCOUNT, null)
  }
}
