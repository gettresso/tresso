// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { frameScript } from './frameLinks'

const posted: unknown[] = []

function click(selector: string): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  document.querySelector(selector)!.dispatchEvent(event)
  return event.defaultPrevented
}

describe('the frame script', () => {
  // Once: its click listener stays on the document, as in the web view.
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
    })
    Object.assign(window, { ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) } })
    new Function(frameScript('token-1'))()
  })

  beforeEach(() => {
    document.body.innerHTML = `
      <p><a id="out" href="https://example.test/offer"><span id="inside">Offer</span></a></p>
      <p><a id="contents" href="#part-2">Part 2</a> <a id="named" href="#old">Old anchor</a> <a id="missing" href="#nowhere">Gone</a></p>
      <p id="text">Plain text</p>
      <h2 id="part-2">Part 2</h2>
      <a name="old"></a>
    `
    posted.length = 0
  })

  it('reports a tapped link instead of following it, also when the tap lands inside the link', () => {
    expect(click('#out')).toBe(true)
    expect(click('#inside')).toBe(true)

    expect(posted).toEqual([{ token: 'token-1', tap: 'https://example.test/offer' }, { token: 'token-1', tap: 'https://example.test/offer' }])
  })

  it('reports where a place in the same mail is instead of navigating to it', () => {
    vi.spyOn(document.getElementById('part-2')!, 'getBoundingClientRect').mockReturnValue({ top: 480 } as DOMRect)

    expect(click('#contents')).toBe(true)
    expect(click('#named')).toBe(true)
    expect(click('#missing')).toBe(true)

    expect(posted).toEqual([{ token: 'token-1', place: 480 }, { token: 'token-1', place: 0 }])
  })

  it('leaves taps outside links alone', () => {
    expect(click('#text')).toBe(false)
    expect(posted).toEqual([])
  })
})
