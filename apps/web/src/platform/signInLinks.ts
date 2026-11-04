import type { RouteLocationRaw } from 'vue-router'

/**
 * The pages a provider sign-in (connecting Gmail or Microsoft 365) may come back to, by the `next` the API puts in the
 * link. Nothing else: a link is not trusted to pick a page.
 */
const CONNECT_PAGES = new Map([
  ['/settings/accounts/new', 'settings-accounts-new'],
  ['/settings/accounts', 'settings-accounts'],
])

/**
 * Where a link the desktop app was opened with leads. Both kinds of sign-in come back through this app's redirect URI:
 * signing in to Tresso goes to the callback screen with its parameters (code and state, or the error); connecting a
 * mail account at Google or Microsoft carries the page it started on in `next`, which gets the provider's answer to
 * finish there. Anything else is not ours and is ignored.
 */
export function signInRoute(link: string, redirectUri: string): RouteLocationRaw | null {
  const queryStart = link.indexOf('?')
  const base = queryStart === -1 ? link : link.slice(0, queryStart)
  if (base !== redirectUri) {
    return null
  }
  const { next, ...query } = Object.fromEntries(new URLSearchParams(queryStart === -1 ? '' : link.slice(queryStart + 1)))
  if (next === undefined) {
    return { name: 'auth-callback', query }
  }
  const page = CONNECT_PAGES.get(next)
  return page === undefined ? null : { name: page, query }
}
