import { describe, expect, it } from 'vitest'
import {
  accountSubtitle,
  bubbleMeta,
  chatKindOf,
  chatSubtitle,
  importable,
  importableChat,
  inInbox,
  labelText,
  nameText,
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
    expect(previewLine(group, newest)).toBe('\u2068Anna\u2069: On my way')
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
    expect(previewLine(group, fromAnna)).toBe('\u2068Anna\u2069: Photo')
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

describe('audit fixes', () => {
  describe('timeline echo matching (B2)', () => {
    const ids = (entries: ReturnType<typeof timeline>) =>
      entries.map((entry) => (entry.kind === 'message' ? entry.message.id : entry.outgoing.id))

    it('matches each sent reply to its nearest stored copy, so no real reply vanishes', () => {
      const typedOnPhone = message('p', { fromMe: true, text: 'Ok', sentAt: '2026-11-12T09:56:00+00:00' })
      const echo = message('e', { fromMe: true, text: 'Ok', sentAt: '2026-11-12T10:00:01+00:00' })
      const entries = timeline(
        [typedOnPhone, echo],
        [
          outgoing('a', { text: 'Ok', sentAt: '2026-11-12T10:00:00+00:00' }),
          outgoing('b', { text: 'Ok', sentAt: '2026-11-12T10:04:30+00:00' }),
        ],
      )
      expect(ids(entries)).toEqual(['p', 'e', 'b'])
    })

    it('matches replies oldest first whatever their order in the list', () => {
      const echo = message('e', { fromMe: true, text: 'Ok', sentAt: '2026-11-12T10:00:01+00:00' })
      const entries = timeline(
        [echo],
        [
          outgoing('b', { text: 'Ok', sentAt: '2026-11-12T10:04:30+00:00' }),
          outgoing('a', { text: 'Ok', sentAt: '2026-11-12T10:00:00+00:00' }),
        ],
      )
      expect(ids(entries)).toEqual(['e', 'b'])
    })

    it('never lets a message typed on the phone before the reply hide it', () => {
      const typedOnPhone = message('p', { fromMe: true, text: 'Ok', sentAt: '2026-11-12T09:56:00+00:00' })
      const entries = timeline([typedOnPhone], [outgoing('a', { text: 'Ok', sentAt: '2026-11-12T10:00:00+00:00' })])
      expect(ids(entries)).toEqual(['p', 'a'])
    })

    it('allows a stored copy up to a minute before the reply for clock skew', () => {
      const early = message('e', { fromMe: true, text: 'Ok', sentAt: '2026-11-12T09:59:00+00:00' })
      expect(ids(timeline([early], [outgoing('a', { text: 'Ok', sentAt: '2026-11-12T10:00:00+00:00' })]))).toEqual(['e'])
      const tooEarly = message('e', { fromMe: true, text: 'Ok', sentAt: '2026-11-12T09:58:59+00:00' })
      expect(ids(timeline([tooEarly], [outgoing('a', { text: 'Ok', sentAt: '2026-11-12T10:00:00+00:00' })]))).toEqual([
        'e',
        'a',
      ])
    })

    it('never matches a reply without text, for example to an own photo without caption', () => {
      const photo = message('p', {
        fromMe: true,
        text: '',
        media: media('image'),
        sentAt: '2026-11-12T10:00:01+00:00',
      })
      expect(ids(timeline([photo], [outgoing('a', { text: '  ', sentAt: '2026-11-12T10:00:00+00:00' })]))).toEqual([
        'a',
        'p',
      ])
    })
  })

  describe('timeline times (1, 10)', () => {
    it('sorts a reply without sentAt by its creation time', () => {
      const entries = timeline(
        [message('1', { sentAt: '2026-11-12T10:00:00+00:00' }), message('2', { sentAt: '2026-11-12T10:10:00+00:00' })],
        [outgoing('a', { status: 'failed', sentAt: null, createdAt: '2026-11-12T10:05:00+00:00' })],
      )
      expect(entries.map((entry) => entry.at)).toEqual([
        Date.parse('2026-11-12T10:00:00+00:00'),
        Date.parse('2026-11-12T10:05:00+00:00'),
        Date.parse('2026-11-12T10:10:00+00:00'),
      ])
    })

    it('sorts entries whose time does not parse last, in a stable order', () => {
      const entries = timeline(
        [message('bad', { sentAt: 'not a time' }), message('1', { sentAt: '2026-11-12T10:00:00+00:00' })],
        [
          outgoing('a', { status: 'waiting', sentAt: null, createdAt: 'garbage' }),
          outgoing('b', { status: 'sent', sentAt: 'garbage', createdAt: '2026-11-12T09:00:00+00:00' }),
        ],
      )
      expect(entries.map((entry) => (entry.kind === 'message' ? entry.message.id : entry.outgoing.id))).toEqual([
        'b',
        '1',
        'bad',
        'a',
      ])
      expect(entries[2]!.at).toBe(Number.POSITIVE_INFINITY)
    })

    it('puts messages before replies at the same time and keeps the order of each list', () => {
      const at = '2026-11-12T10:00:00+00:00'
      const entries = timeline(
        [message('1', { sentAt: at }), message('2', { sentAt: at })],
        [outgoing('a', { status: 'waiting', sentAt: null, createdAt: at }), outgoing('b', { status: 'failed', sentAt: null, createdAt: at })],
      )
      expect(entries.map((entry) => (entry.kind === 'message' ? entry.message.id : entry.outgoing.id))).toEqual([
        '1',
        '2',
        'a',
        'b',
      ])
    })
  })

  describe('labelText and the labels that use it (2, 3, 4)', () => {
    it('collapses whitespace and strips control and direction characters', () => {
      expect(labelText('  Anna\n\tde\u0000 Vries  ')).toBe('Anna de Vries')
      expect(labelText('\u202Eanna\u202C')).toBe('anna')
      expect(labelText('\u2066Kim\u2069 \u200FVisser')).toBe('Kim \u200FVisser')
      expect(labelText('\u0085\u009B')).toBe('')
    })

    it('cleans names and texts in the preview', () => {
      const group = chat({ kind: 'group', jid: '120363025246125486@g.us' })
      const newest = message('1', { text: 'See\nyou\u202E soon', sender: { id: '1', name: '\u202Eanna\nde Vries' } })
      expect(previewLine(group, newest)).toBe('\u2068anna\u2069: See you soon')
    })

    it('keeps the direction marks and strips overrides', () => {
      expect(labelText('\u05E9\u05DC\u05D5\u05DD!\u200F')).toBe('\u05E9\u05DC\u05D5\u05DD!\u200F')
      expect(labelText('\u0645\u0631\u062D\u0628\u0627\u061C!')).toBe('\u0645\u0631\u062D\u0628\u0627\u061C!')
      expect(labelText('a\u200Eb')).toBe('a\u200Eb')
      expect(labelText('\u202Eanna')).toBe('anna')
    })

    it('treats a name of only invisible characters as no name, in every label', () => {
      const group = chat({ kind: 'group', jid: '120363025246125486@g.us' })
      for (const invisible of ['\u200B', '\u2060', '\u00AD', '\u3164', '\u115F', '\u200F', '\u200B\u2060 \u00AD']) {
        expect(nameText(invisible), JSON.stringify(invisible)).toBe('')
        expect(previewLine(group, message('1', { text: 'x', sender: { id: '1', name: invisible } }))).toBe('x')
        expect(accountSubtitle(account({ relayDeviceName: invisible }), 'device-phone')).toBe(
          '+31698765432, via another device',
        )
        expect(previewLine(chat(), message('1', { text: '', media: media('document', invisible) }))).toBe('File')
      }
    })

    it('skips an invisible first word and keeps invisible characters inside a visible name', () => {
      const group = chat({ kind: 'group', jid: '120363025246125486@g.us' })
      const hidden = message('1', { text: 'x', sender: { id: '1', name: '\u200B Anna' } })
      expect(previewLine(group, hidden)).toBe('\u2068Anna\u2069: x')
      const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
      expect(nameText(`${family} Kim`)).toBe(`${family} Kim`)
      expect(previewLine(group, message('1', { text: 'x', sender: { id: '1', name: `${family} Kim` } }))).toBe(
        `\u2068${family}\u2069: x`,
      )
    })

    it('isolates a Hebrew name so digits at the start of the text stay on their side', () => {
      const group = chat({ kind: 'group', jid: '120363025246125486@g.us' })
      const newest = message('1', { text: '123 ok', sender: { id: '1', name: '\u05D3\u05E0\u05D4 \u05DB\u05D4\u05DF' } })
      expect(previewLine(group, newest)).toBe('\u2068\u05D3\u05E0\u05D4\u2069: 123 ok')
    })

    it('treats a name that is empty after cleaning as no name', () => {
      const group = chat({ kind: 'group', jid: '120363025246125486@g.us' })
      expect(previewLine(group, message('1', { text: 'Hi', sender: { id: '1', name: '\u202E \n' } }))).toBe('Hi')
    })

    it('shows the media label for whitespace-only text', () => {
      expect(previewLine(chat(), message('1', { text: ' \n ', media: media('image') }))).toBe('Photo')
      expect(previewLine(chat(), message('1', { text: ' \n ' }))).toBe('')
    })

    it('says File for a document without a name and for an unknown kind', () => {
      expect(previewLine(chat(), message('1', { text: '', media: media('document', ' ') }))).toBe('File')
      const unknown = { kind: 'sticker', name: 'x', size: null } as unknown as ChatMedia
      expect(previewLine(chat(), message('1', { text: '', media: unknown }))).toBe('File')
    })
  })

  describe('phoneLabel and accountSubtitle (5, 6)', () => {
    it('gives null for anything but digits', () => {
      expect(phoneLabel('+316')).toBeNull()
      expect(phoneLabel('abc')).toBeNull()
      expect(phoneLabel('316 12')).toBeNull()
    })

    it('treats an empty device name or id as unknown', () => {
      expect(accountSubtitle(account({ relayDeviceName: '' }), 'device-phone')).toBe('+31698765432, via another device')
      expect(accountSubtitle(account({ relayDeviceName: ' \u202E ' }), 'device-phone')).toBe(
        '+31698765432, via another device',
      )
      expect(accountSubtitle(account({ relayDeviceId: '', relayDeviceName: 'Office iMac' }), '')).toBe(
        '+31698765432, via Office iMac',
      )
      expect(accountSubtitle(account({ address: '+31698765432' }), 'device-mac')).toBe('Via this Mac')
    })
  })

  describe('JID classification (7)', () => {
    it('takes only phone and hidden-number direct chats and groups', () => {
      expect(importableChat('31612345678@s.whatsapp.net')).toBe(true)
      expect(importableChat('84932172912345@lid')).toBe(true)
      expect(importableChat('120363025246125486@g.us')).toBe(true)
      expect(importableChat('31612345678-1600000000@g.us')).toBe(true)
    })

    it('refuses everything else', () => {
      for (const jid of [
        '0@s.whatsapp.net',
        'status@broadcast',
        '120363144038483540@newsletter',
        '31612345678@bot',
        '31612345678@c.us',
        '31612345678@hosted',
        'abc@s.whatsapp.net',
        '31612345678-1@s.whatsapp.net',
        '31612345678',
        '',
        ' 31612345678@s.whatsapp.net',
      ]) {
        expect(importableChat(jid), jid).toBe(false)
        expect(importable(jid, true, new Set()), jid).toBe(false)
      }
    })

    it('compares in lower case and drops a device suffix', () => {
      expect(importableChat('31612345678@S.WhatsApp.Net')).toBe(true)
      expect(importableChat('31612345678:12@s.whatsapp.net')).toBe(true)
      expect(chatKindOf('120363025246125486@G.US')).toBe('group')
      expect(chatSubtitle(chat({ jid: '31612345678:3@s.whatsapp.net' }))).toBe('+31612345678')
      expect(importable('31612345678:3@s.whatsapp.net', true, new Set(['31612345678@s.whatsapp.net']))).toBe(false)
      expect(importable('120363025246125486@G.US', false, new Set())).toBe(false)
    })
  })

  describe('unread and inbox state (8, 10)', () => {
    it('treats a readThrough that does not parse as never read', () => {
      const messages = [message('1'), message('2', { fromMe: true })]
      expect(unreadCount(chat({ readThrough: 'garbage' }), messages)).toBe(1)
    })

    it('counts a message in the same second as readThrough as read', () => {
      const messages = [message('1', { sentAt: '2026-11-12T10:00:00+00:00' })]
      expect(unreadCount(chat({ readThrough: '2026-11-12T10:00:00.000Z' }), messages)).toBe(0)
    })

    it('compares instants across a change from summer to winter time', () => {
      // Amsterdam, 25 October 2026: 03:00 summer time became 02:00 winter time. 02:10+01:00 is after 02:30+02:00.
      const messages = [message('1', { sentAt: '2026-10-25T02:10:00+01:00' })]
      expect(unreadCount(chat({ readThrough: '2026-10-25T02:30:00+02:00' }), messages)).toBe(1)
      expect(inInbox(chat({ lastMessageAt: '2026-10-25T02:10:00+01:00', archivedThrough: '2026-10-25T02:30:00+02:00' }))).toBe(
        true,
      )
      expect(inInbox(chat({ lastMessageAt: '2026-10-25T02:30:00+02:00', archivedThrough: '2026-10-25T02:10:00+01:00' }))).toBe(
        false,
      )
    })

    it('treats an archivedThrough that does not parse as not archived', () => {
      expect(inInbox(chat({ archivedThrough: 'garbage' }))).toBe(true)
    })
  })

  describe('mergeInbox ties (10)', () => {
    it('puts mail first on equal times and keeps each list in order', () => {
      const mail = [{ id: 'm1', lastMessageAt: 30 }, { id: 'm2', lastMessageAt: 30 }]
      const chats = [{ id: 'c1', lastMessageAt: 30 }, { id: 'c2', lastMessageAt: 30 }]
      expect(mergeInbox(mail, chats, 4).map((row) => row.id)).toEqual(['m1', 'm2', 'c1', 'c2'])
      expect(mergeInbox(mail, chats, 3).map((row) => row.id)).toEqual(['m1', 'm2', 'c1'])
    })
  })

  describe('senderColor values (9)', () => {
    it('keeps the colour of known ids', () => {
      // FNV-1a of "a" is 0xe40c292c; 3826002220 % 6 = 4.
      expect(senderColor('a')).toBe('#B42318')
      expect(senderColor('31611111111')).toBe('#256B5D')
    })
  })
})
