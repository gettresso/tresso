import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ChatSummary, ConversationSummary } from '@tresso/core'
import { InboxList } from '@/components/InboxList'
import { shortTime } from '@/mail/format'
import { chat, message } from '@/chat/__tests__/fixtures'

const env = vi.hoisted(() => ({
  conversations: [] as unknown[],
  chats: [] as unknown[],
  push: vi.fn(),
}))

vi.mock('expo-router', () => ({ useRouter: () => ({ push: env.push }) }))
vi.mock('react-native-svg', () => ({ default: () => null, Path: () => null }))
vi.mock('@/mail/MailProvider', () => ({
  useMail: () => ({ inbox: async () => env.conversations, version: 0, ready: true, syncError: null, syncState: 'idle', syncNow: async () => undefined }),
}))
vi.mock('@/chat/ChatProvider', () => ({ useChats: () => ({ inbox: env.chats }) }))

const TODAY = new Date()
TODAY.setHours(9, 0, 0, 0)
const at = (minutes: number) => TODAY.getTime() + minutes * 60_000

function conversation(threadId: string, subject: string, lastMessageAt: number): ConversationSummary {
  return {
    threadId,
    subject,
    snippet: 'A snippet',
    senders: [{ address: 'anna@partner.example', name: 'Anna de Vries' }],
    lastMessageAt,
    messageCount: 1,
    unreadCount: 0,
  } as unknown as ConversationSummary
}

function summary(id: string, name: string, lastMessageAt: number, unread: number, text: string): ChatSummary {
  const iso = new Date(lastMessageAt).toISOString()
  return { chat: chat(id, { name, jid: `3161234${id.replace(/\D/g, '').padStart(4, '0')}@s.whatsapp.net`, lastMessageAt: iso }), newest: message(`${id}-m`, id, iso, { text }), unread, lastMessageAt }
}

describe('the inbox list', () => {
  it('puts WhatsApp chats among the mail by the time of their last message, with the WhatsApp mark and their unread state', async () => {
    env.conversations = [conversation('t1', 'Budget review', at(60)), conversation('t2', 'Offsite', at(10))]
    env.chats = [summary('c1', 'Bram Visser', at(30), 1, 'Can you bring the drill on Saturday?'), summary('c2', 'Lisa', at(5), 0, 'Thanks!')]
    render(<InboxList header={<></>} />)

    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(4))
    const rows = screen.getAllByRole('button')
    const labels = rows.map((row) => row.getAttribute('aria-label') ?? '')
    expect(labels[0]).toMatch(/^Anna de Vries\. Budget review\./)
    expect(labels[1]).toBe(`Unread. Bram Visser, WhatsApp, ${shortTime(at(30))}. Can you bring the drill on Saturday?`)
    expect(labels[2]).toMatch(/^Anna de Vries\. Offsite\./)
    expect(labels[3]).toBe(`Lisa, WhatsApp, ${shortTime(at(5))}. Thanks!`)
    expect(within(rows[1]!).getByText('BV')).toBeTruthy()
    expect(within(rows[1]!).getByText('Can you bring the drill on Saturday?')).toBeTruthy()
  })

  it('opens a chat from its row', async () => {
    env.conversations = []
    env.chats = [summary('c1', 'Bram Visser', at(30), 0, 'Hi')]
    render(<InboxList header={<></>} />)

    fireEvent.click(await screen.findByRole('button', { name: /Bram Visser, WhatsApp/ }))

    expect(env.push).toHaveBeenCalledWith({ pathname: '/chats/[id]', params: { id: 'c1' } })
  })

  it('shows only mail without WhatsApp on the server', async () => {
    env.conversations = [conversation('t1', 'Budget review', at(60))]
    env.chats = []
    render(<InboxList header={<></>} />)

    expect(await screen.findAllByRole('button')).toHaveLength(1)
    expect(screen.queryByText(/WhatsApp/)).toBeNull()
  })
})
