import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { CHAT_BACKFILL, ChatApiError, SqliteMailStore, uuidV7Time } from '@tresso/core'
import { memorySql } from '@tresso/core/testing/sql'
import type { WhatsAppCommands } from '@/platform/whatsapp'
import { useAuthStore } from '@/stores/auth'
import { ACCOUNT_ID, FakeChatServer } from './chatServerFixture'
import { at, copyWith, DIRECT, direct, fakeMail, fakeRelay, GROUP, incoming, NOW } from './chatFixtures'

const fakes = vi.hoisted(() => ({ relay: null as unknown, mail: null as unknown, server: null as unknown, shell: [] as string[], shown: [] as unknown[] }))
vi.mock('@/api/chats', () => ({ useChatApi: () => fakes.server }))
vi.mock('@/stores/whatsappRelay', async (original) => ({ ...(await original<typeof import('@/stores/whatsappRelay')>()), useWhatsAppRelayStore: () => fakes.relay }))
vi.mock('@/stores/mail', () => ({ useMailStore: () => fakes.mail }))
vi.mock('@/platform/notifier', () => ({ notifier: { show: async (list: unknown[]) => void fakes.shown.push(...list) } }))
// The browser: no bridge, the chats come from the server. Every shell command the store could call is recorded.
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
    send: async () => {
      fakes.shell.push('send')
      throw new Error('unsupported')
    },
  }),
}))

const { useChatsStore, UNSURE_REPLIES } = await import('../chats')
const { RELAY_ONLY } = await import('../whatsappRelay')

const SERVER_CHAT = `chat-${DIRECT}`
const GROUP_CHAT = `chat-${GROUP}`

/** The relay store in the browser: nothing of it runs (init returns at once), so it holds nothing. */
function browserRelay() {
  const relay = fakeRelay()
  relay.available = false
  relay.connected = false
  relay.config = null
  relay.linked = false
  relay.relayRunning = false
  relay.identity = null
  return relay
}

describe('the chats store in the browser', () => {
  let relay: ReturnType<typeof fakeRelay>
  let mail: ReturnType<typeof fakeMail>
  let server: FakeChatServer
  let store: SqliteMailStore

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    setActivePinia(createPinia())
    useAuthStore().tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3_600_000 }
    relay = browserRelay()
    mail = fakeMail()
    fakes.relay = relay
    fakes.mail = mail
    fakes.shell = []
    fakes.shown = []
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
        { chatJid: DIRECT, waId: 'S1', fromMe: false, sender: null, text: 'Can you bring the drill?', sentAt: at(-3), media: null },
        { chatJid: GROUP, waId: 'S2', fromMe: false, sender: { id: '31611111111', name: 'Mom' }, text: 'Dinner at 18:00?', sentAt: at(-10), media: { kind: 'image', name: 'image_1.jpg', size: 184_320 } },
      ],
    })
    store = await SqliteMailStore.open(await memorySql())
    await server.deliver(store)
    server.calls.length = 0
    mail.store = store
    mail.currentStore = () => mail.store
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function ready() {
    const chats = useChatsStore()
    await vi.waitFor(() => expect(chats.serverChecked).toBe(true))
    await chats.refresh()
    return chats
  }

  /** Every request the chat screens made, by endpoint: the read endpoints (for MCP) are never among them. */
  const endpoints = () => [...new Set(server.calls.map((call) => call.name))]

  describe('availability', () => {
    it('is on exactly while the copy holds the server account, with no switch and no bridge', async () => {
      const chats = await ready()
      expect(chats.serverOnly).toBe(true)
      expect(chats.enabled).toBe(true)
      expect(chats.accountId).toBe(ACCOUNT_ID)
      expect(chats.relaysHere).toBe(false)
      expect(chats.canReply).toBe(true)
      expect(chats.canAttach).toBe(true)
      expect(chats.attachNote).toBe('Files are sent from the relaying Mac for now.')
      expect(chats.bringingIn).toBe(false)
      expect(chats.account?.relayDeviceName).toBe('Office iMac')
      expect(await chats.serverChats()).toBe('shown')

      // Disconnected on the Mac (or "Only this Mac" chosen there): the tombstone takes the account and its chats.
      server.removeElsewhere()
      await server.deliver(store)
      mail.chatChanges++
      await vi.waitFor(() => expect(chats.enabled).toBe(false))
      await chats.refresh()
      expect(chats.summaries).toEqual([])
      expect(chats.unread).toBe(0)
      expect(await chats.serverChats()).toBe('none')
      expect(endpoints()).toEqual([])
    })

    it('is off without a server account, also when the copy holds chats only a Mac keeps ("Only this Mac")', async () => {
      mail.store = await copyWith([direct], [incoming('A1', DIRECT, -5)])
      const chats = await ready()
      expect(chats.enabled).toBe(false)
      expect(chats.summaries).toEqual([])
      expect(await chats.page('wa:31612345678@s.whatsapp.net', { limit: 5 })).toBeNull()
      expect(await chats.serverChats()).toBe('none')
    })

    it('turns on once the delta brings the account', async () => {
      mail.store = await SqliteMailStore.open(await memorySql())
      const chats = await ready()
      expect(chats.enabled).toBe(false)
      await server.deliver(mail.store)
      mail.chatChanges++
      await vi.waitFor(() => expect(chats.enabled).toBe(true))
      await vi.waitFor(() => expect(chats.summaries).toHaveLength(2))
    })

    it('knows nothing while the copy is still opening: an address waits for it, and gives up after a while', async () => {
      mail.ready = false
      const chats = useChatsStore()
      expect(chats.serverChecked).toBe(false)
      const waiting = chats.serverChats()
      mail.ready = true
      expect(await waiting).toBe('shown')

      mail.ready = false
      await vi.waitFor(() => expect(chats.serverChecked).toBe(false))
      const slow = chats.serverChats()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await slow).toBe('unknown')

      // Signed out: nothing to wait for.
      useAuthStore().tokens = null
      expect(await chats.serverChats()).toBe('none')
    })

    it('waits on a fresh copy until the account comes or a pull ended, so a link opened at sign-in is kept', async () => {
      mail.synced = false
      mail.store = await SqliteMailStore.open(await memorySql())
      const chats = useChatsStore()
      await vi.advanceTimersByTimeAsync(0)
      expect(chats.serverChecked).toBe(false)
      const answer = chats.serverChats()
      // The first pull brings the account a few seconds later.
      await vi.advanceTimersByTimeAsync(3_000)
      await server.deliver(mail.store)
      mail.chatChanges++
      expect(await answer).toBe('shown')
    })

    it('says none on a fresh copy once a pull ended, or on a copy that synced before without a backfill to do', async () => {
      mail.synced = false
      const fresh = await SqliteMailStore.open(await memorySql())
      mail.store = fresh
      const chats = useChatsStore()
      await vi.advanceTimersByTimeAsync(0)
      expect(chats.serverChecked).toBe(false)
      mail.synced = true
      await vi.waitFor(() => expect(chats.serverChecked).toBe(true))
      expect(await chats.serverChats()).toBe('none')

      setActivePinia(createPinia())
      useAuthStore().tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3_600_000 }
      mail.synced = false
      const before = await SqliteMailStore.open(await memorySql())
      await before.markSynced(NOW - 60_000)
      await before.setChatMeta(CHAT_BACKFILL, '1')
      mail.store = before
      const again = useChatsStore()
      await vi.advanceTimersByTimeAsync(0)
      expect(again.serverChecked, 'Its chats are still to be fetched again.').toBe(false)
      await before.setChatMeta(CHAT_BACKFILL, null)
      mail.chatChanges++
      await vi.waitFor(() => expect(again.serverChecked).toBe(true))
      expect(again.enabled).toBe(false)
    })
  })

  describe('before the server confirmed who is signed in', () => {
    it('reads the chats but writes nothing, also no read by itself; then writes as usual', async () => {
      mail.confirmed = false
      const chats = await ready()
      expect(chats.enabled).toBe(true)
      expect(chats.summaries).toHaveLength(2)
      expect(chats.writesHeld).toBe(true)
      expect(chats.canReply).toBe(false)
      const chat = chats.summaries[0]!.chat
      await chats.markRead(chat)
      const still = 'Tresso is still checking who is signed in. Try again once it is connected.'
      await expect(chats.send(SERVER_CHAT, 'On my way')).rejects.toThrow(still)
      await expect(chats.archive(chat)).rejects.toThrow(still)
      await expect(chats.leaveChatOut(chat)).rejects.toThrow(still)
      await expect(chats.setNotify(true)).rejects.toThrow(still)
      await expect(chats.removeFromServer()).rejects.toThrow(still)
      expect(server.calls).toEqual([])
      expect((await store.chatPage(SERVER_CHAT, { limit: 5 }))?.outgoing).toEqual([])

      mail.confirmed = true
      expect(chats.canReply).toBe(true)
      await chats.markRead(chat)
      expect(server.callsOf('updateChat')).toEqual([[SERVER_CHAT, { readThrough: chat.lastMessageAt }]])
    })
  })

  describe('removing WhatsApp from the server', () => {
    it('deletes the account, pulls, and the chats go', async () => {
      const syncNow = vi.spyOn(mail, 'syncNow').mockImplementation(async () => {
        await server.deliver(store)
        mail.chatChanges++
      })
      const chats = await ready()
      await chats.removeFromServer()
      expect(server.callsOf('removeAccount')).toEqual([[ACCOUNT_ID]])
      expect(syncNow).toHaveBeenCalled()
      await vi.waitFor(() => expect(chats.enabled).toBe(false))
      expect(await chats.serverChats()).toBe('none')
    })

    it('counts an account already gone as removed, and says a refusal in plain words', async () => {
      const chats = await ready()
      server.fail('removeAccount', new ChatApiError(404, 'Not found.'))
      await expect(chats.removeFromServer()).resolves.toBeUndefined()
      server.fail('removeAccount', new ChatApiError(403, 'Forbidden.'))
      await expect(chats.removeFromServer()).rejects.toThrow('This session of Tresso may not change WhatsApp chats. Sign out and in again.')
      server.fail('removeAccount', new TypeError('Failed to fetch'))
      await expect(chats.removeFromServer()).rejects.toThrow('Tresso could not reach your Tresso server. Try again.')
    })
  })

  it('lists the chats with their unread counts, from the copy alone', async () => {
    const chats = await ready()
    expect(chats.summaries.map((summary) => [summary.chat.id, summary.unread])).toEqual([
      [SERVER_CHAT, 1],
      [GROUP_CHAT, 1],
    ])
    expect(chats.unread).toBe(2)
    const page = await chats.page(SERVER_CHAT, { limit: 50 })
    expect(page?.messages.map((message) => message.text)).toEqual(['Can you bring the drill?'])
    expect(endpoints()).toEqual([])
  })

  it('reads, archives and notes on the server through the copy', async () => {
    const chats = await ready()
    const chat = chats.summaries[0]!.chat
    await chats.markRead(chat)
    expect(server.callsOf('updateChat')).toEqual([[SERVER_CHAT, { readThrough: chat.lastMessageAt }]])
    expect(chats.unread).toBe(1)
    await chats.archive(chats.summaries[1]!.chat)
    expect(server.lastCall('updateChat')).toEqual([GROUP_CHAT, { archivedThrough: at(-10) }])
    expect(chats.inboxSummaries.map((summary) => summary.chat.id)).toEqual([SERVER_CHAT])
    expect(endpoints()).toEqual(['updateChat'])
  })

  it('holds a read the server refused: not asked again until the chat is looked at again, and not before Retry-After', async () => {
    const chats = await ready()
    const chat = chats.summaries[0]!.chat
    server.fail('updateChat', new ChatApiError(429, 'Slow down.', null, 120_000), true)
    const refusedAt = Date.now()
    await chats.markRead(chat)
    // Put back, so the chat is unread again; reading the list again (as the pane does after it) asks nothing more.
    expect(chats.summaries[0]!.unread).toBe(1)
    await chats.markRead(chats.summaries[0]!.chat)
    await chats.markRead(chats.summaries[0]!.chat)
    expect(server.callsOf('updateChat')).toHaveLength(1)

    // Looked at again, but the server asked to wait two minutes.
    chats.lookedAt(SERVER_CHAT)
    await chats.markRead(chats.summaries[0]!.chat)
    expect(server.callsOf('updateChat')).toHaveLength(1)
    vi.setSystemTime(refusedAt + 119_000)
    await chats.markRead(chats.summaries[0]!.chat)
    expect(server.callsOf('updateChat')).toHaveLength(1)
    vi.setSystemTime(refusedAt + 120_000)
    server.failures.clear()
    await chats.markRead(chats.summaries[0]!.chat)
    expect(server.callsOf('updateChat')).toHaveLength(2)
    expect(chats.summaries[0]!.unread).toBe(0)
  })

  it('waits for Retry-After also when a newer message came meanwhile', async () => {
    const chats = await ready()
    server.fail('updateChat', new ChatApiError(429, 'Slow down.', null, 60_000))
    const refusedAt = Date.now()
    await chats.markRead(chats.summaries[0]!.chat)
    vi.setSystemTime(refusedAt + 5_000)
    await server.relayMessages(ACCOUNT_ID, {
      deviceId: 'other-device',
      firstImport: false,
      chats: [],
      messages: [{ chatJid: DIRECT, waId: 'S4', fromMe: false, sender: null, text: 'Hello?', sentAt: at(-1), media: null }],
    })
    await server.deliver(store)
    await chats.refresh()
    chats.lookedAt(SERVER_CHAT)
    await chats.markRead(chats.summaries[0]!.chat)
    expect(server.callsOf('updateChat')).toHaveLength(1)
    vi.setSystemTime(refusedAt + 60_000)
    await chats.markRead(chats.summaries[0]!.chat)
    expect(server.callsOf('updateChat')).toHaveLength(2)
  })

  it('asks a held read again for a newer message', async () => {
    const chats = await ready()
    server.fail('updateChat', new ChatApiError(503, 'Unavailable.'))
    await chats.markRead(chats.summaries[0]!.chat)
    await chats.markRead(chats.summaries[0]!.chat)
    expect(server.callsOf('updateChat')).toHaveLength(1)
    await server.relayMessages(ACCOUNT_ID, {
      deviceId: 'other-device',
      firstImport: false,
      chats: [],
      messages: [{ chatJid: DIRECT, waId: 'S3', fromMe: false, sender: null, text: 'Still there?', sentAt: at(-1), media: null }],
    })
    await server.deliver(store)
    await chats.refresh()
    await chats.markRead(chats.summaries[0]!.chat)
    expect(server.callsOf('updateChat')).toHaveLength(2)
  })

  describe('replies', () => {
    it('queues a reply on the server under a UUIDv7 of the server clock, and nothing runs here to send it', async () => {
      const auth = useAuthStore()
      vi.spyOn(auth, 'serverNow').mockReturnValue(NOW - 90_000)
      const pollNow = vi.spyOn(relay, 'pollNow')
      const chats = await ready()
      chats.setDraft(SERVER_CHAT, ' On my way ')
      const row = await chats.send(SERVER_CHAT, ' On my way ')
      expect(uuidV7Time(row.id)).toBe(NOW - 90_000)
      expect(server.callsOf('queueReply')).toEqual([[SERVER_CHAT, { id: row.id, text: 'On my way' }]])
      expect(row.status).toBe('waiting')
      expect(chats.draftOf(SERVER_CHAT)).toBe('')
      await vi.waitFor(() => expect(chats.version).toBeGreaterThan(1))
      expect(pollNow).not.toHaveBeenCalled()
      expect(fakes.shell).toEqual([])
      expect((await store.chatPage(SERVER_CHAT, { limit: 5 }))?.outgoing.map((reply) => [reply.id, reply.status])).toEqual([[row.id, 'waiting']])
    })

    it('keeps the draft and takes the reply out when the server refuses it, and sends a new one under a new id', async () => {
      const chats = await ready()
      chats.setDraft(SERVER_CHAT, 'On my way')
      server.fail('queueReply', new ChatApiError(422, 'Invalid.', null, null, { text: 'Too long.' }))
      await expect(chats.send(SERVER_CHAT, 'On my way')).rejects.toThrow('Your Tresso server did not take this change.')
      expect(chats.draftOf(SERVER_CHAT)).toBe('On my way')
      expect((await store.chatPage(SERVER_CHAT, { limit: 1 }))?.outgoing.map((reply) => reply.status)).toEqual(['cancelled'])
      expect(await store.chatMeta(UNSURE_REPLIES)).toBeNull()
      await chats.send(SERVER_CHAT, 'On my way')
      const ids = server.callsOf('queueReply').map((args) => (args[1] as { id: string }).id)
      expect(ids[1]).not.toBe(ids[0])
    })

    for (const [what, error] of [
      ['no answer', new TypeError('Failed to fetch')],
      ['408', new ChatApiError(408, 'Timeout.')],
      ['a 5xx', new ChatApiError(502, 'Bad gateway.')],
    ] as const) {
      it(`reuses the id after ${what}, kept per chat in the copy, and a deliberate second reply is a new one`, async () => {
        const original = server.queueReply.bind(server)
        let lose = true
        server.queueReply = async (chatId, request) => {
          const row = await original(chatId, request)
          if (lose) {
            lose = false
            throw error
          }
          return row
        }
        let chats = await ready()
        await expect(chats.send(SERVER_CHAT, 'On my way')).rejects.toThrow('it may already be queued')
        expect(JSON.parse((await store.chatMeta(UNSURE_REPLIES))!)).toEqual([[SERVER_CHAT, { text: 'On my way', id: expect.any(String) }]])

        // Another text in another chat is another reply; the same text in this chat, also after a reload, is the same one.
        setActivePinia(createPinia())
        useAuthStore().tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3_600_000 }
        chats = await ready()
        await chats.send(SERVER_CHAT, 'On my way ')
        const ids = server.callsOf('queueReply').map((args) => (args[1] as { id: string }).id)
        expect(ids[1]).toBe(ids[0])
        expect(server.outgoing.size).toBe(1)
        expect(await store.chatMeta(UNSURE_REPLIES)).toBeNull()

        await chats.send(SERVER_CHAT, 'On my way')
        expect(server.outgoing.size).toBe(2)
      })
    }

    it('takes an unsure reply the delta brought as sent: its draft goes, so Send cannot make a second', async () => {
      const original = server.queueReply.bind(server)
      server.queueReply = async (chatId, request) => {
        await original(chatId, request)
        throw new ChatApiError(504, 'Gateway timeout.')
      }
      const chats = await ready()
      chats.setDraft(SERVER_CHAT, 'On my way')
      await expect(chats.send(SERVER_CHAT, 'On my way')).rejects.toThrow('it may already be queued')
      expect(chats.draftOf(SERVER_CHAT)).toBe('On my way')
      await server.deliver(store)
      mail.chatChanges++
      await vi.waitFor(() => expect(chats.unsureArrived).toMatchObject({ chatId: SERVER_CHAT }))
      expect(chats.draftOf(SERVER_CHAT)).toBe('')
      expect(await store.chatMeta(UNSURE_REPLIES)).toBeNull()
    })

    it('cancels a waiting reply, refuses to cancel one being sent, and sends a failed one again only on Try again', async () => {
      const chats = await ready()
      const first = await chats.send(SERVER_CHAT, 'First')
      await chats.cancel(SERVER_CHAT, first.id)
      expect(server.callsOf('cancelReply')).toEqual([[first.id]])

      const second = await chats.send(SERVER_CHAT, 'Second')
      server.outgoing.set(second.id, { ...server.outgoing.get(second.id)!, status: 'sending', claimedAt: at(0) })
      await server.deliver(store)
      await expect(chats.cancel(SERVER_CHAT, second.id)).rejects.toThrow('The reply is already going out.')

      server.outgoing.set(second.id, { ...server.outgoing.get(second.id)!, status: 'failed', error: 'unconfirmed' })
      await server.deliver(store)
      await chats.refresh()
      // Nothing resends it: reading the chat again leaves it failed.
      expect((await store.chatPage(SERVER_CHAT, { limit: 5 }))?.outgoing.find((reply) => reply.id === second.id)?.status).toBe('failed')
      expect(server.callsOf('retryReply')).toEqual([])
      await chats.retry(SERVER_CHAT, second.id)
      expect(server.callsOf('retryReply')).toEqual([[second.id]])
      expect(endpoints().sort()).toEqual(['cancelReply', 'queueReply', 'retryReply'])
    })
  })

  it('leaves a chat out on the server; taking it back in is for the relaying Mac', async () => {
    const leaveOut = vi.spyOn(relay, 'leaveOut')
    const takeBackIn = vi.spyOn(relay, 'takeBackIn')
    const chats = await ready()
    chats.setDraft(SERVER_CHAT, 'Half a reply')
    expect(await chats.leaveChatOut(chats.summaries[0]!.chat)).toBe(true)
    expect(server.callsOf('updateChat')).toEqual([[SERVER_CHAT, { leftOut: true }]])
    expect(chats.draftOf(SERVER_CHAT)).toBe('')
    expect(chats.summaries.map((summary) => summary.chat.id)).toEqual([GROUP_CHAT])
    expect(chats.leftOut.map((chat) => chat.id)).toEqual([SERVER_CHAT])
    await expect(chats.takeBackIn(DIRECT)).rejects.toThrow(RELAY_ONLY)
    expect(leaveOut).not.toHaveBeenCalled()
    expect(takeBackIn).not.toHaveBeenCalled()

    server.fail('updateChat', new ChatApiError(503, 'Unavailable.'))
    await expect(chats.leaveChatOut(chats.summaries[0]!.chat)).rejects.toThrow('Your Tresso server could not take this change just now. Try again.')
    expect(chats.summaries.map((summary) => summary.chat.id)).toEqual([GROUP_CHAT])
  })

  it('sets Notify me on the server account', async () => {
    const chats = await ready()
    await chats.setNotify(true)
    expect(server.callsOf('updateAccount')).toEqual([[ACCOUNT_ID, { notify: true }]])
    expect(chats.serverAccount?.notify).toBe(true)
    server.fail('updateAccount', new ChatApiError(403, 'Forbidden.'))
    await expect(chats.setNotify(false)).rejects.toThrow('This session of Tresso may not change WhatsApp chats. Sign out and in again.')
    expect(chats.serverAccount?.notify).toBe(true)
  })

  it('never touches files, the bridge or the relay, and shows no notifications of its own', async () => {
    const chats = await ready()
    const groupChat = chats.summaries[1]!.chat
    const page = await chats.page(GROUP_CHAT, { limit: 5 })
    await chats.download(groupChat, page!.messages[0]!)
    await chats.attach(groupChat)
    await server.relayMessages(ACCOUNT_ID, {
      deviceId: 'other-device',
      firstImport: false,
      chats: [],
      messages: [{ chatJid: DIRECT, waId: 'S9', fromMe: false, sender: null, text: 'New', sentAt: at(-1), media: null }],
    })
    await server.deliver(store)
    mail.chatChanges++
    await vi.waitFor(() => expect(chats.summaries[0]!.unread).toBe(2))
    expect(fakes.shell).toEqual([])
    expect(fakes.shown).toEqual([])
    expect(chats.attaching).toEqual({ state: 'idle' })
  })
})
