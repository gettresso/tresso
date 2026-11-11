import { afterEach, describe, expect, it, vi } from 'vitest'

// The desktop app with a sign-in in the keychain, which answers only after a moment, as the real keychain does.
vi.mock(import('@/platform/desktop'), async (importOriginal) => ({
  ...(await importOriginal()),
  isDesktop: true,
  loadKeychainTokens: () =>
    new Promise<string | null>((resolve) =>
      setTimeout(() => resolve(JSON.stringify({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 })), 10),
    ),
  onDeepLinks: async () => {},
}))
vi.mock(import('@/platform/notifier'), async (importOriginal) => ({ ...(await importOriginal()), startNotificationClicks: () => {} }))
// The app itself is not what this is about: only which screen the first navigation lands on.
vi.mock('@/App.vue', () => ({ default: { render: () => null } }))

describe('starting the app', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('in the desktop app, reads the sign-in before the first navigation, so a reload stays on the signed-in screen', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    document.body.innerHTML = '<div id="app"></div>'
    window.history.replaceState(null, '', '/settings/billing')

    await import('@/main')
    const { default: router } = await import('@/router')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('settings-billing')
  })
})
