import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { mailNotificationPath } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'
import AuthCallbackView from '@/views/AuthCallbackView.vue'
import SignInView from '@/views/SignInView.vue'
import router from '../index'

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
    await router.push({ name: 'unified', query: { returnTo: '//evil.example/x' } })

    await signInHere()

    expect(router.currentRoute.value.fullPath).toBe('/')
  })
})
