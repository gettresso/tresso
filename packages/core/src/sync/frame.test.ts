import { describe, expect, it } from 'vitest'
import { mailFrameDocument, signatureFrameDocument } from './frame'

function policyOf(document: string): string {
  const match = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(document)
  expect(match).not.toBeNull()
  return match![1]!.replace(/&#39;|&apos;/g, "'")
}

describe('mailFrameDocument', () => {
  it('allows images only from the API by default', () => {
    const policy = policyOf(mailFrameDocument('<p>Hi</p>', { apiOrigin: 'https://api.example', allowRemoteContent: false }))

    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain('img-src https://api.example data:;')
    expect(policy).not.toContain('https:;')
    expect(policy).not.toContain('script-src')
  })

  it('opens images and fonts to the internet once allowed', () => {
    const policy = policyOf(mailFrameDocument('<p>Hi</p>', { apiOrigin: 'https://api.example', allowRemoteContent: true }))

    expect(policy).toContain('img-src https://api.example data: https: http:')
    expect(policy).toContain('font-src data: https: http:')
  })

  it('puts the policy before the body and links open outside the frame', () => {
    const document = mailFrameDocument('<a href="https://x.example">x</a>', { apiOrigin: 'https://api.example', allowRemoteContent: false })

    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<body>'))
    expect(document).toContain('<base target="_blank">')
    expect(document).toContain('<body><a href="https://x.example">x</a></body>')
  })
})

describe('signatureFrameDocument', () => {
  it('runs nothing and loads images only from https and data', () => {
    const policy = policyOf(signatureFrameDocument('<p>Kim</p>', { background: 'light' }))

    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain('img-src https: data:;')
    expect(policy).not.toContain('http:')
    expect(policy).not.toContain('script-src')
  })

  it('shows the signature on the chosen background', () => {
    const dark = signatureFrameDocument('<p>Kim</p>', { background: 'dark' })

    expect(dark).toContain('<meta name="color-scheme" content="dark">')
    expect(dark).toContain('background:#1B1D22')
    expect(signatureFrameDocument('<p>Kim</p>', { background: 'light' })).toContain('background:#fff')
    expect(dark).toContain('<body><p>Kim</p></body>')
  })

  it('can leave the background to the screen around the frame', () => {
    const dark = signatureFrameDocument('<p>Kim</p>', { background: 'dark', transparent: true })

    expect(dark).toContain('<meta name="color-scheme" content="dark">')
    expect(dark).toContain('background:transparent;color:#F3F4F6')
    expect(dark).not.toContain('#1B1D22')
  })
})
