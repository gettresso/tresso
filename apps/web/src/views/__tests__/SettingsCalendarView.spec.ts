import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { MeetingPreferences, SchedulingPreferences } from '@tresso/core'
import { createMemoryHistory, createRouter } from 'vue-router'
import SettingsCalendarView from '../SettingsCalendarView.vue'

function router() {
  return createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/settings/meeting-apps', name: 'settings-meeting-apps', component: { template: '<div />' } }] })
}

/** Form validation runs asynchronously; let it and the requests it starts finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const stored: SchedulingPreferences = { bufferMinutes: 10, travelMinutes: 0, minimumNoticeMinutes: 0, planTodos: false }

describe('SettingsCalendarView', () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  let meeting: MeetingPreferences

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    meeting = { ownLink: null, addWithGuests: true, defaults: {}, defaultOther: null, disabled: [], apps: ['meet', 'teams', 'own'] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const body = init?.body ? (JSON.parse(String(init.body)) as Partial<SchedulingPreferences>) : undefined
        const path = new URL(String(input)).pathname
        if (path === '/api/v1/calendar/meeting-preferences') {
          return new Response(JSON.stringify(meeting))
        }
        requests.push({ method, path, body })
        return new Response(JSON.stringify({ ...stored, ...body }))
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('switches todo planning on and sends only that', async () => {
    const wrapper = mount(SettingsCalendarView, { global: { plugins: [router()] } })
    await settle()
    const toggle = wrapper.get('input[type="checkbox"]')
    expect((toggle.element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()

    await toggle.setValue(true)
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(requests).toEqual([
      { method: 'GET', path: '/api/v1/calendar/scheduling-preferences', body: undefined },
      { method: 'PATCH', path: '/api/v1/calendar/scheduling-preferences', body: { planTodos: true } },
    ])
    expect(wrapper.get('.saved').text()).toBe('Saved. Your open todos with a due date and a duration are being planned.')
  })

  it('points to Meeting apps, naming Zoom only when the server offers it', async () => {
    const wrapper = mount(SettingsCalendarView, { global: { plugins: [router()] } })
    await settle()
    const block = wrapper.get('.meeting-links')
    expect(block.get('h3').text()).toBe('Meeting links')
    expect(block.text()).toContain('Google Meet, Microsoft Teams and your own link are set up under Meeting apps.')
    expect(block.get('a').text()).toBe('Open Meeting apps')
    expect(block.get('a').attributes('href')).toBe('/settings/meeting-apps')
    wrapper.unmount()

    setActivePinia(createPinia())
    meeting = { ...meeting, apps: ['meet', 'teams', 'own', 'zoom'] }
    const withZoom = mount(SettingsCalendarView, { global: { plugins: [router()] } })
    await settle()
    expect(withZoom.get('.meeting-links').text()).toContain('Google Meet, Microsoft Teams, Zoom and your own link are set up under Meeting apps.')
  })
})
