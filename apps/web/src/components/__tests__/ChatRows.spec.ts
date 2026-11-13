import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { ChatSummary } from '@tresso/core'
import type { Conversation } from '@/mail/db'
import { useSelectionStore } from '@/stores/selection'
import ConversationList from '../ConversationList.vue'

const DAY = Date.UTC(2026, 10, 12, 12, 0)

function conversation(threadId: string, lastMessageAt: number): Conversation {
  return {
    threadId,
    mailAccountId: 'work',
    subject: `Mail ${threadId}`,
    snippet: '',
    lastMessageAt,
    messageCount: 1,
    unreadCount: 0,
    flagged: false,
    hasAttachments: false,
    attachmentsBlocked: false,
    senders: [{ name: 'Anna', address: 'anna@example.test' }],
    inbox: true,
    active: true,
    heldUntil: null,
    batchedAt: null,
    smartInboxId: null,
    verdict: null,
    classificationReason: null,
  }
}

function chat(id: string, name: string, lastMessageAt: number): ChatSummary {
  return {
    chat: { id, chatAccountId: 'wa:account', jid: `${id.slice(3)}@s.whatsapp.net`, kind: 'direct', name, lastMessageAt: new Date(lastMessageAt).toISOString(), readThrough: null, archivedThrough: null, leftOut: false },
    newest: null,
    unread: 0,
    lastMessageAt,
  }
}

describe('ConversationList with chats', () => {
  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  function list(props: Record<string, unknown> = {}) {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { template: '<div />' } }] })
    return mount(ConversationList, {
      props: {
        title: 'Unified Inbox',
        conversations: [conversation('t1', DAY), conversation('t2', DAY - 2 * 3_600_000)],
        selectedThreadId: null,
        hasMore: false,
        loading: false,
        hasAccounts: true,
        linkTo: (id: string) => `/inbox/${id}`,
        chatRows: [chat('wa:31611111111', 'Bram Visser', DAY - 3_600_000), chat('wa:31622222222', 'Sanne Peters', DAY - 3 * 3_600_000)],
        selectedChatId: 'wa:31611111111',
        chatLinkTo: (id: string) => `/chats/${encodeURIComponent(id)}`,
        channel: 'all',
        ...props,
      },
      global: { plugins: [router] },
    })
  }

  it('places chat rows among the mail by time, in the same day groups', () => {
    const wrapper = list()
    const rows = wrapper.findAll('.scroll section .row, .scroll section .chat-row')
    expect(rows.map((row) => (row.classes().includes('chat-row') ? row.get('.name').text() : row.get('.subject').text()))).toEqual(['Mail t1', 'Bram Visser', 'Mail t2', 'Sanne Peters'])
    expect(wrapper.findAll('.scroll section')).toHaveLength(1)
    expect(wrapper.get('.chat-row.selected a').attributes('href')).toBe('/chats/wa%3A31611111111')
  })

  it('gives chat rows no checkbox, and keeps them out of a selection', async () => {
    const wrapper = list()
    expect(wrapper.findAll('.chat-row [role="checkbox"]')).toHaveLength(0)
    expect(wrapper.findAll('[role="checkbox"]')).toHaveLength(2)
    await wrapper.findAll('.row .check')[0]!.trigger('click')
    await wrapper.findAll('.row .check')[1]!.trigger('click')
    expect([...useSelectionStore().threadIds].sort()).toEqual(['t1', 't2'])
  })

  it('shows the Channels tabs, the chosen one pressed, and says which was chosen', async () => {
    const wrapper = list()
    const tabs = wrapper.get('[aria-label="Channels"]')
    expect(tabs.findAll('button').map((button) => [button.text(), button.attributes('aria-pressed')])).toEqual([
      ['All', 'true'],
      ['Mail', 'false'],
      ['WhatsApp', 'false'],
    ])
    await tabs.findAll('button')[2]!.trigger('click')
    expect(wrapper.emitted('update:channel')).toEqual([['whatsapp']])
  })

  it('shows no tabs and no chat rows where none are given, as before', () => {
    const wrapper = list({ chatRows: undefined, channel: undefined })
    expect(wrapper.find('[aria-label="Channels"]').exists()).toBe(false)
    expect(wrapper.findAll('.chat-row')).toHaveLength(0)
    expect(wrapper.findAll('.row')).toHaveLength(2)
  })

  it('says there are no chats when the list is empty', () => {
    const wrapper = list({ conversations: [], chatRows: [], emptyText: 'No chats yet.' })
    expect(wrapper.get('.empty').text()).toBe('No chats yet.')
  })
})
