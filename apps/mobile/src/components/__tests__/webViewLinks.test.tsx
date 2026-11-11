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
  onLoadStart(event: { nativeEvent: { url: string } }): void
  injectedJavaScript: string
}

const { views, injected } = vi.hoisted(() => ({ views: [] as WebViewProps[], injected: [] as string[] }))

vi.mock('expo-crypto', () => ({ randomUUID: () => 'token-1' }))
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

/** A report as the frame script of this view sends it, with its token unless another (or none, null) is given. */
function send(report: Record<string, unknown>, sender = 'about:blank', token: string | null = 'token-1'): void {
  act(() => last().onMessage({ nativeEvent: { url: sender, data: JSON.stringify(token === null ? report : { ...report, token }) } }))
}

describe('the web views', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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

  it('puts its token into the frame script and opens a tapped web link reported with it, whatever the sender', () => {
    const open = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
    render(<HtmlFrame html="<p>Hi</p>" allowRemoteContent={false} accessibilityLabel="Message" />)
    expect(last().injectedJavaScript).toContain('"token-1"')

    send({ tap: 'https://example.test/offer' })
    send({ tap: 'https://example.test/android' }, 'null')
    send({ tap: 'tresso://auth/callback?code=x' })

    expect(open.mock.calls).toEqual([['https://example.test/offer'], ['https://example.test/android']])
  })

  it('ignores a report without the token or with another', () => {
    const open = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
    render(<HtmlFrame html="<p>Hi</p>" allowRemoteContent={false} accessibilityLabel="Message" />)

    send({ tap: 'https://phish.example/next' }, 'about:blank', null)
    send({ tap: 'https://phish.example/next' }, 'about:blank', 'token-2')
    send({ height: 900 }, 'null', 'guess')

    expect(open).not.toHaveBeenCalled()
    expect(last()).toMatchObject({ style: [expect.anything(), { height: 80 }] })
  })

  it('ignores every report once the view started loading a page that is not its own', () => {
    const open = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
    render(<HtmlFrame html="<p>Hi</p>" allowRemoteContent={false} accessibilityLabel="Message" />)
    act(() => last().onLoadStart({ nativeEvent: { url: 'about:blank' } }))
    send({ height: 300 })

    act(() => last().onLoadStart({ nativeEvent: { url: 'https://phish.example/' } }))
    send({ tap: 'https://phish.example/next' }, 'null')
    send({ height: 900 }, 'null')

    expect(open).not.toHaveBeenCalled()
    expect(last()).toMatchObject({ style: [expect.anything(), { height: 300 }] })
  })

  it('scrolls the screen to a place in the mail', () => {
    const scrollTo = vi.fn()
    render(
      <PlaceScrollProvider value={scrollTo}>
        <HtmlFrame html="<p>Hi</p>" allowRemoteContent={false} accessibilityLabel="Message" />
      </PlaceScrollProvider>,
    )

    send({ place: 480 })

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

    send({ place: 480 })

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
