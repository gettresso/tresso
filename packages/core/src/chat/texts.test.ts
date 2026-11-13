import { describe, expect, it } from 'vitest'
import { SENDER_COLORS, senderColor } from './format'
import { attachHeldText, chatName, clockTime, mediaKindLabel, mediaTitle, senderLabel, senderTone, serverFileView, waitText } from './texts'
import type { SyncedChatMessage } from './types'

type FileState = Pick<SyncedChatMessage, 'mediaKind' | 'mediaState' | 'mediaError' | 'mediaAccess'>

describe('chat texts shared by the web app and the phone', () => {
  it('names a chat by its WhatsApp name, else its number, else what it is', () => {
    expect(chatName({ name: 'Bram Visser', jid: '31612345678@s.whatsapp.net', kind: 'direct' })).toBe('Bram Visser')
    expect(chatName({ name: null, jid: '31612345678@s.whatsapp.net', kind: 'direct' })).toBe('+31612345678')
    expect(chatName({ name: '  ', jid: '120363025246125486@g.us', kind: 'group' })).toBe('Group')
  })

  it('names a group sender, or says the sender is unknown', () => {
    expect(senderLabel({ sender: { id: '31611111111', name: 'Mom' } })).toBe('Mom')
    expect(senderLabel({ sender: { id: '31611111111', name: null } })).toBe('Unknown sender')
    expect(senderLabel({ sender: null })).toBe('Unknown sender')
  })

  it('gives a sender the index of their colour', () => {
    const tone = senderTone('31611111111')
    expect(SENDER_COLORS[tone]).toBe(senderColor('31611111111'))
  })

  it('says the time of day', () => {
    expect(clockTime(new Date(2026, 10, 13, 10, 2).getTime())).toMatch(/10[:.]02/)
  })

  it('says a file by its kind and size, a document by its name', () => {
    expect(mediaKindLabel('audio')).toBe('Voice message')
    expect(mediaTitle({ mediaKind: 'image', mediaName: 'IMG_1.jpg', mediaSize: 184_320 })).toBe('Photo, 180 KB')
    expect(mediaTitle({ mediaKind: 'document', mediaName: 'plan.pdf', mediaSize: 2048 })).toBe('plan.pdf, 2.0 KB')
    expect(mediaTitle({ mediaKind: 'document', mediaName: null, mediaSize: null })).toBe('File')
  })

  it('says where a file on the server stands and what can be done', () => {
    const view = (state: Partial<FileState>, online = true) => serverFileView({ mediaKind: 'image', mediaState: 'remote', mediaError: null, mediaAccess: null, ...state }, online)
    expect(view({})).toEqual({ line: 'Photo, on your Mac', action: 'download', failed: false })
    expect(view({ mediaState: 'requested' })).toEqual({ line: 'Your Mac is bringing this file.', action: null, failed: false })
    expect(view({ mediaState: 'requested' }, false).line).toBe('Waiting for your Mac.')
    expect(view({ mediaState: 'failed', mediaError: 'too_large' })).toEqual({ line: 'This file is larger than 100 MB, the most Tresso passes on.', action: null, failed: true })
    expect(view({ mediaState: 'failed', mediaError: 'not_found' }).action).toBe('retry')
    expect(view({ mediaState: 'stored', mediaAccess: 'allowed' }).action).toBe('open')
    expect(view({ mediaState: 'stored', mediaAccess: 'scanning' }).line).toBe('Checking for malware.')
    expect(view({ mediaState: 'stored', mediaAccess: 'confirm' }).action).toBe('confirm')
    expect(view({ mediaState: 'stored', mediaAccess: 'blocked' })).toMatchObject({ action: null, failed: true })
  })

  it('says the real wait the server asked for, rounded up', () => {
    expect(waitText(5_000)).toBe('a minute')
    expect(waitText(60_000)).toBe('a minute')
    expect(waitText(61_000)).toBe('2 minutes')
    expect(waitText(9.5 * 60_000)).toBe('10 minutes')
    expect(waitText(60 * 60_000)).toBe('an hour')
    expect(waitText(61 * 60_000)).toBe('2 hours')
    expect(waitText(0)).toBe('a minute')
    expect(waitText(-5_000)).toBe('a minute')
    expect(waitText(Number.NaN)).toBe('a minute')
    expect(waitText(Number.POSITIVE_INFINITY)).toBe('a minute')
    expect(waitText(26 * 60 * 60_000), 'A long wait in hours.').toBe('26 hours')
    expect(attachHeldText(90_000)).toBe('Too many files sent at once. Wait 2 minutes, then attach it again.')
  })
})
