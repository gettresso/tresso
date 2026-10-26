import { ref, type Ref } from 'vue'
import { PartialActionError, undoPlan, type AppliedAction, type MessageAction, type SyncedFolder, type UndoMove } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'

/**
 * Message actions as screens use them: errors become notices, one action runs at a time, and archiving, trashing or
 * moving offers an undo that puts back exactly what moved.
 *
 * @param busy the guard to use; pass one that outlives the component when it can be unmounted mid-action
 */
export function useMessageActions(busy: Ref<boolean> = ref(false)) {
  const mail = useMailStore()
  const compose = useComposeStore()
  let before: Promise<void> = Promise.resolve()

  /** Lets actions taken from now on wait for this first (e.g. reading a conversation on open). */
  function after(task: Promise<unknown>): void {
    before = task.then(
      () => undefined,
      () => undefined,
    )
  }

  /**
   * Returns what changed: everything, the part the server took when a large selection went partly through (the rest
   * is reported), or null when nothing did.
   */
  async function run(messageIds: string[], action: MessageAction, folderId?: string): Promise<AppliedAction | null> {
    try {
      return await mail.act(messageIds, action, { folderId })
    } catch (error) {
      if (error instanceof PartialActionError) {
        const rest = error.rejected
        compose.notify({ text: `${rest === 1 ? 'One message was' : `${rest} messages were`} not changed: ${errorMessage(error.reason)}`, tone: 'error' })
        return error.accepted
      }
      compose.notify({ text: errorMessage(error), tone: 'error' })
      return null
    }
  }

  /**
   * Runs one action at a time: a second click or a held key during an action is ignored rather than acting on its
   * result. An action waits for what {@link after} was given, then runs.
   */
  async function exclusive(task: () => Promise<void>): Promise<void> {
    if (busy.value) {
      return
    }
    busy.value = true
    try {
      await before
      await task()
    } finally {
      busy.value = false
    }
  }

  /**
   * Archives, trashes or moves the messages and says so, with an undo that puts back exactly what can be (not, for
   * example, messages that were in several folders, since a move takes every copy); the notice says how many it
   * cannot. Returns what changed, as {@link run} does.
   */
  async function relocate(messageIds: string[], action: 'archive' | 'trash' | 'move', folders: SyncedFolder[], folderId?: string): Promise<AppliedAction | null> {
    const applied = await run(messageIds, action, folderId)
    if (applied === null) {
      return null
    }
    const label = action === 'archive' ? 'Archived' : action === 'trash' ? 'Moved to Trash' : `Moved to ${folders.find((folder) => folder.id === folderId)?.displayName ?? 'the folder'}`
    const plan = undoPlan(applied, action, folders)
    const left = plan.unrestorable
    const caveat = left === 0 || plan.moves.length === 0 ? '' : ` Undo cannot put ${left === 1 ? 'one message' : `${left} messages`} back.`
    compose.notify({
      text: `${label}.${caveat}`,
      tone: 'info',
      action: plan.moves.length > 0 ? { label: 'Undo', run: () => void undo(plan.moves) } : undefined,
    })
    return applied
  }

  /** Puts back what an undo plan moves; says what could not be. Returns the moves that failed, to try again. */
  async function undo(moves: UndoMove[]): Promise<UndoMove[]> {
    const failed: UndoMove[] = []
    let reason = ''
    for (const move of moves) {
      try {
        await mail.act(move.messageIds, 'move', { folderId: move.folderId, fromFolderId: move.fromFolderId })
      } catch (error) {
        failed.push(move)
        reason = errorMessage(error)
      }
    }
    const count = failed.reduce((sum, move) => sum + move.messageIds.length, 0)
    if (count > 0) {
      compose.notify({ text: `${count === 1 ? 'One message' : `${count} messages`} could not be put back: ${reason}`, tone: 'error' })
    }
    return failed
  }

  return { busy, after, run, exclusive, relocate, undo }
}

/** Whether a key press is meant for shortcuts: not typing, not writing, not in a menu, not held, no modifiers. */
export function shortcutAllowed(event: KeyboardEvent, composing: boolean): boolean {
  const target = event.target instanceof HTMLElement ? event.target : null
  const typing = target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  const inDialog = target?.closest('[role="dialog"], dialog[open]') != null
  const inMenu = target?.closest('[role="menu"]') != null
  return !(typing || composing || inDialog || inMenu || event.repeat || event.isComposing || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey)
}
