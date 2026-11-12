import { invoke } from '@tauri-apps/api/core'
import type { Sql, SqlValue } from '@tresso/core'

type On = 'reader' | 'writer'

/**
 * This page load. When the web view reloads, the shell drops the handles of earlier page loads (and rolls back what
 * they left open); handles of this one stay, even when two of its opens overlap.
 */
const PAGE = crypto.randomUUID()

/**
 * A mail copy in the desktop shell's SQLite (see `apps/desktop/src-tauri/src/sql.rs`). Reads outside a transaction
 * go to a connection of their own, which sees the last committed state, so they need not wait for a page of the delta
 * being stored.
 */
export async function openDesktopSql(name: string): Promise<Sql> {
  const handle = await invoke<number>('sql_open', { name, page: PAGE })

  function queries(on: On): Omit<Sql, 'transaction' | 'close'> {
    const select = <T>(source: string, params: SqlValue[] = []) => invoke<T[]>('sql_select', { handle, source, params, on })
    return {
      exec: (source) => invoke('sql_exec', { handle, source }),
      run: (source, params = []) => invoke('sql_run', { handle, source, params }),
      all: select,
      first: async <T>(source: string, params: SqlValue[] = []) => (await select<T>(source, params))[0] ?? null,
    }
  }
  const nested = () => Promise.reject(new Error('Transactions do not nest.'))

  return {
    ...queries('reader'),
    // The store queues its writes, so only one transaction is ever open on the writer.
    transaction: async (task) => {
      await invoke('sql_begin', { handle })
      try {
        await task({ ...queries('writer'), transaction: nested, close: nested })
        await invoke('sql_commit', { handle })
      } catch (error) {
        // A failed COMMIT leaves the transaction open too. The caller hears the original error; a rollback that fails
        // as well is logged, and the next transaction rolls back what is left before it begins.
        await invoke('sql_rollback', { handle }).catch((rollbackError: unknown) => console.error('Undoing a failed write failed', rollbackError))
        throw error
      }
    },
    close: () => invoke('sql_close', { handle }),
  }
}

/** Removes a closed copy from the computer. */
export function deleteDesktopSql(name: string): Promise<void> {
  return invoke('sql_delete', { name })
}

/**
 * The names of the mail copies in the desktop app's data folder (`tresso-mail-<userId>[-<serverTag>]`), so copies an
 * earlier release left without listing them can be found. Names only: the shell returns no paths.
 */
export function listDesktopSql(): Promise<string[]> {
  return invoke<string[]>('sql_list')
}
