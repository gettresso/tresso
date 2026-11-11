import { describe, expect, it } from 'vitest'
import { frameMessage, fromFrame, linkToOpen, mayLoad } from './frameLinks'

describe('the link rules of the web views', () => {
  it("loads only the view's own document", () => {
    expect(mayLoad('about:blank')).toBe(true)
    expect(mayLoad('about:srcdoc')).toBe(true)
  })

  it.each(['https://phish.example/login', 'http://tracker.example/', 'mailto:kim@example.test', 'intent://scan/#Intent;scheme=zxing;end', 'tresso://auth/callback?code=x', 'javascript:alert(1)', 'file:///etc/hosts'])(
    'refuses a navigation to %s, so nothing opens without a tap',
    (url) => {
      expect(mayLoad(url)).toBe(false)
    },
  )

  it.each(['https://example.test/a?b=c', 'HTTP://example.test/', 'mailto:kim@example.test', 'tel:+31201234567'])('opens a tapped %s outside the app', (url) => {
    expect(linkToOpen(url)).toBe(url)
  })

  it.each(['intent://scan/#Intent;scheme=zxing;end', 'tresso://auth/callback?code=x', 'javascript:alert(1)', 'sms:+31201234567', 'file:///etc/hosts', 'data:text/html,hi', 'about:blank'])(
    'never opens a tapped %s',
    (url) => {
      expect(linkToOpen(url)).toBeNull()
    },
  )

  it('reads the reports of the frame script and ignores anything else', () => {
    const frame = (data: string) => frameMessage({ url: 'about:blank', data })
    expect(frame('{"height":412}')).toEqual({ kind: 'height', value: 412 })
    expect(frame('{"tap":"https://example.test/"}')).toEqual({ kind: 'tap', url: 'https://example.test/' })
    expect(frame('{"place":640}')).toEqual({ kind: 'place', offset: 640 })
    expect(frame('{"place":-1}')).toBeNull()
    expect(frame('{"height":0}')).toBeNull()
    expect(frame('{"height":"412"}')).toBeNull()
    expect(frame('412')).toBeNull()
    expect(frame('not json')).toBeNull()
    expect(frame('null')).toBeNull()
  })

  it.each(['about:blank', 'about:srcdoc', 'null'])('takes a report from %s for the frame itself (iOS sends the URL, Android the opaque origin)', (sender) => {
    expect(fromFrame(sender)).toBe(true)
    expect(frameMessage({ url: sender, data: '{"height":412}' })).toEqual({ kind: 'height', value: 412 })
  })

  it.each(['https://phish.example', 'https://phish.example/landing', 'http://tracker.example', 'data:text/html,<p>hi</p>', '', 'NULL', 'null://x', 'file://'])(
    'ignores a report sent by %s, not the frame\'s own document',
    (sender) => {
      expect(fromFrame(sender)).toBe(false)
      expect(frameMessage({ url: sender, data: '{"tap":"https://phish.example/next"}' })).toBeNull()
    },
  )
})
