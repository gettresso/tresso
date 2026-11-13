import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SqliteMailStore, SyncedChat, SyncedChatAccount, SyncedChatOutgoing, UpdateChatRequest } from '@tresso/core'
import { ApiError } from '@/auth/session'
import { ChatActions } from '@/chat/chatActions'
import type { PhoneChatApi } from '@/chat/chatApi'
import { clockTime } from '@/chat/texts'
import { account, chat, copyWith, deferred, message, reply } from '@/chat/__tests__/fixtures'
import ChatScreen from '@/app/chats/[id]'

const env = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    params: { id: 'c1' },
    version: 0,
    pulls: 1,
    listeners,
    bump() {
      this.version += 1
      for (const listener of listeners) {
        listener()
      }
    },
    chats: null as unknown as {
      account: SyncedChatAccount | null
      actions: ChatActions
      store: SqliteMailStore
      drafts: Map<string, string>
      createTodo: ReturnType<typeof vi.fn>
    },
    notify: vi.fn(),
    router: { back: vi.fn(), replace: vi.fn(), push: vi.fn(), canGoBack: () => true },
  }
})

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    Stack: { Screen: () => null },
    useLocalSearchParams: () => env.params,
    useRouter: () => env.router,
    useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  }
})
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }))
vi.mock('@/components/Notices', () => ({ useNotices: () => ({ notify: env.notify }) }))
vi.mock('@/components/Icon', () => ({ Icon: () => null }))
vi.mock('@/mail/MailProvider', async () => {
  const React = await import('react')
  return {
    useMail: () => {
      const [, setSeen] = React.useState(0)
      React.useEffect(() => {
        const listener = () => setSeen((seen) => seen + 1)
        env.listeners.add(listener)
        return () => void env.listeners.delete(listener)
      }, [])
      return { version: env.version, pulls: env.pulls, syncState: 'idle', syncError: null, syncNow: async () => undefined }
    },
  }
})
vi.mock('@/chat/ChatProvider', async () => {
  const React = await import('react')
  return {
    useChats: () => {
      const [revision, setRevision] = React.useState(0)
      React.useEffect(() => env.chats.actions.subscribe(() => setRevision((value) => value + 1)), [])
      const { store, drafts } = env.chats
      return {
        account: env.chats.account,
        inbox: [],
        actions: env.chats.actions,
        revision,
        page: (chatId: string, options: Parameters<SqliteMailStore['chatPage']>[1]) => store.chatPage(chatId, options),
        draftOf: (chatId: string) => drafts.get(chatId) ?? '',
        setDraft: (chatId: string, text: string) => (text === '' ? drafts.delete(chatId) : drafts.set(chatId, text)),
        createTodo: env.chats.createTodo,
      }
    },
  }
})

const TODAY = new Date()
TODAY.setHours(9, 58, 0, 0)
const minutes = (n: number) => new Date(TODAY.getTime() + n * 60_000).toISOString()
const time = (iso: string) => clockTime(Date.parse(iso))

/** Bram's chat: read through his first message, so his second is unread. */
const BRAM = chat('c1', { lastMessageAt: minutes(16), readThrough: minutes(0) })
const BRAM_SAYS = [
  message('m1', 'c1', minutes(0), { text: 'Hey Kim! Are we still on for moving the cabinets this weekend?' }),
  message('m2', 'c1', minutes(4), { fromMe: true, text: 'Yes, Saturday from 10. Thanks for helping!' }),
  message('m3', 'c1', minutes(16), { text: 'This is the wall. Can you bring the drill on Saturday?' }),
]

function fakeApi(overrides: Partial<PhoneChatApi> = {}): PhoneChatApi {
  return {
    queueReply: vi.fn(async (chatId: string, request: { id: string; text: string }) => reply(request.id, chatId, { text: request.text, createdAt: new Date().toISOString() })),
    cancelReply: vi.fn(async () => undefined),
    retryReply: vi.fn(async (id: string) => reply(id, 'c1', { status: 'waiting' })),
    updateChat: vi.fn(async (id: string, request: UpdateChatRequest) => ({ ...BRAM, id, readThrough: request.readThrough ?? null })),
    ...overrides,
  }
}

async function open(rows: { account?: SyncedChatAccount | null; chats?: SyncedChat[]; outgoing?: SyncedChatOutgoing[] } = {}, api: PhoneChatApi = fakeApi()) {
  const store = await copyWith({ account: rows.account, chats: rows.chats ?? [BRAM], messages: BRAM_SAYS, outgoing: rows.outgoing ?? [] })
  let ids = 0
  env.chats = {
    account: rows.account === undefined ? account() : rows.account,
    store,
    drafts: new Map(),
    createTodo: vi.fn(async () => undefined),
    actions: new ChatActions({
      store: () => store,
      api,
      now: () => Date.now(),
      newId: () => `0193a1c2-0000-7000-8000-${String(++ids).padStart(12, '0')}`,
      changed: () => env.bump(),
    }),
  }
  render(<ChatScreen />)
  return { store, api }
}

function sendButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Send' })
}

describe('the chat screen', () => {
  beforeEach(() => {
    env.params.id = 'c1'
    env.version = 0
    env.pulls = 1
    env.notify.mockClear()
  })

  it('shows a direct chat: the name, WhatsApp, theirs and mine with their times', async () => {
    await open()

    expect(await screen.findByText('Bram Visser')).toBeTruthy()
    expect(screen.getByText('WhatsApp')).toBeTruthy()
    expect(screen.getByText('This is the wall. Can you bring the drill on Saturday?')).toBeTruthy()
    expect(screen.getByLabelText(`You, ${time(minutes(4))}, Yes, Saturday from 10. Thanks for helping!`)).toBeTruthy()
    expect(screen.getByLabelText(`Bram Visser, ${time(minutes(16))}, This is the wall. Can you bring the drill on Saturday?`)).toBeTruthy()
    expect(screen.getByText('Today')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Make todo' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
    expect(screen.queryByText(/Your Mac is offline/)).toBeNull()
  })

  it('shows group senders by name above their messages', async () => {
    const family = chat('c1', { jid: '120363025246125486@g.us', kind: 'group', name: 'Family', lastMessageAt: minutes(0), readThrough: minutes(0) })
    const store = await copyWith({ chats: [family], messages: [message('g1', 'c1', minutes(0), { sender: { id: '31611111111@s.whatsapp.net', name: 'Mom' }, text: 'Dinner at 18:00 on Sunday?' })] })
    env.chats = { account: account(), store, drafts: new Map(), createTodo: vi.fn(), actions: new ChatActions({ store: () => store, api: fakeApi(), now: Date.now, newId: () => 'x', changed: () => env.bump() }) }
    render(<ChatScreen />)

    expect(await screen.findByText('Mom')).toBeTruthy()
    expect(screen.getByText('Family')).toBeTruthy()
  })

  it('says the Mac is offline, and that a reply waits for it', async () => {
    await open({ account: account({ relayOnline: false, relayOfflineSince: minutes(-80) }), outgoing: [reply('r1', 'c1', { text: "Perfect, I'll bring the drill on Saturday", createdAt: minutes(33) })] })

    expect(await screen.findByText('Your Mac is offline. Replies go out once it is back.')).toBeTruthy()
    expect(screen.getByText(`${time(minutes(33))}, waiting for your Mac`)).toBeTruthy()
  })

  it('shows a reply that was not sent with its reason, and sends it again on a tap', async () => {
    const { api } = await open({ outgoing: [reply('r1', 'c1', { status: 'failed', error: 'bridge_stopped', createdAt: minutes(20) })] })

    expect(await screen.findByText('Not sent, tap to retry')).toBeTruthy()
    expect(screen.getByText('The bridge is not running.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(`You, ${time(minutes(20))}, not sent, Reply r1`))

    await waitFor(() => expect(api.retryReply).toHaveBeenCalledWith('r1'))
  })

  it('never sends a reply that may have gone out on a tap, only with its own Try again', async () => {
    const { api } = await open({ outgoing: [reply('r1', 'c1', { status: 'failed', error: 'unconfirmed', createdAt: minutes(20) })] })

    expect(await screen.findByText(`${time(minutes(20))}, not confirmed`)).toBeTruthy()
    expect(screen.getByText('Tresso could not confirm this was sent. Check WhatsApp on your phone before trying again.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(`You, ${time(minutes(20))}, not confirmed, Reply r1`))
    expect(api.retryReply).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(api.retryReply).toHaveBeenCalledWith('r1'))
  })

  it('shows a reply as waiting for the Mac at once and queues it once, however often Send is pressed', async () => {
    const answer = deferred<SyncedChatOutgoing>()
    const queueReply = vi.fn(() => answer.promise)
    await open({ account: account({ relayOnline: false }) }, fakeApi({ queueReply }))
    const field = await screen.findByLabelText('Reply to Bram Visser')

    fireEvent.change(field, { target: { value: 'On my way' } })
    fireEvent.click(sendButton())
    fireEvent.click(sendButton())

    await waitFor(() => expect(screen.getByText('On my way')).toBeTruthy())
    expect(screen.getByText(/, waiting for your Mac$/)).toBeTruthy()
    expect((field as HTMLTextAreaElement).value).toBe('')
    expect(queueReply).toHaveBeenCalledTimes(1)

    const id = (queueReply.mock.calls[0] as unknown as [string, { id: string }])[1].id
    await act(async () => answer.resolve(reply(id, 'c1', { text: 'On my way' })))
    expect(screen.getByText('On my way')).toBeTruthy()
  })

  it('takes a refused reply back: the bubble goes, the text is back in the box, and the reason shows', async () => {
    const refusal = new ApiError(429, 'Too many WhatsApp replies at once. Wait a few minutes, then try again.')
    await open({}, fakeApi({ queueReply: vi.fn(async () => Promise.reject(refusal)) }))
    const field = await screen.findByLabelText('Reply to Bram Visser')

    fireEvent.change(field, { target: { value: 'On my way' } })
    fireEvent.click(sendButton())

    expect(await screen.findByText('Not sent. Too many WhatsApp replies at once. Wait a few minutes, then try again.')).toBeTruthy()
    expect((field as HTMLTextAreaElement).value).toBe('On my way')
    expect(screen.queryByText(/waiting for your Mac|, sending$/)).toBeNull()
  })

  it('keeps Send off for an empty reply and says when one is too long', async () => {
    const { api } = await open()
    const field = await screen.findByLabelText('Reply to Bram Visser')

    expect(sendButton().getAttribute('aria-disabled')).toBe('true')
    fireEvent.change(field, { target: { value: 'x'.repeat(4097) } })

    expect(screen.getByText('A reply can have at most 4,096 characters.')).toBeTruthy()
    expect(screen.getByText('4,097 of 4,096 characters')).toBeTruthy()
    fireEvent.click(sendButton())
    expect(api.queueReply).not.toHaveBeenCalled()
  })

  it('reads the chat in Tresso when it opens in front', async () => {
    const { api, store } = await open()

    await waitFor(() => expect(api.updateChat).toHaveBeenCalledWith('c1', { readThrough: BRAM.lastMessageAt }))
    expect((await store.chatByJid(BRAM.chatAccountId, BRAM.jid))?.readThrough).toBe(BRAM.lastMessageAt)
  })

  it('shows nothing of WhatsApp without an account on the server', async () => {
    const { api } = await open({ account: null })

    expect(await screen.findByText('This chat is not on this phone. WhatsApp shows here only while your Mac passes your chats to your Tresso server.')).toBeTruthy()
    expect(screen.queryByLabelText('Reply to Bram Visser')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Make todo' })).toBeNull()
    expect(api.updateChat).not.toHaveBeenCalled()
  })

  it('makes a todo titled after the chat, which the user sees first', async () => {
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Make todo' }))

    const title = screen.getByLabelText('Todo') as HTMLInputElement
    expect(title.value).toBe('Reply to Bram Visser')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(env.chats.createTodo).toHaveBeenCalledWith('Reply to Bram Visser'))
  })
})
