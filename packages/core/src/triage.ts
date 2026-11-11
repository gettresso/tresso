/**
 * Triage: the user's unprocessed mail, one conversation at a time, each decided as something to do (D), to hand over
 * (H) or to know (K). Pure state, shared by the web client and the phone; the screens run the actions.
 */

import type { ConversationSummary } from './sync/conversation'
import type { SyncedSmartInbox } from './sync/types'

/** What the user decided for a conversation. */
export type TriageDecision = 'do' | 'delegate' | 'know'

/**
 * Whether a conversation waits for triage: it is in an inbox (spam never is) and the user did not decide where it
 * belongs yet. A conversation the user placed (`classificationReason` `user`, which triage's do and hand over set)
 * or archived (know) is done.
 */
export function needsTriage(conversation: Pick<ConversationSummary, 'inbox' | 'classificationReason'>): boolean {
  return conversation.inbox && conversation.classificationReason !== 'user'
}

/**
 * Where do and hand over put a conversation: it keeps its smart inbox (the kind of mail it is) and gets the verdict;
 * one in no smart inbox yet, or in Spam, goes to the built-in Todo. null when that is missing too (the smart inboxes
 * did not arrive yet).
 */
export function triagePlacement(
  decision: 'do' | 'delegate',
  smartInboxId: string | null,
  smartInboxes: Pick<SyncedSmartInbox, 'id' | 'builtin'>[],
): { smartInboxId: string; verdict: 'do' | 'delegate' } | null {
  const current = smartInboxes.find((smartInbox) => smartInbox.id === smartInboxId)
  const target = current !== undefined && current.builtin !== 'spam' ? current : smartInboxes.find((smartInbox) => smartInbox.builtin === 'todo')

  return target === undefined ? null : { smartInboxId: target.id, verdict: decision }
}

/** A decision taken in a round; `id` tells two decisions on the same conversation apart (undo works by it). */
export interface TriageEntry {
  readonly id: number
  readonly threadId: string
  readonly decision: TriageDecision
}

export interface TriageState {
  /** The conversations of this round, in the order they are shown (newest first, like the inbox; arrivals at the end). */
  readonly queue: readonly string[]
  /** Where the user is in the queue; equal to its length when the round is over. */
  readonly position: number
  /** Decisions taken in this round, oldest first. */
  readonly decided: readonly TriageEntry[]
  /** Conversations that left the queue some other way (archived on another device, placed from the list). */
  readonly gone: ReadonlySet<string>
}

/** A round over the conversations waiting now. */
export function startTriage(threadIds: readonly string[]): TriageState {
  return { queue: [...threadIds], position: 0, decided: [], gone: new Set() }
}

/** The conversation on screen, or null when the round is over. */
export function currentTriage(state: TriageState): string | null {
  return state.queue[state.position] ?? null
}

/** Goes on to the next conversation that still waits, leaving this one as it is. */
export function skipTriage(state: TriageState): TriageState {
  return settle({ ...state, position: Math.min(state.position + 1, state.queue.length) })
}

/** Records decision `id` for the conversation on screen and goes on. */
export function decideTriage(state: TriageState, decision: TriageDecision, id: number): TriageState {
  const threadId = currentTriage(state)
  if (threadId === null) {
    return state
  }

  return skipTriage({ ...state, decided: [...state.decided, { id, threadId, decision }] })
}

/** The last decision of the round, or null when there is none. */
export function lastTriageDecision(state: TriageState): TriageEntry | null {
  return state.decided[state.decided.length - 1] ?? null
}

/**
 * Takes back decision `id` (the last one when none is given) once undone, or once it did not happen: that
 * conversation is on screen again. Unchanged when there is no such decision.
 */
export function undoTriage(state: TriageState, id?: number): TriageState {
  const entry = id === undefined ? lastTriageDecision(state) : (state.decided.find((candidate) => candidate.id === id) ?? null)
  if (entry === null) {
    return state
  }
  const gone = new Set(state.gone)
  gone.delete(entry.threadId)
  const position = state.queue.indexOf(entry.threadId)

  return { ...state, decided: state.decided.filter((candidate) => candidate !== entry), gone, position: position === -1 ? state.position : position }
}

/**
 * Follows changes from elsewhere. `checked` holds the conversations of the queue that were looked at (all of them when
 * not given), `waiting` those of them that still wait, and `arrivals` the newest waiting conversations, which join the
 * round at its end when they are not in it yet. Conversations that stopped waiting are passed over, unless decided in
 * this round (progress still counts those); one not looked at keeps its state (it was decided when the look began).
 * One that waits again after it was passed over (its undo synced late, it was moved back to the inbox) comes back at
 * the end of the round.
 */
export function followTriage(state: TriageState, waiting: ReadonlySet<string>, arrivals: readonly string[] = [], checked?: ReadonlySet<string>): TriageState {
  const decided = new Set(state.decided.map((entry) => entry.threadId))
  const back = state.queue.filter((threadId, index) => index < state.position && state.gone.has(threadId) && waiting.has(threadId) && !decided.has(threadId))
  const known = new Set(state.queue)
  const fresh = arrivals.filter((threadId) => !known.has(threadId))
  const queue = back.length === 0 && fresh.length === 0 ? state.queue : [...state.queue.filter((threadId) => !back.includes(threadId)), ...back, ...fresh]
  const position = state.position - back.length
  const isWaiting = (threadId: string) => waiting.has(threadId) || fresh.includes(threadId)
  const looked = (threadId: string) => checked === undefined || checked.has(threadId) || fresh.includes(threadId)
  const gone = new Set(queue.filter((threadId) => (looked(threadId) ? !isWaiting(threadId) && !decided.has(threadId) : state.gone.has(threadId))))
  const unchanged = queue === state.queue && gone.size === state.gone.size && [...gone].every((threadId) => state.gone.has(threadId))

  return settle(unchanged ? state : { ...state, queue, position, gone })
}

export interface TriageProgress {
  /** 1-based number of the conversation on screen; equal to `total` once the round is over. */
  shown: number
  /** Conversations in this round, without the ones that left it some other way. */
  total: number
  /** Decisions taken in this round. */
  counts: Record<TriageDecision, number>
}

export function triageProgress(state: TriageState): TriageProgress {
  const counts: Record<TriageDecision, number> = { do: 0, delegate: 0, know: 0 }
  for (const entry of state.decided) {
    counts[entry.decision] += 1
  }
  const total = state.queue.filter((threadId) => !state.gone.has(threadId)).length
  const before = state.queue.slice(0, state.position).filter((threadId) => !state.gone.has(threadId)).length

  return { shown: Math.min(before + 1, total), total, counts }
}

/**
 * Moves past conversations that are gone or decided already, so the one on screen always still waits. Decided ones
 * lie ahead when an earlier decision was taken back (an undo, a request that failed) after later ones were taken.
 */
function settle(state: TriageState): TriageState {
  const decided = new Set(state.decided.map((entry) => entry.threadId))
  let position = state.position
  while (position < state.queue.length && (state.gone.has(state.queue[position]!) || decided.has(state.queue[position]!))) {
    position += 1
  }

  return position === state.position ? state : { ...state, position }
}
