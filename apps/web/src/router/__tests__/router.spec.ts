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

      expect(sessionStorage.getItem('tresso.returnPath'), returnTo).toBeNull()
      expect(router.currentRoute.value.fullPath, returnTo).toBe('/')
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
      expect(returnablePath(path), String(path)).toBeNull()
    }
    for (const path of ['/todos/abc', '/inbox/t1?from=push', '/calendar/week/2026-11-11', '/search?q=a%2Fb']) {
      expect(returnablePath(path)).toBe(path)
    }
  })
})
