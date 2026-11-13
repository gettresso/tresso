import { describe, expect, it } from 'vitest'
import type { ChatSummary, SyncedChatMessage } from '@tresso/core'
import { chatNotificationPath, chatNotifications, CHAT_NOTIFICATION_BODY_MAX } from '../chatNotifications'

const NOW = Date.parse('2026-11-12T10:00:00Z')

function summary(id: string, newest: Partial<SyncedChatMessage> | null, extra: Partial<ChatSummary> = {}, kind: 'direct' | 'group' = 'direct'): ChatSummary {
  const message: SyncedChatMessage | null =
    newest === null
      ? null
      : { id: `${id}:m`, chatId: id, chatAccountId: 'wa:account', waId: 'm', fromMe: false, sender: null, text: 'Dinner at 18:00?', sentAt: new Date(NOW - 60_000).toISOString(), mediaKind: null, mediaName: null, mediaSize: null, ...newest }
  return {
    chat: { id, chatAccountId: 'wa:account', jid: '31612345678@s.whatsapp.net', kind, name: 'Bram', lastMessageAt: new Date(NOW).toISOString(), readThrough: null, archivedThrough: null, leftOut: false },
    newest: message,
    unread: 1,
    lastMessageAt: NOW,
    ...extra,
  }
}

const base = { seen: new Map<string, string | null>(), now: NOW, notify: true, firstImport: false, focusedChatId: null }

describe('chat notifications', () => {
  it('notifies a fresh incoming message with the chat name and the start of the text, linking to the chat', () => {
    const round = chatNotifications({ ...base, summaries: [summary('wa:a', {})] })
    expect(round.notifications).toEqual([{ title: 'Bram', body: 'Dinner at 18:00?', path: '/chats/wa%3Aa', silent: false }])
    expect(round.seen).toEqual(new Map([['wa:a', 'wa:a:m']]))
    expect(chatNotificationPath('wa:31612345678@s.whatsapp.net')).toBe('/chats/wa%3A31612345678%40s.whatsapp.net')
  })

  it('cuts a long text to 120 characters, on a character', () => {
    const long = `${'😀'.repeat(150)}`
    const body = chatNotifications({ ...base, summaries: [summary('wa:a', { text: long })] }).notifications[0]!.body
    expect([...body]).toHaveLength(CHAT_NOTIFICATION_BODY_MAX)
    expect(body.endsWith('…')).toBe(true)
  })

  it('names the group sender first, and falls back to the number for a chat without a name', () => {
    const group = summary('wa:g', { sender: { id: '1', name: 'Mom Visser' } }, {}, 'group')
    expect(chatNotifications({ ...base, summaries: [group] }).notifications[0]!.body).toBe('⁨Mom⁩: Dinner at 18:00?')
    const unnamed = summary('wa:a', {})
    unnamed.chat.name = null
    expect(chatNotifications({ ...base, summaries: [unnamed] }).notifications[0]!.title).toBe('+31612345678')
  })

  it('says nothing for a stale message, one seen before, an own one, a read chat, or with Notify me off', () => {
    const cases = [
      { ...base, summaries: [summary('wa:a', { sentAt: new Date(NOW - 16 * 60_000).toISOString() })] },
      { ...base, summaries: [summary('wa:a', {})], seen: new Map([['wa:a', 'wa:a:m']]) },
      { ...base, summaries: [summary('wa:a', { fromMe: true })] },
      { ...base, summaries: [summary('wa:a', {}, { unread: 0 })] },
      { ...base, summaries: [summary('wa:a', null)] },
      { ...base, summaries: [summary('wa:a', {})], notify: false },
    ]
    for (const round of cases) {
      expect(chatNotifications(round).notifications).toEqual([])
    }
  })

  it('says nothing during the first import or for the focused chat, but notes what it saw', () => {
    const first = chatNotifications({ ...base, summaries: [summary('wa:a', {})], firstImport: true })
    expect(first.notifications).toEqual([])
    expect(first.seen.get('wa:a')).toBe('wa:a:m')
    expect(chatNotifications({ ...base, summaries: [summary('wa:a', {})], focusedChatId: 'wa:a' }).notifications).toEqual([])
    // Another chat focused: this one notifies.
    expect(chatNotifications({ ...base, summaries: [summary('wa:a', {})], focusedChatId: 'wa:b' }).notifications).toHaveLength(1)
  })

  it('uses a name learned after the message was stored', () => {
    const group = summary('wa:g', { sender: { id: '1', name: null } }, {}, 'group')
    const round = chatNotifications({ ...base, summaries: [group], named: (message) => ({ ...message, sender: { id: '1', name: 'Joost' } }) })
    expect(round.notifications[0]!.body).toBe('⁨Joost⁩: Dinner at 18:00?')
  })
})
