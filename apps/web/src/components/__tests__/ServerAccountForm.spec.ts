import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { MailAccount } from '@tresso/core'
import ServerAccountForm from '../ServerAccountForm.vue'

const FOUND = 'A calendar server was found at https://dav.studio-noord.example/caldav/. To sync your calendars there, confirm this address in the account settings.'

function account(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'acc-1',
    emailAddress: 'kim@studio-noord.example',
    displayName: 'Kim',
    provider: 'imap',
    status: 'active',
    statusDetail: null,
    username: 'kim@studio-noord.example',
    imap: { host: 'imap.studio-noord.example', port: 993, security: 'tls' },
    smtp: { host: 'smtp.studio-noord.example', port: 465, security: 'tls' },
    calendarUrl: null,
    calendarStatus: 'unknown',
    calendarStatusDetail: null,
    lastSyncedAt: '2026-10-20T08:00:00Z',
    createdAt: '2026-10-01T08:00:00Z',
    defaultSignatureId: null,
    ...overrides,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('ServerAccountForm calendar server', () => {
  const requests: { method: string; body: unknown }[] = []

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        requests.push({ method: init?.method ?? 'GET', body })
        return Response.json({ ...account(), ...body })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  function mountForm(overrides: Partial<MailAccount>) {
    const value = account(overrides)
    return mount(ServerAccountForm, { props: { account: value, servers: { username: value.username!, imap: value.imap!, smtp: value.smtp! } } })
  }

  it('offers the address the worker found, and saves it with the password', async () => {
    const wrapper = mountForm({ calendarStatus: 'unconfirmed', calendarStatusDetail: FOUND })

    expect(wrapper.get('.calendar-state').text()).toContain(FOUND)
    await wrapper.findAll('button').find((button) => button.text() === 'Use this address')!.trigger('click')
    expect((wrapper.get('input[type="url"]').element as HTMLInputElement).value).toBe('https://dav.studio-noord.example/caldav/')
    await wrapper.get('input[type="password"]').setValue('app-password')
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ password: 'app-password', calendarUrl: 'https://dav.studio-noord.example/caldav/' })
  })

  it('takes the found address from its own field when the API has it', async () => {
    const wrapper = mountForm({ calendarStatus: 'unconfirmed', calendarStatusDetail: 'A calendar server was found.', calendarFoundUrl: 'https://dav.studio-noord.example/caldav/?user=kim' })

    await wrapper.findAll('button').find((button) => button.text() === 'Use this address')!.trigger('click')

    expect((wrapper.get('input[type="url"]').element as HTMLInputElement).value).toBe('https://dav.studio-noord.example/caldav/?user=kim')
  })

  it('says when no calendar server was found', () => {
    expect(mountForm({ calendarStatus: 'unsupported' }).get('.calendar-state').text()).toBe('No calendar server found for this account. Enter its CalDAV address if your provider has one.')
  })

  it('shows why the calendar server refused', () => {
    expect(mountForm({ calendarStatus: 'auth_failed', calendarStatusDetail: 'The calendar server rejected the username or password.' }).get('.calendar-state').text()).toBe(
      'The calendar server rejected the username or password.',
    )
  })

  it('lets an address be cleared, so Tresso looks again', async () => {
    const wrapper = mountForm({ calendarUrl: 'https://dav.studio-noord.example/', calendarStatus: 'active' })

    expect(wrapper.find('.calendar-state').exists()).toBe(false)
    await wrapper.get('input[type="url"]').setValue('')
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ calendarUrl: '' })
  })

  it('wants an https address', async () => {
    const wrapper = mountForm({})

    await wrapper.get('input[type="url"]').setValue('http://dav.studio-noord.example/')
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(wrapper.text()).toContain('Enter an address that starts with https://, for example https://dav.example.com/.')
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false)
  })
})
