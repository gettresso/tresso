import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'

const openCursorInstall = vi.fn<(endpoint: string) => Promise<void>>(async () => undefined)

vi.mock('@/platform/desktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/desktop')>()),
  isDesktop: true,
  openCursorInstall: (endpoint: string) => openCursorInstall(endpoint),
}))

const { default: SettingsAssistantsView } = await import('../SettingsAssistantsView.vue')
const { useAuthStore } = await import('@/stores/auth')

const ENDPOINT = 'https://mcp.tresso.example/mcp'

/** On the desktop app, Add to Cursor asks the shell, which builds the install link itself (mcp_install.rs). */
describe('Settings, Apps, AI assistants on the desktop app', () => {
  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    useAuthStore().tokens = { accessToken: 'token', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 }
    openCursorInstall.mockReset()
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/v1/server-info') return new Response(JSON.stringify({ mcpEndpoint: ENDPOINT }))
        if (path === '/api/v1/connected-apps') return new Response('[]')
        return new Response(JSON.stringify({ items: [], nextCursor: null, apps: [], empty: true }))
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  async function page() {
    const stub = { template: '<div />' }
    const router = createRouter({ history: createMemoryHistory(), routes: ['settings-apps', 'settings-apps-assistants', 'settings-apps-activity'].map((name) => ({ path: `/${name}`, name, component: stub })) })
    const wrapper = mount(SettingsAssistantsView, { global: { plugins: [router] }, attachTo: document.body })
    for (let i = 0; i < 5; i++) {
      await flushPromises()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await wrapper.findAll('[role="tab"]').find((tab) => tab.get('.tile-name').text() === 'Cursor')!.trigger('click')
    return wrapper
  }

  it('hands only the endpoint to the shell, never a link', async () => {
    const wrapper = await page()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    wrapper.get('a.how-link').element.dispatchEvent(event)
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(openCursorInstall).toHaveBeenCalledExactlyOnceWith(ENDPOINT)
  })

  it('says why when the shell refuses', async () => {
    openCursorInstall.mockRejectedValueOnce(new Error('This is not an MCP endpoint Tresso can open Cursor with.'))
    const wrapper = await page()
    await wrapper.get('a.how-link').trigger('click')
    await flushPromises()
    expect(wrapper.get('.endpoint [role="alert"]').text()).toBe('This is not an MCP endpoint Tresso can open Cursor with.')
  })
})
