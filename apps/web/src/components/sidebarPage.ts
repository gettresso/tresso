import type { RouteLocationNormalizedLoaded } from 'vue-router'

/** The screens of their own that the sidebar marks as the one on screen; lists of mail mark themselves. */
export type SidebarPage = 'brief' | 'todos' | 'waiting' | 'calendar' | 'triage' | 'drafts' | 'cleanup' | 'outbox' | 'search' | 'settings'

const pages: Record<string, SidebarPage> = {
  brief: 'brief',
  'brief-edition': 'brief',
  todos: 'todos',
  todo: 'todos',
  waiting: 'waiting',
  calendar: 'calendar',
  triage: 'triage',
  drafts: 'drafts',
  cleanup: 'cleanup',
  outbox: 'outbox',
  search: 'search',
}

/** Which sidebar item a route belongs to; undefined for a list of mail (an inbox, a smart inbox, the batches). */
export function sidebarPage(route: Pick<RouteLocationNormalizedLoaded, 'name' | 'path'>): SidebarPage | undefined {
  if (route.path.startsWith('/settings')) {
    return 'settings'
  }

  return typeof route.name === 'string' ? pages[route.name] : undefined
}
