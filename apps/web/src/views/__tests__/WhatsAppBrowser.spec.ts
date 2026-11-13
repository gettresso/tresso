import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { ChatApiError, SqliteMailStore, type SyncedChatAccount } from '@tresso/core'
import { memorySql } from '@tresso/core/testing/sql'
import { isDesktop } from '@/platform/desktop'
import { chatsFromServer } from '@/platform/whatsapp'
import { useAuthStore } from '@/stores/auth'
import { useChatsStore } from '@/stores/chats'
import { useMailStore } from '@/stores/mail'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import { ACCOUNT_ID, FakeChatServer } from '@/stores/__tests__/chatServerFixture'
import { at, DIRECT, GROUP, NOW } from '@/stores/__tests__/chatFixtures'
import appRouter from '@/router'
import MailView from '../MailView.vue'
import SettingsAccountsView from '../SettingsAccountsView.vue'
import SettingsWhatsAppBrowserView from '../SettingsWhatsAppBrowserView.vue'

const fakes = vi.hoisted(() => ({ server: null as unknown }))
vi.mock('@/api/chats', () => ({ useChatApi: () => fakes.server }))

/**
 * WhatsApp in the browser (app.gettresso.com, the WhatsApp plan's WP11): nothing of the bridge or the relay, and the
 * chats the server holds exactly while the copy has the server's WhatsApp account (a Mac relays them in "All my
 * devices"). Without one nothing of WhatsApp shows and every WhatsApp address leads elsewhere, as before.
 */
describe('WhatsApp in the browser', () => {
  let server: FakeChatServer
  let copy: SqliteMailStore
  let wrapper: VueWrapper | null = null

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    setActivePinia(createPinia())
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([])),
    )
    useAuthStore().tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3_600_000 }
    server = new FakeChatServer()
    fakes.server = server
    copy = await SqliteMailStore.open(await memorySql())
    const mail = useMailStore()
    vi.spyOn(mail, 'currentStore').mockImplementation(() => copy)
    vi.spyOn(mail, 'showMailbox').mockResolvedValue()
    vi.spyOn(mail, 'syncNow').mockResolvedValue()
    mail.ready = true
    mail.synced = true
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** A Mac relays the user's WhatsApp ("All my devices"), and a pull brought it into the copy. */
  async function relayed(account: Partial<SyncedChatAccount> = {}): Promise<void> {
    await server.connect({ deviceId: 'other-device', deviceName: "Kim's MacBook Pro", address: '31698765432', displayName: 'Kim', includeGroups: true, notify: false })
    server.account = { ...server.account!, ...account }
    await server.relayMessages(ACCOUNT_ID, {
      deviceId: 'other-device',
      firstImport: false,
      chats: [
        { jid: DIRECT, name: 'Bram Visser', kind: 'direct' },
        { jid: GROUP, name: 'Family', kind: 'group' },
      ],
      messages: [
        { chatJid: DIRECT, waId: 'S1', fromMe: false, sender: null, text: 'Can you bring the drill?', sentAt: at(-3), media: null },
        { chatJid: GROUP, waId: 'S2', fromMe: false, sender: { id: '31611111111', name: 'Mom' }, text: 'Dinner at 18:00?', sentAt: at(-4), media: null },
      ],
    })
    await server.deliver(copy)
    useMailStore().chatChanges++
    await vi.waitFor(() => expect(useChatsStore().enabled).toBe(true))
    server.calls.length = 0
  }

  it('takes the chats from the server in the browser only, and never turns the bridge on there', async () => {
    expect(isDesktop).toBe(false)
    expect(chatsFromServer).toBe(true)
    const wa = useWhatsAppRelayStore()
    await wa.init()
    expect(wa.available).toBe(false)
    expect(wa.connected).toBe(false)
    const chats = useChatsStore()
    await vi.waitFor(() => expect(chats.serverChecked).toBe(true))
    expect(chats.enabled).toBe(false)
    await relayed()
    expect(chats.enabled).toBe(true)
    expect(wa.available).toBe(false)
  })

  describe('addresses', () => {
    const addresses = [
      ['/settings/whatsapp', 'settings-accounts', 'settings-whatsapp'],
      ['/settings/whatsapp/connect', 'settings-accounts', 'settings-whatsapp'],
      ['/whatsapp', 'unified', 'whatsapp'],
      [`/whatsapp/chat-${DIRECT}`, 'unified', 'whatsapp-chat'],
      [`/chats/chat-${DIRECT}`, 'unified', 'unified-chat'],
    ] as const

    it('lead elsewhere without a WhatsApp account, and open with one (the connect dialog never)', async () => {
      for (const [path, without] of addresses) {
        await appRouter.push(path)
        expect({ path, lands: appRouter.currentRoute.value.name }).toEqual({ path, lands: without })
      }
      await relayed()
      for (const [path, , withAccount] of addresses) {
        await appRouter.push('/settings/accounts')
        await appRouter.push(path)
        expect({ path, lands: appRouter.currentRoute.value.name }).toEqual({ path, lands: withAccount })
      }
    })

    it('wait for the copy to open before they decide', async () => {
      const mail = useMailStore()
      await appRouter.push('/settings/accounts')
      await relayed()
      mail.ready = false
      await vi.waitFor(() => expect(useChatsStore().serverChecked).toBe(false))
      const going = appRouter.push('/whatsapp')
      await flushPromises()
      mail.ready = true
      await going
      expect(appRouter.currentRoute.value.name).toBe('whatsapp')
    })
  })

  describe('the WhatsApp list', () => {
    let router: Router

    beforeEach(() => {
      router = createRouter({
        history: createMemoryHistory(),
        routes: [
          { path: '/', name: 'unified', component: MailView },
          { path: '/inbox/:threadId', name: 'unified-thread', component: MailView },
          { path: '/chats/:chatId', name: 'unified-chat', component: MailView },
          { path: '/whatsapp', name: 'whatsapp', component: MailView },
          { path: '/whatsapp/:chatId', name: 'whatsapp-chat', component: MailView },
          { path: '/settings/whatsapp', name: 'settings-whatsapp', component: { template: '<p />' } },
          { path: '/settings/accounts/new', name: 'settings-accounts-new', component: { template: '<p />' } },
          { path: '/calendar', name: 'calendar', component: { template: '<p />' } },
        ],
      })
    })

    async function show(path: string): Promise<VueWrapper> {
      await router.push(path)
      wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router], stubs: { MiniAgenda: true, ReadingPane: true } }, attachTo: document.body })
      await flushPromises()
      return wrapper
    }

    it('lists the chats with the notice while the relaying Mac is offline, and the Channels tabs in the Unified Inbox', async () => {
      await relayed({ relayOnline: false, relayOfflineSince: at(-60) })
      const view = await show('/whatsapp')
      await vi.waitFor(() => expect(view.findAll('.chat-row')).toHaveLength(2))
      expect(view.get('.relay-notice').text()).toMatch(/^Your Mac is offline since \d{1,2}:\d\d(?: [AP]M)?\. New WhatsApp messages show up here once it is back\. Replies wait until then\.$/)

      await router.push('/')
      await flushPromises()
      expect(view.get('[aria-label="Channels"]').text()).toContain('WhatsApp')
      expect(view.findAll('.chat-row').length).toBeGreaterThan(0)
      // The notice is for the WhatsApp tab, not for the mail.
      expect(view.find('.relay-notice').exists()).toBe(false)
      useChatsStore().channel = 'whatsapp'
      await flushPromises()
      expect(view.find('.relay-notice').exists()).toBe(true)
    })

    it('leads back to the Unified Inbox once the account goes', async () => {
      await relayed()
      const view = await show(`/whatsapp/chat-${DIRECT}`)
      await vi.waitFor(() => expect(view.find('.chat-pane h2').exists()).toBe(true))
      server.removeElsewhere()
      await server.deliver(copy)
      useMailStore().chatChanges++
      await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('unified'))
    })
  })

  describe('Settings', () => {
    const router = appRouter

    async function show(path: string, component: typeof SettingsAccountsView | typeof SettingsWhatsAppBrowserView): Promise<VueWrapper> {
      await router.push(path)
      wrapper = mount(component, { global: { plugins: [router] } })
      await flushPromises()
      return wrapper
    }

    it('shows no WhatsApp card on Accounts without an account, and one that opens its settings with one', async () => {
      let view = await show('/settings/accounts', SettingsAccountsView)
      expect(view.find('section[aria-label="WhatsApp"]').exists()).toBe(false)
      expect(view.text()).not.toContain('WhatsApp')
      view.unmount()

      await relayed()
      view = await show('/settings/accounts', SettingsAccountsView)
      const card = view.get('section[aria-label="WhatsApp"]')
      expect(card.text()).toBe("WAWhatsApp+31698765432, via Kim's MacBook ProSettings")
      expect(card.get('a').attributes('href')).toBe('/settings/whatsapp')
      expect(card.text()).not.toContain('Connect')
    })

    it('shows the connection read only, with no connect, relay, mode or folder controls', async () => {
      await relayed({ linkedAt: at(-3 * 24 * 60) })
      const view = await show('/settings/whatsapp', SettingsWhatsAppBrowserView)
      await vi.waitFor(() => expect(view.find('h2').exists()).toBe(true))
      expect(view.get('h2').text()).toBe('WhatsApp')
      expect(view.get('.line').text()).toBe("+31698765432, via Kim's MacBook Pro")
      expect(view.get('.pill').text()).toBe('Connected')
      expect(view.text()).toContain("WhatsApp is connected through the Tresso app on Kim's MacBook Pro.")
      const rows = view.findAll('.row').map((row) => [row.get('.label').text(), row.get('.value').text()])
      expect(rows).toEqual([
        ['Relaying Mac', "Kim's MacBook Pro, online now"],
        ['Bridge', 'Running'],
        ['Linked to phone', 'Linked 3 days ago. WhatsApp can ask you to link again.'],
      ])
      expect(view.text()).toContain('Chats to bring inChange this on the Mac that relays WhatsApp.Direct chats and groups')
      // The only control is Notify me.
      expect(view.findAll('button')).toEqual([])
      expect(view.findAll('select')).toEqual([])
      expect(view.findAll('input').map((input) => input.attributes('id'))).toEqual(['wa-notify'])
      for (const word of ['Use this Mac instead', 'Change folder', 'Disconnect', 'Connect WhatsApp', 'Where messages live', 'Show how to link', 'Take back in']) {
        expect(view.text()).not.toContain(word)
      }
    })

    it('says when the relaying Mac is offline, and what it last reported', async () => {
      await relayed({ relayOnline: false, relayOfflineSince: at(-120), bridge: 'stopped', link: 'unlinked', includeGroups: false })
      const view = await show('/settings/whatsapp', SettingsWhatsAppBrowserView)
      await vi.waitFor(() => expect(view.find('h2').exists()).toBe(true))
      expect(view.get('.pill').text()).toBe('Mac offline')
      const rows = view.findAll('.row').map((row) => row.get('.value').text())
      expect(rows).toEqual(["Kim's MacBook Pro, offline, last heard from 2 hours ago", 'Not running', 'Not linked. Nothing comes in or goes out.'])
      expect(view.text()).toContain('The bridge and the link are as your Mac last reported them.')
      expect(view.text()).toContain('Direct chats only')
    })

    it('changes Notify me on the server account, and says so when the server refuses', async () => {
      await relayed()
      const view = await show('/settings/whatsapp', SettingsWhatsAppBrowserView)
      await vi.waitFor(() => expect(view.find('#wa-notify').exists()).toBe(true))
      const box = view.get<HTMLInputElement>('#wa-notify')
      expect(box.element.checked).toBe(false)
      expect(box.attributes('role')).toBe('switch')
      await box.setValue(true)
      await flushPromises()
      expect(server.callsOf('updateAccount')).toEqual([[ACCOUNT_ID, { notify: true }]])
      await vi.waitFor(() => expect(view.get<HTMLInputElement>('#wa-notify').element.checked).toBe(true))

      server.fail('updateAccount', new ChatApiError(503, 'Unavailable.'))
      await view.get('#wa-notify').setValue(false)
      await flushPromises()
      expect(view.get('[role="alert"]').text()).toBe('Your Tresso server could not take this change just now. Try again.')
      expect(view.get<HTMLInputElement>('#wa-notify').element.checked).toBe(true)
    })

    it('lists the chats left out, read only, with why they are taken back in on the Mac', async () => {
      await relayed()
      server.chats.get(DIRECT)!.leftOut = true
      await server.deliver(copy)
      useMailStore().chatChanges++
      const view = await show('/settings/whatsapp', SettingsWhatsAppBrowserView)
      await vi.waitFor(() => expect(view.find('.left-out').exists()).toBe(true))
      expect(view.findAll('.left-row').map((row) => row.text())).toEqual(['Bram Visser'])
      expect(view.get('.left-out').text()).toContain('Take chats back in on the Mac that relays WhatsApp: only it can read its bridge again.')
      expect(view.get('.left-out').findAll('button')).toEqual([])
    })

    it('goes back to Accounts once the account goes', async () => {
      await relayed()
      await show('/settings/whatsapp', SettingsWhatsAppBrowserView)
      server.removeElsewhere()
      await server.deliver(copy)
      useMailStore().chatChanges++
      await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('settings-accounts'))
    })
  })
})
