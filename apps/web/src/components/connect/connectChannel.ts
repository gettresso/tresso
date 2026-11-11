import type { ProviderConnection } from '@tresso/core'

/**
 * Between the tab that started a provider sign-in and the tab the provider sent back: on the web the sign-in opens in
 * a new tab, which comes back to /settings/accounts/new, finishes the sign-in there and tells the tab that started
 * it. That tab takes the outcome only for the sign-in it is waiting for (matched by the OAuth state) and says so; the
 * new tab then closes. Without an answer it shows the outcome itself.
 */
const NAME = 'tresso-connect'
/** The sign-in a tab waits for, so the tab the provider sends back knows whether to tell anyone (and wait for it). */
const AWAITING_KEY = 'tresso.connect.awaiting'

type Message = { type: 'result'; state: string; result: ProviderConnection } | { type: 'taken'; state: string }

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(NAME)
}

/**
 * Listens for outcomes other tabs finished. `take` returns true for an outcome this tab was waiting for.
 *
 * @returns stops listening
 */
export function listenForSignIns(take: (state: string, result: ProviderConnection) => boolean): () => void {
  const listener = channel()
  if (listener === null) return () => {}
  listener.onmessage = (event: MessageEvent<Message>) => {
    const message = event.data
    if (message?.type === 'result' && take(message.state, message.result)) {
      listener.postMessage({ type: 'taken', state: message.state } satisfies Message)
    }
  }
  return () => listener.close()
}

/**
 * Tells the other tabs how a sign-in ended.
 *
 * @returns whether a tab took it within the wait
 */
export function announceSignIn(state: string, result: ProviderConnection, waitMs = 1500): Promise<boolean> {
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
    sender.postMessage({ type: 'result', state, result } satisfies Message)
  })
}

/** Notes that this browser waits for the sign-in with this state, until it expires. */
export function markAwaiting(state: string, expiresAt: number): void {
  try {
    localStorage.setItem(AWAITING_KEY, JSON.stringify({ state, expiresAt }))
  } catch {
    // Without storage the tab the provider sends back shows the outcome itself, as it does without a waiting tab.
  }
}

export function clearAwaiting(): void {
  try {
    localStorage.removeItem(AWAITING_KEY)
  } catch {
    // Nothing was stored then either.
  }
}

/** Whether a tab of this browser waits for the sign-in with this state. */
export function isAwaited(state: string): boolean {
  try {
    const stored = JSON.parse(localStorage.getItem(AWAITING_KEY) ?? 'null') as { state?: unknown; expiresAt?: unknown } | null
    return stored?.state === state && typeof stored.expiresAt === 'number' && stored.expiresAt > Date.now()
  } catch {
    return false
  }
}

/** The OAuth state of an authorization URL, which the provider's answer carries back. */
export function stateOf(authorizationUrl: string): string | null {
  try {
    return new URL(authorizationUrl).searchParams.get('state')
  } catch {
    return null
  }
}
