import { describe, expect, it } from 'vitest'
import { frameMessage, linkToOpen, mayLoad } from './frameLinks'

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
    expect(frameMessage('{"height":412}')).toEqual({ kind: 'height', value: 412 })
    expect(frameMessage('{"tap":"https://example.test/"}')).toEqual({ kind: 'tap', url: 'https://example.test/' })
    expect(frameMessage('{"height":0}')).toBeNull()
    expect(frameMessage('{"height":"412"}')).toBeNull()
    expect(frameMessage('412')).toBeNull()
    expect(frameMessage('not json')).toBeNull()
    expect(frameMessage('null')).toBeNull()
  })
})
