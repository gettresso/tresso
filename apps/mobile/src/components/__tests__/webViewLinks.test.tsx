import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { Linking } from 'react-native'
import { HtmlFrame } from '@/components/HtmlFrame'
import { PlaceScrollProvider, scrollToPlaceIn } from '@/components/placeScroll'
import { MessageEditor } from '@/compose/MessageEditor'

type WebViewProps = {
  style: unknown
  originWhitelist: string[]
  onShouldStartLoadWithRequest(request: { url: string }): boolean
  onMessage(event: { nativeEvent: { url: string; data: string } }): void
}

const { views, injected } = vi.hoisted(() => ({ views: [] as WebViewProps[], injected: [] as string[] }))

vi.mock('@/config', () => ({ config: { apiUrl: 'https://api.example.test', clientId: 'mobile', redirectUri: 'tresso://auth/callback' } }))
vi.mock('react-native-webview', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    WebView: forwardRef(function WebView(props: WebViewProps, ref) {
      useImperativeHandle(ref, () => ({ injectJavaScript: (script: string) => injected.push(script) }))
      views.push(props)
      return null
    }),
  }
})

const last = () => views[views.length - 1]!

function send(data: string, url = 'about:blank'): void {
  act(() => last().onMessage({ nativeEvent: { url, data } }))
}

describe('the web views', () => {
  beforeEach(() => {
    views.length = 0
    injected.length = 0
  })

  it('pass every URL through the whitelist, so the link rules decide, and refuse every navigation away', () => {
    render(<HtmlFrame html="<p>Hi</p>" allowRemoteContent={false} accessibilityLabel="Message" />)
    render(<MessageEditor initialHtml="" onChange={() => undefined} onState={() => undefined} />)

    for (const view of views.slice(-2)) {
      expect(view.originWhitelist).toEqual(['*'])
      expect(view.onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true)
      expect(view.onShouldStartLoadWithRequest({ url: 'https://phish.example/' })).toBe(false)
      expect(view.onShouldStartLoadWithRequest({ url: 'intent://scan/#Intent;end' })).toBe(false)
    }
  })

  it('opens a tapped web link reported by the message itself, and nothing a loaded page reports', () => {
    const open = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
    render(<HtmlFrame html="<p>Hi</p>" allowRemoteContent={false} accessibilityLabel="Message" />)

    send('{"tap":"https://example.test/offer"}')
    send('{"tap":"tresso://auth/callback?code=x"}')
    send('{"tap":"https://example.test/android"}', 'null')
    send('{"tap":"https://phish.example/next"}', 'https://phish.example/landing')
    send('{"tap":"https://phish.example/next"}', 'https://phish.example')

    expect(open.mock.calls).toEqual([['https://example.test/offer'], ['https://example.test/android']])
  })

  it('sizes the mail to the height its frame reports on Android, where the sender is the opaque origin', () => {
    render(<HtmlFrame html="<p>Hi</p>" allowRemoteContent={false} accessibilityLabel="Message" />)

    send('{"height":640}', 'null')

    expect(last()).toMatchObject({ style: [expect.anything(), { height: 640 }] })
  })

  it('scrolls the screen to a place in the mail', () => {
    const scrollTo = vi.fn()
    render(
      <PlaceScrollProvider value={scrollTo}>
        <HtmlFrame html="<p>Hi</p>" allowRemoteContent={false} accessibilityLabel="Message" />
      </PlaceScrollProvider>,
    )

    send('{"place":480}')

    expect(scrollTo).toHaveBeenCalledOnce()
    expect(scrollTo.mock.calls[0]![1]).toBe(480)
    expect(injected).toEqual([])
  })

  it('scrolls inside a mail that scrolls in its own view', () => {
    const scrollTo = vi.fn()
    render(
      <PlaceScrollProvider value={scrollTo}>
        <HtmlFrame html="<p>Hi</p>" allowRemoteContent={false} accessibilityLabel="Message" initialHeight={20_000} />
      </PlaceScrollProvider>,
    )

    send('{"place":480}')

    expect(injected).toEqual(['window.scrollTo(0, 480); true;'])
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('scrolls the list so the place, measured within its content, is at the top', () => {
    const content = {}
    const list = { getInnerViewRef: () => content, scrollTo: vi.fn() }
    const view = { measureLayout: vi.fn((relativeTo: unknown, done: (left: number, top: number) => void) => done(0, relativeTo === content ? 1200 : -1)) }

    scrollToPlaceIn(list as never, view as never, 480)

    expect(list.scrollTo).toHaveBeenCalledWith({ y: 1680, animated: true })
  })
})
