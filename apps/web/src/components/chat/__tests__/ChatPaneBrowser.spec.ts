import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { ChatApiError, replyErrorText, SqliteMailStore, type SyncedChatAccount, type SyncedChatOutgoing } from '@tresso/core'
import { memorySql } from '@tresso/core/testing/sql'
import type { WhatsAppCommands } from '@/platform/whatsapp'
import { useAuthStore } from '@/stores/auth'
import { ACCOUNT_ID, FakeChatServer } from '@/stores/__tests__/chatServerFixture'
import { at, DIRECT, fakeMail, fakeRelay, GROUP, NOW } from '@/stores/__tests__/chatFixtures'

const fakes = vi.hoisted(() => ({
  server: null as unknown,
  relay: null as unknown,
  mail: null as unknown,
  shell: [] as string[],
  todos: { create: null as unknown },
  selection: { active: false },
  compose: { draft: null as unknown, minimized: false, notify: (_note: { text: string; tone: string }) => undefined },
}))
vi.mock('@/stores/whatsappRelay', async (original) => ({ ...(await original<typeof import('@/stores/whatsappRelay')>()), useWhatsAppRelayStore: () => fakes.relay }))
vi.mock('@/api/chats', () => ({ useChatApi: () => fakes.server }))
vi.mock('@/stores/mail', () => ({ useMailStore: () => fakes.mail }))
vi.mock('@/stores/todos', () => ({ useTodosStore: () => fakes.todos }))
vi.mock('@/stores/compose', () => ({ useComposeStore: () => fakes.compose }))
vi.mock('@/platform/notifier', () => ({ notifier: null }))
vi.mock('@/stores/selection', () => ({ useSelectionStore: () => fakes.selection }))
// The browser: the chats come from the server; no shell command may be called.
vi.mock('@/platform/whatsapp', async (original) => ({
  ...(await original<typeof import('@/platform/whatsapp')>()),
  chatsFromServer: true,
  whatsAppShell: (): Partial<WhatsAppCommands> => ({
    download: async () => {
      fakes.shell.push('download')
      throw new Error('unsupported')
    },
    openFile: async () => void fakes.shell.push('openFile'),
    chooseFile: async () => {
      fakes.shell.push('chooseFile')
      return null
    },
  }),
}))

const { default: ChatPane } = await import('../ChatPane.vue')
const { useChatsStore } = await import('@/stores/chats')

const SERVER_CHAT = `chat-${DIRECT}`
const GROUP_CHAT = `chat-${GROUP}`
const TIME = /\d{1,2}:\d\d(?: [AP]M)?/

/** The chat pane in the browser (WP11): a Mac relays the chats; replies wait in the server's queue for it. */
describe('ChatPane in the browser', () => {
  let server: FakeChatServer
  let mail: ReturnType<typeof fakeMail>
  let store: SqliteMailStore
  let router: Router
  let wrapper: VueWrapper | null
  /** The account as the relaying Mac left it: online, bridge running, linked. */
  let relayed: SyncedChatAccount

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    setActivePinia(createPinia())
    useAuthStore().tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3_600_000 }
    const relay = fakeRelay()
    relay.available = false
    relay.connected = false
    relay.config = null
    relay.linked = false
    relay.relayRunning = false
    fakes.relay = relay
    mail = fakeMail()
    fakes.mail = mail
    fakes.shell = []
    fakes.selection.active = false
    fakes.compose.draft = null
    fakes.compose.notify = vi.fn<(note: { text: string; tone: string }) => undefined>()
    fakes.todos.create = vi.fn<(todo: { title: string }) => Promise<object>>(async () => ({}))
    server = new FakeChatServer()
    fakes.server = server
    await server.connect({ deviceId: 'other-device', deviceName: 'Office iMac', address: '31698765432', displayName: 'Kim', includeGroups: true, notify: false })
    await server.relayMessages(ACCOUNT_ID, {
      deviceId: 'other-device',
      firstImport: false,
      chats: [
        { jid: DIRECT, name: 'Bram Visser', kind: 'direct' },
        { jid: GROUP, name: 'Family', kind: 'group' },
      ],
      messages: [
        { chatJid: DIRECT, waId: 'S1', fromMe: false, sender: null, text: 'Can you bring the drill?', sentAt: at(-10), media: null },
        { chatJid: GROUP, waId: 'S2', fromMe: false, sender: { id: '31611111111', name: 'Mom' }, text: '', sentAt: at(-9), media: { kind: 'image', name: 'image_1.jpg', size: 184_320 } },
        { chatJid: GROUP, waId: 'S3', fromMe: false, sender: { id: '31611111111', name: 'Mom' }, text: '', sentAt: at(-8), media: { kind: 'document', name: 'plan.pdf', size: 2048 } },
      ],
    })
    relayed = { ...server.account! }
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'unified', component: { template: '<p>List</p>' } },
        { path: '/chats/:chatId', name: 'unified-chat', component: { template: '<p>Chat</p>' } },
        { path: '/settings/whatsapp', name: 'settings-whatsapp', component: { template: '<p>Settings</p>' } },
      ],
    })
    await router.push('/chats/x')
    wrapper = null
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.useRealTimers()
  })

  /** The copy as a pull leaves it, with the account as `account` changes it, and the pane on `chatId`. */
  async function open(chatId: string, account: Partial<SyncedChatAccount> = {}, replies: Partial<SyncedChatOutgoing>[] = []): Promise<VueWrapper> {
    server.account = { ...relayed, ...account }
    for (const [i, reply] of replies.entries()) {
      const id = `0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b0${i}`
      server.outgoing.set(id, { id, chatId: SERVER_CHAT, chatAccountId: ACCOUNT_ID, text: `Reply ${i}`, status: 'waiting', error: null, createdAt: at(-1), claimedAt: null, sentAt: null, ...reply })
    }
    store = await SqliteMailStore.open(await memorySql())
    await server.deliver(store)
    server.calls.length = 0
    mail.store = store
    mail.currentStore = () => mail.store
    // MailView opens a chat once the chats show (chats.enabled): the store has read the copy by then.
    mail.chatChanges++
    const chats = useChatsStore()
    await vi.waitFor(() => expect(chats.accountId).toBe(ACCOUNT_ID))
    await chats.refresh()
    wrapper = mount(ChatPane, { props: { chatId, backTo: '/' }, global: { plugins: [router] }, attachTo: document.body })
    await vi.waitFor(() => expect(wrapper!.find('h2').exists() || wrapper!.find('.state').exists()).toBe(true))
    await flushPromises()
    return wrapper
  }

  const notice = (view: VueWrapper) => view.find('.relay-notice')
  const bubbles = (view: VueWrapper) => view.findAll('.bubbles > li.item')

  it('shows the chat from the copy, names the relaying Mac under the composer and keeps Attach off with why', async () => {
    const view = await open(SERVER_CHAT)
    expect(view.get('h2').text()).toBe('Bram Visser')
    expect(view.get('.pill').text()).toBe('WhatsApp')
    expect(bubbles(view).map((item) => item.get('.text').text())).toEqual(['Can you bring the drill?'])
    expect(notice(view).exists()).toBe(false)
    expect(view.find('.notice').exists()).toBe(false)
    expect(view.get('#chat-composer-note').text()).toBe('Sent on WhatsApp by Office iMac. No signature, no subject.')
    const attach = view.get('button[aria-label="Attach a file"]')
    expect(attach.attributes('disabled')).toBeDefined()
    expect(view.get('#chat-attach-note').text()).toBe('Files are sent from the relaying Mac for now.')
    expect(view.get('textarea').attributes('disabled')).toBeUndefined()
    // Opened: read through its last message on the server, never through the read endpoints.
    expect(server.calls.map((call) => call.name)).toEqual(['updateChat'])
    expect(fakes.shell).toEqual([])
  })

  it('says when the relaying Mac is offline (since when), its bridge stopped or its link went', async () => {
    let view = await open(SERVER_CHAT, { relayOnline: false, relayOfflineSince: at(-80) })
    expect(notice(view).attributes('role')).toBe('status')
    expect(notice(view).text()).toMatch(new RegExp(`^Your Mac is offline since ${TIME.source}\\. New WhatsApp messages show up here once it is back\\. Replies wait until then\\.$`))
    view.unmount()

    view = await open(SERVER_CHAT, { relayOnline: false, relayOfflineSince: null })
    expect(notice(view).text()).toBe('Your Mac is offline. New WhatsApp messages show up here once it is back. Replies wait until then.')
    view.unmount()

    view = await open(SERVER_CHAT, { link: 'unlinked' })
    expect(notice(view).text()).toBe('WhatsApp is not linked on your Mac. Nothing comes in or goes out until it is linked again there.')
    view.unmount()

    view = await open(SERVER_CHAT, { bridge: 'stopped' })
    expect(notice(view).text()).toBe('The bridge on your Mac is not running. New messages are not picked up, and replies wait until it runs again.')
  })

  it('reads the time again every minute, so a notice from before midnight shows the date after it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const evening = new Date(2026, 10, 12, 23, 50).getTime()
    vi.setSystemTime(evening + 60_000)
    const view = await open(SERVER_CHAT, { relayOnline: false, relayOfflineSince: new Date(evening).toISOString() })
    const before = notice(view).text()
    expect(before).toMatch(new RegExp(`^Your Mac is offline since ${TIME.source}\\.`))
    vi.setSystemTime(new Date(2026, 10, 13, 0, 5).getTime())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(notice(view).text()).not.toBe(before)
    expect(notice(view).text()).not.toMatch(new RegExp(`since ${TIME.source}\\.`))
  })

  it('holds every write until the server confirmed who is signed in', async () => {
    mail.confirmed = false
    const view = await open(SERVER_CHAT)
    expect(view.get('h2').text()).toBe('Bram Visser')
    expect(view.get('textarea').attributes('disabled')).toBeDefined()
    expect(server.calls).toEqual([])
    mail.confirmed = true
    await flushPromises()
    expect(view.get('textarea').attributes('disabled')).toBeUndefined()
  })

  it('follows the account the delta brings: the notice comes and goes', async () => {
    const view = await open(SERVER_CHAT)
    server.account = { ...server.account!, relayOnline: false, relayOfflineSince: at(0) }
    await server.deliver(store)
    mail.chatChanges++
    await vi.waitFor(() => expect(notice(view).exists()).toBe(true))
    server.account = { ...server.account!, relayOnline: true, relayOfflineSince: null }
    await server.deliver(store)
    mail.chatChanges++
    await vi.waitFor(() => expect(notice(view).exists()).toBe(false))
  })

  it('shows files by kind, size or name, to be opened on the relaying Mac, with nothing to download here', async () => {
    const view = await open(GROUP_CHAT)
    const rows = view.findAll('.media')
    expect(rows.map((row) => row.get('.title').text())).toEqual(['Photo, 180 KB', 'plan.pdf, 2.0 KB'])
    expect(rows.map((row) => row.get('.line').text())).toEqual(['Open this file on the relaying Mac.', 'Open this file on the relaying Mac.'])
    expect(view.findAll('.media button')).toEqual([])
    expect(fakes.shell).toEqual([])
  })

  describe('replies', () => {
    const metaOf = (view: VueWrapper) => bubbles(view).filter((item) => item.classes().includes('mine')).map((item) => item.get('.meta').text())

    it('waits for the Mac while it is offline, with Cancel; is sending while it is online, without', async () => {
      let view = await open(SERVER_CHAT, { relayOnline: false, relayOfflineSince: at(-30) }, [{ status: 'waiting' }])
      expect(metaOf(view)[0]).toMatch(new RegExp(`^${TIME.source}, waiting for your Mac$`))
      expect(view.get('.mine .meta').classes()).toContain('waiting')
      const cancel = view.findAll('.mine .under button')
      expect(cancel.map((button) => button.text())).toEqual(['Cancel'])
      await cancel[0]!.trigger('click')
      await flushPromises()
      expect(server.callsOf('cancelReply')).toHaveLength(1)
      await vi.waitFor(() => expect(bubbles(view).filter((item) => item.classes().includes('mine'))).toEqual([]))
      view.unmount()

      view = await open(SERVER_CHAT, {}, [{ status: 'waiting' }, { status: 'sending', claimedAt: at(0) }])
      expect(metaOf(view).map((meta) => meta.replace(TIME, 'T'))).toEqual(['T, sending', 'T, sending'])
      expect(view.findAll('.mine .under')).toEqual([])
    })

    it('says sent, and not sent with the reason and Try again, which is the only way it goes again', async () => {
      const view = await open(SERVER_CHAT, {}, [
        { status: 'sent', sentAt: at(-1) },
        { status: 'failed', error: 'refused' },
      ])
      expect(metaOf(view)[0]).toMatch(new RegExp(`^${TIME.source}, sent$`))
      expect(metaOf(view)[1]).toBe('Not sent, click to retry')
      const failed = bubbles(view).filter((item) => item.classes().includes('mine'))[1]!
      expect(failed.get('.why').text()).toBe(replyErrorText('refused'))
      expect(failed.findAll('.under button').map((button) => button.text())).toEqual(['Try again', 'Delete'])
      // Reading the chat again never sends it again.
      mail.chatChanges++
      await flushPromises()
      expect(server.callsOf('retryReply')).toEqual([])
      await failed.get('.under button').trigger('click')
      await flushPromises()
      expect(server.callsOf('retryReply')).toHaveLength(1)
    })

    it('says a reply the Mac could not confirm may have been sent, and sends it again only on Try again', async () => {
      const view = await open(SERVER_CHAT, {}, [{ status: 'failed', error: 'unconfirmed' }])
      const mine = bubbles(view).find((item) => item.classes().includes('mine'))!
      expect(mine.get('.meta').text()).toMatch(new RegExp(`^${TIME.source}, not confirmed$`))
      expect(mine.get('.meta').element.tagName).toBe('SPAN')
      expect(mine.get('.why').text()).toBe(replyErrorText('unconfirmed'))
      expect(replyErrorText('unconfirmed')).toBe('Tresso could not confirm this was sent. Check WhatsApp on your phone before trying again.')
      await mine.get('.meta').trigger('click')
      await flushPromises()
      expect(server.callsOf('retryReply')).toEqual([])
      await mine.get('.under button').trigger('click')
      await flushPromises()
      expect(server.callsOf('retryReply')).toHaveLength(1)
    })

    it('queues what is typed with Enter, once for Enter twice, never for an input method Enter', async () => {
      const view = await open(SERVER_CHAT, { relayOnline: false })
      const field = view.get<HTMLTextAreaElement>('textarea')
      await field.setValue('こんにちは')
      await field.trigger('keydown', { key: 'Enter', keyCode: 229 })
      await field.trigger('keydown', { key: 'Enter', isComposing: true })
      await flushPromises()
      expect(server.callsOf('queueReply')).toEqual([])

      await field.setValue('On my way')
      void field.trigger('keydown', { key: 'Enter' })
      void field.trigger('keydown', { key: 'Enter' })
      await flushPromises()
      await vi.waitFor(() => expect(server.callsOf('queueReply')).toHaveLength(1))
      expect(server.callsOf('queueReply')[0]![1]).toMatchObject({ text: 'On my way' })
      expect(field.element.value).toBe('')
      await vi.waitFor(() => expect(metaOf(view)[0]).toMatch(/waiting for your Mac$/))
    })

    it('keeps the text and says it may already be queued when the answer is lost, and sends it once', async () => {
      const original = server.queueReply.bind(server)
      let lose = true
      server.queueReply = async (chatId, request) => {
        const row = await original(chatId, request)
        if (lose) {
          lose = false
          throw new ChatApiError(502, 'Bad gateway.')
        }
        return row
      }
      const view = await open(SERVER_CHAT)
      const field = view.get<HTMLTextAreaElement>('textarea')
      await field.setValue('On my way')
      await view.get('form.composer').trigger('submit')
      await flushPromises()
      expect(view.get('.composer [role="alert"]').text()).toBe('Tresso could not tell whether your Tresso server took this reply; it may already be queued. Sending it again sends it once.')
      expect(field.element.value).toBe('On my way')
      await view.get('form.composer').trigger('submit')
      await flushPromises()
      const ids = server.callsOf('queueReply').map((args) => (args[1] as { id: string }).id)
      expect(ids).toHaveLength(2)
      expect(ids[1]).toBe(ids[0])
      expect(server.outgoing.size).toBe(1)
    })
  })

  it('leaves the chat out on the server and goes back to the list; a chat left out says where to take it back in', async () => {
    const view = await open(SERVER_CHAT)
    await view.get('[aria-haspopup="menu"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()
    await flushPromises()
    expect(view.get('#chat-leave-body').text().replace(/\s+/g, ' ')).toBe(
      "Tresso removes this chat's messages from your Tresso server and from every device, and stops reading it. The chat stays in WhatsApp. A contact can appear as two chats in WhatsApp (by number and by hidden number). Leave both out to keep the contact out. Only the Mac that relays WhatsApp can take it back in.",
    )
    await view.findAll('.confirm button').find((button) => button.text() === 'Leave out')!.trigger('click')
    await flushPromises()
    expect(server.lastCall('updateChat')).toEqual([SERVER_CHAT, { leftOut: true }])
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'))
    view.unmount()

    const again = await open(SERVER_CHAT)
    expect(again.get('.state').text()).toBe('You left this chat out. Take it back in on the Mac that relays WhatsApp, under Settings, WhatsApp.')
    again.unmount()
    const gone = await open('chat-unknown')
    expect(gone.get('.state').text()).toContain('This chat is not here any more.')
    wrapper = gone
  })
})
