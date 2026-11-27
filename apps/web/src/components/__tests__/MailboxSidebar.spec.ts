import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describeSync, type SyncFacts } from '@tresso/core'
import { useMailStore } from '@/stores/mail'
import { useChatsStore } from '@/stores/chats'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import AppIcon from '../AppIcon.vue'
import MailboxSidebar from '../MailboxSidebar.vue'
import ProviderMark from '../ProviderMark.vue'
import SenderAvatar from '../SenderAvatar.vue'

// The desktop app's chats: these tests turn WhatsApp on for a Mac (the browser's are in the *Browser specs).
vi.mock('@/platform/whatsapp', async (original) => ({ ...(await original<typeof import('@/platform/whatsapp')>()), chatsFromServer: false }))

const NOW = Date.UTC(2026, 10, 12, 14, 30)
const time = (at: number) => new Date(at).toISOString().slice(11, 16)

function facts(change: Partial<SyncFacts>): SyncFacts {
  return { copy: 'open', confirmed: true, afterUpdate: false, pull: null, origin: null, error: null, stream: 'live', wasLive: true, online: true, lastSyncedAt: NOW - 28 * 60_000, now: NOW, ...change }
}

describe('MailboxSidebar', () => {
  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  function sidebar(extra: Record<string, unknown> = {}) {
    return mount(MailboxSidebar, {
      props: { displayName: 'Kim', email: 'kim@example.test', accounts: [], unreadCounts: new Map(), mailbox: null, smartInboxes: [], smartInboxCounts: new Map(), smartInbox: null, batches: false, nextBatch: null, ...extra },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
  }

  it('says at its foot what the sync is doing, in every state, and no longer "Connecting…" while it pulls', async () => {
    const mail = useMailStore()
    const wrapper = sidebar()
    const states: [Partial<SyncFacts>, string][] = [
      [{ copy: 'opening' }, 'Opening your mail…'],
      [{ confirmed: false, stream: 'off' }, 'Showing mail kept on this device'],
      [{ stream: 'connecting', wasLive: false, pull: { from: 0, cursor: 6200, latest: 10_000, items: 9000, pages: 18, hasMore: true }, origin: 0, lastSyncedAt: null }, 'Getting your mail, 62%'],
      [{ afterUpdate: true, pull: { from: 0, cursor: 2500, latest: 10_000, items: 5000, pages: 10, hasMore: true }, origin: 0 }, 'Updating your mail on this device after the update, 25%'],
      [{ pull: { from: 50_000, cursor: 50_600, latest: 63_000, items: 500, pages: 1, hasMore: true }, origin: 50_000 }, 'Catching up: 12,400 changes to go'],
      [{}, 'Up to date'],
      [{ stream: 'connecting', wasLive: false }, 'Connecting…'],
      [{ stream: 'retrying' }, 'Reconnecting… Last synced 14:02'],
      [{ online: false, stream: 'retrying' }, 'Offline. Last synced 14:02'],
      [{ error: 'Bad gateway' }, 'Sync stopped. Last synced 14:02'],
    ]
    for (const [change, text] of states) {
      mail.syncStatus = describeSync(facts(change), time)
      await wrapper.vm.$nextTick()
      expect(wrapper.get('.sync-status .line').text()).toBe(text)
    }
    expect(wrapper.get('.sync-status [role="status"]').text()).toBe('Sync stopped')
  })

  it('shows the WhatsApp row with its unread chats only where WhatsApp is on and connected', async () => {
    const account = { emailAddress: 'kim@company.example', provider: 'imap', statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null, status: 'active' as const }
    const accounts = [
      { ...account, id: 'work', displayName: 'Work' },
      { ...account, id: 'support', displayName: 'Support' },
      { ...account, id: 'home', displayName: 'Personal' },
    ]
    const wrapper = sidebar({ accounts, unreadCounts: new Map([['work', 96], ['support', 41], ['home', 21]]) })
    expect(wrapper.text()).not.toContain('WhatsApp')
    expect(wrapper.get('.profile-detail').text()).toBe('3 accounts')

    const wa = useWhatsAppRelayStore()
    wa.available = true
    wa.config = { mode: 'local', deviceId: 'd1', deviceName: 'Mac', linkedAt: null, importSince: '2026-10-13T10:00:00.000Z', includeGroups: true, notify: false, leftOut: [], moved: false }
    wa.identity = { number: '31698765432', name: 'Kim' }
    const chats = useChatsStore()
    const chat = (id: string, unread: number, archived = false) => ({
      chat: { id, chatAccountId: 'wa:account', jid: `${id}@s.whatsapp.net`, kind: 'direct' as const, name: id, lastMessageAt: '2026-11-12T10:00:00.000Z', readThrough: null, archivedThrough: archived ? '2026-11-12T10:00:00.000Z' : null, leftOut: false },
      newest: null,
      unread,
      lastMessageAt: Date.parse('2026-11-12T10:00:00.000Z'),
    })
    // The copy is not open here: the store's own read (on the switch) leaves the list empty first.
    await flushPromises()
    chats.summaries = [...Array.from({ length: 6 }, (_, index) => chat(`c${index}`, 1)), chat('quiet', 0), chat('archived', 3, true)]
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.profile-detail').text()).toBe('3 mail accounts, WhatsApp')
    const row = wrapper.get('.item.whatsapp')
    // The WhatsApp mark in the second ink at 16, instead of the letters "WA".
    const mark = row.getComponent(ProviderMark)
    expect([mark.props('kind'), mark.props('tone'), mark.props('size')]).toEqual(['whatsapp', 'ink', 16])
    expect(row.find('.avatar').exists()).toBe(false)
    expect(row.get('.account-text').text()).toBe('WhatsApp+31698765432, via this Mac')
    expect(row.get('.account-name').text()).toBe('WhatsApp')
    expect(row.get('.account-address').text()).toBe('+31698765432, via this Mac')
    expect(row.get('.count').text()).toBe('6 unread')
    expect(wrapper.findAllComponents(RouterLinkStub).find((link) => link.classes().includes('whatsapp'))!.props('to')).toEqual({ name: 'whatsapp' })
    // The Unified Inbox counts the chats in it with unread messages too, as on the board: 96 + 41 + 21 + 6.
    expect(wrapper.findAll('.item')[0]!.get('.count').text()).toBe('164 unread')
    expect(row.attributes('aria-current')).toBeUndefined()

    await wrapper.setProps({ whatsapp: true })
    expect(wrapper.get('.item.whatsapp').attributes('aria-current')).toBe('page')
    expect(wrapper.findAll('.item')[0]!.attributes('aria-current')).toBeUndefined()
  })

  it('marks each account by the provider the server reports, never by its name, and no longer with letters', async () => {
    const account = { statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null, status: 'active' as const }
    const accounts = [
      { ...account, id: 'work', displayName: 'Work', emailAddress: 'kim@work.example', provider: 'microsoft' },
      { ...account, id: 'support', displayName: 'Support', emailAddress: 'support@company.example', provider: 'gmail' },
      // A mail server account named after a brand, at that brand's domain, still gets the mail icon.
      { ...account, id: 'home', displayName: 'Google', emailAddress: 'kim@gmail.com', provider: 'imap' },
    ]
    const wrapper = sidebar({ accounts, mailbox: 'support' })
    const rows = wrapper.findAll('.item.account')
    expect(rows.map((row) => row.get('.account-name').text())).toEqual(['Work', 'Support', 'Google'])
    expect(rows.map((row) => row.getComponent(ProviderMark).props('kind'))).toEqual(['microsoft', 'google', 'mail'])
    for (const row of rows) {
      const mark = row.getComponent(ProviderMark)
      expect([mark.props('tone'), mark.props('size')]).toEqual(['ink', 16])
      // No letter mark: no avatar, and nothing but the name and the address is written in the row.
      expect(row.findComponent(SenderAvatar).exists()).toBe(false)
      expect(row.find('.avatar').exists()).toBe(false)
      expect(mark.text()).toBe('')
    }
    expect(rows[2]!.find('path[fill="currentColor"]').exists()).toBe(false)
    expect(rows[2]!.getComponent(AppIcon).props('name')).toBe('mail')
    expect(rows.map((row) => row.get('.account-text').text())).toEqual(['Workkim@work.example', 'Supportsupport@company.example', 'Googlekim@gmail.com'])

    // The account on screen is still the current page, and only it.
    expect(rows.map((row) => row.attributes('aria-current'))).toEqual([undefined, 'page', undefined])
    await wrapper.setProps({ mailbox: 'home' })
    expect(wrapper.findAll('.item.account').map((row) => row.attributes('aria-current'))).toEqual([undefined, undefined, 'page'])
    await wrapper.setProps({ page: 'settings' })
    expect(wrapper.findAll('.item[aria-current="page"]').map((row) => row.text())).toEqual(['Settings'])

    // The signed-in user keeps the initials of their own avatar.
    const profile = wrapper.get('.profile').getComponent(SenderAvatar)
    expect(profile.props('sender')).toEqual({ name: 'Kim', address: 'kim@example.test' })
    expect(profile.text()).toBe('KI')
  })

  it('starts "New smart inbox" and "Add account" with the plus icon instead of a typed plus', () => {
    const smartInboxes = [{ id: 'todo', name: 'To do', builtin: 'todo' }]
    const wrapper = sidebar({ smartInboxes })
    const adds = wrapper.findAll('.add')
    expect(adds.map((add) => add.text())).toEqual(['New smart inbox', 'Add account'])
    for (const add of adds) {
      const icon = add.getComponent(AppIcon)
      expect([icon.props('name'), icon.props('size')]).toEqual(['plus', 16])
      expect(icon.attributes('aria-hidden')).toBe('true')
      expect(add.element.firstElementChild).toBe(icon.element)
      expect(add.text()).not.toContain('+')
    }
    const links = wrapper.findAllComponents(RouterLinkStub)
    expect(links.find((link) => link.text() === 'New smart inbox')!.props('to')).toEqual({ name: 'settings-smart-inbox', params: { smartInboxId: 'new' } })
    expect(links.find((link) => link.text() === 'Add account')!.props('to')).toEqual({ name: 'settings-accounts-new' })
  })
})
