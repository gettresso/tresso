import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import App from '../App.vue'
import { useMailStore } from '../stores/mail'
import AppShell from '../views/AppShell.vue'

describe('App', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setActivePinia(createPinia())
  })

  it('offers sign in when signed out', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: AppShell, children: [{ path: '', name: 'unified', component: { template: '<div />' } }] }] })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(App, { global: { plugins: [router] } })
    await flushPromises()

    expect(wrapper.text()).toContain('Sign in')
  })

  it('says to reload, with a button that does, once another tab moved to a newer Tresso', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: AppShell, children: [{ path: '', name: 'unified', component: { template: '<div />' } }] }] })
    await router.push('/')
    await router.isReady()
    const reload = vi.fn<() => void>()
    vi.stubGlobal('location', { ...window.location, reload })

    const wrapper = mount(App, { global: { plugins: [router] } })
    useMailStore().updatedElsewhere = 'Tresso was updated in another tab. Reload this tab to keep using it.'
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('Tresso was updated in another tab.')
    await wrapper.get('[role="alert"] button').trigger('click')
    expect(reload).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('lets no shortcut act behind the payment screen', async () => {
    // A page of its own: the signed-in shell links to routes this test has no need for.
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'unified', component: { template: '<div />' } }] })
    await router.push('/')
    await router.isReady()
    // A signed-in user whose server says 402 to everything but billing.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).endsWith('/api/v1/billing')
          ? new Response(JSON.stringify({ enabled: true, entitled: false, plans: ['monthly'], organizations: [] }), { status: 200 })
          : new Response(JSON.stringify({ title: 'Payment Required', status: 402 }), { status: 402 }),
      ),
    )
    const { useAuthStore } = await import('../stores/auth')
    const auth = useAuthStore()
    auth.tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }
    const wrapper = mount(App, { global: { plugins: [router] }, attachTo: document.body })
    await vi.waitFor(() => expect(document.querySelector('[data-payment-screen] h1')).not.toBeNull())
    const behind = vi.fn<(event: KeyboardEvent) => void>()
    window.addEventListener('keydown', behind)

    expect(auth.paymentRequired).toBe(true)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }))
    // Also a key sent to the screen itself, which has the focus: the calendar's shortcuts listen on the window too.
    document.querySelector('[data-payment-screen] h1')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))
    expect(behind).not.toHaveBeenCalled()

    auth.paymentRequired = false
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }))
    expect(behind).toHaveBeenCalledOnce()
    window.removeEventListener('keydown', behind)
    wrapper.unmount()
    vi.unstubAllGlobals()
  })
})
