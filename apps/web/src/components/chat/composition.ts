/**
 * Whether a keydown belongs to an input method's composition (Japanese, Chinese, Korean input): such an Enter confirms
 * the composition and must not send or submit. WKWebView sends that Enter after compositionend, with isComposing false
 * but keyCode 229, so both are checked.
 */
export function composing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
}
