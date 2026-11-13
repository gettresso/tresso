import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { setLocalChatState, type SqliteMailStore } from '@tresso/core'
import type { Conversation } from '@/mail/db'
import { useChatsStore } from '@/stores/chats'
import { useMailStore } from '@/stores/mail'
import { useSelectionStore } from '@/stores/selection'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import { config, copyWith, DIRECT, DIRECT_ID, direct, GROUP, GROUP_ID, group, incoming, LINKED, NOW } from '@/stores/__tests__/chatFixtures'
import { defineComponent, h } from 'vue'
import { openConversation, useConversationCommands } from '@/mail/openConversation'
import MailView from '../MailView.vue'

function conversation(threadId: string, lastMessageAt: number): Conversation {
  return {
    threadId,
    mailAccountId: 'work',
    subject: `Mail ${threadId}`,
    snippet: '',
    lastMessageAt,
    messageCount: 1,
    unreadCount: 0,
    flagged: false,
    hasAttachments: false,
    attachmentsBlocked: false,
    senders: [{ name: 'Anna', address: 'anna@example.test' }],
    inbox: true,
    active: true,
    heldUntil: null,
    batchedAt: null,
    smartInboxId: null,
    verdict: null,
    classificationReason: null,
  }
}

/** MailView with the Unified Inbox's chats, the route deciding which chat is open. */
describe('MailView with chats', () => {
  let router: Router
  let copy: SqliteMailStore
  let wrapper: VueWrapper | null = null

  beforeEach(async () => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    setActivePinia(createPinia())
    copy = await copyWith(
      [direct, group],
      [incoming('A1', DIRECT, -5), incoming('G1', GROUP, -10, { sender: { id: '31611111111', name: 'Mom' } })],
    )
    const mail = useMailStore()
    vi.spyOn(mail, 'showMailbox').mockResolvedValue()
    vi.spyOn(mail, 'currentStore').mockReturnValue(copy)
    mail.ready = true
    mail.synced = true
    mail.conversations = [conversation('t1', NOW - 7 * 60_000)]
    const wa = useWhatsAppRelayStore()
    wa.available = true
    wa.config = config()
    wa.bridge = LINKED
    vi.spyOn(wa, 'pollNow').mockResolvedValue()
    vi.spyOn(wa, 'lookUpNames').mockResolvedValue()
    vi.spyOn(wa, 'leaveOut').mockImplementation(async (jid: string) => {
      await setLocalChatState(copy, `wa:${jid}`, { leftOut: true })
      return true
    })
    await useChatsStore().refresh()
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'unified', component: MailView },
        { path: '/inbox/:threadId', name: 'unified-thread', component: MailView },
        { path: '/chats/:chatId', name: 'unified-chat', component: MailView },
        { path: '/settings/whatsapp', name: 'settings-whatsapp', component: { template: '<p />' } },
      ],
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.useRealTimers()
    sessionStorage.clear()
  })

  async function show(path: string): Promise<VueWrapper> {
    await router.push(path)
    wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router], stubs: { MiniAgenda: true, ReadingPane: true } }, attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  const rows = (view: VueWrapper) => view.findAll('.scroll a.link').map((link) => link.attributes('href'))

  it('moves focus to the row after the chat that was left out', async () => {
    const view = await show(`/chats/${encodeURIComponent(DIRECT_ID)}`)
    expect(rows(view)).toEqual([`/chats/${DIRECT_ID}`, '/inbox/t1', `/chats/${GROUP_ID}`])
    expect(view.find('.chat-pane').exists()).toBe(true)

    await view.get('.chat-pane [aria-haspopup="menu"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()
    await flushPromises()
    await view.get('[role="alertdialog"] .button-danger').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/')
    expect(view.find('.chat-pane').exists()).toBe(false)
    expect(document.activeElement?.getAttribute('href')).toBe('/inbox/t1')
  })

  it('moves focus to the list itself after Noted on the last row', async () => {
    const view = await show(`/chats/${encodeURIComponent(GROUP_ID)}`)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }))
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
    expect(document.activeElement).toBe(view.get('.scroll').element)
  })

  it('offers the Message menu no mail conversation while a chat is open', async () => {
    // A reading pane that offers its commands as the real one does (useConversationCommands).
    const done = async () => undefined
    const ReadingPane = defineComponent({
      setup() {
        useConversationCommands({ ready: () => true, read: () => true, flagged: () => false, hasTodo: () => false, reply: done, archive: done, trash: done, chooseFolder: done, toggleRead: done, toggleFlag: done, settleDo: done, handOver: done, settleNoted: done, makeTodo: done })
        return () => h('article', { class: 'mail-pane' })
      },
    })
    await router.push('/inbox/t1')
    wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router], stubs: { MiniAgenda: true, ReadingPane } }, attachTo: document.body })
    await flushPromises()
    expect(openConversation()).not.toBeNull()

    // A chat opened from the list: the mail pane goes, and with it every command the menu could run on that mail.
    await router.push(`/chats/${encodeURIComponent(DIRECT_ID)}`)
    await flushPromises()
    expect(wrapper.find('.chat-pane').exists()).toBe(true)
    expect(wrapper.find('.mail-pane').exists()).toBe(false)
    expect(openConversation()).toBeNull()
  })

  it('leaves the focus alone when a mail conversation is opened from the open chat', async () => {
    const view = await show(`/chats/${encodeURIComponent(DIRECT_ID)}`)
    await view.get('.scroll a[href="/inbox/t1"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/inbox/t1')
    expect(view.find('.chat-pane').exists()).toBe(false)
    // Not moved to a row or the list by the chat's closing.
    expect(document.activeElement?.closest('.scroll')).toBeNull()
  })

  it('clears the selection of mail when another channel tab is chosen', async () => {
    const view = await show('/')
    const selection = useSelectionStore()
    selection.set(['t1'])
    expect(selection.active).toBe(true)
    await view.findAll('[aria-label="Channels"] button')[2]!.trigger('click')
    await flushPromises()
    expect(useChatsStore().channel).toBe('whatsapp')
    expect(selection.active).toBe(false)
    expect(rows(view)).toEqual([`/chats/${DIRECT_ID}`, `/chats/${GROUP_ID}`])
  })
})
