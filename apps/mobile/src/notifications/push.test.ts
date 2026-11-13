import { describe, expect, it, vi } from 'vitest'
import { foregroundBehavior, forgetPushDevice, startPushRegistration, tappedRoute, type DeviceIdStore, type PushPlatform } from './push'

/** An api that answers every request with the same body (or failure), and records the requests. */
function fakeApi(answer: () => Promise<unknown> = async () => ({ id: 'device-1' })) {
  const calls: [string, RequestInit | undefined][] = []
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    calls.push([path, init])
    return (await answer()) as T
  }
  return { api, calls }
}

function memoryStore(id: string | null = null): DeviceIdStore & { id: string | null } {
  const store = {
    id,
    get: async () => store.id,
    set: async (next: string | null) => {
      store.id = next
    },
  }
  return store
}

function platform(overrides: Partial<PushPlatform> = {}): PushPlatform & { changeToken(): void } {
  let listener: (() => void) | null = null
  return {
    permitted: async () => true,
    token: async () => 'ExponentPushToken[abc]',
    onTokenChange: (next) => {
      listener = next
      return () => (listener = null)
    },
    name: 'Pixel 10',
    changeToken: () => listener?.(),
    ...overrides,
  }
}

describe('startPushRegistration', () => {
  it('registers the phone with its Expo token and remembers the device', async () => {
    const { api, calls } = fakeApi()
    const store = memoryStore()

    startPushRegistration(api, platform(), store, () => {})

    await vi.waitFor(() => expect(store.id).toBe('device-1'))
    expect(calls).toEqual([
      [
        '/api/v1/notification-devices',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'expo', endpoint: 'ExponentPushToken[abc]', name: 'Pixel 10' }) },
      ],
    ])
  })

  it('registers again when the token changes, and not after it stopped', async () => {
    const { api, calls } = fakeApi()
    const phone = platform()
    const stop = startPushRegistration(api, phone, memoryStore(), () => {})
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    phone.changeToken()
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    stop()
    phone.changeToken()

    expect(calls).toHaveLength(2)
  })

  it('registers nothing when the user does not allow notifications', async () => {
    const { api, calls } = fakeApi()
    const store = memoryStore()

    startPushRegistration(api, platform({ permitted: async () => false }), store, () => {})
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toEqual([])
    expect(store.id).toBeNull()
  })

  it('reports what went wrong', async () => {
    const onError = vi.fn()

    startPushRegistration(fakeApi().api, platform({ token: async () => Promise.reject(new Error('no project id')) }), memoryStore(), onError)

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(new Error('no project id')))
  })
})

describe('forgetPushDevice', () => {
  it('removes the registered device and forgets it', async () => {
    const { api, calls } = fakeApi(async () => undefined)
    const store = memoryStore('device-1')

    await forgetPushDevice(api, store)

    expect(calls).toEqual([['/api/v1/notification-devices/device-1', { method: 'DELETE' }]])
    expect(store.id).toBeNull()
  })

  it('keeps the id when the server could not be told', async () => {
    const store = memoryStore('device-1')

    await expect(forgetPushDevice(fakeApi(async () => Promise.reject(new Error('offline'))).api, store)).rejects.toThrow('offline')

    expect(store.id).toBe('device-1')
  })

  it('has nothing to do for a phone that never registered', async () => {
    const { api, calls } = fakeApi()

    await forgetPushDevice(api, memoryStore())

    expect(calls).toEqual([])
  })
})

describe('tappedRoute', () => {
  it('opens the conversation of a mail notification, the daily brief and the todos', () => {
    expect(tappedRoute({ kind: 'mail', path: '/thread/0199-abc' })).toBe('/thread/0199-abc')
    expect(tappedRoute({ kind: 'mail', path: '/batches' })).toBe('/batches')
    expect(tappedRoute({ kind: 'daily_brief', path: '/brief' })).toBe('/brief')
    expect(tappedRoute({ path: '/brief?date=2026-10-20' })).toBe('/brief?date=2026-10-20')
    expect(tappedRoute({ path: '/todos' })).toBe('/todos')
  })

  it('opens the chat of a WhatsApp notification', () => {
    expect(tappedRoute({ kind: 'whatsapp', path: '/chats/0199-c1', chatId: '0199-c1' })).toBe('/chats/0199-c1')
    expect(tappedRoute({ kind: 'whatsapp', path: '/chats/0199-c1/more' })).toBeNull()
    expect(tappedRoute({ kind: 'whatsapp', path: '/chats/' })).toBeNull()
  })

  it('opens Waiting on for a hand-over past its due date', () => {
    expect(tappedRoute({ kind: 'hand_over', path: '/waiting?nudge=0199-h1' })).toBe('/waiting?nudge=0199-h1')
    expect(tappedRoute({ path: '/waiting' })).toBe('/waiting')
    expect(tappedRoute({ path: '/waiting/elsewhere' })).toBeNull()
  })

  it('opens nothing for paths the phone has no screen for, or that leave the app', () => {
    expect(tappedRoute({ kind: 'reminder', path: '/calendar/events/e1' })).toBeNull()
    expect(tappedRoute({ path: '/thread/t1/extra' })).toBeNull()
    expect(tappedRoute({ path: 'https://elsewhere.example/thread/t1' })).toBeNull()
    expect(tappedRoute({ path: null })).toBeNull()
    expect(tappedRoute(null)).toBeNull()
  })
})

describe('foregroundBehavior', () => {
  it('puts mail in the list only while the app is open', () => {
    expect(foregroundBehavior({ kind: 'mail', silent: false })).toEqual({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false })
  })

  it('puts a WhatsApp message in the list only while the app is open', () => {
    expect(foregroundBehavior({ kind: 'whatsapp', silent: false })).toEqual({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false })
  })

  it('shows reminders as a banner with sound, unless they came silently', () => {
    expect(foregroundBehavior({ kind: 'reminder', silent: false })).toEqual({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false })
    expect(foregroundBehavior({ kind: 'reminder', silent: true })).toMatchObject({ shouldShowBanner: false, shouldPlaySound: false })
  })
})
