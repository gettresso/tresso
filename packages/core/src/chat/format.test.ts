import { describe, expect, it } from 'vitest'
import {
  accountSubtitle,
  bubbleMeta,
  chatKindOf,
  chatSubtitle,
  importable,
  inInbox,
  mergeInbox,
  phoneLabel,
  previewLine,
  replyErrorText,
  replyLabel,
  SENDER_COLORS,
  senderColor,
  timeline,
  unreadCount,
} from './format'
import type { ChatMedia, SyncedChat, SyncedChatAccount, SyncedChatMessage, SyncedChatOutgoing } from './types'

function chat(extra: Partial<SyncedChat> = {}): SyncedChat {
  return {
    id: 'chat-1',
    chatAccountId: 'account-1',
    jid: '31612345678@s.whatsapp.net',
    kind: 'direct',
    name: 'Kim Visser',
    lastMessageAt: '2026-11-12T10:00:00+00:00',
    readThrough: null,
    archivedThrough: null,
    leftOut: false,
    ...extra,
  }
}

function account(extra: Partial<SyncedChatAccount> = {}): SyncedChatAccount {
  return {
    id: 'account-1',
    channel: 'whatsapp',
    address: '31698765432',
    displayName: 'Sam',
    relayDeviceId: 'device-mac',
    relayDeviceName: 'Sam’s MacBook Air',
    relayOnline: true,
    relayOfflineSince: null,
    bridge: 'running',
    link: 'linked',
    linkedAt: null,
    loopbackOnly: true,
    includeGroups: true,
    notify: false,
    ...extra,
  }
}

function message(id: string, extra: Partial<SyncedChatMessage> = {}): SyncedChatMessage {
  return {
    id,
    chatId: 'chat-1',
    waId: `wa-${id}`,
    fromMe: false,
    sender: null,
    text: `Text ${id}`,
    sentAt: '2026-11-12T10:00:00+00:00',
    media: null,
    ...extra,
  }
}

function outgoing(id: string, extra: Partial<SyncedChatOutgoing> = {}): SyncedChatOutgoing {
  return {
    id,
    chatId: 'chat-1',
    text: `Reply ${id}`,
    status: 'sent',
    error: null,
    createdAt: '2026-11-12T10:00:00+00:00',
    sentAt: '2026-11-12T10:00:05+00:00',
    ...extra,
  }
}

function media(kind: ChatMedia['kind'], name = 'file'): ChatMedia {
  return { kind, name, size: 1024 }
}

describe('chatKindOf', () => {
  it('knows a group by its JID', () => {
    expect(chatKindOf('120363025246125486@g.us')).toBe('group')
    expect(chatKindOf('31612345678@s.whatsapp.net')).toBe('direct')
    expect(chatKindOf('84932172912345@lid')).toBe('direct')
  })
})

describe('importable', () => {
  const none = new Set<string>()

  it('takes direct chats and groups', () => {
    expect(importable('31612345678@s.whatsapp.net', true, none)).toBe(true)
    expect(importable('120363025246125486@g.us', true, none)).toBe(true)
  })

  it('never takes status updates, channels or an empty JID', () => {
    expect(importable('status@broadcast', true, none)).toBe(false)
    expect(importable('120363144038483540@newsletter', true, none)).toBe(false)
    expect(importable('', true, none)).toBe(false)
  })

  it('skips groups when they are not included', () => {
    expect(importable('120363025246125486@g.us', false, none)).toBe(false)
    expect(importable('31612345678@s.whatsapp.net', false, none)).toBe(true)
  })

  it('skips a chat the user left out', () => {
    const leftOut = new Set(['31612345678@s.whatsapp.net'])
    expect(importable('31612345678@s.whatsapp.net', true, leftOut)).toBe(false)
    expect(importable('31600000000@s.whatsapp.net', true, leftOut)).toBe(true)
  })
})

describe('phoneLabel', () => {
  it('puts a plus in front of the digits, without grouping', () => {
    expect(phoneLabel('31612345678')).toBe('+31612345678')
  })

  it('gives null for no digits', () => {
    expect(phoneLabel('')).toBeNull()
  })
})

describe('chatSubtitle', () => {
  it('shows the number of a direct chat', () => {
    expect(chatSubtitle(chat())).toBe('+31612345678')
  })

  it('shows nothing for a direct chat without a number', () => {
    expect(chatSubtitle(chat({ jid: '84932172912345@lid' }))).toBe('')
    expect(chatSubtitle(chat({ jid: 'abc@s.whatsapp.net' }))).toBe('')
    expect(chatSubtitle(chat({ jid: '@s.whatsapp.net' }))).toBe('')
  })

  it('says Group for a group', () => {
    expect(chatSubtitle(chat({ jid: '120363025246125486@g.us', kind: 'group' }))).toBe('Group')
  })
})

describe('accountSubtitle', () => {
  it('names this Mac when this device relays', () => {
    expect(accountSubtitle(account(), 'device-mac')).toBe('+31698765432, via this Mac')
  })

  it('names the relaying device otherwise', () => {
    expect(accountSubtitle(account(), 'device-phone')).toBe('+31698765432, via Sam’s MacBook Air')
  })

  it('leaves out an unknown number', () => {
    expect(accountSubtitle(account({ address: null }), 'device-mac')).toBe('Via this Mac')
    expect(accountSubtitle(account({ address: '' }), 'device-phone')).toBe('Via Sam’s MacBook Air')
  })
})

describe('previewLine', () => {
  const group = chat({ kind: 'group', jid: '120363025246125486@g.us' })

  it('shows the text in a direct chat', () => {
    expect(previewLine(chat(), message('1', { text: 'See you at ten' }))).toBe('See you at ten')
  })

  it('puts the first word of the sender name in front in a group', () => {
    const newest = message('1', { text: 'On my way', sender: { id: '31611111111', name: '  Anna de Vries' } })
    expect(previewLine(group, newest)).toBe('Anna: On my way')
  })

  it('shows only the text in a group when there is no sender name', () => {
    expect(previewLine(group, message('1', { text: 'Hi', sender: { id: '31611111111', name: null } }))).toBe('Hi')
    expect(previewLine(group, message('1', { text: 'Hi', fromMe: true, sender: null }))).toBe('Hi')
  })

  it('names media without text', () => {
    expect(previewLine(chat(), message('1', { text: '', media: media('image') }))).toBe('Photo')
    expect(previewLine(chat(), message('1', { text: '', media: media('video') }))).toBe('Video')
    expect(previewLine(chat(), message('1', { text: '', media: media('audio') }))).toBe('Voice message')
    expect(previewLine(chat(), message('1', { text: '', media: media('document', 'Offer.pdf') }))).toBe(
      'File: Offer.pdf',
    )
    const fromAnna = message('1', { text: '', media: media('image'), sender: { id: '1', name: 'Anna' } })
    expect(previewLine(group, fromAnna)).toBe('Anna: Photo')
  })

  it('keeps the text of media with a caption', () => {
    expect(previewLine(chat(), message('1', { text: 'The view', media: media('image') }))).toBe('The view')
  })

  it('is empty without a message', () => {
    expect(previewLine(chat(), null)).toBe('')
  })
})

describe('replyLabel', () => {
  it('says Sending while the relay sends or can send', () => {
    expect(replyLabel({ status: 'sending' }, false)).toBe('Sending')
    expect(replyLabel({ status: 'waiting' }, true)).toBe('Sending')
  })

  it('says Waiting for your Mac while the relay is offline', () => {
    expect(replyLabel({ status: 'waiting' }, false)).toBe('Waiting for your Mac')
  })

  it('says Sent and Not sent', () => {
    expect(replyLabel({ status: 'sent' }, false)).toBe('Sent')
    expect(replyLabel({ status: 'failed' }, true)).toBe('Not sent, tap to retry')
  })

  it('gives null for a cancelled reply', () => {
    expect(replyLabel({ status: 'cancelled' }, true)).toBeNull()
  })
})

describe('bubbleMeta', () => {
  it('shows the time alone without a label', () => {
    expect(bubbleMeta('10:02', null)).toBe('10:02')
  })

  it('puts the label in lower case after the time', () => {
    expect(bubbleMeta('10:02', 'Sent')).toBe('10:02, sent')
    expect(bubbleMeta('10:02', 'Sending')).toBe('10:02, sending')
    expect(bubbleMeta('10:02', 'Waiting for your Mac')).toBe('10:02, waiting for your Mac')
  })

  it('lets the failed label stand alone', () => {
    expect(bubbleMeta('10:02', 'Not sent, tap to retry')).toBe('Not sent, tap to retry')
  })
})

describe('replyErrorText', () => {
  it('explains each error', () => {
    expect(replyErrorText('bridge_stopped')).toBe('The bridge is not running.')
    expect(replyErrorText('not_linked')).toBe('WhatsApp is not linked.')
    expect(replyErrorText('refused')).toBe('WhatsApp refused the message.')
    expect(replyErrorText('unconfirmed')).toBe(
      'Tresso could not confirm this was sent. Check WhatsApp on your phone before trying again.',
    )
  })
})

describe('unreadCount', () => {
  const messages = [
    message('1', { sentAt: '2026-11-12T09:00:00+00:00' }),
    message('2', { sentAt: '2026-11-12T09:30:00+00:00' }),
    message('3', { sentAt: '2026-11-12T09:45:00+00:00', fromMe: true }),
    message('4', { sentAt: '2026-11-12T10:00:00+00:00' }),
    message('5', { sentAt: '2026-11-12T10:00:00+00:00', chatId: 'chat-2' }),
  ]

  it('counts incoming messages of the chat after readThrough', () => {
    expect(unreadCount(chat({ readThrough: '2026-11-12T09:00:00+00:00' }), messages)).toBe(2)
    expect(unreadCount(chat({ readThrough: '2026-11-12T10:00:00+00:00' }), messages)).toBe(0)
  })

  it('compares times, not strings', () => {
    expect(unreadCount(chat({ readThrough: '2026-11-12T10:15:00+01:00' }), messages)).toBe(2)
  })

  it('counts every incoming message when nothing was read', () => {
    expect(unreadCount(chat(), messages)).toBe(3)
  })
})

describe('inInbox', () => {
  it('shows a chat that was never archived', () => {
    expect(inInbox(chat())).toBe(true)
  })

  it('hides an archived chat until a newer message comes in', () => {
    expect(inInbox(chat({ archivedThrough: '2026-11-12T10:00:00+00:00' }))).toBe(false)
    expect(inInbox(chat({ archivedThrough: '2026-11-12T09:59:59+00:00' }))).toBe(true)
  })

  it('never shows a left-out chat', () => {
    expect(inInbox(chat({ leftOut: true }))).toBe(false)
  })
})

describe('timeline', () => {
  it('merges messages and replies by time', () => {
    const entries = timeline(
      [message('1', { sentAt: '2026-11-12T10:00:00+00:00' }), message('2', { sentAt: '2026-11-12T10:10:00+00:00' })],
      [
        outgoing('a', { sentAt: '2026-11-12T10:05:00+00:00' }),
        outgoing('b', { status: 'waiting', createdAt: '2026-11-12T10:20:00+00:00', sentAt: null }),
      ],
    )
    expect(entries.map((entry) => (entry.kind === 'message' ? entry.message.id : entry.outgoing.id))).toEqual([
      '1',
      'a',
      '2',
      'b',
    ])
  })

  it('drops cancelled replies', () => {
    expect(timeline([], [outgoing('a', { status: 'cancelled', sentAt: null })])).toEqual([])
  })

  it('drops a sent reply the bridge also stored', () => {
    const stored = message('1', { fromMe: true, text: 'On my way', sentAt: '2026-11-12T10:04:00+00:00' })
    const entries = timeline([stored], [outgoing('a', { text: 'On my way', sentAt: '2026-11-12T10:00:00+00:00' })])
    expect(entries).toEqual([{ kind: 'message', at: Date.parse(stored.sentAt), message: stored }])
  })

  it('keeps a sent reply when the stored message is too far away, from someone else or says something else', () => {
    const reply = outgoing('a', { text: 'On my way', sentAt: '2026-11-12T10:00:00+00:00' })
    const late = message('1', { fromMe: true, text: 'On my way', sentAt: '2026-11-12T10:05:01+00:00' })
    const theirs = message('2', { fromMe: false, text: 'On my way', sentAt: '2026-11-12T10:00:00+00:00' })
    const other = message('3', { fromMe: true, text: 'Running late', sentAt: '2026-11-12T10:00:00+00:00' })
    const otherChat = message('4', { fromMe: true, text: 'On my way', chatId: 'chat-2', sentAt: reply.sentAt! })
    for (const stored of [late, theirs, other, otherChat]) {
      expect(timeline([stored], [reply]).filter((entry) => entry.kind === 'outgoing')).toHaveLength(1)
    }
  })

  it('keeps replies that are not sent even when the text matches', () => {
    const stored = message('1', { fromMe: true, text: 'On my way', sentAt: '2026-11-12T10:00:00+00:00' })
    const failed = outgoing('a', { text: 'On my way', status: 'failed', error: 'refused', sentAt: null })
    expect(timeline([stored], [failed]).filter((entry) => entry.kind === 'outgoing')).toHaveLength(1)
  })

  it('lets one stored message stand in for one reply only', () => {
    const stored = message('1', { fromMe: true, text: 'Yes', sentAt: '2026-11-12T10:01:00+00:00' })
    const entries = timeline(
      [stored],
      [
        outgoing('a', { text: 'Yes', sentAt: '2026-11-12T10:00:00+00:00' }),
        outgoing('b', { text: 'Yes', sentAt: '2026-11-12T10:02:00+00:00' }),
      ],
    )
    expect(entries.map((entry) => (entry.kind === 'message' ? entry.message.id : entry.outgoing.id))).toEqual([
      '1',
      'b',
    ])
  })
})

describe('mergeInbox', () => {
  const mail = [{ id: 'm1', lastMessageAt: 50 }, { id: 'm2', lastMessageAt: 30 }, { id: 'm3', lastMessageAt: 10 }]
  const chats = [{ id: 'c1', lastMessageAt: 40 }, { id: 'c2', lastMessageAt: 30 }, { id: 'c3', lastMessageAt: 5 }]

  it('merges newest first and cuts to the limit', () => {
    expect(mergeInbox(mail, chats, 4).map((row) => row.id)).toEqual(['m1', 'c1', 'm2', 'c2'])
    expect(mergeInbox(mail, chats, 10).map((row) => row.id)).toEqual(['m1', 'c1', 'm2', 'c2', 'm3', 'c3'])
  })

  it('handles an empty side and a limit of zero', () => {
    expect(mergeInbox([], chats, 2).map((row) => row.id)).toEqual(['c1', 'c2'])
    expect(mergeInbox(mail, [], 5).map((row) => row.id)).toEqual(['m1', 'm2', 'm3'])
    expect(mergeInbox(mail, chats, 0)).toEqual([])
  })
})

describe('senderColor', () => {
  it('gives the same colour for the same id', () => {
    expect(senderColor('31611111111')).toBe(senderColor('31611111111'))
  })

  it('picks from the six colours and uses more than one', () => {
    const colors = new Set(Array.from({ length: 60 }, (_, i) => senderColor(`3161${i}`)))
    for (const color of colors) {
      expect(SENDER_COLORS).toContain(color)
    }
    expect(colors.size).toBeGreaterThan(3)
  })
})
