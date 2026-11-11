import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { SyncedCalendar, SyncedMailAccount } from '@tresso/core'
import CalendarAccessNotices from '../CalendarAccessNotices.vue'

function account(overrides: Partial<SyncedMailAccount>): SyncedMailAccount {
  return {
    id: 'work',
    emailAddress: 'kim@company.example',
    displayName: 'Kim',
    provider: 'microsoft',
    status: 'active',
    statusDetail: null,
    lastSyncedAt: '2026-10-20T08:00:00Z',
    defaultSignatureId: null,
    calendarStatus: 'active',
    calendarStatusDetail: null,
    ...overrides,
  }
}

describe('CalendarAccessNotices', () => {
  const requests: { path: string; body: unknown }[] = []
  const assign = vi.fn<(url: string) => void>()

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    assign.mockReset()
    vi.stubGlobal('location', { ...window.location, assign })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        requests.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        return Response.json({ authorizationUrl: 'https://login.microsoftonline.example/authorize?state=s', provider: 'microsoft', expiresAt: '2026-10-20T08:15:00Z' }, { status: 201 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  function mountNotices(accounts: SyncedMailAccount[], calendars: Partial<SyncedCalendar>[] = []) {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/settings/accounts', name: 'settings-accounts', component: { template: '<div />' } }] })
    return mount(CalendarAccessNotices, { props: { accounts, calendars: calendars as SyncedCalendar[] }, global: { plugins: [router] } })
  }

  it('offers calendar access for an account without it, in one click', async () => {
    const wrapper = mountNotices([account({ calendarStatus: 'not_granted' })])

    expect(wrapper.text()).toContain('Tresso may not use the calendars of kim@company.example yet.')
    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(requests.find((r) => r.path === '/api/v1/provider-authorizations')?.body).toEqual({ provider: 'microsoft', features: ['calendar'], mailAccountId: 'work' })
    expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.example/authorize?state=s')
  })

  it('points a calendar server that needs the user to the account settings', () => {
    const wrapper = mountNotices([
      account({ provider: 'imap', calendarStatus: 'unconfirmed', calendarStatusDetail: 'A calendar server was found at https://dav.company.example/. To sync your calendars there, confirm this address in the account settings.' }),
    ])

    expect(wrapper.text()).toContain('A calendar server was found at https://dav.company.example/.')
    expect(wrapper.get('a').text()).toBe('Open account settings')
  })

  it('says it is still looking only while an account has no calendars', () => {
    expect(mountNotices([account({ calendarStatus: 'unknown' })]).text()).toContain('Looking for the calendars of kim@company.example...')
    expect(mountNotices([account({ calendarStatus: 'unknown' })], [{ id: 'c1', mailAccountId: 'work' }]).find('li').exists()).toBe(false)
  })

  it('says nothing for accounts whose calendars sync', () => {
    expect(mountNotices([account({}), account({ id: 'other', provider: 'imap', calendarStatus: 'unsupported' })]).find('ul').exists()).toBe(false)
  })
})
