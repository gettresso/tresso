import { describe, expect, it } from 'vitest'
import { chatMessageFromDelta, chatOutgoingFromDelta } from './rows'

const message = { id: 'm1', chatId: 'c1', chatAccountId: 'a1', waId: 'W1', fromMe: false, sender: null, text: '', sentAt: '2026-11-12T09:15:00+00:00', mediaName: 'drill.jpg', mediaSize: 20 }

describe('a file in the delta', () => {
  it('reads where a message file stands, and what may be done with a stored one', () => {
    expect(chatMessageFromDelta({ ...message, mediaKind: 'image', mediaState: 'stored', mediaError: null, mediaAccess: 'allowed' })).toMatchObject({ mediaState: 'stored', mediaError: null, mediaAccess: 'allowed' })
    expect(chatMessageFromDelta({ ...message, mediaKind: 'image', mediaState: 'failed', mediaError: 'mismatch', mediaAccess: null })).toMatchObject({ mediaState: 'failed', mediaError: 'mismatch', mediaAccess: null })
    expect(chatMessageFromDelta({ ...message, mediaKind: 'image', mediaState: 'requested', mediaError: 'mismatch', mediaAccess: 'allowed' })).toMatchObject({ mediaState: 'requested', mediaError: null, mediaAccess: null })
  })

  it('reads what a newer server sends safely: nothing downloads that it has not cleared', () => {
    expect(chatMessageFromDelta({ ...message, mediaKind: 'image', mediaState: 'moved', mediaAccess: 'allowed' })).toMatchObject({ mediaState: 'remote', mediaAccess: null })
    expect(chatMessageFromDelta({ ...message, mediaKind: 'image', mediaState: 'stored', mediaAccess: 'maybe' })).toMatchObject({ mediaAccess: 'blocked' })
    expect(chatMessageFromDelta({ ...message, mediaKind: 'image', mediaState: 'failed', mediaError: 'eaten' })).toMatchObject({ mediaError: 'unavailable' })
  })

  it('leaves the state out for a message without a file and for a server that does not say', () => {
    const plain = chatMessageFromDelta({ ...message, mediaKind: null, mediaState: 'stored' })!
    expect('mediaState' in plain).toBe(false)
    const older = chatMessageFromDelta({ ...message, mediaKind: 'image' })!
    expect('mediaState' in older).toBe(false)
  })

  it('reads the file a reply carries, and leaves it out for a text reply', () => {
    const reply = { id: 'r1', chatId: 'c1', chatAccountId: 'a1', text: '', status: 'waiting', error: null, createdAt: '2026-11-12T09:15:00+00:00', claimedAt: null, sentAt: null }
    expect(chatOutgoingFromDelta({ ...reply, file: { name: 'manual.pdf', size: 25 } })?.file).toEqual({ name: 'manual.pdf', size: 25 })
    expect(chatOutgoingFromDelta({ ...reply, file: { name: 'manual.pdf' } })?.file).toEqual({ name: 'manual.pdf', size: null })
    expect('file' in chatOutgoingFromDelta({ ...reply, file: null })!).toBe(false)
    expect(chatOutgoingFromDelta({ ...reply, status: 'failed', error: 'file_unavailable' })?.error).toBe('file_unavailable')
  })
})
