import { describe, expect, it } from 'vitest'
import { ApiError } from '@/auth/session'
import { cancelFailureText, chatInitials, chatName, counterText, mediaTitle, relayBanner, replyProblemText, replyView, retryFailureText, sendFailureText } from '@/chat/texts'
import { account, chat } from './fixtures'

describe('chat texts', () => {
  it('names a chat by its WhatsApp name, else its number, else what it is', () => {
    expect(chatName(chat('c1'))).toBe('Bram Visser')
    expect(chatName(chat('c1', { name: '​' }))).toBe('+31612345678')
    expect(chatName(chat('c1', { name: null, jid: '123456@lid' }))).toBe('WhatsApp chat')
    expect(chatName(chat('c1', { name: null, jid: '120363025246125486@g.us', kind: 'group' }))).toBe('Group')
    expect(chatName(chat('c1', { name: 'Bram‮ Visser\nJr' }))).toBe('Bram Visser Jr')
  })

  it('makes avatar initials of the first and last word, or the first digits of a number', () => {
    expect(chatInitials('Bram Visser')).toBe('BV')
    expect(chatInitials('family')).toBe('F')
    expect(chatInitials('+31612345678')).toBe('31')
    expect(chatInitials('')).toBe('?')
  })

  it('says a reply waits for the Mac only while the Mac is offline', () => {
    expect(replyView({ status: 'waiting', error: null }, '10:31', false)).toEqual({ meta: '10:31, waiting for your Mac', state: 'waiting', reason: null, spoken: 'waiting for your Mac' })
    expect(replyView({ status: 'waiting', error: null }, '10:31', true)).toMatchObject({ meta: '10:31, sending', state: 'sending' })
    expect(replyView({ status: 'sending', error: null }, '10:31', false)).toMatchObject({ meta: '10:31, sending', state: 'sending' })
    expect(replyView({ status: 'sent', error: null }, '10:02', false)).toMatchObject({ meta: '10:02, sent', state: 'sent' })
  })

  it('says a reply was not sent with the reason, and offers a tap to retry', () => {
    expect(replyView({ status: 'failed', error: 'bridge_stopped' }, '10:31', true)).toEqual({ meta: 'Not sent, tap to retry', state: 'failed', reason: 'The bridge is not running.', spoken: 'not sent' })
    expect(replyView({ status: 'failed', error: 'refused' }, '10:31', true)?.reason).toBe('WhatsApp refused the message.')
  })

  it('says a send the Mac could not confirm may have gone out, and is not a tap to retry', () => {
    expect(replyView({ status: 'failed', error: 'unconfirmed' }, '10:31', true)).toEqual({
      meta: '10:31, not confirmed',
      state: 'unconfirmed',
      reason: 'Tresso could not confirm this was sent. Check WhatsApp on your phone before trying again.',
      spoken: 'not confirmed',
    })
  })

  it('shows no cancelled reply', () => {
    expect(replyView({ status: 'cancelled', error: null }, '10:31', true)).toBeNull()
  })

  it('names a file by its kind and size, a document by its name', () => {
    expect(mediaTitle({ mediaKind: 'image', mediaName: 'image_20261106_101422.jpg', mediaSize: 184_320 })).toBe('Photo, 180 KB')
    expect(mediaTitle({ mediaKind: 'audio', mediaName: null, mediaSize: null })).toBe('Voice message')
    expect(mediaTitle({ mediaKind: 'document', mediaName: 'plan.pdf', mediaSize: 2048 })).toBe('plan.pdf, 2.0 KB')
    expect(mediaTitle({ mediaKind: 'document', mediaName: null, mediaSize: null })).toBe('File')
  })

  it('says when the Mac that relays is offline or cannot send, and nothing while it works', () => {
    expect(relayBanner(account({ relayOnline: false, relayOfflineSince: '2026-11-13T08:40:00Z' }))).toBe('Your Mac is offline. Replies go out once it is back.')
    expect(relayBanner(account({ link: 'unlinked' }))).toBe('WhatsApp is not linked on your Mac. Nothing comes in or goes out until it is linked again.')
    expect(relayBanner(account({ bridge: 'stopped' }))).toBe('The bridge on your Mac is not running. Replies go out once it runs again.')
    expect(relayBanner(account())).toBeNull()
    expect(relayBanner(null)).toBeNull()
  })

  it('says how long a reply is near the limit, and why one cannot go', () => {
    expect(counterText(3950)).toBe('3,950 of 4,096 characters')
    expect(replyProblemText('too_long')).toBe('A reply can have at most 4,096 characters.')
    expect(replyProblemText('control')).toBe('The reply cannot contain control characters.')
    expect(replyProblemText('empty')).toBeNull()
  })

  it('says what failed in plain words: the server\'s own, or that it could not be reached', () => {
    expect(sendFailureText(new ApiError(429, 'Too many WhatsApp replies at once. Wait a few minutes, then try again.'))).toBe('Not sent. Too many WhatsApp replies at once. Wait a few minutes, then try again.')
    expect(sendFailureText(new TypeError('Network request failed'))).toBe('Not sent. The server could not be reached. Check your connection.')
    expect(cancelFailureText(new ApiError(409, 'This reply is being sent or was sent; it can no longer be cancelled.', {}, null, 'already_going_out'))).toBe(
      'This reply is being sent already and can no longer be cancelled.',
    )
    expect(retryFailureText(new ApiError(409, 'Only a reply that failed can be tried again.', {}, null, 'not_failed'))).toBe('This reply is on its way again already.')
  })
})
