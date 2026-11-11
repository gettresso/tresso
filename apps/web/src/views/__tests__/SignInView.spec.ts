import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'

const desktop = vi.hoisted(() => ({ isDesktop: true, opened: [] as string[] }))

vi.mock('@/platform/desktop', () => ({
  get isDesktop() {
    return desktop.isDesktop
  },
  loadKeychainTokens: async () => null,
  saveKeychainTokens: async () => undefined,
  clearKeychainTokens: async () => undefined,
  openInBrowser: async (url: string) => {
    desktop.opened.push(url)
  },
}))

// The browser's local storage, kept in memory.
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

/** Mounts the screen fresh, so the stored server and the platform are read again. */
async function signInView() {
  vi.resetModules()
  setActivePinia(createPinia())
  const { default: SignInView } = await import('@/views/SignInView.vue')
  // The screen shows in place of the one the visitor went to, and keeps it for after the sign-in.
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
  await router.push('/')
  await router.isReady()
  return mount(SignInView, { attachTo: document.body, global: { plugins: [router] } })
}

describe('SignInView', () => {
  beforeEach(() => {
    desktop.isDesktop = true
    desktop.opened = []
    vi.stubGlobal('localStorage', memoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says which server the desktop app signs in to', async () => {
    const view = await signInView()

    expect(view.get('.server').text()).toContain('localhost:8080')
  })

  it('opens the same authorization page when the browser is opened again', async () => {
    const view = await signInView()

    await view.get('button.sign-in').trigger('click')
    await vi.waitFor(() => expect(desktop.opened).toHaveLength(1))
    await flushPromises()
    await view.findAll('button').find((button) => button.text() === 'Open the browser again')!.trigger('click')
    await vi.waitFor(() => expect(desktop.opened).toHaveLength(2))
    expect(desktop.opened[1]).toBe(desktop.opened[0])
    view.unmount()
    sessionStorage.clear()
  })

  it('switches to the server the user names once it answers', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 })))
    const view = await signInView()

    await view.get('.server-change').trigger('click')
    expect(view.get('button.sign-in').attributes('disabled')).toBeDefined()
    await view.get('input').setValue('mail.example.com')
    await view.get('form').trigger('submit')
    await flushPromises()

    expect(view.get('.server').text()).toContain('mail.example.com')
    expect(localStorage.getItem('tresso.server')).toBe('https://mail.example.com')
    expect(view.get('button.sign-in').attributes('disabled')).toBeUndefined()
  })

  it('keeps the current server and explains why when the named one does not answer', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Promise.reject(new TypeError('Load failed'))))
    const view = await signInView()

    await view.get('.server-change').trigger('click')
    await view.get('input').setValue('mail.example.com')
    await view.get('form').trigger('submit')
    await flushPromises()

    expect(view.get('[role="alert"]').text()).toContain('could not reach https://mail.example.com')
    expect(view.get('input').attributes('aria-invalid')).toBe('true')
    expect(localStorage.getItem('tresso.server')).toBeNull()
  })

  it('never switches to a server the user cancelled while it was checked', async () => {
    let answer: (response: Response) => void = () => undefined
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(() => new Promise((resolve) => (answer = resolve))))
    const view = await signInView()

    await view.get('.server-change').trigger('click')
    await view.get('input').setValue('mail.example.com')
    await view.get('form').trigger('submit')
    expect(view.get('button[type="submit"]').text()).toBe('Checking...')
    const cancel = view.findAll('button').find((button) => button.text() === 'Cancel')!
    await cancel.trigger('click')
    answer(new Response('{}', { status: 401 }))
    await flushPromises()

    expect(view.get('.server').text()).toContain('localhost:8080')
    expect(localStorage.getItem('tresso.server')).toBeNull()
    expect(view.get('button.sign-in').attributes('disabled')).toBeUndefined()
  })

  it('refuses plain http to another computer without asking it', async () => {
    const request = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', request)
    const view = await signInView()

    await view.get('.server-change').trigger('click')
    await view.get('input').setValue('http://mail.example.com')
    await view.get('form').trigger('submit')
    await flushPromises()

    expect(view.get('[role="alert"]').text()).toContain('https://')
    expect(request).not.toHaveBeenCalled()
  })

  it('goes back to the default server', async () => {
    localStorage.setItem('tresso.server', 'https://mail.example.com')
    const view = await signInView()

    await view.get('.server-change').trigger('click')
    expect((view.get('input').element as HTMLInputElement).value).toBe('https://mail.example.com')
    const reset = view.findAll('button').find((button) => button.text() === 'Use localhost:8080')!
    await reset.trigger('click')

    expect(view.get('.server').text()).toContain('localhost:8080')
    expect(localStorage.getItem('tresso.server')).toBeNull()
  })

  it('offers no server choice in the browser, which talks to the server that serves it', async () => {
    desktop.isDesktop = false
    const view = await signInView()

    expect(view.find('.server').exists()).toBe(false)
  })
})
