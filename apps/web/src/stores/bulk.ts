import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  bulkActionRunning,
  bulkPollDelay,
  bulkProgressText,
  bulkResultText,
  bulkSelectionQuery,
  type BulkActionRequest,
  type BulkActionState,
  type BulkScope,
  type BulkSelectionCount,
  type CleanupSuggestionList,
  type SmartInboxSenders,
} from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { useAuthStore } from '@/stores/auth'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'

/** How long the notice with the undo stays, in ms: a bulk action is bigger than one conversation, so a little longer. */
const RESULT_NOTICE_MS = 15_000
/** Where the action under way is kept, so a reload of the tab still follows it to its result and its undo. */
const UNDER_WAY_KEY = 'tresso.bulkAction'
/** Polls that may fail in a row (offline, a deploy) before the store stops following the action. */
const MAX_POLL_FAILURES = 10
/** The wait after a failed poll, doubling per failure in a row up to this. */
const FAILED_POLL_CAP_MS = 30_000
export const LOST_TRACK = 'Tresso lost track of the bulk action. It may still finish; the lists catch up as it does.'

/** The action under way, as kept for a reload: whether it is an undo, and the folder a move goes to. */
interface UnderWay {
  id: string
  undo: boolean
  folderName: string | null
}

function keptUnderWay(): UnderWay | null {
  const raw = sessionStorage.getItem(UNDER_WAY_KEY)
  return raw === null ? null : (JSON.parse(raw) as UnderWay)
}

function keepUnderWay(underWay: UnderWay | null): void {
  if (underWay === null) {
    sessionStorage.removeItem(UNDER_WAY_KEY)
    return
  }
  sessionStorage.setItem(UNDER_WAY_KEY, JSON.stringify(underWay))
}

function failedPollDelay(failures: number): number {
  return Math.min(1000 * 2 ** failures, FAILED_POLL_CAP_MS)
}

/**
 * Bulk actions on a whole scope (a smart inbox, one of its senders, mail older than an age, a cleanup suggestion).
 * The server works through them in batches; this follows one until it is done, says how it went with an undo, and
 * pulls the synced copy, whose lists also change batch by batch through the delta meanwhile. One at a time: kept
 * here rather than in a screen, so it goes on when the user moves elsewhere.
 */
export const useBulkStore = defineStore('bulk', () => {
  const auth = useAuthStore()
  const compose = useComposeStore()
  const mail = useMailStore()

  /** The action (or undo) the server is working through. */
  const running = ref<BulkActionState | null>(null)
  /** Asking the server to start one: a second click meanwhile must not start another. */
  const starting = ref(false)
  /** Whether a bulk action is starting or under way; screens disable their buttons meanwhile. */
  const busy = computed(() => starting.value || running.value !== null)
  const progress = computed(() => (running.value === null ? (starting.value ? 'Starting…' : null) : bulkProgressText(running.value)))

  function count(scope: BulkScope): Promise<BulkSelectionCount> {
    return auth.api<BulkSelectionCount>(`/api/v1/bulk-selection?${bulkSelectionQuery(scope)}`)
  }

  function senders(smartInboxId: string): Promise<SmartInboxSenders> {
    return auth.api<SmartInboxSenders>(`/api/v1/smart-inboxes/${encodeURIComponent(smartInboxId)}/senders`)
  }

  async function suggestions(): Promise<CleanupSuggestionList> {
    return auth.api<CleanupSuggestionList>('/api/v1/cleanup-suggestions')
  }

  /**
   * Starts the action and follows it until it is done. Returns how it ended, or null when it did not start (another
   * one is running, or the server refused it; that is said in a notice).
   *
   * @param folderName the folder a move goes to, for the notice
   */
  async function start(request: BulkActionRequest, folderName?: string): Promise<BulkActionState | null> {
    if (busy.value) {
      compose.notify({ text: 'Another bulk action is still under way. Try again once it is done.', tone: 'error' })
      return null
    }
    starting.value = true
    try {
      const first = await auth.send<BulkActionState>('POST', '/api/v1/bulk-actions', request)
      const state = await follow({ id: first.id, undo: false, folderName: folderName ?? null }, first)
      announce(state, false, folderName)
      return state
    } catch (error) {
      compose.notify({ text: errorMessage(error), tone: 'error' })
      return null
    } finally {
      starting.value = false
    }
  }

  /** Puts back what the action moved, the way an undo of a single action does. */
  async function undo(id: string): Promise<BulkActionState | null> {
    if (busy.value) {
      compose.notify({ text: 'Wait for the action under way to finish, then undo.', tone: 'error' })
      return null
    }
    starting.value = true
    try {
      const first = await auth.send<BulkActionState>('POST', `/api/v1/bulk-actions/${encodeURIComponent(id)}/undo`, {})
      const state = await follow({ id: first.id, undo: true, folderName: null }, first)
      announce(state, true)
      return state
    } catch (error) {
      compose.notify({ text: `Could not undo: ${errorMessage(error)}`, tone: 'error' })
      return null
    } finally {
      starting.value = false
    }
  }

  /** Says how the action (or undo) ended; an action that changed what can be put back offers the undo. */
  function announce(state: BulkActionState, isUndo: boolean, folderName?: string): void {
    if (isUndo) {
      compose.notify({ text: bulkResultText(state), tone: state.status === 'failed' ? 'error' : 'info' })
      return
    }
    compose.notify(
      {
        text: bulkResultText(state, folderName),
        tone: state.status === 'failed' ? 'error' : 'info',
        action: state.canUndo && state.changed > state.unrestorable ? { label: 'Undo', run: () => void undo(state.id) } : undefined,
      },
      RESULT_NOTICE_MS,
    )
  }

  /** Follows an action this tab started before a reload to its end, with the notice and its undo. */
  async function resume(): Promise<void> {
    const kept = keptUnderWay()
    if (kept === null || busy.value) {
      return
    }
    starting.value = true
    try {
      announce(await follow(kept, null), kept.undo, kept.folderName ?? undefined)
    } catch (error) {
      compose.notify({ text: kept.undo ? `Could not undo: ${errorMessage(error)}` : errorMessage(error), tone: 'error' })
    } finally {
      starting.value = false
    }
  }

  /** Stops the action (or undo) under way; what it did stays done, and the notice that follows offers the undo. */
  async function cancel(): Promise<void> {
    const id = running.value?.id
    if (id === undefined) {
      return
    }
    try {
      const stopped = await auth.send<BulkActionState>('POST', `/api/v1/bulk-actions/${encodeURIComponent(id)}/cancel`, {})
      // The poll may have seen it end meanwhile: an answer arriving after that must not bring it back as running.
      if (running.value?.id === id) {
        running.value = stopped
      }
    } catch (error) {
      compose.notify({ text: `Could not stop it: ${errorMessage(error)}`, tone: 'error' })
    }
  }

  /**
   * Asks how the action is doing, soon at first and then less often, until the server stopped working on it. A poll
   * that fails (offline, a deploy) is asked again after a growing wait, as the server goes on working; only after
   * many failures in a row does it stop following, saying so. Without `first` (a reload), it asks right away.
   */
  async function follow(underWay: UnderWay, first: BulkActionState | null): Promise<BulkActionState> {
    keepUnderWay(underWay)
    let state = first
    running.value = state
    if (state !== null) {
      starting.value = false
    }
    let attempt = 0
    let failures = 0
    try {
      while (state === null || bulkActionRunning(state)) {
        if (failures > 0) {
          await new Promise((resolve) => setTimeout(resolve, failedPollDelay(failures)))
        } else if (state !== null) {
          await new Promise((resolve) => setTimeout(resolve, bulkPollDelay(attempt++)))
        }
        try {
          state = await auth.api<BulkActionState>(`/api/v1/bulk-actions/${encodeURIComponent(underWay.id)}`)
        } catch (error) {
          // Signed out, or the action is not there (anymore): asking again changes nothing.
          if (!auth.isAuthenticated || (error instanceof ApiError && (error.status === 401 || error.status === 404))) {
            throw error
          }
          failures += 1
          if (failures >= MAX_POLL_FAILURES) {
            break
          }
          continue
        }
        failures = 0
        running.value = state
        starting.value = false
      }
    } finally {
      running.value = null
      keepUnderWay(null)
    }
    await mail.syncNow()
    if (state === null || bulkActionRunning(state)) {
      throw new Error(LOST_TRACK)
    }

    return state
  }

  // An action this tab followed before a reload is followed again; a sign-out forgets it.
  watch(
    () => auth.isAuthenticated,
    (authenticated, before) => {
      if (authenticated) {
        void resume()
      } else if (before === true) {
        keepUnderWay(null)
      }
    },
    { immediate: true },
  )

  return { running, busy, progress, cancel, count, senders, suggestions, start, undo }
})
