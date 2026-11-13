import { describe, expect, it, vi } from 'vitest'
import type { SyncedChatMessage, SyncedChatOutgoing } from '@tresso/core'
import type { BubbleRow } from '@/chat/timelineRows'

vi.mock('@/components/Icon', () => ({ Icon: () => null }))
const { bubbleActions } = await import('@/components/ChatBubble')

const photo = (extra: Partial<SyncedChatMessage>): SyncedChatMessage => ({
  id: 'm1',
  chatId: 'c1',
  chatAccountId: 'a1',
  waId: 'W1',
  fromMe: false,
  sender: null,
  text: '',
  sentAt: '2026-11-13T10:00:00.000Z',
  mediaKind: 'image',
  mediaName: null,
  mediaSize: 10,
  ...extra,
})

const bubble = (extra: Partial<BubbleRow>): BubbleRow => ({ kind: 'bubble', key: 'k', mine: false, text: '', media: null, sender: null, meta: '', state: 'none', reason: null, reply: null, label: '', grouped: false, ...extra })

describe('what a screen reader may do with a bubble', () => {
  it("offers the file's own action, which sits inside the bubble", () => {
    expect(bubbleActions(bubble({ media: photo({ mediaState: 'remote' }) }), true)).toEqual([{ name: 'file', label: 'Download' }])
    expect(bubbleActions(bubble({ media: photo({ mediaState: 'stored', mediaAccess: 'allowed' }) }), true)).toEqual([{ name: 'file', label: 'Open' }])
    expect(bubbleActions(bubble({ media: photo({ mediaState: 'stored', mediaAccess: 'confirm' }) }), true)).toEqual([{ name: 'file', label: 'Open anyway' }])
    expect(bubbleActions(bubble({ media: photo({ mediaState: 'failed', mediaError: 'unavailable' }) }), true)).toEqual([{ name: 'file', label: 'Try again' }])
    expect(bubbleActions(bubble({ media: photo({ mediaState: 'requested' }) }), true)).toEqual([])
  })

  it('offers Cancel on a file still uploading', () => {
    const reply = { id: 'r1' } as SyncedChatOutgoing
    expect(bubbleActions(bubble({ mine: true, state: 'uploading', reply }), true)).toEqual([{ name: 'cancelUpload', label: 'Cancel' }])
  })
})
