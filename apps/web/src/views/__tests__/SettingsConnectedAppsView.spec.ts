import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ConnectedApp } from '@tresso/core'
import SettingsConnectedAppsView from '../SettingsConnectedAppsView.vue'

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function app(id: string, name: string, extra: Partial<ConnectedApp> = {}): ConnectedApp {
  return {
    id,
    name,
    domains: ['claude.ai'],
    scopes: ['mail:read', 'todos:read'],
    connectedAt: '2026-11-01T08:00:00+00:00',
    lastUsedAt: null,
    ...extra,
  }
}

describe('SettingsConnectedAppsView', () => {
  const requests: { method: string; path: string }[] = []
  let stored: ConnectedApp[]
  let failDelete: boolean

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    failDelete = false
    stored = [app('claude', 'Claude', { lastUsedAt: '2026-11-02T10:00:00+00:00' }), app('inspector', 'MCP Inspector', { domains: ['localhost', 'com.example.inspector'], scopes: ['settings:read'] })]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        requests.push({ method, path: url.pathname })
        if (method === 'DELETE') {
          if (failDelete) return new Response(JSON.stringify({ detail: 'Something went wrong.' }), { status: 500 })
          const id = url.pathname.split('/').pop()
          stored = stored.filter((a) => a.id !== id)
          return new Response(null, { status: 204 })
        }
        return new Response(JSON.stringify(stored))
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  async function mountView() {
    const wrapper = mount(SettingsConnectedAppsView, { attachTo: document.body })
    await settle()
    return wrapper
  }

  it('lists the apps with every domain, their permissions, since when and last use', async () => {
    const wrapper = await mountView()

    const rows = wrapper.findAll('.app')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('Claude')
    expect(rows[0]!.text()).toContain('claude.ai')
    expect(rows[0]!.text()).toContain('Read mail, See todos')
    expect(rows[0]!.text()).toContain('Connected')
    expect(rows[0]!.text()).toContain('Last used')
    expect(rows[1]!.text()).toContain('localhost, com.example.inspector')
    expect(rows[1]!.text()).toContain('See settings')
    expect(rows[1]!.text()).toContain('Never used')
  })

  it('says so when no app is connected', async () => {
    stored = []
    const wrapper = await mountView()

    expect(wrapper.text()).toContain('No connected apps.')
  })

  it('disconnects an app only after confirming in a dialog', async () => {
    const wrapper = await mountView()

    await wrapper.get('.app button').trigger('click')
    await settle()
    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([])
    const dialog = wrapper.get('dialog')
    expect(dialog.attributes('role')).toBe('alertdialog')
    expect(dialog.text()).toContain('Disconnect Claude?')

    await dialog.findAll('button').find((button) => button.text() === 'Keep it')!.trigger('click')
    await settle()
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([])

    await wrapper.get('.app button').trigger('click')
    await settle()
    await wrapper.get('dialog').findAll('button').find((button) => button.text() === 'Disconnect')!.trigger('click')
    await settle()

    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/api/v1/connected-apps/claude' }])
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(wrapper.findAll('.app')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('Claude')
  })

  it('keeps the dialog open with the error when disconnecting fails', async () => {
    failDelete = true
    const wrapper = await mountView()

    await wrapper.get('.app button').trigger('click')
    await settle()
    await wrapper.get('dialog').findAll('button').find((button) => button.text() === 'Disconnect')!.trigger('click')
    await settle()

    expect(wrapper.get('dialog [role="alert"]').text()).not.toBe('')
    expect(wrapper.findAll('.app')).toHaveLength(2)
  })
})
