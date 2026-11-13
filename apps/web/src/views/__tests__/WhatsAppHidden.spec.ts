import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import ConnectPicker from '@/components/connect/ConnectPicker.vue'
import router from '@/router'
import SettingsAccountsView from '../SettingsAccountsView.vue'

// The desktop app: the browser shows the chats the server holds instead (WhatsAppBrowser.spec.ts).
vi.mock('@/platform/whatsapp', async (original) => ({ ...(await original<typeof import('@/platform/whatsapp')>()), chatsFromServer: false }))

/**
 * WhatsApp stays hidden on the desktop until it is turned on for a Mac (`defaults write app.tresso.desktop
 * EnableWhatsApp -bool YES`, read by the shell's whatsapp_available): every way in is checked here, off and on. The
 * browser never turns the bridge on; it shows only the chats the server holds (WhatsAppBrowser.spec.ts).
 */
describe('WhatsApp while it is not turned on', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([])),
    )
  })

  it('the browser build never turns it on', async () => {
    const wa = useWhatsAppRelayStore()
    await wa.init()
    await wa.ready()
    expect(wa.available).toBe(false)
  })

  it('leaves the WhatsApp card out of the provider list', async () => {
    const off = mount(ConnectPicker, { props: { address: null, signInProviders: ['google', 'microsoft'] } })
    expect(off.text()).not.toContain('WhatsApp')

    const on = mount(ConnectPicker, { props: { address: null, signInProviders: ['google', 'microsoft'], whatsapp: true } })
    const card = on.findAll('button').find((button) => button.text().includes('WhatsApp'))!
    expect(card.text()).toBe('WAWhatsAppChats next to your mail, through whatsapp-mcp on your computer. Desktop app only.')
    await card.trigger('click')
    expect(on.emitted('whatsapp')).toHaveLength(1)
  })

  it('leaves the WhatsApp card out of the accounts page', async () => {
    const wrapper = mount(SettingsAccountsView, { global: { plugins: [router] } })
    await flushPromises()
    expect(wrapper.find('section[aria-label="WhatsApp"]').exists()).toBe(false)

    const wa = useWhatsAppRelayStore()
    wa.available = true
    wa.configLoaded = true
    await flushPromises()
    expect(wrapper.get('section[aria-label="WhatsApp"]').text()).toContain('Chats next to your mail, through whatsapp-mcp on this Mac.')
    expect(wrapper.get('section[aria-label="WhatsApp"] a').attributes('href')).toBe('/settings/whatsapp/connect')

    wa.config = { folder: '/Users/kim/whatsapp-mcp', mode: 'local', deviceId: 'd', deviceName: 'Mac', linkedAt: null, importSince: '2026-10-13T10:00:00.000Z', includeGroups: true, notify: false, leftOut: [] }
    wa.identity = { number: '31698765432', name: 'Kim' }
    await flushPromises()
    expect(wrapper.get('section[aria-label="WhatsApp"]').text()).toContain('+31698765432, via this Mac')
    expect(wrapper.get('section[aria-label="WhatsApp"] a').attributes('href')).toBe('/settings/whatsapp')
  })

  it('sends every WhatsApp address elsewhere', async () => {
    useAuthStore().tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 }
    for (const [path, lands] of [
      ['/settings/whatsapp', 'settings-accounts'],
      ['/settings/whatsapp/connect', 'settings-accounts'],
      ['/whatsapp', 'unified'],
      ['/whatsapp/wa:31612345678@s.whatsapp.net', 'unified'],
      ['/chats/wa:31612345678@s.whatsapp.net', 'unified'],
    ] as const) {
      await router.push(path)
      expect({ path, lands: router.currentRoute.value.name }).toEqual({ path, lands })
    }

    // Turned on (the desktop app on macOS): the addresses open; the connect dialog only while not connected.
    const wa = useWhatsAppRelayStore()
    wa.available = true
    await router.push('/settings/whatsapp')
    expect(router.currentRoute.value.name).toBe('settings-whatsapp')
    await router.push('/settings/whatsapp/connect')
    expect(router.currentRoute.value.name).toBe('settings-whatsapp-connect')
    wa.config = { folder: '/Users/kim/whatsapp-mcp', mode: 'local', deviceId: 'd', deviceName: 'Mac', linkedAt: null, importSince: '2026-10-13T10:00:00.000Z', includeGroups: true, notify: false, leftOut: [] }
    await router.push('/settings/accounts')
    await router.push('/settings/whatsapp/connect')
    expect(router.currentRoute.value.name).toBe('settings-whatsapp')
  })
})
