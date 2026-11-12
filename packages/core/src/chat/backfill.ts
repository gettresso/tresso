import type { MailStore } from '../store/mailStore'

/**
 * The chat value (see MailStore.chatMeta) that marks a copy brought up to the version with chats in place: it may have
 * dropped chat rows the delta brought before, so it checks once whether the server holds any (see backfillChats).
 */
export const CHAT_BACKFILL = 'backfill'

/** What backfillChats did: nothing to check, no chats on the server, a sync from the start, or try again next start. */
export type ChatBackfill = 'none' | 'no-chats' | 'resync' | 'later'

/**
 * Run at the start of a session, after the sign-in is confirmed and before the first pull. A copy marked by the
 * update asks the server for its chat accounts (GET /api/v1/chat-accounts): when there is one, the copy syncs again
 * from the start, so it fetches the chats it dropped; either way the mark is cleared. A token without chat access
 * (403) has no chats to fetch. A request that fails otherwise leaves the mark, for the next start.
 *
 * This leaves no gap: a chat account made after the check gets change numbers above the copy's cursor, so the normal
 * pull brings it and everything under it.
 */
export async function backfillChats(
  store: Pick<MailStore, 'chatMeta' | 'setChatMeta' | 'resyncFromStart'>,
  fetchChatAccounts: () => Promise<readonly unknown[]>,
): Promise<ChatBackfill> {
  if ((await store.chatMeta(CHAT_BACKFILL)) === null) {
    return 'none'
  }
  let accounts: readonly unknown[]
  try {
    accounts = await fetchChatAccounts()
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status !== 403) {
      return 'later'
    }
    accounts = []
  }
  if (accounts.length > 0) {
    // Marked first, cleared after: a restart in between asks again rather than skipping the sync from the start.
    await store.resyncFromStart()
  }
  await store.setChatMeta(CHAT_BACKFILL, null)
  return accounts.length > 0 ? 'resync' : 'no-chats'
}
