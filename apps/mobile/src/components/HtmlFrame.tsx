import { useMemo, useRef, useState } from 'react'
import { Linking, StyleSheet } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { mailFrameDocument } from '@tresso/core'
import { config } from '@/config'
import { FRAME_SCRIPT, frameMessage, linkToOpen, mayLoad } from '@/components/frameLinks'
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
  const source = useMemo(() => ({ html: mailFrameDocument(html, { apiOrigin: API_ORIGIN, allowRemoteContent }), baseUrl: '' }), [html, allowRemoteContent])

  return (
    <WebView
      style={[styles.web, { height }]}
      originWhitelist={['*']}
      source={source}
      scrollEnabled={height >= MAX_BODY_HEIGHT}
      nestedScrollEnabled
      javaScriptEnabled
      allowFileAccess={false}
      mixedContentMode="never"
      injectedJavaScript={FRAME_SCRIPT}
      onMessage={(event: WebViewMessageEvent): void => {
        const report = frameMessage(event.nativeEvent.data)
        if (report?.kind === 'tap') {
          const link = linkToOpen(report.url)
          if (link !== null) {
            void Linking.openURL(link)
          }
        } else if (report?.kind === 'height') {
          // Worked out here rather than in a state updater, which React may run twice.
          shown.current = nextBodyHeight(shown.current, report.value, growths.current)
          setHeight(shown.current)
        }
      }}
      onShouldStartLoadWithRequest={(request): boolean => mayLoad(request.url)}
      allowsLinkPreview={false}
      setSupportMultipleWindows={false}
      accessibilityLabel={accessibilityLabel}
    />
  )
}

const styles = StyleSheet.create({
  web: { width: '100%', backgroundColor: '#ffffff' },
})
