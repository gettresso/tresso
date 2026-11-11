/**
 * Where the app-wide problem banner ("Sync stopped", "updated elsewhere") goes, so it never lies over what the user
 * must be able to press. The banner sits below the compose window and the notices (App.vue), so Send, Send later,
 * Undo and a minimized draft's bar always stay on top and take clicks; this moves the banner out of their way so it
 * also stays readable:
 * - no draft: along the bottom edge;
 * - a draft open or minimized on a wide window: along the top edge, clear of the compose window at the bottom right;
 * - on a phone (760 px or less) an open draft covers the whole screen and the banner waits behind it; a minimized
 *   draft is a bar along the bottom edge, and the banner sits above that bar.
 * The width part lives in App.vue's media queries; these are the classes it keys on.
 */
export function problemPlacement(draft: { minimized: boolean } | null): Record<string, boolean> {
  return {
    'with-draft': draft !== null && !draft.minimized,
    'with-minimized-draft': draft !== null && draft.minimized,
  }
}
