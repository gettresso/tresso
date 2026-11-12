import { describe, expect, it } from 'vitest'
import type { BridgeState } from '@/platform/whatsapp'
import {
  BRIDGE_PROBLEMS,
  bridgeText,
  errorName,
  folderText,
  importText,
  linkedAge,
  linkedName,
  linkText,
  relativeTime,
  shellErrorText,
  shortFolder,
} from '../whatsappTexts'

const NOW = Date.parse('2026-11-12T10:00:00Z')
const STOPPED: BridgeState = { process: 'stopped', port: null, loopbackOnly: null, link: 'unknown', qr: null, error: null }
const RUNNING: BridgeState = { process: 'owned', port: 8741, loopbackOnly: true, link: 'unknown', qr: null, error: null }

describe('the WhatsApp texts', () => {
  it('shows a home folder with ~ and a number in its international form', () => {
    expect(shortFolder('/Users/kim/whatsapp-mcp')).toBe('~/whatsapp-mcp')
    expect(shortFolder('/Users/kim')).toBe('~')
    expect(shortFolder('/Volumes/Data/whatsapp-mcp')).toBe('/Volumes/Data/whatsapp-mcp')
    expect(linkedName({ number: '31698765432', name: 'Kim Visser' })).toBe('Kim Visser, +31698765432')
    expect(linkedName({ number: '31698765432', name: null })).toBe('+31698765432')
    expect(linkedName({ number: '', name: 'Kim' })).toBe('Kim')
    expect(linkedName(null)).toBeNull()
  })

  it('says what the folder check found', () => {
    expect(folderText(null)).toEqual({ status: 'Choose the folder', detail: null, ok: false })
    expect(folderText({ found: false, built: false, hasStore: false, safe: true }).status).toBe('Not found')
    expect(folderText({ found: true, built: false, hasStore: false, safe: true })).toMatchObject({ status: 'Found, not built yet', detail: 'Build the bridge once in Terminal, in this folder:' })
    expect(folderText({ found: true, built: true, hasStore: false, safe: false })).toMatchObject({ status: 'Found, not safe to start', ok: false })
    expect(folderText({ found: true, built: true, hasStore: true, safe: true })).toEqual({ status: 'Found', detail: null, ok: true })
  })

  it('names every state of the bridge, each failure with what to do', () => {
    expect(bridgeText(STOPPED, false)).toMatchObject({ status: 'Not started', ok: false })
    expect(bridgeText({ ...RUNNING, port: null }, true)).toMatchObject({ status: 'Starting', ok: false })
    expect(bridgeText(RUNNING, true)).toMatchObject({ status: 'Running on this Mac', ok: true })
    expect(bridgeText({ ...RUNNING, loopbackOnly: false }, true)).toMatchObject({ status: 'Running, open to your network on port 8741' })
    expect(bridgeText(STOPPED, true)).toMatchObject({ status: 'Stopped', detail: 'Tresso starts it again in a moment.' })
    expect(bridgeText({ ...STOPPED, link: 'unlinked' }, true)).toMatchObject({ status: 'Stopped', detail: 'Nobody scanned the code for three minutes, so the bridge stopped.' })
    for (const failure of ['not_built', 'exited', 'port_busy', 'unprotected', 'unsafe'] as const) {
      expect(bridgeText({ ...STOPPED, error: failure }, true)).toEqual({ status: BRIDGE_PROBLEMS[failure].status, detail: BRIDGE_PROBLEMS[failure].detail, ok: false, problem: failure })
    }
    expect(BRIDGE_PROBLEMS.port_busy.status).toBe('Port in use')
    expect(BRIDGE_PROBLEMS.unsafe.status).toBe('Not safe to start')
    // An unprotected bridge: what it means and what to do, in plain words, pointing at the fork.
    expect(BRIDGE_PROBLEMS.unprotected).toMatchObject({ status: 'Not protected', buildCommand: true })
    expect(BRIDGE_PROBLEMS.unprotected.detail).toContain('any app or web page on this Mac could send WhatsApp messages through it')
    expect(BRIDGE_PROBLEMS.unprotected.detail).toContain('gettresso/whatsapp-mcp')
  })

  it('names every state of the link', () => {
    expect(linkText(RUNNING, null)).toMatchObject({ status: 'Waiting for the bridge', qr: false })
    expect(linkText({ ...RUNNING, link: 'waiting_for_scan' }, null)).toMatchObject({ status: 'Waiting for the code', qr: false })
    expect(linkText({ ...RUNNING, link: 'waiting_for_scan', qr: ['1'] }, null)).toMatchObject({ status: 'Scan the code', qr: true })
    expect(linkText({ ...RUNNING, link: 'linked' }, { number: '31698765432', name: 'Kim Visser' })).toMatchObject({ status: 'Linked as Kim Visser, +31698765432', ok: true })
    expect(linkText({ ...RUNNING, link: 'linked' }, null)).toMatchObject({ status: 'Linked', ok: true })
    expect(linkText({ ...RUNNING, link: 'unlinked' }, null)).toMatchObject({ status: 'Not linked', detail: 'WhatsApp ended the link. A new code comes in a moment.' })
    expect(linkText({ ...STOPPED, link: 'unlinked' }, null)).toMatchObject({ status: 'Code expired', expired: true })
    expect(linkText(STOPPED, null)).toMatchObject({ status: 'Not linked', expired: false })
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
    expect(shellErrorText('not_chosen')).toBe('Choose the whatsapp-mcp folder again: Tresso only uses a folder you picked.')
    expect(shellErrorText('no_folder')).toBe('The whatsapp-mcp folder is not there any more. Choose it again.')
    expect(shellErrorText('Saving the WhatsApp settings failed: disk full')).toBe('Saving the WhatsApp settings failed: disk full')
    expect(shellErrorText('some_new_code')).toBe('Something went wrong with WhatsApp. Try again.')
    expect(shellErrorText(new Error('The chat is left out.'))).toBe('The chat is left out.')

    expect(errorName('busy')).toBe('busy')
    expect(errorName('The folder /Users/kim/secret cannot be used')).toBe('ShellError')
    expect(errorName(new TypeError('Kim said hi'))).toBe('TypeError')
    expect(errorName({ text: 'hi' })).toBe('UnknownError')
  })
})
