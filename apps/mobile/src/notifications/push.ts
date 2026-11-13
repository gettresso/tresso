import type { NewNotificationDevice, NotificationDevice } from '@tresso/core'

type Api = <T>(path: string, init?: RequestInit) => Promise<T>

/** What the phone does for push: Expo's notifications module in the app, a fake in tests. */
export interface PushPlatform {
  /** Whether the user lets the app notify, asking them the first time. */
  permitted(): Promise<boolean>
  /** This phone's Expo push token (ExponentPushToken[...]). */
  token(): Promise<string>
  /** Calls back when the token changes (a reinstall, a restore on a new phone); returns the function that stops it. */
  onTokenChange(listener: () => void): () => void
  /** The name the user sees in their list of devices. */
  name: string
}

/** Where the phone keeps the id of the device it registered, so a sign-out can remove it again. */
export interface DeviceIdStore {
  get(): Promise<string | null>
  set(id: string | null): Promise<void>
}

/**
 * Registers this phone for the user's pushes (reminders, mail that needs them): once signed in, and again whenever
 * the token changes. Registering the same token again only updates the device. Returns the function that stops it.
 */
export function startPushRegistration(api: Api, platform: PushPlatform, store: DeviceIdStore, onError: (error: unknown) => void): () => void {
  let stopped = false
  const register = async () => {
    try {
      if (!(await platform.permitted()) || stopped) {
        return
      }
      const device: NewNotificationDevice = { kind: 'expo', endpoint: await platform.token(), name: platform.name }
      const registered = await api<NotificationDevice>('/api/v1/notification-devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(device),
      })
      await store.set(registered.id)
    } catch (error) {
      if (!stopped) {
        onError(error)
      }
    }
  }
  void register()
  const stopListening = platform.onTokenChange(() => void register())
  return () => {
    stopped = true
    stopListening()
  }
}

/**
 * On sign-out: removes this phone from the user's devices, so their notifications stop coming here. Throws when the
 * server could not be told; the id is kept then, and the next sign-in on this phone takes the device over.
 */
export async function forgetPushDevice(api: Api, store: DeviceIdStore): Promise<void> {
  const id = await store.get()
  if (id === null) {
    return
  }
  await api<void>(`/api/v1/notification-devices/${id}`, { method: 'DELETE' })
  await store.set(null)
}

/**
 * The screens a notification may open on the phone, by the path the server gives (PushMessage.php): a conversation
 * (mail), a WhatsApp chat, the batches (a batch's summary), the daily brief, the todos and Waiting on (a hand-over).
 * Paths the phone has no screen for (a calendar event) open the app as it is.
 */
const TAP_ROUTES = [/^\/thread\/[^/?#]+$/, /^\/chats\/[^/?#]+$/, /^\/batches$/, /^\/brief(\?[^#]*)?$/, /^\/todos$/, /^\/waiting(\?[^#]*)?$/]

/** Where a tapped notification leads in the app, or null to open it as it is. */
export function tappedRoute(data: unknown): string | null {
  const path = typeof data === 'object' && data !== null ? (data as { path?: unknown }).path : undefined
  return typeof path === 'string' && TAP_ROUTES.some((route) => route.test(path)) ? path : null
}

export interface ForegroundBehavior {
  shouldShowBanner: boolean
  shouldShowList: boolean
  shouldPlaySound: boolean
  shouldSetBadge: boolean
}

/**
 * How a push shows while the app is open: mail and WhatsApp messages go to the list only (the user is in the app
 * already), silent deliveries (quiet hours, focus) without banner or sound, reminders as a banner with sound.
 */
export function foregroundBehavior(data: unknown): ForegroundBehavior {
  const payload = typeof data === 'object' && data !== null ? (data as { kind?: unknown; silent?: unknown }) : {}
  const quiet = payload.kind === 'mail' || payload.kind === 'whatsapp' || payload.silent === true

  return { shouldShowBanner: !quiet, shouldShowList: true, shouldPlaySound: !quiet, shouldSetBadge: false }
}
