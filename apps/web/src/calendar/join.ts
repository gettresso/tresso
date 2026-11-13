import { canJoin } from '@tresso/core'
import { isDesktop, openInBrowser } from '@/platform/desktop'

/**
 * What the user reads when the desktop shell could not hand a meeting link to the browser. Never the shell's own error:
 * it may repeat the link, and a meeting link is a key to the meeting (it stays out of messages and logs).
 */
export const JOIN_FAILED = 'The meeting could not be opened.'

/**
 * Opens a meeting link outside the app: in the user's browser through the desktop shell's opener, or in a new tab
 * that gets neither this page as its opener nor its address as the referrer. Never inside the app's own window.
 * A link that core's `canJoin` refuses (no https, a host with letters that may imitate another, no dotted host) is
 * not opened: false. Rejects only when the desktop shell fails, with {@link JOIN_FAILED}.
 */
export async function openMeeting(url: string): Promise<boolean> {
  if (!canJoin({ url })) {
    return false
  }
  if (isDesktop) {
    try {
      await openInBrowser(url)
    } catch {
      throw new Error(JOIN_FAILED)
    }
    return true
  }
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}
