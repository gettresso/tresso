/**
 * The links this desktop window handled already. The deep link plugin keeps returning the link the app was started
 * with from `getCurrent()`, also after the window reloads (a billing check, or Reload in the context menu), and a
 * sign-in answer must not be handled twice. Kept in sessionStorage, which a reload keeps and a restart clears.
 */
const KEY = 'desktop.handledLinks'
/** Enough for any number of links one window sees; the oldest go first. */
const KEEP = 20

function handled(storage: Storage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((link): link is string => typeof link === 'string') : []
  } catch {
    return []
  }
}

export function wasHandled(link: string, storage: Storage = sessionStorage): boolean {
  return handled(storage).includes(link)
}

export function markHandled(link: string, storage: Storage = sessionStorage): void {
  const links = [...handled(storage).filter((known) => known !== link), link].slice(-KEEP)
  storage.setItem(KEY, JSON.stringify(links))
}
