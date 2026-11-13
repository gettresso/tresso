import { describe, expect, it } from 'vitest'
import { SENDER_COLORS, senderColor } from '@tresso/core'
import type { BridgeState } from '@/platform/whatsapp'
import { attachText, localBubbleMeta, localReplyLabel, chatName, chatNoticeKind, mediaRetry, mediaStateText, mediaTitle, replyAnnouncement, senderLabel, senderTone } from '../chatTexts'

const OWNED: BridgeState = { process: 'owned', port: 8741, loopbackOnly: true, link: 'linked', qr: null, error: null }

describe('chat texts', () => {
  it('names a chat by its name, its number, or what it is', () => {
    expect(chatName({ name: 'Bram‮ Visser', jid: '31612345678@s.whatsapp.net', kind: 'direct' })).toBe('Bram Visser')
    expect(chatName({ name: null, jid: '31612345678@s.whatsapp.net', kind: 'direct' })).toBe('+31612345678')
    expect(chatName({ name: '​', jid: '123456789@lid', kind: 'direct' })).toBe('WhatsApp chat')
    expect(chatName({ name: null, jid: '120363000000000001@g.us', kind: 'group' })).toBe('Group')
  })

  it('names a sender, or says the sender is unknown', () => {
    expect(senderLabel({ sender: { id: '1', name: 'Mom' } })).toBe('Mom')
    expect(senderLabel({ sender: { id: '1', name: null } })).toBe('Unknown sender')
    expect(senderLabel({ sender: null })).toBe('Unknown sender')
  })

  it('draws a sender in the colour core gives them', () => {
    for (const id of ['31611111111', '31622222222', 'abc']) {
      expect(SENDER_COLORS[senderTone(id)]).toBe(senderColor(id))
    }
  })

  it('titles a file row by kind and size, a document by its name (plan 6.7)', () => {
    expect(mediaTitle({ mediaKind: 'image', mediaName: 'image_20261106_101422.jpg', mediaSize: 184_320 })).toBe('Photo, 180 KB')
    expect(mediaTitle({ mediaKind: 'video', mediaName: null, mediaSize: null })).toBe('Video')
    expect(mediaTitle({ mediaKind: 'audio', mediaName: 'audio.ogg', mediaSize: 40_960 })).toBe('Voice message, 40 KB')
    expect(mediaTitle({ mediaKind: 'document', mediaName: 'plan.pdf', mediaSize: 2048 })).toBe('plan.pdf, 2.0 KB')
    expect(mediaTitle({ mediaKind: 'document', mediaName: null, mediaSize: null })).toBe('File')
  })

  it('says each state of a file row', () => {
    const photo = { mediaKind: 'image' as const }
    expect(mediaStateText(photo, { state: 'idle' })).toBe('Photo, not downloaded')
    expect(mediaStateText({ mediaKind: 'video' }, { state: 'idle' })).toBe('Video, not downloaded')
    expect(mediaStateText({ mediaKind: 'audio' }, { state: 'idle' })).toBe('Voice message, not downloaded')
    expect(mediaStateText({ mediaKind: 'document' }, { state: 'idle' })).toBe('File, not downloaded')
    expect(mediaStateText(photo, { state: 'downloading' })).toBe('Downloading')
    expect(mediaStateText(photo, { state: 'done', path: '/x' })).toBe('Downloaded')
    expect(mediaStateText(photo, { state: 'failed', reason: 'failed' })).toBe('Could not download. The phone that sent it may be offline.')
    expect(mediaStateText(photo, { state: 'failed', reason: 'mismatch' })).toBe("WhatsApp gave another file than this message's. It was not opened.")
    expect(mediaStateText(photo, { state: 'failed', reason: 'unverified' })).toBe("Tresso could not check that this is the message's file. It was not opened.")
    expect(mediaStateText(photo, { state: 'failed', reason: 'refused' })).toBe('WhatsApp named this file in a way Tresso does not trust. It was not downloaded.')
    expect(mediaRetry('failed')).toBe(true)
    expect(mediaRetry('mismatch')).toBe(false)
    expect(mediaRetry('unverified')).toBe(false)
  })

  it('says what happened to an attached file', () => {
    expect(attachText({ state: 'idle' })).toBeNull()
    const chatId = 'wa:c'
    expect(attachText({ state: 'sending', chatId, name: 'plan.pdf' })).toBe('Sending plan.pdf…')
    expect(attachText({ state: 'sent', chatId, name: 'plan.pdf' })).toBe('plan.pdf was sent.')
    expect(attachText({ state: 'failed', chatId, name: 'plan.pdf', error: 'bridge_stopped' })).toBe('plan.pdf was not sent. The bridge is not running.')
    expect(attachText({ state: 'failed', chatId, name: 'plan.pdf', error: 'unconfirmed' })).toBe('plan.pdf: Tresso could not confirm this was sent. Check WhatsApp on your phone before trying again.')
    expect(attachText({ state: 'failed', chatId, name: 'film.mov', error: 'too_large' })).toBe('film.mov was not sent. It is larger than 2 GB, the most Tresso sends.')
  })

  it('announces a reply\'s change of state', () => {
    expect(replyAnnouncement('sending', null, true)).toBe('Sending.')
    expect(replyAnnouncement('waiting', null, false)).toBe('Waiting for the bridge.')
    expect(replyAnnouncement('sent', null, true)).toBe('Sent.')
    expect(replyAnnouncement('failed', 'not_linked', true)).toBe('Not sent. WhatsApp is not linked.')
    expect(replyAnnouncement('failed', 'unconfirmed', true)).toBe('Tresso could not confirm this was sent. Check WhatsApp on your phone before trying again.')
  })

  it('says on this Mac that a reply waits for the bridge, and is retried with a click', () => {
    expect(localReplyLabel('Waiting for your Mac')).toBe('Waiting for the bridge')
    expect(localReplyLabel('Not sent, tap to retry')).toBe('Not sent, click to retry')
    expect(localReplyLabel('Sent')).toBe('Sent')
    expect(localReplyLabel(null)).toBeNull()
    expect(localBubbleMeta('10:02', 'Waiting for the bridge')).toBe('10:02, waiting for the bridge')
    expect(localBubbleMeta('10:02', 'Not sent, click to retry')).toBe('Not sent, click to retry')
    expect(localBubbleMeta('10:02', null)).toBe('10:02')
  })

  it('picks the notice the bridge calls for', () => {
    expect(chatNoticeKind(OWNED)).toBeNull()
    expect(chatNoticeKind({ ...OWNED, link: 'unknown' })).toBeNull()
    expect(chatNoticeKind({ ...OWNED, link: 'unlinked' })).toBe('unlinked')
    expect(chatNoticeKind({ ...OWNED, link: 'waiting_for_scan' })).toBe('unlinked')
    expect(chatNoticeKind({ ...OWNED, process: 'stopped', port: null, link: 'unknown' })).toBe('stopped')
    expect(chatNoticeKind({ ...OWNED, process: 'stopped', port: null, link: 'unlinked' })).toBe('unlinked')
    expect(chatNoticeKind({ ...OWNED, process: 'stopped', port: null, link: 'unlinked', error: 'exited' })).toBe('stopped')
  })
})
