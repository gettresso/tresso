import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { NO_UNSUBSCRIBE_ON_IMAP, type MailAccount } from '@tresso/core'
import AccountCard from '../AccountCard.vue'

function account(provider: string): MailAccount {
  const servers = provider === 'imap'
  return {
    id: 'work',
    emailAddress: 'kim@company.example',
    displayName: 'Work',
    provider,
    status: 'active',
    statusDetail: null,
    username: servers ? 'kim@company.example' : null,
    imap: servers ? { host: 'imap.company.example', port: 993, security: 'tls' } : null,
    smtp: servers ? { host: 'smtp.company.example', port: 465, security: 'tls' } : null,
    calendarUrl: null,
    calendarStatus: 'unknown',
    calendarStatusDetail: null,
    lastSyncedAt: '2026-10-20T08:00:00Z',
    createdAt: '2026-10-01T08:00:00Z',
    defaultSignatureId: null,
  }
}

describe('AccountCard', () => {
  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  async function opened(provider: string) {
    const wrapper = mount(AccountCard, { props: { account: account(provider) } })
    await wrapper.get('button.head').trigger('click')
    return wrapper
  }

  it('says why an IMAP account offers no one-click unsubscribe', async () => {
    const wrapper = await opened('imap')

    expect(wrapper.text()).toContain(NO_UNSUBSCRIBE_ON_IMAP)
  })

  it('says nothing of the kind for an account that signs in with its provider', async () => {
    const wrapper = await opened('gmail')

    expect(wrapper.text()).not.toContain('One-click unsubscribe is not available')
  })

  it('shows an account without calendar access in the collapsed card, and opens on it', () => {
    const wrapper = mount(AccountCard, { props: { account: { ...account('microsoft'), calendarStatus: 'not_granted' } } })

    expect(wrapper.get('.status.calendar').text()).toBe('Calendars not allowed')
    expect(wrapper.get('button.head').attributes('aria-expanded')).toBe('true')
    expect(wrapper.text()).toContain('Allow calendar access')
  })

  it('stays closed and quiet when the calendars are fine', () => {
    const wrapper = mount(AccountCard, { props: { account: { ...account('microsoft'), calendarStatus: 'active' } } })

    expect(wrapper.find('.status.calendar').exists()).toBe(false)
    expect(wrapper.get('button.head').attributes('aria-expanded')).toBe('false')
  })

  it("names the server's sync of the account in the words of the sync status, never as connecting", () => {
    const first = mount(AccountCard, { props: { account: { ...account('imap'), lastSyncedAt: null } } })
    const on = mount(AccountCard, { props: { account: account('imap') } })

    expect(first.get('.status.active').text()).toBe('Getting mail')
    expect(on.get('.status.active').text()).toBe('Active')
  })
})
