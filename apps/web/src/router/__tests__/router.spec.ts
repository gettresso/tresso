import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { mailNotificationPath } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'
import AuthCallbackView from '@/views/AuthCallbackView.vue'
import SignInView from '@/views/SignInView.vue'
import router from '../index'
import { returnablePath } from '../returnPath'

describe('router', () => {
  beforeEach(() => setActivePinia(createPinia()))

  afterEach(() => sessionStorage.clear())

  it('opens the conversation a notification leads to in the Unified Inbox', async () => {
    await router.push(mailNotificationPath('t1'))

    expect(router.currentRoute.value.name).toBe('unified-thread')
    expect(router.currentRoute.value.params.threadId).toBe('t1')
  })

  /** Signs in from the sign-in screen on the route the router is on, through the callback. */
  async function signInHere(): Promise<void> {
    const auth = useAuthStore()
    vi.spyOn(auth, 'signIn').mockResolvedValue()
    vi.spyOn(auth, 'completeSignIn').mockImplementation(async () => {
      auth.tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }
    })
    const screen = mount(SignInView, { global: { plugins: [router] } })
    await screen.get('button.sign-in').trigger('click')
    screen.unmount()
    // The sign-in page sends the browser back here.
    await router.push('/auth/callback?code=c&state=s')
    mount(AuthCallbackView, { global: { plugins: [router] } })
    // The screen may load first.
    await vi.waitFor(() => expect(router.currentRoute.value.name).not.toBe('auth-callback'))
    await flushPromises()
  }

  it('opens a screen that needs a sign-in once the visitor signed in', async () => {
    await router.push('/todos/abc')
    expect(router.currentRoute.value.name).toBe('unified')

    await signInHere()

    expect(router.currentRoute.value.name).toBe('todo')
    expect(router.currentRoute.value.params.todoId).toBe('abc')
  })

  it('opens the conversation a link led to once the visitor signed in', async () => {
    await router.push(mailNotificationPath('t1'))

    await signInHere()

    expect(router.currentRoute.value.name).toBe('unified-thread')
    expect(router.currentRoute.value.params.threadId).toBe('t1')
  })

  it("keeps a provider's one-time code out of the address bar and the return path when it meets a signed-out tab", async () => {
    await router.push('/settings/accounts?provider=microsoft&state=state-1&code=one-time-code')

    expect(router.currentRoute.value.name).toBe('unified')
    expect(router.currentRoute.value.fullPath).not.toContain('one-time-code')
    expect(router.currentRoute.value.query.returnTo).toBe('/settings/accounts')

    await signInHere()

    // Back on the accounts page, where the account still says what it needs; nothing is finished with an old code.
    expect(router.currentRoute.value.fullPath).toBe('/settings/accounts')
  })

  it('goes to the Unified Inbox after a sign-in started there', async () => {
    sessionStorage.setItem('tresso.returnPath', '/todos/old')
    await router.push('/')

    await signInHere()

    expect(router.currentRoute.value.fullPath).toBe('/')
  })

  it('never leaves the app for a path that leads elsewhere', async () => {
    for (const returnTo of ['//evil.example/x', '/%09/evil.example', '/%2F/evil.example', '/\\evil.example']) {
      setActivePinia(createPinia())
      await router.push({ name: 'unified', query: { returnTo } })

      await signInHere()

      expect(sessionStorage.getItem('tresso.returnPath')).toBeNull()
      expect(router.currentRoute.value.fullPath).toBe('/')
    }
  })
  it('shows the Unified Inbox for a path that matches no screen', async () => {
    useAuthStore().tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }

    for (const path of ['/nope', '/inbox', '/calender']) {
      await router.push(path)
      expect(router.currentRoute.value.name).toBe('unified')
    }
  })

  it('shows the first settings page for a settings path that matches none', async () => {
    useAuthStore().tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }

    await router.push('/settings/nope')

    expect(router.currentRoute.value.name).toBe('settings-accounts')
  })
  it('keeps only paths that stay inside the app', () => {
    for (const path of ['//evil.example/x', '/\\evil.example/x', '/%09/evil.example', '/\t/evil.example', '/\n//evil.example', 'https://evil.example/', 'javascript:alert(1)', '/auth/callback?code=c', '/%2F/evil.example', ['/todos/abc'], null]) {
      expect(returnablePath(path)).toBeNull()
    }
    for (const path of ['/todos/abc', '/inbox/t1?from=push', '/calendar/week/2026-11-11', '/search?q=a%2Fb', '/search?q=a%5Cb']) {
      expect(returnablePath(path)).toBe(path)
    }
  })

  it('refuses the sign-in callback in any case, as the router matches it in any case', () => {
    for (const path of ['/auth/callback', '/AUTH/callback', '/Auth/Callback?code=c', '/x/../auth/callback']) {
      expect(returnablePath(path)).toBeNull()
    }
  })

  it('keeps paths inside the desktop app, which runs under a scheme of its own', () => {
    for (const app of [new URL('tauri://localhost/'), new URL('http://tauri.localhost/')]) {
      expect(returnablePath('/todos/abc', app)).toBe('/todos/abc')
      expect(returnablePath('/inbox/t1?from=push', app)).toBe('/inbox/t1?from=push')
      expect(returnablePath('//evil.example/x', app)).toBeNull()
      expect(returnablePath('/%09/evil.example', app)).toBeNull()
      expect(returnablePath('/AUTH/callback', app)).toBeNull()
    }
  })
})
