import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessibilityInfo, Alert, AppState, Linking } from 'react-native'
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
      accountRead?: boolean
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
const picker = vi.hoisted(() => ({ result: { canceled: true, assets: null } as unknown }))
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn(async () => picker.result) }))
const files = vi.hoisted(() => ({ size: null as number | null, removed: [] as string[] }))
vi.mock('@/chat/fileUpload', () => ({
  fileSizeOf: async () => files.size,
  removeCachedCopy: async (uri: string) => void files.removed.push(uri),
}))
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
        accountRead: env.chats.accountRead ?? true,
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
  message('m4', 'c1', minutes(15), { text: '', mediaKind: 'image', mediaName: 'image_1.jpg', mediaSize: 184_320, mediaState: 'remote', mediaError: null, mediaAccess: null }),
]

function fakeApi(overrides: Partial<PhoneChatApi> = {}): PhoneChatApi {
  return {
    queueReply: vi.fn(async (chatId: string, request: { id: string; text: string }) => reply(request.id, chatId, { text: request.text, createdAt: new Date().toISOString() })),
    cancelReply: vi.fn(async () => undefined),
    retryReply: vi.fn(async (id: string) => reply(id, 'c1', { status: 'waiting' })),
    updateChat: vi.fn(async (id: string, request: UpdateChatRequest) => ({ ...BRAM, id, readThrough: request.readThrough ?? null })),
    requestMedia: vi.fn(async (messageId: string) => ({ messageId, kind: 'image' as const, name: null, size: null, state: 'requested' as const, error: null, access: null, url: null })),
    media: vi.fn(async (messageId: string) => ({ messageId, kind: 'image' as const, name: null, size: null, state: 'stored' as const, error: null, access: 'allowed' as const, url: `https://api.test/content/chat-media/${messageId}` })),
    unscannedMediaLink: vi.fn(async (messageId: string) => ({ messageId, kind: 'image' as const, name: null, size: null, state: 'stored' as const, error: null, access: 'confirm' as const, url: `https://api.test/content/chat-media/${messageId}?unscanned=1` })),
    uploadFile: vi.fn(async (chatId: string, uploadId: string) => ({ id: uploadId, chatId, size: 31 })),
    ...overrides,
  }
}

async function open(rows: { account?: SyncedChatAccount | null; chats?: SyncedChat[]; outgoing?: SyncedChatOutgoing[]; accountRead?: boolean } = {}, api: PhoneChatApi = fakeApi()) {
  const store = await copyWith({ account: rows.account, chats: rows.chats ?? [BRAM], messages: BRAM_SAYS, outgoing: rows.outgoing ?? [] })
  let ids = 0
  env.chats = {
    account: rows.account === undefined ? account() : rows.account,
    accountRead: rows.accountRead,
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

  it('says nothing and puts no text back for a reply cancelled before its queueing answered', async () => {
    const answer = deferred<SyncedChatOutgoing>()
    const queueReply = vi.fn(() => answer.promise)
    const { api } = await open({ account: account({ relayOnline: false }) }, fakeApi({ queueReply }))
    const field = await screen.findByLabelText('Reply to Bram Visser')
    fireEvent.change(field, { target: { value: 'On my way' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(screen.getByText('On my way')).toBeTruthy())

    const id = (queueReply.mock.calls[0] as unknown as [string, { id: string }])[1].id
    await act(async () => env.chats.actions.cancel(reply(id, 'c1', { text: 'On my way' })))
    expect(api.cancelReply).toHaveBeenCalledWith(id)
    await act(async () => answer.reject(new ApiError(409, 'This reply was cancelled.', {}, null, 'cancelled')))

    await waitFor(() => expect(screen.queryByText('On my way')).toBeNull())
    expect((field as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
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

  it('asks the server once for a read it refuses, however often the copy changes', async () => {
    const updateChat = vi.fn(async (): Promise<SyncedChat> => Promise.reject(new ApiError(503, 'Service Unavailable')))
    await open({}, fakeApi({ updateChat }))

    await waitFor(() => expect(updateChat).toHaveBeenCalledTimes(1))
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        env.bump()
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    }

    expect(updateChat).toHaveBeenCalledTimes(1)
    expect(env.version, 'The read and its rollback changed the copy, and the window was read again.').toBeGreaterThanOrEqual(5)
  })

  it('shows loading, not that the chat is missing, until the copy was read for the account', async () => {
    await open({ account: null, accountRead: false })

    expect(await screen.findByLabelText('Loading the chat')).toBeTruthy()
    expect(screen.queryByText(/This chat is not on this phone/)).toBeNull()
  })

  it('says a reply whose sending is unknown may have been sent', async () => {
    await open({}, fakeApi({ queueReply: vi.fn(async () => Promise.reject(new ApiError(504, 'Gateway Timeout'))) }))
    const field = await screen.findByLabelText('Reply to Bram Visser')

    fireEvent.change(field, { target: { value: 'On my way' } })
    fireEvent.click(sendButton())

    expect(await screen.findByText('This reply may have been sent. Gateway Timeout. Check the chat before you send it again.')).toBeTruthy()
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

  describe('files', () => {
    it('asks the Mac for a file only on Download', async () => {
      const { api } = await open()

      expect(await screen.findByText('Photo, on your Mac')).toBeTruthy()
      expect(api.requestMedia).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Download, Photo, 180 KB' }))
      await waitFor(() => expect(api.requestMedia).toHaveBeenCalledWith('m4'))
    })

    it('opens a checked file through a fresh link, and one not checked only after the warning', async () => {
      const opened = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
      const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => undefined)
      const store = await copyWith({ chats: [BRAM], messages: [message('m4', 'c1', minutes(15), { text: '', mediaKind: 'image', mediaName: null, mediaSize: 10, mediaState: 'stored', mediaError: null, mediaAccess: 'allowed' })] })
      const api = fakeApi()
      env.chats = { account: account(), store, drafts: new Map(), createTodo: vi.fn(), actions: new ChatActions({ store: () => store, api, now: Date.now, newId: () => 'x', changed: () => env.bump() }) }
      render(<ChatScreen />)

      fireEvent.click(await screen.findByRole('button', { name: 'Open, Photo, 10 B' }))
      await waitFor(() => expect(opened).toHaveBeenCalledWith('https://api.test/content/chat-media/m4'))

      await store.putChatMessages([message('m4', 'c1', minutes(15), { text: '', mediaKind: 'image', mediaName: null, mediaSize: 10, mediaState: 'stored', mediaError: null, mediaAccess: 'confirm' })])
      act(() => env.bump())
      fireEvent.click(await screen.findByRole('button', { name: 'Open anyway, Photo, 10 B' }))
      expect(alert).toHaveBeenCalledTimes(1)
      expect(api.unscannedMediaLink).not.toHaveBeenCalled()
      const buttons = alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[]
      act(() => buttons.find((button) => button.text === 'Open anyway')!.onPress!())
      await waitFor(() => expect(opened).toHaveBeenCalledWith('https://api.test/content/chat-media/m4?unscanned=1'))
      opened.mockRestore()
      alert.mockRestore()
    })

    it('attaches a file: uploaded, then queued for the Mac, shown by its name', async () => {
      picker.result = { canceled: false, assets: [{ uri: 'file:///cache/plan.pdf', name: 'plan.pdf', size: 31, mimeType: 'application/pdf' }] }
      const { api } = await open()

      fireEvent.click(await screen.findByRole('button', { name: 'Attach a file' }))

      await waitFor(() => expect(api.queueReply).toHaveBeenCalledTimes(1))
      const [[, uploadId]] = vi.mocked(api.uploadFile).mock.calls
      expect(vi.mocked(api.queueReply).mock.calls[0]![1]).toMatchObject({ text: '', file: { uploadId, name: 'plan.pdf' } })
      await waitFor(() => expect(files.removed).toEqual(['file:///cache/plan.pdf']))
      picker.result = { canceled: true, assets: null }
    })

    it('reads the size when the picker gives none, and sends nothing whose size is not known', async () => {
      files.removed = []
      picker.result = { canceled: false, assets: [{ uri: 'file:///cache/notes.txt', name: 'notes.txt', size: undefined, mimeType: 'text/plain' }] }
      files.size = null
      const { api } = await open()

      fireEvent.click(await screen.findByRole('button', { name: 'Attach a file' }))

      expect(await screen.findByText('notes.txt was not sent. Tresso could not tell how large it is.')).toBeTruthy()
      expect(api.uploadFile).not.toHaveBeenCalled()
      await waitFor(() => expect(files.removed).toEqual(['file:///cache/notes.txt']), { timeout: 1000 })

      files.size = 101 * 1024 * 1024
      fireEvent.click(screen.getByRole('button', { name: 'Attach a file' }))
      expect(await screen.findByText('notes.txt is larger than 100 MB, the most Tresso sends.')).toBeTruthy()
      expect(api.uploadFile).not.toHaveBeenCalled()
      files.size = null
      picker.result = { canceled: true, assets: null }
    })

    it('shows a file on its way as uploading with Cancel, and Cancel queues nothing', async () => {
      picker.result = { canceled: false, assets: [{ uri: 'file:///cache/plan.pdf', name: 'plan.pdf', size: 31, mimeType: 'application/pdf' }] }
      const api = fakeApi({
        uploadFile: vi.fn(
          (_chatId: string, _uploadId: string, _file: { uri: string }, options?: { signal?: AbortSignal }) =>
            new Promise<never>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled.', 'AbortError')), { once: true })),
        ),
      })
      await open({}, api)

      fireEvent.click(await screen.findByRole('button', { name: 'Attach a file' }))
      expect(await screen.findByText(/uploading, 0%$/)).toBeTruthy()
      expect(screen.queryByText(/waiting for your Mac/)).toBeNull()
      files.removed = []
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(await screen.findByText('plan.pdf was not sent.')).toBeTruthy()
      expect(api.queueReply).not.toHaveBeenCalled()
      expect(api.cancelReply).not.toHaveBeenCalled()
      await waitFor(() => expect(files.removed, 'The picker\'s copy goes after a cancel too.').toEqual(['file:///cache/plan.pdf']))
      picker.result = { canceled: true, assets: null }
    })

    it('stops an upload when the app goes to the background, and queues nothing', async () => {
      picker.result = { canceled: false, assets: [{ uri: 'file:///cache/plan.pdf', name: 'plan.pdf', size: 31, mimeType: 'application/pdf' }] }
      const handlers: ((state: string) => void)[] = []
      const listen = vi.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
        handlers.push(handler as (state: string) => void)
        return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>
      })
      const api = fakeApi({
        uploadFile: vi.fn(
          (_chatId: string, _uploadId: string, _file: { uri: string }, options?: { signal?: AbortSignal }) =>
            new Promise<never>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled.', 'AbortError')), { once: true })),
        ),
      })
      await open({}, api)
      fireEvent.click(await screen.findByRole('button', { name: 'Attach a file' }))
      expect(await screen.findByText(/uploading, 0%$/)).toBeTruthy()

      act(() => handlers.forEach((handler) => handler('background')))

      expect(await screen.findByText('plan.pdf was not sent.')).toBeTruthy()
      expect(api.queueReply).not.toHaveBeenCalled()
      listen.mockRestore()
      picker.result = { canceled: true, assets: null }
    })

    it('says a file may still be sent when its cancel was not confirmed, and keeps it in the chat', async () => {
      picker.result = { canceled: false, assets: [{ uri: 'file:///cache/plan.pdf', name: 'plan.pdf', size: 31, mimeType: 'application/pdf' }] }
      const answer = deferred<SyncedChatOutgoing>()
      const api = fakeApi({ queueReply: vi.fn(() => answer.promise), cancelReply: vi.fn(async () => Promise.reject(new TypeError('Network request failed'))) })
      await open({ account: account({ relayOnline: false }) }, api)
      fireEvent.click(await screen.findByRole('button', { name: 'Attach a file' }))
      await waitFor(() => expect(api.queueReply).toHaveBeenCalled())

      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(api.cancelReply).toHaveBeenCalled())
      const id = (vi.mocked(api.queueReply).mock.calls[0] as unknown as [string, { id: string }])[1].id
      await act(async () => answer.resolve(reply(id, 'c1', { text: '', file: { name: 'plan.pdf', size: 31 } })))

      expect(await screen.findByText('plan.pdf may still be sent. Check the chat.')).toBeTruthy()
      expect(screen.getByText(/, waiting for your Mac$/)).toBeTruthy()
      picker.result = { canceled: true, assets: null }
    })

    it('says an upload that failed was not sent, never that it may have been', async () => {
      picker.result = { canceled: false, assets: [{ uri: 'file:///cache/plan.pdf', name: 'plan.pdf', size: 31, mimeType: 'application/pdf' }] }
      const api = fakeApi({ uploadFile: vi.fn(async () => Promise.reject(new ApiError(429, 'Too many files uploaded at once. Wait a few minutes, then attach it again.', {}, 60_000))) })
      await open({}, api)

      fireEvent.click(await screen.findByRole('button', { name: 'Attach a file' }))

      expect(await screen.findByText('plan.pdf was not sent. Too many files sent at once. Wait a minute, then attach it again.'), 'The real wait, not the server\'s "a few minutes".').toBeTruthy()
      expect(api.queueReply).not.toHaveBeenCalled()
      await waitFor(() => expect(files.removed, 'The picker\'s copy goes after a failure.').toContain('file:///cache/plan.pdf'))
      // Attach waits until the server's Retry-After, and says why.
      expect(screen.getByText('Too many files sent at once. Wait a minute, then attach it again.'), 'The real wait, rounded up.').toBeTruthy()
      expect(screen.getByRole('button', { name: 'Attach a file' }).getAttribute('aria-disabled')).toBe('true')
      picker.result = { canceled: true, assets: null }
    })

    it('gives screen readers the file action on the bubble, and says a new file state', async () => {
      const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
      const { store } = await open()
      expect(await screen.findByText('Photo, on your Mac')).toBeTruthy()

      await store.putChatMessages([message('m4', 'c1', minutes(15), { text: '', mediaKind: 'image', mediaName: 'image_1.jpg', mediaSize: 184_320, mediaState: 'requested', mediaError: null, mediaAccess: null })])
      act(() => env.bump())

      await waitFor(() => expect(announce).toHaveBeenCalledWith('Photo, 180 KB: Your Mac is bringing this file.'))
      announce.mockRestore()
    })

    it('says when the phone could not hand a file to an app', async () => {
      const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
      const opened = vi.spyOn(Linking, 'openURL').mockRejectedValue(new Error('No app'))
      const store = await copyWith({ chats: [BRAM], messages: [message('m4', 'c1', minutes(15), { text: '', mediaKind: 'image', mediaName: null, mediaSize: 10, mediaState: 'stored', mediaError: null, mediaAccess: 'allowed' })] })
      env.chats = { account: account(), store, drafts: new Map(), createTodo: vi.fn(), actions: new ChatActions({ store: () => store, api: fakeApi(), now: Date.now, newId: () => 'x', changed: () => env.bump() }) }
      render(<ChatScreen />)

      fireEvent.click(await screen.findByRole('button', { name: 'Open, Photo, 10 B' }))

      expect(await screen.findByText('This phone could not open the file.')).toBeTruthy()
      expect(announce, 'Said to a screen reader too.').toHaveBeenCalledWith('This phone could not open the file.')
      opened.mockRestore()
      announce.mockRestore()
    })
  })
})
