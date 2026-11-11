/**
 * The link rules of the app's web views (a message body, the editor). Both set `originWhitelist={['*']}`: a URL that
 * misses react-native-webview's whitelist is opened outside the app before `onShouldStartLoadWithRequest` is asked,
 * so the whitelist has to pass everything for these rules to decide.
 *
 * A web view only ever loads its own document (`about:`). A link the reader taps is not a navigation: the frame's
 * script reports the tap (`FRAME_SCRIPT`) and the app opens it outside, when it is a web, mail or phone link. Android
 * reports every navigation as `other`, so a navigation cannot tell a tap from a redirect; a reported click can.
 */

/** Whether the web view may load this itself: only its own document, never a navigation away from it. */
export function mayLoad(url: string): boolean {
  return url.startsWith('about:')
}

/** The link to open in the browser (or the mail or phone app) for a tap the frame reported; null opens nothing. */
export function linkToOpen(url: string): string | null {
  return /^(https?|mailto|tel):/i.test(url) ? url : null
}

export type FrameMessage = { kind: 'height'; value: number } | { kind: 'tap'; url: string }

/** What the frame's script reported; null for anything else. */
export function frameMessage(data: string): FrameMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const { height, tap } = parsed as { height?: unknown; tap?: unknown }
  if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
    return { kind: 'height', value: height }
  }
  if (typeof tap === 'string') {
    return { kind: 'tap', url: tap }
  }
  return null
}

/**
 * Added by the app, not by the mail: the document's Content-Security-Policy keeps any script in the message itself
 * from running. It reports the content's height so the view can size to it (measured with heights set to auto, so
 * mail sized to the viewport, 100vh or height:100%, does not grow with every report), and turns a tap on a link into a
 * report instead of a navigation.
 */
export const FRAME_SCRIPT = `
  (function () {
    var style = document.createElement('style')
    style.textContent = 'html,body{height:auto!important;min-height:0!important}'
    document.head.appendChild(style)
    function report() { window.ReactNativeWebView.postMessage(JSON.stringify({ height: Math.ceil(document.body.getBoundingClientRect().height) })) }
    new ResizeObserver(report).observe(document.body)
    window.addEventListener('load', report)
    document.addEventListener('click', function (event) {
      var link = event.target instanceof Element ? event.target.closest('a[href], area[href]') : null
      if (link === null) { return }
      event.preventDefault()
      window.ReactNativeWebView.postMessage(JSON.stringify({ tap: link.href }))
    }, true)
    report()
  })();
  true;
`
