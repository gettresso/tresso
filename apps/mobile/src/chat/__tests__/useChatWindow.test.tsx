import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { chatMessageKey } from '@tresso/core'
import { CHAT_PAGE, useChatWindow } from '@/chat/useChatWindow'
import { chat, copyWith, message } from './fixtures'

/** A chat of `count` messages, a minute apart, in a copy on sql.js. */
async function longChat(count: number) {
  const messages = Array.from({ length: count }, (_, i) => message(`m${String(i).padStart(4, '0')}`, 'c1', new Date(Date.parse('2026-11-10T00:00:00.000Z') + i * 60_000).toISOString()))
  const store = await copyWith({ chats: [chat('c1')], messages })
  const read = vi.fn((chatId: string, options: Parameters<typeof store.chatPage>[1]) => store.chatPage(chatId, options))
  return { store, messages, read }
}

describe('useChatWindow', () => {
  it('reads the newest messages first, and older ones on request, keeping what was read', async () => {
    const { messages, read } = await longChat(CHAT_PAGE * 2 + 10)
    const onPage = vi.fn()
    const { result } = renderHook(() => useChatWindow('c1', read, 0, onPage))

    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.messages).toHaveLength(CHAT_PAGE)
    expect(result.current.messages[CHAT_PAGE - 1]?.id).toBe(messages[messages.length - 1]?.id)
    expect(result.current.hasOlder).toBe(true)
    expect(read).toHaveBeenLastCalledWith('c1', { limit: CHAT_PAGE })

    act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.messages).toHaveLength(CHAT_PAGE * 2))
    expect(read).toHaveBeenLastCalledWith('c1', { limit: CHAT_PAGE, before: chatMessageKey(messages[CHAT_PAGE + 10]!) })

    act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.hasOlder).toBe(false))
    expect(result.current.messages).toHaveLength(CHAT_PAGE * 2 + 10)
    expect(result.current.messages[0]?.id).toBe(messages[0]?.id)
    expect(onPage).toHaveBeenCalledTimes(3)
  })

  it('reads the window again from its first message when the copy changed, with the new messages and none fewer', async () => {
    const { store, messages, read } = await longChat(CHAT_PAGE + 5)
    const { result, rerender } = renderHook(({ version }) => useChatWindow('c1', read, version, () => {}), { initialProps: { version: 0 } })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    const first = result.current.messages[0]!

    await store.putChatMessages([message('new', 'c1', '2026-11-13T10:00:00.000Z')])
    rerender({ version: 1 })

    await waitFor(() => expect(result.current.messages.at(-1)?.id).toBe('new'))
    expect(result.current.messages[0]?.id).toBe(first.id)
    expect(read).toHaveBeenLastCalledWith('c1', { limit: CHAT_PAGE * 2, from: chatMessageKey(first) })
    expect(result.current.hasOlder).toBe(true)
    expect(messages).toHaveLength(CHAT_PAGE + 5)
  })

  it('says the chat is not on the phone once it is gone', async () => {
    const { store, read } = await longChat(3)
    const { result, rerender } = renderHook(({ version }) => useChatWindow('c1', read, version, () => {}), { initialProps: { version: 0 } })
    await waitFor(() => expect(result.current.chat?.id).toBe('c1'))

    await store.removeChat('c1')
    rerender({ version: 1 })

    await waitFor(() => expect(result.current.chat).toBeNull())
    expect(result.current.messages).toEqual([])
  })

  it('does not read again for a version it has read', async () => {
    const { read } = await longChat(3)
    const { result, rerender } = renderHook(({ version }) => useChatWindow('c1', read, version, () => {}), { initialProps: { version: 4 } })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    rerender({ version: 4 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(read).toHaveBeenCalledTimes(1)
  })
})
