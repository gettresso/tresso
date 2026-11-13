import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { LOCAL_CHAT_ACCOUNT, type SqliteMailStore } from '@tresso/core'
import type { WhatsAppCommands } from '@/platform/whatsapp'
import { at, config, copyWith, DIRECT, DIRECT_ID, direct, fakeMail, fakeRelay, fakeShell, GROUP, GROUP_ID, group, incoming, NOW } from './chatFixtures'

const fakes = vi.hoisted(() => ({ relay: null as unknown, mail: null as unknown, shell: null as unknown, shown: [] as unknown[] }))
vi.mock('@/stores/whatsappRelay', () => ({ useWhatsAppRelayStore: () => fakes.relay }))
vi.mock('@/stores/mail', () => ({ useMailStore: () => fakes.mail }))
vi.mock('@/platform/notifier', () => ({ notifier: { show: async (list: unknown[]) => void fakes.shown.push(...list) } }))
vi.mock('@/platform/whatsapp', async (original) => ({
  ...(await original<typeof import('@/platform/whatsapp')>()),
  whatsAppShell: (): Partial<WhatsAppCommands> => {
    const shell = fakes.shell as ReturnType<typeof fakeShell>
    return {
      download: async () => {
        shell.calls.push('download')
        return shell.downloadAnswer()
      },
      openFile: async (path: string) => void shell.calls.push(`open ${path}`),
      chooseFile: async () => shell.chosen,
      send: async (recipient: string, text: string, mediaPath: string | null = null) => {
        shell.sent.push({ recipient, text, mediaPath })
        return shell.sendAnswer()
      },
    }
  },
}))

const { useChatsStore } = await import('../chats')

describe('the chats store', () => {
  let relay: ReturnType<typeof fakeRelay>
  let mail: ReturnType<typeof fakeMail>
  let shell: ReturnType<typeof fakeShell>
  let store: SqliteMailStore

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    relay = fakeRelay()
    mail = fakeMail()
    shell = fakeShell()
    fakes.relay = relay
    fakes.mail = mail
    fakes.shell = shell
    fakes.shown = []
    store = await copyWith(
      [direct, group],
      [
        incoming('A1', DIRECT, -30),
        incoming('A2', DIRECT, -5),
        incoming('G1', GROUP, -10, { sender: { id: '31611111111', name: 'Mom' } }),
        incoming('G2', GROUP, -20, { sender: { id: '31622222222', name: null }, text: '', media: { kind: 'image', name: 'image_1.jpg', size: 2048 } }),
      ],
    )
    mail.store = store
    mail.currentStore = () => mail.store
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function ready() {
    const chats = useChatsStore()
    await chats.refresh()
    return chats
  }

  it('reads nothing where WhatsApp is off or not connected', async () => {
    relay.available = false
    const chats = await ready()
    expect(chats.enabled).toBe(false)
    expect(chats.summaries).toEqual([])
    expect(chats.unread).toBe(0)
    expect(await chats.page(DIRECT_ID, { limit: 5 })).toBeNull()

    relay.available = true
    relay.config = null
    relay.connected = false
    await chats.refresh()
    expect(chats.summaries).toEqual([])
  })

  it('lists the chats newest first with their unread counts, and the inbox ones', async () => {
    const chats = await ready()
    expect(chats.summaries.map((summary) => [summary.chat.id, summary.unread])).toEqual([
      [DIRECT_ID, 2],
      [GROUP_ID, 2],
    ])
    expect(chats.inboxSummaries).toHaveLength(2)
    expect(chats.unread).toBe(2)
    expect(chats.account?.id).toBe(LOCAL_CHAT_ACCOUNT)
  })

  it('reading a chat sets readThrough; Noted and Archive take it out of the inbox until a message comes in', async () => {
    const chats = await ready()
    const bram = chats.summaries[0]!.chat
    await chats.markRead(bram)
    expect(chats.summaries[0]!.unread).toBe(0)
    expect(chats.summaries[0]!.chat.readThrough).toBe(at(-5))
    expect(chats.unread).toBe(1)

    await chats.archive(chats.summaries[1]!.chat)
    expect(chats.inboxSummaries.map((summary) => summary.chat.id)).toEqual([DIRECT_ID])
    // Archived, but still in the WhatsApp list, and still unread there.
    expect(chats.summaries.map((summary) => summary.chat.id)).toEqual([DIRECT_ID, GROUP_ID])

    await chats.noted(chats.summaries[0]!.chat)
    expect(chats.inboxSummaries).toEqual([])
    expect(chats.unread).toBe(0)

    // A new message brings Bram back.
    const { LocalChatBackend } = await import('@tresso/core')
    await new LocalChatBackend(store, { includeGroups: true, leftOut: [], importSince: 0 }, { number: null, name: null, deviceId: 'd', deviceName: 'Mac' }).ingest([direct], [incoming('A3', DIRECT, 1)], false)
    relay.revision++
    await chats.refresh()
    expect(chats.inboxSummaries.map((summary) => summary.chat.id)).toEqual([DIRECT_ID])
    expect(chats.unread).toBe(1)
  })

  it('send queues the reply trimmed and asks the relay for a round; cancel and retry follow the rules', async () => {
    const pollNow = vi.spyOn(relay, 'pollNow')
    const chats = await ready()
    const reply = await chats.send(DIRECT_ID, '  On my way  ')
    expect(reply).toMatchObject({ status: 'waiting', text: 'On my way' })
    await vi.waitFor(() => expect(pollNow).toHaveBeenCalled())

    await expect(chats.send(DIRECT_ID, '   ')).rejects.toMatchObject({ code: 'empty' })

    await chats.cancel(DIRECT_ID, reply.id)
    expect((await store.chat(DIRECT_ID))!.outgoing[0]).toMatchObject({ status: 'cancelled' })

    // Only a failed reply goes again, and only on the user's Try again.
    const second = await chats.send(DIRECT_ID, 'Second')
    await store.putChatOutgoing([{ ...second, status: 'failed', error: 'unconfirmed', claimedAt: at(0) }])
    await chats.retry(DIRECT_ID, second.id)
    expect((await store.chat(DIRECT_ID))!.outgoing.find((row) => row.id === second.id)).toMatchObject({ status: 'waiting', error: null })

    // A reply being sent cannot be cancelled.
    await store.putChatOutgoing([{ ...second, status: 'sending', claimedAt: at(0) }])
    await expect(chats.cancel(DIRECT_ID, second.id)).rejects.toMatchObject({ code: 'already_going_out' })
  })

  it('reads a chat in windows through the copy', async () => {
    const chats = await ready()
    const page = await chats.page(DIRECT_ID, { limit: 1 })
    expect(page!.messages.map((message) => message.waId)).toEqual(['A2'])
    expect(page!.hasOlder).toBe(true)
  })

  it('downloads a file into Tresso\'s own folder and opens only that; says plainly why one is refused', async () => {
    const chats = await ready()
    const groupChat = chats.summaries[1]!.chat
    const photo = (await store.chat(GROUP_ID))!.messages.find((message) => message.waId === 'G2')!

    await chats.download(groupChat, photo)
    expect(chats.mediaOf(photo.id)).toEqual({ state: 'done', path: '/Users/kim/Library/Application Support/app.tresso.desktop/whatsapp-media/abc.jpg' })
    await chats.openFile(photo)
    expect(shell.calls).toEqual(['download', 'open /Users/kim/Library/Application Support/app.tresso.desktop/whatsapp-media/abc.jpg'])

    for (const [answer, reason] of [
      ['mismatch', 'mismatch'],
      ['refused', 'refused'],
      ['too_large', 'too_large'],
      ['bridge_stopped', 'stopped'],
      ['failed', 'failed'],
      ['not_found', 'failed'],
    ] as const) {
      setActivePinia(createPinia())
      const fresh = await ready()
      shell.downloadAnswer = () => Promise.reject(answer)
      await fresh.download(groupChat, photo)
      expect(fresh.mediaOf(photo.id)).toEqual({ state: 'failed', reason })
      // Nothing to open after a failure.
      shell.calls.length = 0
      await fresh.openFile(photo)
      expect(shell.calls).toEqual([])
    }

    // No hash in the store to check against: kept from opening too.
    setActivePinia(createPinia())
    const unchecked = await ready()
    shell.downloadAnswer = () => Promise.resolve({ path: '/x/abc.jpg', verified: false })
    await unchecked.download(groupChat, photo)
    expect(unchecked.mediaOf(photo.id)).toEqual({ state: 'failed', reason: 'unverified' })
  })

  it('attaches a file from the picker: sent at once, recorded only when it went out', async () => {
    const chats = await ready()
    const bram = chats.summaries[0]!.chat
    await chats.attach(bram)
    expect(shell.sent).toEqual([{ recipient: DIRECT, text: '', mediaPath: '/Users/kim/Documents/plan.pdf' }])
    expect(chats.attaching).toEqual({ state: 'sent', chatId: DIRECT_ID, name: 'plan.pdf' })
    expect((await store.chat(DIRECT_ID))!.outgoing).toEqual([expect.objectContaining({ status: 'sent', text: 'File: plan.pdf' })])

    for (const error of ['bridge_stopped', 'not_linked', 'refused', 'unconfirmed'] as const) {
      shell.sendAnswer = () => Promise.resolve({ ok: false, message: error })
      await chats.attach(bram)
      expect(chats.attaching).toEqual({ state: 'failed', chatId: DIRECT_ID, name: 'plan.pdf', error })
    }
    // Over what Attach sends: the shell refuses before the bridge reads it, said as such.
    shell.sendAnswer = () => Promise.reject('too_large')
    await chats.attach(bram)
    expect(chats.attaching).toEqual({ state: 'failed', chatId: DIRECT_ID, name: 'plan.pdf', error: 'too_large' })
    expect((await store.chat(DIRECT_ID))!.outgoing).toHaveLength(1)

    // Cancelled in the picker: nothing happens.
    shell.chosen = null
    chats.clearAttach()
    await chats.attach(bram)
    expect(chats.attaching).toEqual({ state: 'idle' })
    expect(shell.sent).toHaveLength(6)
  })

  it('leaves a chat out and takes it back in through the relay store', async () => {
    const leaveOut = vi.spyOn(relay, 'leaveOut')
    const takeBackIn = vi.spyOn(relay, 'takeBackIn')
    const chats = await ready()
    expect(await chats.leaveChatOut(chats.summaries[0]!.chat)).toBe(true)
    expect(leaveOut).toHaveBeenCalledWith(DIRECT)
    expect(await chats.takeBackIn(DIRECT)).toBe(true)
    expect(takeBackIn).toHaveBeenCalledWith(DIRECT)
  })

  it('lists the chats left out as the copy keeps them', async () => {
    const { setLocalChatState } = await import('@tresso/core')
    await setLocalChatState(store, DIRECT_ID, { leftOut: true })
    relay.config = config({ leftOut: [DIRECT] })
    const chats = await ready()
    expect(chats.leftOut.map((chat) => chat.id)).toEqual([DIRECT_ID])
    expect(chats.summaries.map((summary) => summary.chat.id)).toEqual([GROUP_ID])
  })

  it('names a sender stored without a name once the session knows it', async () => {
    const chats = await ready()
    const photo = (await store.chat(GROUP_ID))!.messages.find((message) => message.waId === 'G2')!
    expect(chats.named(photo)).toBe(photo)
    relay.senderNames = new Map([['31622222222', 'Joost']])
    expect(chats.named(photo).sender).toEqual({ id: '31622222222', name: 'Joost' })
  })

  describe('notifications', () => {
    async function arrive(waId: string, minutes: number) {
      const { LocalChatBackend } = await import('@tresso/core')
      await new LocalChatBackend(store, { includeGroups: true, leftOut: [], importSince: 0 }, { number: null, name: null, deviceId: 'd', deviceName: 'Mac' }).ingest([direct], [incoming(waId, DIRECT, minutes, { text: 'Can you bring the drill on Saturday?' })], false)
    }

    it('notifies new messages once per chat with the chat name and the start of the text, when Notify me is on', async () => {
      relay.config = config({ notify: true })
      const chats = await ready()
      // What was there at the first read is no news.
      expect(fakes.shown).toEqual([])

      await arrive('A3', 0)
      await chats.refresh()
      expect(fakes.shown).toEqual([{ title: 'Bram Visser', body: 'Can you bring the drill on Saturday?', path: `/chats/${encodeURIComponent(DIRECT_ID)}`, silent: false }])

      // The same message again says nothing.
      await chats.refresh()
      expect(fakes.shown).toHaveLength(1)
    })

    it('says nothing with Notify me off, during the first import, or for the chat open in a focused window', async () => {
      const chats = await ready()
      await arrive('A3', 0)
      await chats.refresh()
      expect(fakes.shown).toEqual([])

      relay.config = config({ notify: true })
      relay.importState = 'reading'
      await arrive('A4', 0)
      await chats.refresh()
      expect(fakes.shown).toEqual([])

      // A re-read after a chat was taken back in: what came in after it began is news.
      relay.liveFrom = NOW - 60_000
      await arrive('A7', 0)
      await chats.refresh()
      expect(fakes.shown).toHaveLength(1)
      fakes.shown.length = 0

      relay.importState = 'done'
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      chats.openChatId = DIRECT_ID
      await arrive('A5', 1)
      await chats.refresh()
      expect(fakes.shown).toEqual([])

      // Focused, but on another chat: it notifies.
      chats.openChatId = GROUP_ID
      await arrive('A6', 2)
      await chats.refresh()
      expect(fakes.shown).toHaveLength(1)
    })
  })

  it('keeps drafts per chat in memory, and drops them for a chat that went and at sign-out', async () => {
    const chats = await ready()
    chats.setDraft(DIRECT_ID, 'Half a thought')
    chats.setDraft(GROUP_ID, 'For the family')
    expect(chats.draftOf(DIRECT_ID)).toBe('Half a thought')
    chats.setDraft(GROUP_ID, '')
    expect(chats.draftOf(GROUP_ID)).toBe('')

    // Removed from the copy (groups off, disconnect): its draft goes at the next read.
    chats.setDraft(GROUP_ID, 'For the family')
    await store.removeChat(GROUP_ID)
    await chats.refresh()
    expect(chats.draftOf(GROUP_ID)).toBe('')
    expect(chats.draftOf(DIRECT_ID)).toBe('Half a thought')

    // Signed out: nothing typed stays.
    relay.connected = false
    relay.config = null
    await chats.refresh()
    expect(chats.draftOf(DIRECT_ID)).toBe('')
  })

  it('reads the chats at most once a second while the store is read in', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    const chats = await ready()
    const reads = vi.spyOn(store, 'chats')
    relay.importState = 'reading'
    for (let page = 0; page < 5; page++) {
      relay.revision++
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reads.mock.calls.length).toBeLessThanOrEqual(2)
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(1)

    // Once done, each change is read at once.
    relay.importState = 'done'
    reads.mockClear()
    relay.revision++
    await vi.advanceTimersByTimeAsync(0)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(chats.enabled).toBe(true)
  })
})
