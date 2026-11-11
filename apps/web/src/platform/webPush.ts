import type { NewNotificationDevice, NotificationDevice } from '@tresso/core'
import { isDesktop } from '@/platform/desktop'

/** The service worker that shows pushes and opens what a clicked one is about (public/push-worker.js). */
export const PUSH_WORKER = `${import.meta.env.BASE_URL}push-worker.js`

type Api = <T>(method: 'POST' | 'DELETE', path: string, body?: unknown) => Promise<T>
type Get = <T>(path: string) => Promise<T>

/**
 * Web Push in this browser: notifications the server sends (reminders, mail that needs the user), shown by the
 * service worker also while no Tresso tab is open. The desktop app shows its notifications natively instead.
 */
export function webPushSupported(): boolean {
  return !isDesktop && typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** The VAPID public key (base64url) as the bytes PushManager.subscribe takes. */
export function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const base64 = publicKey.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(publicKey.length / 4) * 4, '=')
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** What the server needs to push to a subscription. */
export function deviceOf(subscription: PushSubscriptionJSON, name: string): NewNotificationDevice {
  const { endpoint, keys } = subscription
  if (endpoint === undefined || keys?.p256dh === undefined || keys.auth === undefined) {
    throw new Error('The browser gave a push subscription without its keys.')
  }
  return { kind: 'web_push', endpoint, publicKey: keys.p256dh, authSecret: keys.auth, name }
}

/** A name the user recognizes in their list of devices. */
export function browserName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser'
  const system = /Mac OS X/.test(userAgent) ? 'macOS' : /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /Linux/.test(userAgent) ? 'Linux' : null
  return system === null ? browser : `${browser} on ${system}`
}

/** This browser's push subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!webPushSupported()) {
    return null
  }
  const registration = await navigator.serviceWorker.getRegistration(PUSH_WORKER)
  return (await registration?.pushManager.getSubscription()) ?? null
}

/**
 * Who turned Web Push on in this browser, kept where the push worker reads it too (Cache Storage, shared with it): the
 * worker shows a push only when it is for that user. The server says in every push whom it is for (userId).
 */
const OWNER_CACHE = 'tresso-push'
const OWNER_KEY = '/push-owner'

async function setPushOwner(userId: string | null): Promise<void> {
  const cache = await caches.open(OWNER_CACHE)
  if (userId === null) {
    await cache.delete(OWNER_KEY)
    return
  }
  await cache.put(OWNER_KEY, new Response(userId))
}

export async function pushOwner(): Promise<string | null> {
  const stored = await (await caches.open(OWNER_CACHE)).match(OWNER_KEY)
  return stored === undefined ? null : stored.text()
}

/**
 * Asks the browser for permission, subscribes it with the server's key and registers it as a device of this user.
 * Registering again (the same endpoint) only updates the device.
 */
export async function enableWebPush(get: Get, send: Api, userId: string): Promise<void> {
  if (!webPushSupported()) {
    throw new Error('This browser cannot show notifications from Tresso.')
  }
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error('Notifications are blocked for Tresso in this browser. Allow them in the site settings and try again.')
  }
  const { publicKey } = await get<{ publicKey: string | null }>('/api/v1/notification-devices/web-push-key')
  if (publicKey === null) {
    throw new Error('This Tresso server does not send browser notifications (it has no Web Push key).')
  }
  const registration = await navigator.serviceWorker.register(PUSH_WORKER)
  await navigator.serviceWorker.ready
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) }))
  await setPushOwner(userId)
  await send<NotificationDevice>('POST', '/api/v1/notification-devices', deviceOf(subscription.toJSON(), browserName(navigator.userAgent)))
}

/**
 * Stops pushes to this browser: the subscription in the browser goes first, always, and then the device on the server.
 * A subscription that is gone makes the server's next push to it fail as gone, and the server then removes the device
 * itself, so even a sign-out that cannot reach the server, or that stops waiting for it, stops the pushes.
 */
export async function disableWebPush(send: Api): Promise<void> {
  const subscription = await currentSubscription()
  if (subscription === null) {
    return
  }
  // What the server knows the device by, read before the subscription goes.
  const device = deviceOf(subscription.toJSON(), browserName(navigator.userAgent))
  try {
    await subscription.unsubscribe()
  } finally {
    await setPushOwner(null)
  }
  // Registering the same endpoint again names the device it already is, which the list does not show.
  const registered = await send<NotificationDevice>('POST', '/api/v1/notification-devices', device)
  await send('DELETE', `/api/v1/notification-devices/${registered.id}`)
}

/**
 * Someone else signed in here: pushes another user turned on in this browser stop (they did not sign out, e.g. they
 * closed the tab). Returns whether it stopped any.
 */
export async function releaseOtherUsersPush(userId: string): Promise<boolean> {
  const subscription = await currentSubscription()
  if (subscription === null || (await pushOwner()) === userId) {
    return false
  }
  await subscription.unsubscribe()
  await setPushOwner(null)
  return true
}

/** The path a message from the push worker asks an open tab to show (a clicked notification), if it is one. */
export function openedPath(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== 'tresso:open') {
    return null
  }
  const path = (data as { path?: unknown }).path
  return typeof path === 'string' && path.startsWith('/') ? path : null
}

/** An open tab: a click on one of this browser's notifications opens what it is about here. */
export function onPushClick(open: (path: string) => void): void {
  if (!webPushSupported()) {
    return
  }
  navigator.serviceWorker.addEventListener('message', (event) => {
    const path = openedPath(event.data)
    if (path !== null) {
      open(path)
    }
  })
}
