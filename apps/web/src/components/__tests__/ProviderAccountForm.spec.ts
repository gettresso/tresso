import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { MailAccount } from '@tresso/core'
import ProviderAccountForm from '../ProviderAccountForm.vue'

const fakes = vi.hoisted(() => ({ desktop: false, browser: [] as string[] }))
vi.mock('@/platform/desktop', async (original) => ({
  ...(await original<typeof import('@/platform/desktop')>()),
  get isDesktop() {
    return fakes.desktop
  },
  openInBrowser: async (url: string) => void fakes.browser.push(url),
}))

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
  calendarStatusDetail: null,
  lastSyncedAt: '2026-10-19T08:00:00+00:00',
  createdAt: '2026-10-19T08:00:00+00:00',
  defaultSignatureId: null,
}

describe('ProviderAccountForm', () => {
  const requests: { path: string; body: unknown }[] = []
  const assign = vi.fn<(url: string) => void>()
  let failing = false

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    failing = false
    fakes.desktop = false
    fakes.browser.length = 0
    assign.mockReset()
    vi.stubGlobal('location', { ...window.location, assign })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        requests.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        if (failing) return Response.json({ detail: 'Google sign-in is not set up on this server.' }, { status: 409 })
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

  function mounted() {
    const wrapper = mount(ProviderAccountForm, { props: { account: gmail, provider: 'google' } })
    return { wrapper, signInAgain: (wrapper.vm as unknown as { signInAgain: (features?: ['calendar']) => Promise<void> }).signInAgain }
  }

  it('shows nothing while nothing happens', () => {
    expect(mounted().wrapper.text()).toBe('')
  })

  it('signs in again for mail without asking for calendars', async () => {
    const { signInAgain } = mounted()
    await signInAgain()
    await flushPromises()

    expect(requests).toEqual([{ path: '/api/v1/provider-authorizations', body: { provider: 'google', features: ['mail'], mailAccountId: 'acc-g' } }])
    expect(assign).toHaveBeenCalledWith('https://accounts.google.example/o/oauth2/v2/auth?state=s')
  })

  it('asks the provider for just the calendars when they are to be allowed', async () => {
    const { signInAgain } = mounted()
    await signInAgain(['calendar'])
    await flushPromises()

    expect(requests).toEqual([{ path: '/api/v1/provider-authorizations', body: { provider: 'google', features: ['calendar'], mailAccountId: 'acc-g' } }])
  })

  it('says the provider opens while it does, and opens it once', async () => {
    const { wrapper, signInAgain } = mounted()
    const first = signInAgain()
    const second = signInAgain()
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="status"]').text()).toBe('Opening Google…')
    await Promise.all([first, second])
    await flushPromises()
    expect(requests).toHaveLength(1)
  })

  it('in the desktop app, opens the provider in the browser and says to continue there', async () => {
    // Signed in to Tresso in the browser first: the desktop app would read its tokens from the keychain.
    const { wrapper, signInAgain } = mounted()
    fakes.desktop = true
    await signInAgain()
    await flushPromises()

    expect(fakes.browser).toEqual(['https://accounts.google.example/o/oauth2/v2/auth?state=s'])
    expect(assign).not.toHaveBeenCalled()
    expect(wrapper.get('[role="status"]').text()).toBe('Continue in your browser. Tresso shows the result here once you have signed in.')
  })

  it('says why the provider did not open', async () => {
    failing = true
    const { wrapper, signInAgain } = mounted()
    await signInAgain()
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe('Google sign-in is not set up on this server.')
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })
})
