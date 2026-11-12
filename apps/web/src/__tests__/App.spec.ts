import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import App from '../App.vue'
import { useMailStore } from '../stores/mail'
import { useAuthStore } from '../stores/auth'
import { useComposeStore } from '../stores/compose'
import AppShell from '../views/AppShell.vue'

describe('App', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not start the mail copy for a user whose /me answer arrives after the sign-out', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'unified', component: { template: '<div />' } }] })
    await router.push('/')
    await router.isReady()
    let answerMe!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).endsWith('/api/v1/me')
          ? new Promise<Response>((resolve) => (answerMe = resolve))
          : Promise.resolve(Response.json({ enabled: false, entitled: true, plans: [], organizations: [] })),
      ),
    )
    vi.stubGlobal('location', { ...window.location, assign: vi.fn<(url: string) => void>() })
    const auth = useAuthStore()
    auth.tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }
    const mail = useMailStore()
    const start = vi.spyOn(mail, 'start').mockResolvedValue()
    const wrapper = mount(App, { global: { plugins: [router] } })
    await vi.waitFor(() => expect(answerMe).toBeDefined())

    await auth.signOut()
    answerMe(Response.json({ id: 'user-1', email: 'anna@example.com' }))
    await flushPromises()

    expect(auth.me).toBeNull()
    expect(start).not.toHaveBeenCalled()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('tells a signed-in user when the sign-in could not be kept on this device', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'unified', component: { template: '<div />' } }] })
    await router.push('/')
    await router.isReady()
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const auth = useAuthStore()
    auth.tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }
    mount(App, { global: { plugins: [router] } })

    const text = 'The sign-in could not be kept on this device, so you will have to sign in again next time: denied'
    auth.storageError = text
    auth.storageFailures++
    await flushPromises()
    // The same failure again (the next refresh): said again, though the text did not change.
    auth.storageFailures++
    await flushPromises()

    expect(useComposeStore().notices.filter((notice) => notice.text === text)).toHaveLength(2)
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

  it('offers to try again when sync stopped', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: AppShell, children: [{ path: '', name: 'unified', component: { template: '<div />' } }] }] })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(App, { global: { plugins: [router] } })
    const mail = useMailStore()
    const syncNow = vi.spyOn(mail, 'syncNow').mockResolvedValue()
    // A copy that syncs, whose pull failed.
    mail.synced = true
    mail.syncState = 'error'
    mail.syncError = 'The server could not be reached'
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('Sync stopped: The server could not be reached')
    // Along the bottom edge while no draft is open; it lies below the compose window and the notices either way.
    expect(wrapper.get('[role="alert"]').classes()).not.toContain('with-draft')
    await wrapper.get('[role="alert"] button').trigger('click')
    expect(syncNow).toHaveBeenCalled()
  })

  it('hides a sync error on request, and shows a different one again', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: AppShell, children: [{ path: '', name: 'unified', component: { template: '<div />' } }] }] })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(App, { global: { plugins: [router] } })
    const mail = useMailStore()
    mail.syncState = 'error'
    mail.syncError = 'The server could not be reached'
    await flushPromises()

    await wrapper.get('[role="alert"] button[aria-label="Hide this message"]').trigger('click')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    mail.syncError = 'Signing in to kim@company.example failed'
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Signing in to kim@company.example failed')
  })

  it('shows a hidden sync error again on a later outage, once a pull worked in between', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: AppShell, children: [{ path: '', name: 'unified', component: { template: '<div />' } }] }] })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(App, { global: { plugins: [router] } })
    const mail = useMailStore()
    mail.syncState = 'error'
    mail.syncError = 'Failed to fetch'
    await flushPromises()
    await wrapper.get('[role="alert"] button[aria-label="Hide this message"]').trigger('click')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    // A retry on its way changes nothing; a pull that worked does.
    mail.syncState = 'syncing'
    await flushPromises()
    mail.syncState = 'error'
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    mail.syncState = 'idle'
    await flushPromises()
    mail.syncState = 'error'
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Sync stopped: Failed to fetch')
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
  it('writes no new message on "C" while a modal dialog is open', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'unified', component: { template: '<div />' } }] })
    await router.push('/')
    await router.isReady()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ title: 'Unavailable' }), { status: 503 })))
    const { useAuthStore } = await import('../stores/auth')
    useAuthStore().tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }
    const { useComposeStore } = await import('../stores/compose')
    const openNew = vi.spyOn(useComposeStore(), 'openNew').mockImplementation(() => undefined)
    mount(App, { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    const dialog = document.createElement('dialog')
    const button = document.createElement('button')
    dialog.append(button)
    document.body.append(dialog)
    dialog.setAttribute('open', '')

    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    expect(openNew).not.toHaveBeenCalled()
    dialog.remove()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', repeat: true, bubbles: true }))
    expect(openNew).not.toHaveBeenCalled()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    expect(openNew).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  describe('a start that fails', () => {
    const me = { id: 'user-1', email: 'ada@example.com', displayName: 'Ada', createdAt: '2026-01-01T00:00:00+00:00' }

    /** A signed-in tab whose server answers /me with what `answers` says, one per call, and 200 to the rest. */
    async function signedIn(answers: (() => Response)[], knownUserId?: string) {
      const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'unified', component: { template: '<div />' } }] })
      await router.push('/')
      await router.isReady()
      const fetchMe = vi.fn<() => Response>()
      answers.forEach((answer) => fetchMe.mockImplementationOnce(answer))
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).endsWith('/api/v1/me')) {
            return fetchMe()
          }
          if (String(url).endsWith('/api/v1/billing')) {
            return new Response(JSON.stringify({ enabled: false, entitled: true, plans: [], organizations: [] }))
          }
          return new Response(null, { status: 204 })
        }),
      )
      const { useAuthStore } = await import('../stores/auth')
      const auth = useAuthStore()
      auth.tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000, ...(knownUserId === undefined ? {} : { userId: knownUserId }) }
      const mail = useMailStore()
      const start = vi.spyOn(mail, 'start').mockResolvedValue()
      return { router, start, fetchMe, auth }
    }

    const offline = () => {
      throw new TypeError('Failed to fetch')
    }
    const answered = () => new Response(JSON.stringify(me))

    it('says so with a Retry button, and starts once the device is back online', async () => {
      const { router, start } = await signedIn([offline, answered])
      const wrapper = mount(App, { global: { plugins: [router] } })
      await flushPromises()

      expect(start).not.toHaveBeenCalled()
      expect(wrapper.get('[role="alert"]').text()).toContain('Failed to fetch')
      expect(wrapper.get('[role="alert"] button').text()).toBe('Retry')

      window.dispatchEvent(new Event('online'))
      await flushPromises()

      expect(start).toHaveBeenCalledWith('user-1', { confirmed: true })
      expect(wrapper.text()).not.toContain('could not start')
      vi.unstubAllGlobals()
    })

    it('starts again when the user presses Retry', async () => {
      const { router, start } = await signedIn([() => new Response(JSON.stringify({ title: 'Bad Gateway' }), { status: 502 }), answered])
      const wrapper = mount(App, { global: { plugins: [router] } })
      await flushPromises()

      await wrapper.get('[role="alert"] button').trigger('click')
      await flushPromises()

      expect(start).toHaveBeenCalledWith('user-1', { confirmed: true })
      expect(wrapper.text()).not.toContain('could not start')
      vi.unstubAllGlobals()
    })

    it('tries again by itself after a wait', async () => {
      vi.useFakeTimers()
      const { router, start } = await signedIn([offline, offline, answered])
      const wrapper = mount(App, { global: { plugins: [router] } })
      await flushPromises()

      await vi.advanceTimersByTimeAsync(5_000)
      expect(start).not.toHaveBeenCalled()
      // The second wait is longer than the first.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(start).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5_000)

      expect(start).toHaveBeenCalledWith('user-1', { confirmed: true })
      expect(wrapper.text()).not.toContain('could not start')
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('opens the copy of the user last confirmed for the tokens before the server answers, only to read it', async () => {
      const { router, start } = await signedIn([offline], 'user-1')
      mount(App, { global: { plugins: [router] } })
      await flushPromises()

      expect(start).toHaveBeenCalledExactlyOnceWith('user-1', { confirmed: false })
      vi.unstubAllGlobals()
    })

    it('says the mail on screen is kept on this device while it cannot reach the server', async () => {
      const { router } = await signedIn([offline], 'user-1')
      const wrapper = mount(App, { global: { plugins: [router] } })
      useMailStore().ready = true
      await flushPromises()

      expect(wrapper.text()).toContain('Showing mail kept on this device. Tresso is still connecting.')
      expect(wrapper.text()).not.toContain('could not start')
      expect(wrapper.findAll('button').some((button) => button.text() === 'Try again')).toBe(true)
      vi.unstubAllGlobals()
    })

    it('starts again from the sync error when the copy could not be opened again', async () => {
      const { router, start } = await signedIn([answered, answered])
      const wrapper = mount(App, { global: { plugins: [router] } })
      await flushPromises()
      expect(start).toHaveBeenCalledOnce()
      const mail = useMailStore()
      mail.syncState = 'error'
      mail.syncError = 'The mail on this device was removed elsewhere and could not be opened again: refused'
      await flushPromises()

      await wrapper.findAll('button').find((button) => button.text() === 'Try again')!.trigger('click')
      await flushPromises()

      // The user is known now: the copy opens to be read, then the start confirms it.
      expect(start.mock.calls.slice(1)).toEqual([
        ['user-1', { confirmed: false }],
        ['user-1', { confirmed: true }],
      ])
      vi.unstubAllGlobals()
    })

    it('opens no copy before the server answers when no user was confirmed for the tokens', async () => {
      const { router, start } = await signedIn([offline])
      mount(App, { global: { plugins: [router] } })
      await flushPromises()

      expect(start).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('keeps the confirmed user with the tokens', async () => {
      const { router, auth } = await signedIn([answered])
      mount(App, { global: { plugins: [router] } })
      await flushPromises()

      expect(auth.knownUserId).toBe('user-1')
      expect(auth.tokens).toMatchObject({ accessToken: 'access-1', userId: 'user-1' })
      vi.unstubAllGlobals()
    })

    it('lets go of the draft on screen before it opens the copy of another user than the one kept', async () => {
      const { router, start } = await signedIn([answered], 'user-0')
      const { useComposeStore } = await import('../stores/compose')
      const reset = vi.spyOn(useComposeStore(), 'reset')
      const { useHandOversStore } = await import('../stores/handOvers')
      const handOversReset = vi.spyOn(useHandOversStore(), 'reset')
      const { useBulkStore } = await import('../stores/bulk')
      const bulkReset = vi.spyOn(useBulkStore(), 'reset')
      mount(App, { global: { plugins: [router] } })
      await flushPromises()

      expect(start.mock.calls).toEqual([
        ['user-0', { confirmed: false }],
        ['user-1', { confirmed: true }],
      ])
      expect(reset).toHaveBeenCalledOnce()
      expect(reset.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[1]!)
      expect(handOversReset).toHaveBeenCalledOnce()
      expect(bulkReset).toHaveBeenCalledOnce()
      expect(bulkReset.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[1]!)
      vi.unstubAllGlobals()
    })

    it('stops trying once signed out', async () => {
      vi.useFakeTimers()
      const { router, start, auth, fetchMe } = await signedIn([offline, answered], 'user-1')
      mount(App, { global: { plugins: [router] } })
      await flushPromises()

      auth.tokens = null
      await flushPromises()
      await vi.advanceTimersByTimeAsync(600_000)

      expect(fetchMe).toHaveBeenCalledOnce()
      expect(start).toHaveBeenCalledOnce()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })
  })
})
