import type { RouteLocationRaw } from 'vue-router'

/**
 * The pages a provider sign-in (connecting Gmail or Microsoft 365) may come back to, by the `next` the API puts in the
 * link, besides the page of an import list ({@link IMPORT_PAGE}). Nothing else: a link is not trusted to pick a page.
 */
const CONNECT_PAGES = new Map([
  ['/settings/accounts/new', 'settings-accounts-new'],
  ['/settings/accounts', 'settings-accounts'],
])

/** The page of a mail account import list: /settings/accounts/import/<uuid>, nothing more. */
const IMPORT_PAGE = /^\/settings\/accounts\/import\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

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
  if (page !== undefined) {
    return { name: page, query }
  }
  // The page of a mail account import list, by its id only.
  const importList = IMPORT_PAGE.exec(next)
  return importList === null ? null : { name: 'settings-accounts-import', params: { importId: importList[1]!.toLowerCase() }, query }
}

/**
 * Where a link the desktop app receives leads, like {@link signInRoute}, except for an answer to signing in to Tresso
 * when no sign-in is under way in this window: one that was finished already, or a stray link from a web page. That
 * one is ignored instead of replacing the current screen with a failed sign-in.
 */
export function desktopLinkRoute(link: string, redirectUri: string, signInPending: boolean): RouteLocationRaw | null {
  const route = signInRoute(link, redirectUri)
  const signInAnswer = route !== null && typeof route === 'object' && 'name' in route && route.name === 'auth-callback'
  return signInAnswer && !signInPending ? null : route
}
