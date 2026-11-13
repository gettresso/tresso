import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { ChangePage } from '@tresso/core'
import { calendar as calendarRow, calendarEvent } from '@tresso/core/testing'
import { deleteMailDatabase } from '@/mail/db'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import { useCalendarStore } from '@/stores/calendar'
import { valuesFromInput } from '@/forms/calendarEvent'
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

  it('opens an event the user left for Settings again, with its values', async () => {
    const calendar = useCalendarStore()
    calendar.keepEditor({
      target: { kind: 'new', start: Date.UTC(2026, 9, 22, 8), allDay: false },
      values: { ...valuesFromInput({ calendarId: '', summary: 'Planning', description: '', location: '', url: null, start: { dateTime: '2026-10-22T10:00:00', timeZone: null }, end: { dateTime: '2026-10-22T11:00:00', timeZone: null }, recurrence: null, status: 'confirmed', transparency: 'busy', visibility: 'public', attendees: [], useDefaultReminders: true, reminders: [], important: false, travelMinutes: null, conferenceUrl: null, organizerMailAccountId: null }, 'UTC') },
      link: { on: false, app: null, touched: false, removed: false },
      notify: true,
    })
    const wrapper = await calendarScreen()
    expect((wrapper.get('input[placeholder="Add a title"]').element as HTMLInputElement).value).toBe('Planning')
    expect(calendar.keptEditor).toBeUndefined()
    wrapper.unmount()
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

describe('Shift J', () => {
  const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_1%40thread.v2/0'

  async function screenWith(url: string) {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    const changes = page(1)
    changes.calendars = [calendarRow('work', null, { name: 'Work', isDefault: true })]
    changes.calendarEvents = [calendarEvent('review', 'work', { summary: 'Product review', conference: { provider: 'teams', url, id: null, dialIn: null } })]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const address = new URL(String(input))
        if (address.pathname === '/api/v1/sync/changes') {
          return new Response(JSON.stringify(Number(address.searchParams.get('since')) === 0 ? changes : page(Number(address.searchParams.get('since')) + 1)))
        }
        return new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503 })
      }),
    )
    await useMailStore().start('calendar-join-user')
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/calendar/:view(day|week|month|agenda)?/:date(\\d{4}-\\d{2}-\\d{2})?', name: 'calendar', component: CalendarView }] })
    await router.push('/calendar/day/2026-10-20')
    await router.isReady()
    const wrapper = mount(CalendarView, { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    // The day's events are read from the copy on this device after the first sync.
    await vi.waitFor(() => wrapper.get('.block'))
    await wrapper.get('.block').trigger('click')
    await flushPromises()
    return wrapper
  }

  afterEach(async () => {
    await useMailStore().stop()
    await deleteMailDatabase('calendar-join-user')
    vi.unstubAllGlobals()
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  it('joins the selected event in a new tab without opener or referrer', async () => {
    const open = vi.fn<typeof window.open>()
    vi.stubGlobal('open', open)
    const wrapper = await screenWith(TEAMS)
    expect(wrapper.text()).toContain('Microsoft Teams')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', shiftKey: true, bubbles: true }))
    await flushPromises()
    expect(open).toHaveBeenCalledWith(TEAMS, '_blank', 'noopener,noreferrer')
    wrapper.unmount()
  })

  it('does not open a link without a Join button', async () => {
    const open = vi.fn<typeof window.open>()
    vi.stubGlobal('open', open)
    const wrapper = await screenWith('javascript:alert(1)')
    expect(wrapper.text()).toContain('Tresso does not open this link.')
    expect(wrapper.find('.detail-panel a[href^="javascript"]').exists()).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', shiftKey: true, bubbles: true }))
    await flushPromises()
    expect(open).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
