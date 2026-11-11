/**
 * The link rules of the app's web views (a message body, the editor). Both set `originWhitelist={['*']}`: a URL that
 * misses react-native-webview's whitelist is opened outside the app before `onShouldStartLoadWithRequest` is asked,
 * so the whitelist has to pass everything for these rules to decide.
 *
 * A web view only ever loads its own document (`about:`). A link the reader taps is not a navigation: the frame's
 * script reports the tap (`FRAME_SCRIPT`) and the app opens it outside, when it is a web, mail or phone link, or
 * scrolls to the place it names in the same mail. Android reports every navigation as `other`, so a navigation cannot
 * tell a tap from a redirect; a reported click can.
 */

/** Whether the web view may load this itself: only its own document, never a navigation away from it. */
export function mayLoad(url: string): boolean {
  return url.startsWith('about:')
}

/** The link to open in the browser (or the mail or phone app) for a tap the frame reported; null opens nothing. */
export function linkToOpen(url: string): string | null {
  return /^(https?|mailto|tel):/i.test(url) ? url : null
}

export type FrameMessage = { kind: 'height'; value: number } | { kind: 'tap'; url: string } | { kind: 'place'; offset: number }

/**
 * What the frame's script reported; null for anything else, and for any message sent by a page other than the
 * frame's own document. A navigation the app refused can still load on Android when the answer takes too long (the
 * library allows it after 250 ms), and a page loaded that way must not open links nobody tapped.
 */
export function frameMessage(event: { url: string; data: string }): FrameMessage | null {
  if (!mayLoad(event.url)) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(event.data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const { height, tap, place } = parsed as { height?: unknown; tap?: unknown; place?: unknown }
  if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
    return { kind: 'height', value: height }
  }
  if (typeof tap === 'string') {
    return { kind: 'tap', url: tap }
  }
  if (typeof place === 'number' && Number.isFinite(place) && place >= 0) {
    return { kind: 'place', offset: place }
  }
  return null
}

/**
 * Added by the app, not by the mail: the document's Content-Security-Policy keeps any script in the message itself
 * from running. It reports the content's height so the view can size to it (measured with heights set to auto, so
 * mail sized to the viewport, 100vh or height:100%, does not grow with every report), and turns a tap on a link into a
 * report instead of a navigation: a link elsewhere is reported to open outside, a link to a place in the same mail
 * (a table of contents, a footnote) reports where that place is, so the screen scrolls to it.
 */
export const FRAME_SCRIPT = `
  (function () {
    var style = document.createElement('style')
    style.textContent = 'html,body{height:auto!important;min-height:0!important}'
    document.head.appendChild(style)
    function post(report) { window.ReactNativeWebView.postMessage(JSON.stringify(report)) }
    function report() { post({ height: Math.ceil(document.body.getBoundingClientRect().height) }) }
    function place(name) {
      if (name === '' || name === 'top') { return document.body }
      return document.getElementById(name) || document.getElementsByName(name)[0] || null
    }
    new ResizeObserver(report).observe(document.body)
    window.addEventListener('load', report)
    document.addEventListener('click', function (event) {
      var link = event.target instanceof Element ? event.target.closest('a[href], area[href]') : null
      if (link === null) { return }
      event.preventDefault()
      if (link.href.split('#')[0] === location.href.split('#')[0] && link.href.indexOf('#') !== -1) {
        var name = link.hash.slice(1)
        try { name = decodeURIComponent(name) } catch (error) {}
        var target = place(name)
        if (target !== null) { post({ place: Math.max(0, Math.round(target.getBoundingClientRect().top + window.scrollY)) }) }
        return
      }
      post({ tap: link.href })
    }, true)
    report()
  })();
  true;
`
