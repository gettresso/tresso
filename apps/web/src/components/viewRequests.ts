import { onBeforeUnmount, onMounted } from 'vue'

/**
 * Something asked of a view that may not be on screen yet: the menu bar's New Event (the calendar opens its editor),
 * New To-do (the to-dos focus their quick add) and Find (the search field takes the focus). The view on screen that
 * handles it does so at once; otherwise the request waits for one to mount.
 */
export type ViewRequest = 'newEvent' | 'quickAddTodo' | 'focusSearch'

const handlers = new Map<ViewRequest, (() => void)[]>()
const waiting = new Set<ViewRequest>()

/** Asks for it; true when a view on screen took it now, false when it waits for one to mount. */
export function askView(request: ViewRequest): boolean {
  const list = handlers.get(request) ?? []
  const handler = list[list.length - 1]
  if (handler === undefined) {
    waiting.add(request)
    return false
  }
  waiting.delete(request)
  handler()
  return true
}

/** Forgets what was asked and never taken, e.g. at a sign-out. */
export function forgetViewRequests(): void {
  waiting.clear()
}

/** Handles the request while the returned function is not called; one that waits is handled at once. */
export function onViewRequest(request: ViewRequest, handler: () => void): () => void {
  const list = handlers.get(request) ?? []
  list.push(handler)
  handlers.set(request, list)
  if (waiting.delete(request)) {
    handler()
  }
  return () => {
    const current = handlers.get(request) ?? []
    handlers.set(
      request,
      current.filter((candidate) => candidate !== handler),
    )
  }
}

/** For a component: handles the request while it is mounted (the newest one mounted takes it). */
export function useViewRequest(request: ViewRequest, handler: () => void): void {
  let stop: (() => void) | null = null
  onMounted(() => {
    stop = onViewRequest(request, handler)
  })
  onBeforeUnmount(() => stop?.())
}
