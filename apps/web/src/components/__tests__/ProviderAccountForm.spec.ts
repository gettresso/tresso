import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { MailAccount } from '@tresso/core'
import ProviderAccountForm from '../ProviderAccountForm.vue'

const gmail: MailAccount = {
  id: 'acc-g',
  emailAddress: 'kim@gmail.example',
  displayName: 'Kim',
  provider: 'gmail',
  status: 'active',
  statusDetail: null,
  username: null,
  imap: null,
  smtp: null,
  calendarUrl: null,
  calendarStatus: 'not_granted',
  calendarStatusDetail: 'Tresso is not allowed to use the calendars of this account yet. Allow it by signing in with Google again.',
  lastSyncedAt: '2026-10-19T08:00:00+00:00',
  createdAt: '2026-10-19T08:00:00+00:00',
  defaultSignatureId: null,
}

describe('ProviderAccountForm', () => {
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
        return new Response(JSON.stringify({ authorizationUrl: 'https://accounts.google.example/o/oauth2/v2/auth?state=s', provider: 'google', expiresAt: '2026-10-19T08:15:00+00:00' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('asks the provider for just the calendars when they are not allowed yet', async () => {
    const wrapper = mount(ProviderAccountForm, { props: { account: gmail, provider: 'google' } })
    expect(wrapper.text()).toContain('Tresso may not use the calendars of this account yet.')

    const allow = wrapper.findAll('button').find((button) => button.text() === 'Allow calendar access')
    expect(allow).toBeDefined()
    await allow!.trigger('click')
    await flushPromises()

    expect(requests).toEqual([{ path: '/api/v1/provider-authorizations', body: { provider: 'google', features: ['calendar'], mailAccountId: 'acc-g' } }])
    expect(assign).toHaveBeenCalledWith('https://accounts.google.example/o/oauth2/v2/auth?state=s')
  })

  it('signs in again for mail without asking for calendars', async () => {
    const wrapper = mount(ProviderAccountForm, { props: { account: { ...gmail, calendarStatus: 'unknown', calendarStatusDetail: null }, provider: 'google' } })

    await wrapper.findAll('button').find((button) => button.text() === 'Sign in with Google again')!.trigger('click')
    await flushPromises()

    expect(requests).toEqual([{ path: '/api/v1/provider-authorizations', body: { provider: 'google', features: ['mail'], mailAccountId: 'acc-g' } }])
  })

  it('shows why the calendars failed and lets the user allow calendar access again', async () => {
    const detail = 'Google refused the calendars of this account (forbidden). Your organization may not allow Tresso to use calendars.'
    const wrapper = mount(ProviderAccountForm, { props: { account: { ...gmail, calendarStatus: 'error', calendarStatusDetail: detail }, provider: 'google' } })

    const line = wrapper.get('.calendars')
    expect(line.text()).toContain(detail)
    await line.get('button').trigger('click')
    await flushPromises()

    expect(line.get('button').text()).toBe('Allow calendar access again')
    expect(requests).toEqual([{ path: '/api/v1/provider-authorizations', body: { provider: 'google', features: ['calendar'], mailAccountId: 'acc-g' } }])
  })

  it('shows why the calendar sign-in failed and offers signing in again next to it', async () => {
    const detail = "Google no longer accepts Tresso's access to this account. Sign in with Google again."
    const wrapper = mount(ProviderAccountForm, { props: { account: { ...gmail, calendarStatus: 'auth_failed', calendarStatusDetail: detail }, provider: 'google' } })

    const line = wrapper.get('.calendars')
    expect(line.text()).toContain(detail)
    expect(line.get('button').text()).toBe('Sign in with Google again')
    await line.get('button').trigger('click')
    await flushPromises()

    // Signing in again asks for what the account allows already, calendars included (the API adds them).
    expect(requests).toEqual([{ path: '/api/v1/provider-authorizations', body: { provider: 'google', features: ['mail'], mailAccountId: 'acc-g' } }])
  })

  it('shows nothing about calendars once they sync', () => {
    const wrapper = mount(ProviderAccountForm, { props: { account: { ...gmail, calendarStatus: 'active', calendarStatusDetail: null }, provider: 'google' } })
    expect(wrapper.text()).not.toContain('Allow calendar access')
  })
})
