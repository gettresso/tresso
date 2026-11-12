import { computed, onScopeDispose, ref, watch } from 'vue'
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
import { config } from '@/config'
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

/**
 * The action under way, as kept for a reload: whose it is (the server and the user, so it is never followed in another
 * session), whether it is an undo, and the folder a move goes to.
 */
interface UnderWay {
  id: string
  undo: boolean
  folderName: string | null
  server: string
  userId: string
}

function isUnderWay(value: unknown): value is UnderWay {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const kept = value as Record<string, unknown>
  return typeof kept.id === 'string' && typeof kept.undo === 'boolean' && (kept.folderName === null || typeof kept.folderName === 'string') && typeof kept.server === 'string' && typeof kept.userId === 'string'
}

/** The action kept in this tab, or null; an entry that is not one (written by an older Tresso, say) is dropped. */
function keptUnderWay(): UnderWay | null {
  const raw = sessionStorage.getItem(UNDER_WAY_KEY)
  if (raw === null) {
    return null
  }
  let kept: unknown
  try {
    kept = JSON.parse(raw)
  } catch {
    kept = null
  }
  if (!isUnderWay(kept)) {
    sessionStorage.removeItem(UNDER_WAY_KEY)
    return null
  }
  return kept
}

function keepUnderWay(underWay: UnderWay | null): void {
  if (underWay === null) {
    sessionStorage.removeItem(UNDER_WAY_KEY)
    return
  }
  sessionStorage.setItem(UNDER_WAY_KEY, JSON.stringify(underWay))
}

/** The wait after the given number of failed polls in a row: 1 s, doubling, at most FAILED_POLL_CAP_MS. */
export function failedPollDelay(failures: number): number {
  return Math.min(1000 * 2 ** (failures - 1), FAILED_POLL_CAP_MS)
}

/** The session the action was followed in ended (a sign-out, another user): it is left without a word. */
class FollowEnded extends Error {
  constructor() {
    super('The session the bulk action belonged to ended.')
    this.name = 'FollowEnded'
  }
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
  /** Asking how an action followed before a reload is doing, before the first answer. */
  const resuming = ref(false)
  /** Whether a bulk action is starting or under way; screens disable their buttons meanwhile. */
  const busy = computed(() => starting.value || resuming.value || running.value !== null)
  const progress = computed(() => {
    if (running.value !== null) {
      return bulkProgressText(running.value)
    }
    return resuming.value ? 'Checking on the bulk action under way…' : starting.value ? 'Starting…' : null
  })
  /** Ends the waits of the follow under way, at a sign-out or when the store goes. */
  let stopFollowing = new AbortController()

  /** Waits, unless the follow is stopped meanwhile. */
  function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new FollowEnded())
        return
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', ended)
        resolve()
      }, ms)
      function ended(): void {
        clearTimeout(timer)
        reject(new FollowEnded())
      }
      signal.addEventListener('abort', ended, { once: true })
    })
  }

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
    // A sign-out meanwhile starts a new follow session; this one then leaves the flag to it.
    const signal = stopFollowing.signal
    try {
      const session = auth.generation
      const first = await auth.send<BulkActionState>('POST', '/api/v1/bulk-actions', request)
      const state = await follow(underWay(first.id, false, folderName ?? null), first, session)
      announce(state, false, folderName)
      return state
    } catch (error) {
      // Not for a request of a session that ended meanwhile: its failure is no longer anyone's concern.
      if (!(error instanceof FollowEnded) && signal === stopFollowing.signal) {
        compose.notify({ text: errorMessage(error), tone: 'error' })
      }
      return null
    } finally {
      if (signal === stopFollowing.signal) {
        starting.value = false
      }
    }
  }

  /** Puts back what the action moved, the way an undo of a single action does. */
  async function undo(id: string): Promise<BulkActionState | null> {
    if (busy.value) {
      compose.notify({ text: 'Wait for the action under way to finish, then undo.', tone: 'error' })
      return null
    }
    starting.value = true
    // A sign-out meanwhile starts a new follow session; this one then leaves the flag to it.
    const signal = stopFollowing.signal
    try {
      const session = auth.generation
      const first = await auth.send<BulkActionState>('POST', `/api/v1/bulk-actions/${encodeURIComponent(id)}/undo`, {})
      const state = await follow(underWay(first.id, true, null), first, session)
      announce(state, true)
      return state
    } catch (error) {
      if (!(error instanceof FollowEnded) && signal === stopFollowing.signal) {
        compose.notify({ text: `Could not undo: ${errorMessage(error)}`, tone: 'error' })
      }
      return null
    } finally {
      if (signal === stopFollowing.signal) {
        starting.value = false
      }
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

  /** The action as kept for a reload, tied to the server and the user it belongs to. */
  function underWay(id: string, isUndo: boolean, folderName: string | null): UnderWay | null {
    const userId = auth.me?.id
    // Not known yet (the server has not said who is signed in): followed now, but not kept for a reload.
    return userId === undefined ? null : { id, undo: isUndo, folderName, server: config.apiUrl, userId }
  }

  /**
   * Follows an action this tab started before a reload to its end, with the notice and its undo: only for the same
   * server and user. One the server no longer knows is let go without a word.
   */
  async function resume(userId: string): Promise<void> {
    const kept = keptUnderWay()
    if (kept === null || busy.value) {
      return
    }
    if (kept.server !== config.apiUrl || kept.userId !== userId) {
      keepUnderWay(null)
      return
    }
    resuming.value = true
    try {
      announce(await follow(kept, null, auth.generation), kept.undo, kept.folderName ?? undefined)
    } catch (error) {
      if (error instanceof FollowEnded || (error instanceof ApiError && error.status === 404)) {
        return
      }
      compose.notify({ text: kept.undo ? `Could not undo: ${errorMessage(error)}` : errorMessage(error), tone: 'error' })
    } finally {
      resuming.value = false
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
  async function follow(kept: UnderWay | null, first: BulkActionState | null, session: number): Promise<BulkActionState> {
    const id = kept?.id ?? first!.id
    const signal = stopFollowing.signal
    // The session that asked for it ended while the request was under way.
    const ended = (): boolean => signal.aborted || session !== auth.generation || !auth.isAuthenticated
    if (ended()) {
      throw new FollowEnded()
    }
    keepUnderWay(kept)
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
          await pause(failedPollDelay(failures), signal)
        } else if (state !== null) {
          await pause(bulkPollDelay(attempt++), signal)
        }
        try {
          state = await auth.api<BulkActionState>(`/api/v1/bulk-actions/${encodeURIComponent(id)}`)
        } catch (error) {
          if (ended()) {
            throw new FollowEnded()
          }
          // The action is not there (anymore), or the session ended: asking again changes nothing.
          if (error instanceof ApiError && (error.status === 401 || error.status === 404)) {
            throw error
          }
          failures += 1
          if (failures >= MAX_POLL_FAILURES) {
            break
          }
          continue
        }
        if (ended()) {
          throw new FollowEnded()
        }
        failures = 0
        running.value = state
        starting.value = false
        resuming.value = false
      }
    } finally {
      // Another follow may have begun since a sign-out stopped this one; what is on screen is its own.
      if (signal === stopFollowing.signal) {
        running.value = null
        keepUnderWay(null)
      }
    }
    await mail.syncNow()
    if (state === null || bulkActionRunning(state)) {
      throw new Error(LOST_TRACK)
    }

    return state
  }

  /**
   * The session ended (or the copy of another user than the one kept is about to open): the follow under way stops at
   * once, and nothing of it is kept or shown.
   */
  function endFollowing(): void {
    stopFollowing.abort()
    stopFollowing = new AbortController()
    running.value = null
    starting.value = false
    resuming.value = false
    keepUnderWay(null)
  }

  // An action this tab followed before a reload is followed again once the server said who is signed in (only for
  // that user); signed out, nothing is followed or kept.
  watch(
    () => auth.me?.id ?? null,
    (userId) => {
      if (userId !== null) {
        void resume(userId)
      }
    },
    { immediate: true },
  )
  watch(
    () => auth.isAuthenticated,
    (authenticated) => {
      if (!authenticated) {
        endFollowing()
      }
    },
    { immediate: true },
  )
  onScopeDispose(() => stopFollowing.abort())

  return { running, busy, progress, cancel, count, senders, suggestions, start, undo, reset: endFollowing }
})
