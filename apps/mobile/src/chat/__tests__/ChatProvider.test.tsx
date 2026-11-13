import { describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { uuidV7Time, type SqliteMailStore } from '@tresso/core'
import { ChatProvider, useChats, type Chats } from '@/chat/ChatProvider'
import { account, chat, copyWith } from './fixtures'

const env = vi.hoisted(() => ({
  store: null as unknown as SqliteMailStore,
  serverNow: 0,
  requests: [] as { path: string; body: unknown }[],
}))

// The phone's uploader is native (expo-file-system); no file goes anywhere in these tests.
vi.mock('@/chat/fileUpload', () => ({ uploadByUri: () => async () => new Response(null, { status: 204 }) }))
vi.mock('@/auth/AuthProvider', () => {
  const session = {
    serverNow: () => env.serverNow,
    api: async (path: string, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      env.requests.push({ path, body })
      const request = body as { id: string; text: string }
      return { id: request.id, chatId: 'c1', chatAccountId: account().id, text: request.text, status: 'waiting', error: null, createdAt: new Date(env.serverNow).toISOString(), claimedAt: null, sentAt: null }
    },
  }
  return { useAuth: () => ({ session }) }
})
vi.mock('@/mail/MailProvider', () => {
  const store = () => env.store
  const touch = () => {}
  const syncNow = async () => {}
  return { useMail: () => ({ store, version: 0, userId: 'kim', touch, syncNow }) }
})

describe('ChatProvider', () => {
  it('makes reply ids by the server\'s clock, so a phone whose clock is off is not refused', async () => {
    env.store = await copyWith({ chats: [chat('c1')] })
    // The phone's clock is an hour behind the server's.
    env.serverNow = Date.now() + 60 * 60 * 1000
    let chats: Chats | null = null
    function Probe() {
      chats = useChats()
      return null
    }
    render(
      <ChatProvider>
        <Probe />
      </ChatProvider>,
    )
    await waitFor(() => expect(chats?.accountRead).toBe(true))

    await act(async () => {
      await chats!.actions.send(chat('c1'), 'On my way')
    })

    const id = (env.requests[0]?.body as { id: string }).id
    expect(uuidV7Time(id)).toBe(env.serverNow)
  })

  it('says the account was read only once the copy was read', async () => {
    env.store = await copyWith({ account: null, chats: [] })
    let chats: Chats | null = null
    function Probe() {
      chats = useChats()
      return null
    }
    render(
      <ChatProvider>
        <Probe />
      </ChatProvider>,
    )
    expect(chats!.accountRead).toBe(false)

    await waitFor(() => expect(chats?.accountRead).toBe(true))
    expect(chats!.account).toBeNull()
  })
})
