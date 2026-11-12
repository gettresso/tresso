import { isPermissionGranted, onAction, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { isDesktop, showMainWindow } from '@/platform/desktop'
import type { MailNotification } from '@/mail/mailNotifications'

/** Shows notifications outside the app. */
export interface Notifier {
  show(notifications: MailNotification[]): Promise<void>
}

/**
 * The sound a notification that may make one plays: the plugin names system sounds per platform, and plays none
 * without a name, which is how silent notifications (quiet hours, busy) come.
 */
export function desktopSound(userAgent: string): string {
  if (/Mac OS X|Macintosh/.test(userAgent)) {
    return 'Ping'
  }
  return /Windows/.test(userAgent) ? 'Mail' : 'message-new-email'
}

/** The desktop app: native notifications, asking the operating system for permission the first time. */
const desktopNotifier: Notifier = {
  async show(notifications) {
    if (notifications.length === 0) {
      return
    }
    if (!(await isPermissionGranted()) && (await requestPermission()) !== 'granted') {
      return
    }
    const sound = desktopSound(navigator.userAgent)
    for (const notification of notifications) {
      sendNotification({ title: notification.title, body: notification.body, extra: { path: notification.path }, ...(notification.silent ? {} : { sound }) })
    }
  },
}

/**
 * The browser build shows none from the page: the server sends browsers Web Push, which the service worker shows
 * (public/push-worker.js), also while no tab is open.
 */
export const notifier: Notifier | null = isDesktop ? desktopNotifier : null

/** The path a clicked notification carries, if it is one of ours. */
export function clickedPath(extra: Record<string, unknown> | undefined): string | null {
  const path = extra?.path
  return typeof path === 'string' && path.startsWith('/') ? path : null
}

/**
 * The desktop app: a click on a notification brings the window to the front and opens what the notification is about
 * (the conversation). Notifications shown before this listener existed are not reported (see the plugin's onAction).
 */
export async function onNotificationClick(open: (path: string) => void): Promise<void> {
  if (!isDesktop) {
    return
  }
  await onAction((event) => {
    if (event.actionId !== 'tap') {
      return
    }
    // Also from a window that was closed (hidden) on macOS; the conversation opens in it.
    showMainWindow().catch((error: unknown) => console.error('Showing the window failed', error))
    const path = clickedPath(event.notification?.extra)
    if (path !== null) {
      open(path)
    }
  })
}

/**
 * Starts listening for clicks without holding anything up: the window mounts at once, and a listener that cannot be
 * registered is reported (the app works without it, only clicks open nothing).
 */
export function startNotificationClicks(open: (path: string) => void, report: (error: unknown) => void): void {
  onNotificationClick(open).catch(report)
}
