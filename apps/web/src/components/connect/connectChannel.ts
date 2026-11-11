import type { ProviderConnection } from '@tresso/core'

/**
 * Between the tab that started a provider sign-in and the tab the provider sent back. On the web the provider's page
 * opens in a new tab, which comes back to /settings/accounts/new, finishes the sign-in there and hands the outcome to
 * the tab that waits for it (matched by the OAuth state). Two ways carry it, so neither order of events loses it:
 *
 * - a BroadcastChannel message, which a waiting tab takes at once and answers with `taken`, after which the new tab
 *   closes;
 * - a note in localStorage, which a waiting tab reads when it starts waiting or comes to the front, for an outcome
 *   that arrived before it listened.
 *
 * A new tab that comes back signed out of Tresso cannot finish the sign-in; it says so the same two ways, so the
 * waiting tab can tell the user instead of waiting for ever. Cancelling in the waiting tab is noted too, so the new tab
 * does not finish a sign-in the user gave up on.
 *
 * Needs the sign-in shared between tabs (tokens in localStorage), or the new tab is always signed out.
 */
const NAME = 'tresso-connect'
const AWAITING_KEY = 'tresso.connect.awaiting'
const CANCELLED_KEY = 'tresso.connect.cancelled'
const OUTCOME_KEY = 'tresso.connect.outcome'

/** How a sign-in the waiting tab started ended in the other tab. */
export type HandedOver = { kind: 'result'; result: ProviderConnection } | { kind: 'signed-out' }

type Message = { type: 'outcome'; state: string; outcome: HandedOver } | { type: 'taken'; state: string }

interface Noted {
  state: string
  expiresAt: number
}

/** Why a sign-in is no longer waited for: the user cancelled it, or the waiting tab gave up (expired, signed out). */
export type Abandoned = 'cancelled' | 'given-up'

function live<T extends Noted>(list: T[] | null, except?: string): T[] {
  const now = Date.now()
  return (Array.isArray(list) ? list : []).filter((noted) => noted.expiresAt > now && noted.state !== except)
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function read<T>(key: string): T | null {
  try {
    return JSON.parse(storage()?.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) storage()?.removeItem(key)
    else storage()?.setItem(key, JSON.stringify(value))
  } catch {
    // Without storage only the BroadcastChannel carries the outcome; a tab that missed it times out and says so.
  }
}

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(NAME)
}

/**
 * Notes that a tab of this browser waits for the sign-in with this state, until it expires. Per state, so dialogs in
 * several tabs each wait for their own.
 */
export function markAwaiting(state: string, expiresAt: number): void {
  write(AWAITING_KEY, [...live(read<Noted[]>(AWAITING_KEY), state), { state, expiresAt }])
}

export function clearAwaiting(state: string): void {
  write(AWAITING_KEY, live(read<Noted[]>(AWAITING_KEY), state))
}

/** Whether a tab of this browser waits for the sign-in with this state. */
export function isAwaited(state: string): boolean {
  return live(read<Noted[]>(AWAITING_KEY)).some((noted) => noted.state === state)
}

function awaitedUntil(state: string): number {
  return live(read<Noted[]>(AWAITING_KEY)).find((noted) => noted.state === state)?.expiresAt ?? Date.now() + 15 * 60_000
}

/**
 * Notes that the sign-in with this state is no longer waited for: the user cancelled it, or the waiting tab gave up
 * and told the user nothing was connected. The tab the provider sends back then finishes nothing, whenever it arrives
 * (also after the user signed in to Tresso there).
 */
export function markCancelled(state: string, expiresAt: number, reason: Abandoned = 'cancelled'): void {
  write(CANCELLED_KEY, [...live(read<(Noted & { reason?: Abandoned })[]>(CANCELLED_KEY), state), { state, expiresAt, reason }])
}

/** Why the sign-in with this state was abandoned, or null when it was not. */
export function abandoned(state: string): Abandoned | null {
  const noted = live(read<(Noted & { reason?: Abandoned })[]>(CANCELLED_KEY)).find((entry) => entry.state === state)
  return noted === undefined ? null : (noted.reason ?? 'cancelled')
}

export function isCancelled(state: string): boolean {
  return abandoned(state) !== null
}

/**
 * The outcome another tab noted for this state, taken once: it is removed when read. For a waiting tab that was not
 * listening (or not in front) when the outcome came.
 */
export function takeNotedOutcome(state: string): HandedOver | null {
  const noted = read<Noted & { outcome: HandedOver }>(OUTCOME_KEY)
  if (noted === null || noted.state !== state || noted.expiresAt <= Date.now()) return null
  write(OUTCOME_KEY, null)
  return noted.outcome
}

/**
 * Listens for outcomes other tabs report. `take` returns true for an outcome this tab was waiting for.
 *
 * @returns stops listening
 */
export function listenForSignIns(take: (state: string, outcome: HandedOver) => boolean): () => void {
  const listener = channel()
  if (listener === null) return () => {}
  listener.onmessage = (event: MessageEvent<Message>) => {
    const message = event.data
    if (message?.type === 'outcome' && take(message.state, message.outcome)) {
      write(OUTCOME_KEY, null)
      listener.postMessage({ type: 'taken', state: message.state } satisfies Message)
    }
  }
  return () => listener.close()
}

/**
 * Hands an outcome to the tab that waits for this state: notes it in localStorage and posts it on the channel.
 *
 * @param waitMs how long to wait for a tab to take it
 * @returns whether a tab took it within the wait
 */
export function handOver(state: string, outcome: HandedOver, waitMs = 1500): Promise<boolean> {
  write(OUTCOME_KEY, { state, expiresAt: Date.now() + 15 * 60_000, outcome })
  const sender = channel()
  if (sender === null) return Promise.resolve(false)

  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), waitMs)
    function finish(taken: boolean): void {
      clearTimeout(timer)
      sender!.close()
      resolve(taken)
    }
    sender.onmessage = (event: MessageEvent<Message>) => {
      if (event.data?.type === 'taken' && event.data.state === state) finish(true)
    }
    sender.postMessage({ type: 'outcome', state, outcome } satisfies Message)
  })
}

/**
 * For a tab the provider sent back while it is signed out of Tresso (it cannot finish the sign-in): tells the tab
 * that waits for it, so that one says why nothing was connected. True when a tab of this browser waits for it.
 */
export function reportSignedOutReturn(query: Record<string, unknown>): boolean {
  const state = query.state
  if ((query.provider !== 'google' && query.provider !== 'microsoft') || typeof state !== 'string' || !isAwaited(state)) return false
  // Given up from here on: should this tab come back to the page once the user signed in to Tresso, it finishes
  // nothing, since the waiting tab already said nothing was connected.
  markCancelled(state, awaitedUntil(state), 'given-up')
  void handOver(state, { kind: 'signed-out' }, 0)
  return true
}

/** The OAuth state of an authorization URL, which the provider's answer carries back. */
export function stateOf(authorizationUrl: string): string | null {
  try {
    return new URL(authorizationUrl).searchParams.get('state')
  } catch {
    return null
  }
}
