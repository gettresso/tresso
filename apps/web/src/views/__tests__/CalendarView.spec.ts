import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { ChangePage } from '@tresso/core'
import { deleteMailDatabase } from '@/mail/db'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import CalendarView from '../CalendarView.vue'

function page(cursor: number): ChangePage {
  return { cursor, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [] }
}

/** Without a calendar, N says there is none to add to: a sign that the shortcut acted. */
const NO_CALENDAR = 'There is no calendar to add events to.'

describe('the calendar shortcuts', () => {
  beforeEach(async () => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname === '/api/v1/sync/changes') {
          return new Response(JSON.stringify(page(Number(url.searchParams.get('since')) + 1)))
        }
        return new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503 })
      }),
    )
    await useMailStore().start('calendar-keys-user')
  })

  afterEach(async () => {
    await useMailStore().stop()
    await deleteMailDatabase('calendar-keys-user')
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  async function calendarScreen() {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/calendar/:view(day|week|month|agenda)?/:date(\\d{4}-\\d{2}-\\d{2})?', name: 'calendar', component: CalendarView }] })
    await router.push('/calendar')
    await router.isReady()
    const wrapper = mount(CalendarView, { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  it('leaves the keys to the message being written', async () => {
    const compose = useComposeStore()
    compose.openNew()
    const wrapper = await calendarScreen()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))
    await flushPromises()
    expect(wrapper.text()).not.toContain(NO_CALENDAR)

    // Minimized, the message no longer takes the keys.
    compose.minimized = true
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))
    await flushPromises()
    expect(wrapper.text()).toContain(NO_CALENDAR)
  })

  it('does not act on a key held down, or with a modal dialog open', async () => {
    const wrapper = await calendarScreen()
    const dialog = document.createElement('dialog')
    document.body.append(dialog)
    dialog.setAttribute('open', '')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))
    await flushPromises()
    expect(wrapper.text()).not.toContain(NO_CALENDAR)

    dialog.remove()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', repeat: true, bubbles: true }))
    await flushPromises()
    expect(wrapper.text()).not.toContain(NO_CALENDAR)
  })
})
