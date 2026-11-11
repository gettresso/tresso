import { useMemo, useRef, useState, type ComponentRef } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { randomUUID } from 'expo-crypto'
import { mailFrameDocument } from '@tresso/core'
import { config } from '@/config'
import { frameMessage, frameScript, linkToOpen, mayLoad, ownDocument } from '@/components/frameLinks'
import { usePlaceScroll } from '@/components/placeScroll'
import { MAX_BODY_HEIGHT, nextBodyHeight } from '@/mail/bodyHeight'

const API_ORIGIN = new URL(config.apiUrl).origin

interface Props {
  /** Sanitized HTML (a message body, a quote, a signature). */
  html: string
  allowRemoteContent: boolean
  accessibilityLabel: string
  /** Height before the content reported its own. */
  initialHeight?: number
}

/**
 * Sanitized HTML in a locked-down web view that sizes to its content. Links the reader taps open in the browser (or
 * the mail or phone app), never inside the view; nothing else leaves the page (see frameLinks).
 */
export function HtmlFrame({ html, allowRemoteContent, accessibilityLabel, initialHeight = 80 }: Props) {
  const [height, setHeight] = useState(initialHeight)
  /** The last growths, to tell content that grows with the view (sized in vh) from content that is just long. */
  const growths = useRef<number[]>([])
  const shown = useRef(initialHeight)
  const frame = useRef<ComponentRef<typeof View>>(null)
  const web = useRef<ComponentRef<typeof WebView>>(null)
  const scrollToPlace = usePlaceScroll()
  // Each document comes with the token that binds reports to its script (see frameMessage): a new one for every
  // document, so a page that loaded in place of an earlier one, and got its script, knows a token that no longer counts.
  const { source, token } = useMemo(
    () => ({ source: { html: mailFrameDocument(html, { apiOrigin: API_ORIGIN, allowRemoteContent }), baseUrl: '' }, token: randomUUID() }),
    [html, allowRemoteContent],
  )
  const script = useMemo(() => frameScript(token), [token])
  /**
   * The token of the document the view left by starting to load something else: nothing reported with it counts.
   * A new document has a new token, so this needs no reset.
   */
  const left = useRef<string | null>(null)

  return (
    <View ref={frame} collapsable={false} style={styles.frame}>
      <WebView
        ref={web}
        style={[styles.web, { height }]}
        originWhitelist={['*']}
        source={source}
        scrollEnabled={height >= MAX_BODY_HEIGHT}
        nestedScrollEnabled
        javaScriptEnabled
        allowFileAccess={false}
        mixedContentMode="never"
        injectedJavaScript={script}
        onLoadStart={(event): void => {
          if (!ownDocument(event.nativeEvent.url)) {
            left.current = token
          }
        }}
        onMessage={(event: WebViewMessageEvent): void => {
          const report = left.current === token ? null : frameMessage(event.nativeEvent.data, token)
          if (report?.kind === 'tap') {
            const link = linkToOpen(report.url)
            if (link !== null) {
              void Linking.openURL(link)
            }
          } else if (report?.kind === 'height') {
            // Worked out here rather than in a state updater, which React may run twice.
            shown.current = nextBodyHeight(shown.current, report.value, growths.current)
            setHeight(shown.current)
          } else if (report?.kind === 'place') {
            if (shown.current >= MAX_BODY_HEIGHT) {
              // The view scrolls inside itself (see scrollEnabled).
              web.current?.injectJavaScript(`window.scrollTo(0, ${report.offset}); true;`)
            } else if (frame.current !== null) {
              scrollToPlace?.(frame.current, report.offset)
            }
          }
        }}
        onShouldStartLoadWithRequest={(request): boolean => mayLoad(request.url)}
        allowsLinkPreview={false}
        setSupportMultipleWindows={false}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  frame: { width: '100%' },
  web: { width: '100%', backgroundColor: '#ffffff' },
})
