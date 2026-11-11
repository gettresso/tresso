import { describe, expect, it } from 'vitest'
import { frameMessage, linkToOpen, mayLoad, ownDocument } from './frameLinks'

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
    const frame = (data: string) => frameMessage(data, 'token-1')
    expect(frame('{"token":"token-1","height":412}')).toEqual({ kind: 'height', value: 412 })
    expect(frame('{"token":"token-1","tap":"https://example.test/"}')).toEqual({ kind: 'tap', url: 'https://example.test/' })
    expect(frame('{"token":"token-1","place":640}')).toEqual({ kind: 'place', offset: 640 })
    expect(frame('{"token":"token-1","place":-1}')).toBeNull()
    expect(frame('{"token":"token-1","height":0}')).toBeNull()
    expect(frame('{"token":"token-1","height":"412"}')).toBeNull()
    expect(frame('412')).toBeNull()
    expect(frame('not json')).toBeNull()
    expect(frame('null')).toBeNull()
  })

  it.each([
    ['without a token', '{"tap":"https://phish.example/next"}'],
    ['with another token', '{"token":"token-2","tap":"https://phish.example/next"}'],
    ['with a token that is not a string', '{"token":1,"tap":"https://phish.example/next"}'],
  ])('refuses a report %s', (_case, data) => {
    expect(frameMessage(data, 'token-1')).toBeNull()
  })

  it('refuses every report while the view has no token', () => {
    expect(frameMessage('{"token":"","height":412}', '')).toBeNull()
  })

  it.each(['about:blank', 'about:srcdoc', 'data:text/html;charset=utf-8;base64,PGI+'])('takes a load of %s for the view\'s own document', (url) => {
    expect(ownDocument(url)).toBe(true)
  })

  it.each(['https://phish.example/', 'http://tracker.example/', 'file:///sdcard/x.html', 'content://x', 'intent://x#Intent;end', ''])('takes a load of %s for a page that is not the view\'s own', (url) => {
    expect(ownDocument(url)).toBe(false)
  })
})
