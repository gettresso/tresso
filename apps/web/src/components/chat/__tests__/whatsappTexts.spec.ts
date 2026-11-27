import { describe, expect, it } from 'vitest'
import type { BridgeFailure, BridgeState } from '@/platform/whatsapp'
import {
  CONNECT_LEAD,
  FAILURES,
  LINK_STEPS,
  MOVED_TEXT,
  RISK_TEXT,
  STILL_LISTED,
  carriedText,
  carryCountsText,
  notCarriedText,
  pauseText,
  otherRelayText,
  serverRefusedText,
  switchText,
  errorName,
  failureLine,
  importText,
  linkStage,
  linkedAge,
  linkedName,
  linkedTitle,
  relativeTime,
  shellErrorText,
  statusWord,
} from '../whatsappTexts'

const NOW = Date.parse('2026-11-12T10:00:00Z')
const STOPPED: BridgeState = { process: 'stopped', port: null, loopbackOnly: null, link: 'unknown', qr: null, error: null }
const RUNNING: BridgeState = { process: 'owned', port: 8741, loopbackOnly: true, link: 'unknown', qr: null, error: null }
const FAILURE_KINDS: BridgeFailure[] = ['missing', 'store', 'offline', 'pair_failed', 'outdated', 'replaced', 'banned', 'logged_out', 'exited']
/** Words a user should never read about WhatsApp in Tresso for Mac: it carries its own link. */
const UNSAID = /whatsapp-mcp|bridge|folder|\bport\b|install whatsapp/i

describe('the WhatsApp texts', () => {
  it('shows a number in its international form', () => {
    expect(linkedName({ number: '31698765432', name: 'Kim Visser' })).toBe('Kim Visser, +31698765432')
    expect(linkedName({ number: '31698765432', name: null })).toBe('+31698765432')
    expect(linkedName({ number: '', name: 'Kim' })).toBe('Kim')
    expect(linkedName(null)).toBeNull()
    expect(linkedTitle({ number: '31612345678', name: 'Kim Visser' })).toBe('Linked to +31612345678')
    expect(linkedTitle({ number: '', name: 'Kim' })).toBe('Linked')
    expect(linkedTitle(null)).toBe('Linked')
  })

  it('says the board copy and nothing about how WhatsApp runs', () => {
    expect(CONNECT_LEAD).toBe('Read and answer your WhatsApp chats next to your mail.')
    expect(RISK_TEXT).toBe('WhatsApp does not officially allow other apps to link this way and can limit or ban an account that does. Use an account you can afford to lose access to.')
    expect(LINK_STEPS).toEqual(['Open WhatsApp on your phone.', 'Go to Settings, then Linked devices.', 'Tap Link a device and scan this code.'])
    expect(MOVED_TEXT).toBe('WhatsApp now runs inside Tresso. Link your phone again.')
    for (const text of [CONNECT_LEAD, RISK_TEXT, MOVED_TEXT, STILL_LISTED, ...LINK_STEPS]) {
      expect(text).not.toMatch(UNSAID)
    }
  })

  it('has a title, a sentence and one action for every failure', () => {
    expect(Object.keys(FAILURES).sort()).toEqual([...FAILURE_KINDS].sort())
    expect(FAILURES.exited).toEqual({ title: 'WhatsApp could not start on this Mac', text: 'Nothing was linked. Try again in a moment.', action: 'Try again' })
    expect(FAILURES.logged_out).toEqual({ title: 'This phone signed Tresso out', text: 'New messages do not come in until you link again.', action: 'Link again' })
    for (const kind of FAILURE_KINDS) {
      const { title, text, action } = FAILURES[kind]
      expect({ kind, complete: title.length > 0 && text.endsWith('.') && action.length > 0 }).toEqual({ kind, complete: true })
      expect(`${title} ${text} ${failureLine(kind)}`).not.toMatch(UNSAID)
    }
    expect(failureLine('offline')).toBe('WhatsApp could not be reached. Check that this Mac is online, then try again.')
    // In Settings something was linked before, so "Nothing was linked" is not said there.
    expect(failureLine('exited')).not.toContain('Nothing was linked')
  })

  it('tells where linking stands from the state of the bridge', () => {
    expect(linkStage(STOPPED)).toBe('idle')
    expect(linkStage({ ...RUNNING, port: null })).toBe('loading')
    expect(linkStage({ ...RUNNING, port: null, link: 'waiting_for_scan' })).toBe('loading')
    expect(linkStage({ ...RUNNING, port: null, link: 'waiting_for_scan', qr: ['1'] })).toBe('scan')
    expect(linkStage({ ...RUNNING, link: 'linked' })).toBe('linked')
    expect(linkStage({ ...STOPPED, link: 'unlinked' })).toBe('expired')
    expect(linkStage({ ...STOPPED, link: 'unlinked', error: 'logged_out' })).toBe('failed')
    expect(linkStage({ ...STOPPED, error: 'offline' })).toBe('failed')
  })

  it("says Settings' status in plain words", () => {
    expect(statusWord({ ...RUNNING, link: 'linked' }, false)).toEqual({ text: 'Connected', ok: true })
    expect(statusWord({ ...RUNNING, link: 'linked' }, true)).toEqual({ text: 'Connected', ok: true })
    expect(statusWord({ ...RUNNING, port: null }, false)).toEqual({ text: 'Starting', ok: false })
    expect(statusWord({ ...RUNNING, port: null, link: 'waiting_for_scan', qr: ['1'] }, false)).toEqual({ text: 'Not linked', ok: false })
    expect(statusWord({ ...RUNNING, port: null, link: 'waiting_for_scan', qr: ['1'] }, true)).toEqual({ text: 'Link again', ok: false })
    expect(statusWord({ ...STOPPED, link: 'unlinked' }, false)).toEqual({ text: 'Not linked', ok: false })
    expect(statusWord({ ...STOPPED, link: 'unlinked', error: 'logged_out' }, false)).toEqual({ text: 'Not linked', ok: false })
    expect(statusWord({ ...STOPPED, error: 'missing' }, false)).toEqual({ text: 'Could not start', ok: false })
    expect(statusWord(STOPPED, false)).toEqual({ text: 'Stopped', ok: false })
  })

  it('says how long ago the phone linked, without a countdown', () => {
    expect(linkedAge('2026-10-26T09:00:00Z', NOW)).toBe('Linked 17 days ago. WhatsApp can ask you to link again.')
    expect(linkedAge('2026-11-11T09:00:00Z', NOW)).toBe('Linked 1 day ago. WhatsApp can ask you to link again.')
    expect(linkedAge('2026-11-12T09:00:00Z', NOW)).toBe('Linked today. WhatsApp can ask you to link again.')
    expect(linkedAge(null, NOW)).toBe('Linked.')
    expect(relativeTime('2026-11-12T09:58:00Z', NOW)).toBe('2 minutes ago')
    expect(relativeTime('2026-11-12T09:59:30Z', NOW)).toBe('just now')
    expect(relativeTime('2026-11-12T07:00:00Z', NOW)).toBe('3 hours ago')
    expect(relativeTime('2026-11-10T10:00:00Z', NOW)).toBe('2 days ago')
  })

  it('tells the first import in counts only', () => {
    const counts = { messages: 1234, chats: 12, stored: 214, refused: 4 }
    expect(importText('waiting', counts)).toMatchObject({ status: 'Waiting', ok: false })
    expect(importText('reading', counts)).toMatchObject({ status: 'Reading', detail: '1,234 messages from 12 chats so far.' })
    expect(importText('done', counts)).toEqual({ status: '214 chats, 30 days', detail: null, ok: true })
    expect(importText('done', { ...counts, stored: 1 }).status).toBe('1 chat, 30 days')
    expect(importText('stuck', counts)).toMatchObject({ status: 'Stuck', ok: false })
    expect(importText('stuck', counts).detail).toContain('4 messages could not be stored')
  })

  it('turns the shell refusals into plain words and logs nothing but names', () => {
    expect(shellErrorText('unsupported')).toBe('WhatsApp works in Tresso for Mac only.')
    expect(shellErrorText('bridge_stopped')).toBe('WhatsApp is not running on this Mac.')
    expect(shellErrorText('no_store')).toBe('WhatsApp has not stored any messages on this Mac yet.')
    for (const code of ['busy', 'failed', 'refused', 'bridge_stopped', 'no_store']) {
      expect(shellErrorText(code)).not.toMatch(UNSAID)
    }
    expect(shellErrorText('Saving the WhatsApp settings failed: disk full')).toBe('Saving the WhatsApp settings failed: disk full')
    expect(shellErrorText('some_new_code')).toBe('Something went wrong with WhatsApp. Try again.')
    expect(shellErrorText(new Error('The chat is left out.'))).toBe('The chat is left out.')

    expect(errorName('busy')).toBe('busy')
    expect(errorName('The folder /Users/kim/secret cannot be used')).toBe('ShellError')
    expect(errorName(new TypeError('Kim said hi'))).toBe('TypeError')
    expect(errorName({ text: 'hi' })).toBe('UnknownError')
  })

  it('names the Mac that relays, online or since when it was last heard from', () => {
    const now = Date.parse('2026-11-12T10:00:00Z')
    expect(otherRelayText({ name: 'Office iMac', online: true, offlineSince: null }, now)).toBe('Office iMac, online now')
    expect(otherRelayText({ name: 'Office iMac', online: false, offlineSince: '2026-11-12T09:40:00Z' }, now)).toBe('Office iMac, offline, last heard from 20 minutes ago')
    expect(otherRelayText({ name: '\u200b', online: false, offlineSince: null }, now)).toBe('your Mac, offline')
  })

  it('says what a switch, refused rows and carried replies mean, in counts only', () => {
    expect(switchText('all', false)).toBe('Moving your WhatsApp chats to your Tresso server.')
    expect(switchText('local', false)).toBe('Removing your WhatsApp chats from your Tresso server.')
    expect(switchText('local', true)).toContain('come in again on this Mac')
    expect(serverRefusedText(0)).toBeNull()
    expect(serverRefusedText(1)).toBe('1 message could not be copied to your Tresso server; it stays on this Mac only.')
    expect(serverRefusedText(3)).toBe('3 messages could not be copied to your Tresso server; they stay on this Mac only.')
    expect(carriedText(0)).toBeNull()
    expect(carriedText(2)).toBe('2 replies written on this Mac before the switch go to your Tresso server once their chats are there.')
    expect(carryCountsText({ lost: 0, cancelled: 0, unsure: 0, notSent: 0 })).toBeNull()
    expect(carryCountsText({ lost: 1, cancelled: 0, unsure: 0, notSent: 0 })).toContain('1 reply could not be carried over')
    expect(carryCountsText({ lost: 0, cancelled: 2, unsure: 0, notSent: 0 })).toBe('2 replies were cancelled on another device and were not sent.')
    expect(carryCountsText({ lost: 0, cancelled: 0, unsure: 1, notSent: 0 })).toContain('may already have been queued or cancelled before')
    expect(carryCountsText({ lost: 0, cancelled: 0, unsure: 0, notSent: 3 })).toBe('3 replies that were not sent on this Mac were not carried over.')
    expect(notCarriedText(1)).toBe('1 reply on this Mac that was not sent is not carried over: it goes with the chats on this Mac.')
    expect(pauseText(10 * 60_000)).toBe('Your Tresso server asked Tresso to wait; it tries again in about 10 minutes.')
  })
})
