import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import CalendarView from '../CalendarView.vue'

async function mountView() {
  setActivePinia(createPinia())
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/calendar/:view(day|week|month|agenda)?/:date(\\d{4}-\\d{2}-\\d{2})?', name: 'calendar', component: { template: '<div />' } }],
  })
  await router.push('/calendar/week')
  const wrapper = mount(CalendarView, {
    attachTo: document.body,
    global: {
      plugins: [router],
      stubs: { CalendarRail: { template: '<nav class="rail" aria-label="Calendars"><button type="button" class="day">12</button></nav>' }, TimeGrid: true, MonthGrid: true, AgendaList: true },
    },
  })
  await flushPromises()
  return wrapper
}

describe('CalendarView', () => {
  it('opens the calendar rail as a drawer from the toolbar, and closes it on Escape or a press beside it', async () => {
    const wrapper = await mountView()
    const toggle = wrapper.get('button[aria-controls="calendar-rail"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('#calendar-rail').classes()).not.toContain('open')

    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('#calendar-rail').classes()).toContain('open')

    await wrapper.get('#calendar-rail .day').trigger('keydown', { key: 'Escape' })
    expect(wrapper.get('#calendar-rail').classes()).not.toContain('open')

    await toggle.trigger('click')
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()
    expect(wrapper.get('#calendar-rail').classes()).not.toContain('open')
  })
})
