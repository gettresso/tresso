import { draftOnlyHere, SqliteMailStore, type MailStore } from '@tresso/core'
import { databaseName, deleteMailDatabase, IndexedDbMailStore, type ClosedElsewhere } from '@/mail/db'
import { isDesktop } from '@/platform/desktop'
import { deleteDesktopSql, openDesktopSql } from '@/platform/desktopSql'
import { server, serverTag } from '@/platform/server'

/**
 * Opens the user's mail copy: SQLite in the desktop app, IndexedDB in the browser. The first time the desktop app
 * opens one, drafts that exist only in the web view's old IndexedDB copy are carried over and that copy is removed.
 * In the browser, `onClosedElsewhere` hears when another tab or the browser closes the copy under this tab.
 */
export async function openMailStore(userId: string, onClosedElsewhere?: (reason: ClosedElsewhere) => void): Promise<MailStore> {
  if (!isDesktop) {
    return IndexedDbMailStore.open(userId, onClosedElsewhere)
  }
  const store = await SqliteMailStore.open(await openDesktopSql(desktopName(userId)))
  try {
    await moveIndexedDbDrafts(userId, store)
  } catch (error) {
    // The old copy stays, so nothing is lost; moving is tried again the next time.
    console.error('Moving drafts from the old mail copy failed', error)
  }
  return store
}

/** Removes everything stored for a user, e.g. on sign-out. The copy must be closed. */
export async function deleteMailStore(userId: string): Promise<void> {
  if (isDesktop) {
    await deleteDesktopSql(desktopName(userId))
  }
  // In the desktop app too: an old IndexedDB copy may still be there when moving its drafts failed.
  await deleteMailDatabase(userId)
}

/**
 * The desktop copy of a user on the server the app talks to now. User ids are only unique per server, and a copy whose
 * session expired stays on disk, so a copy from another server (a restored backup, a staging clone) is never reused.
 */
function desktopName(userId: string): string {
  const tag = serverTag(server.value)
  return tag === '' ? databaseName(userId) : `${databaseName(userId)}-${tag}`
}

async function moveIndexedDbDrafts(userId: string, store: MailStore): Promise<void> {
  const name = databaseName(userId)
  if (!(await indexedDB.databases()).some((database) => database.name === name)) {
    return
  }
  const old = await IndexedDbMailStore.open(userId)
  try {
    for (const draft of (await old.drafts()).filter(draftOnlyHere)) {
      if ((await store.draft(draft.id)) === null) {
        await store.saveDraft(draft)
      }
      // Gone from the old copy once moved: if moving stops halfway, a draft the user sent or deleted since is not
      // brought back by the next attempt.
      await old.deleteDraft(draft.id)
    }
  } finally {
    await old.close()
  }
  await deleteMailDatabase(userId)
}
