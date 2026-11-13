import { describe, expect, it } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import type { ChatSummary, SyncedChatMessage } from '@tresso/core'
import ChatListRow from '../ChatListRow.vue'

const NOW = Date.now()

function message(extra: Partial<SyncedChatMessage> = {}): SyncedChatMessage {
  return { id: 'm', chatId: 'wa:c', chatAccountId: 'wa:account', waId: 'm', fromMe: false, sender: null, text: 'Can you bring the drill on Saturday?', sentAt: new Date(NOW).toISOString(), mediaKind: null, mediaName: null, mediaSize: null, ...extra }
}

function summary(newest: SyncedChatMessage | null, extra: Partial<ChatSummary['chat']> = {}, unread = 1): ChatSummary {
  return {
    chat: { id: 'wa:c', chatAccountId: 'wa:account', jid: '31612345678@s.whatsapp.net', kind: 'direct', name: 'Bram Visser', lastMessageAt: new Date(NOW).toISOString(), readThrough: null, archivedThrough: null, leftOut: false, ...extra },
    newest,
    unread,
    lastMessageAt: NOW,
  }
}

function row(value: ChatSummary, props: Record<string, unknown> = {}) {
  return mount(ChatListRow, { props: { summary: value, selected: false, to: '/chats/wa%3Ac', ...props }, global: { stubs: { RouterLink: RouterLinkStub } } })
}

describe('ChatListRow', () => {
  it('shows the unread dot, the avatar with the WhatsApp badge, the name, the time and the preview', () => {
    const wrapper = row(summary(message()))
    expect(wrapper.classes()).toContain('unread')
    expect(wrapper.get('.badge').attributes('title')).toBe('WhatsApp')
    expect(wrapper.get('.name').text()).toBe('Bram Visser')
    expect(wrapper.get('.time').text()).not.toBe('')
    expect(wrapper.get('.preview').text()).toBe('Can you bring the drill on Saturday?')
    // A screen reader hears it is unread and a WhatsApp chat; no checkbox.
    expect(wrapper.text()).toContain('Unread.')
    expect(wrapper.text()).toContain(', WhatsApp, ')
    expect(wrapper.find('[role="checkbox"]').exists()).toBe(false)
    expect(wrapper.findComponent(RouterLinkStub).props('to')).toBe('/chats/wa%3Ac')
  })

  it('shows a read chat without the dot, and marks the open one', () => {
    const wrapper = row(summary(message(), {}, 0), { selected: true })
    expect(wrapper.classes()).not.toContain('unread')
    expect(wrapper.classes()).toContain('selected')
    expect(wrapper.get('a').attributes('aria-current')).toBe('true')
    expect(wrapper.text()).not.toContain('Unread.')
  })

  it('puts the sender\'s first name in front in a group', () => {
    const wrapper = row(summary(message({ sender: { id: '1', name: 'Mom Visser' }, text: 'Dinner at 18:00 on Sunday?' }), { kind: 'group', name: 'Family', jid: '120363000000000001@g.us' }))
    expect(wrapper.get('.preview').text()).toBe('⁨Mom⁩: Dinner at 18:00 on Sunday?')
  })

  it('uses a sender name learned later', () => {
    const wrapper = row(summary(message({ sender: { id: '1', name: null } }), { kind: 'group', name: 'Family', jid: '120363000000000001@g.us' }), {
      named: (m: SyncedChatMessage) => ({ ...m, sender: { id: '1', name: 'Joost' } }),
    })
    expect(wrapper.get('.preview').text()).toBe('⁨Joost⁩: Can you bring the drill on Saturday?')
  })

  it('says what a file is when a message has no text', () => {
    const cases: [Partial<SyncedChatMessage>, string][] = [
      [{ mediaKind: 'image', mediaName: 'image_1.jpg' }, 'Photo'],
      [{ mediaKind: 'video', mediaName: 'video_1.mp4' }, 'Video'],
      [{ mediaKind: 'audio', mediaName: 'audio_1.ogg' }, 'Voice message'],
      [{ mediaKind: 'document', mediaName: 'plan.pdf' }, 'File: plan.pdf'],
    ]
    for (const [media, preview] of cases) {
      expect(row(summary(message({ text: '', ...media }))).get('.preview').text()).toBe(preview)
    }
  })

  it('names a chat without a name by its number, and shows nothing for a chat without messages', () => {
    const wrapper = row(summary(null, { name: null }))
    expect(wrapper.get('.name').text()).toBe('+31612345678')
    expect(wrapper.get('.preview').text()).toBe('')
  })
})
