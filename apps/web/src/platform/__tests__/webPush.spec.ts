import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applicationServerKey, browserName, deviceOf, disableWebPush, openedPath, pushOwner, releaseOtherUsersPush } from '../webPush'

describe('applicationServerKey', () => {
  it('reads the base64url VAPID key without padding as its bytes', () => {
    expect([...applicationServerKey('AQID_-8')]).toEqual([1, 2, 3, 255, 239])
  })
})

describe('deviceOf', () => {
  it('registers the subscription with its keys', () => {
    expect(deviceOf({ endpoint: 'https://push.example.test/1', keys: { p256dh: 'p', auth: 'a' } }, 'Firefox on macOS')).toEqual({
      kind: 'web_push',
      endpoint: 'https://push.example.test/1',
      publicKey: 'p',
      authSecret: 'a',
      name: 'Firefox on macOS',
    })
  })

  it('refuses a subscription without keys', () => {
    expect(() => deviceOf({ endpoint: 'https://push.example.test/1' }, 'Firefox')).toThrow('without its keys')
  })
})

describe('browserName', () => {
  it('names the browser and the system', () => {
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) Gecko/20100101 Firefox/150.0')).toBe('Firefox on macOS')
    expect(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0 Safari/537.36 Edg/150.0')).toBe('Edge on Windows')
    expect(browserName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0 Safari/537.36')).toBe('Chrome on Linux')
    expect(browserName('Unknown')).toBe('Browser')
  })
})

describe('openedPath', () => {
  it('takes the path a clicked notification opens, and nothing else', () => {
    expect(openedPath({ type: 'tresso:open', path: '/thread/t1' })).toBe('/thread/t1')
    expect(openedPath({ type: 'tresso:open', path: 'https://elsewhere.example/' })).toBeNull()
    expect(openedPath({ type: 'other', path: '/thread/t1' })).toBeNull()
    expect(openedPath('tresso:open')).toBeNull()
  })
})

describe('the subscription of this browser', () => {
  let subscription: { endpoint: string; unsubscribe: ReturnType<typeof vi.fn>; toJSON: () => PushSubscriptionJSON } | null
  let stored: Map<string, string>

  beforeEach(() => {
    subscription = { endpoint: 'https://push.example.test/1', unsubscribe: vi.fn<() => Promise<boolean>>(async () => true), toJSON: () => ({ endpoint: 'https://push.example.test/1', keys: { p256dh: 'p', auth: 'a' } }) }
    stored = new Map([['/push-owner', 'kim']])
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', class {})
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (key: string) => (stored.has(key) ? new Response(stored.get(key)) : undefined),
        put: async (key: string, response: Response) => void stored.set(key, await response.text()),
        delete: async (key: string) => stored.delete(key),
      }),
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })

  it('goes on sign-out: the device on the server, and the subscription even when the server cannot be told', async () => {
    const send = vi.fn<(method: string, path: string) => Promise<{ id: string }>>(async (method) => {
      if (method === 'DELETE') {
        throw new Error('offline')
      }
      return { id: 'device-1' }
    })

    await expect(disableWebPush(send as never)).rejects.toThrow('offline')

    expect(send.mock.calls.map(([method, path]) => `${method} ${path}`)).toEqual(['POST /api/v1/notification-devices', 'DELETE /api/v1/notification-devices/device-1'])
    expect(subscription!.unsubscribe).toHaveBeenCalled()
    expect(stored.has('/push-owner')).toBe(false)
  })

  it('goes from the browser before the server is asked, so a sign-out that stops waiting for the server still drops it', async () => {
    const send = vi.fn<(method: string, path: string) => Promise<{ id: string }>>(() => new Promise(() => {}))

    void disableWebPush(send as never)

    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    expect(subscription!.unsubscribe).toHaveBeenCalled()
    expect(stored.has('/push-owner')).toBe(false)
  })

  it('goes when another user signs in here, and stays for the user who turned it on', async () => {
    expect(await releaseOtherUsersPush('kim')).toBe(false)
    expect(subscription!.unsubscribe).not.toHaveBeenCalled()

    expect(await releaseOtherUsersPush('lisa')).toBe(true)
    expect(subscription!.unsubscribe).toHaveBeenCalled()
    expect(await pushOwner()).toBeNull()
  })
})
