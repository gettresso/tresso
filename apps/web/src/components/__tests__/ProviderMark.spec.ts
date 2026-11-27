import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { MailAccount } from '@tresso/core'
import AppIcon from '../AppIcon.vue'
import source from '../ProviderMark.vue?raw'
import ProviderMark from '../ProviderMark.vue'
import { markForAccount, PROVIDER_MARKS, type BrandKind } from '../providerMarks'

function account(provider: string, displayName: string, emailAddress: string): MailAccount {
  const servers = provider === 'imap'
  return {
    id: 'work',
    emailAddress,
    displayName,
    provider,
    status: 'active',
    statusDetail: null,
    username: servers ? emailAddress : null,
    imap: servers ? { host: 'imap.gmail.com', port: 993, security: 'tls' } : null,
    smtp: servers ? { host: 'smtp.gmail.com', port: 465, security: 'tls' } : null,
    calendarUrl: null,
    calendarStatus: 'unknown',
    calendarStatusDetail: null,
    lastSyncedAt: null,
    createdAt: '2026-10-01T08:00:00Z',
    defaultSignatureId: null,
  }
}

const BRANDS: [BrandKind, string][] = [
  ['microsoft', '#5E5E5E'],
  ['google', '#4285F4'],
  ['whatsapp', '#25D366'],
]

describe('ProviderMark', () => {
  it.each(BRANDS)('draws %s in its brand colour on a 36 tile with the 18 mark of the board', (kind, hex) => {
    const wrapper = mount(ProviderMark, { props: { kind } })
    const tile = wrapper.get('span.tile')

    expect(tile.attributes('aria-hidden')).toBe('true')
    expect(tile.attributes('style')).toContain('width: 36px')
    expect(tile.attributes('style')).toContain('height: 36px')
    expect(tile.attributes('style')).toContain('border-radius: 10px')
    const svg = tile.get('svg')
    expect(svg.attributes('width')).toBe('18')
    expect(svg.attributes('viewBox')).toBe('0 0 24 24')
    const paths = svg.findAll('path')
    expect(paths).toHaveLength(1)
    expect(paths[0]!.attributes('d')).toBe(PROVIDER_MARKS[kind].path)
    expect(paths[0]!.attributes('fill')).toBe(hex)
    expect(wrapper.text()).toBe('')
  })

  it.each(BRANDS)('draws %s alone in the second ink at the given size in the ink tone', (kind) => {
    const wrapper = mount(ProviderMark, { props: { kind, tone: 'ink', size: 16 } })

    expect(wrapper.find('.tile').exists()).toBe(false)
    const svg = wrapper.get('svg.ink')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('width')).toBe('16')
    expect(svg.attributes('height')).toBe('16')
    expect(svg.get('path').attributes('d')).toBe(PROVIDER_MARKS[kind].path)
    expect(svg.get('path').attributes('fill')).toBe('currentColor')
    expect(wrapper.text()).toBe('')
  })

  it('scales the tile, the mark and the radius together', () => {
    const wrapper = mount(ProviderMark, { props: { kind: 'google', size: 72 } })

    expect(wrapper.get('span.tile').attributes('style')).toContain('border-radius: 20px')
    expect(wrapper.get('svg').attributes('width')).toBe('36')
  })

  it('shows the mail icon for a mail server in both tones, never a brand path', () => {
    const brand = mount(ProviderMark, { props: { kind: 'mail' } })
    const icon = brand.getComponent(AppIcon)
    expect(brand.get('span.tile').classes()).toContain('mail')
    expect(icon.props('name')).toBe('mail')
    expect(icon.props('size')).toBe(18)
    expect(icon.attributes('aria-hidden')).toBe('true')
    expect(brand.text()).toBe('')

    const ink = mount(ProviderMark, { props: { kind: 'mail', tone: 'ink', size: 16 } })
    const inkIcon = ink.getComponent(AppIcon)
    expect(ink.find('.tile').exists()).toBe(false)
    expect(inkIcon.props('name')).toBe('mail')
    expect(inkIcon.props('size')).toBe(16)
    expect(inkIcon.classes()).toContain('ink')
    expect(inkIcon.attributes('aria-hidden')).toBe('true')
    expect(ink.text()).toBe('')

    const brandPaths = Object.values(PROVIDER_MARKS).map((mark) => mark.path)
    for (const wrapper of [brand, ink]) {
      for (const path of wrapper.findAll('path')) expect(brandPaths).not.toContain(path.attributes('d'))
    }
  })

  it('gives Microsoft the second ink on the dark tile, in the theme the app follows', () => {
    const dark = source.slice(source.indexOf('@media (prefers-color-scheme: dark)'))

    expect(source).toContain('@media (prefers-color-scheme: dark)')
    expect(dark).toMatch(/\.tile\.microsoft path \{\s*fill: #b5bbc6;/)
  })
})

describe('markForAccount', () => {
  it('follows the provider type the server reports', () => {
    expect(markForAccount(account('gmail', 'Kim', 'kim@company.example'))).toBe('google')
    expect(markForAccount(account('microsoft', 'Kim', 'kim@company.example'))).toBe('microsoft')
    expect(markForAccount(account('imap', 'Kim', 'kim@company.example'))).toBe('mail')
  })

  it('never takes a brand from the name or the address a user or an app typed', () => {
    expect(markForAccount(account('imap', 'Google', 'kim@gmail.com'))).toBe('mail')
    expect(markForAccount(account('imap', 'Microsoft', 'kim@outlook.com'))).toBe('mail')
    expect(markForAccount(account('imap', 'WhatsApp', 'kim@whatsapp.com'))).toBe('mail')
    // A provider type the server does not send reads as a mail server, whatever it looks like.
    expect(markForAccount(account('Gmail', 'Google', 'kim@gmail.com'))).toBe('mail')
    expect(markForAccount(account('google', 'Google', 'kim@gmail.com'))).toBe('mail')
    // And the reverse: a Microsoft account keeps its mark under any name or address.
    expect(markForAccount(account('microsoft', 'Google', 'kim@gmail.com'))).toBe('microsoft')
  })
})
