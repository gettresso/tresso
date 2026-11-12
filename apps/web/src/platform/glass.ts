import { invoke } from '@tauri-apps/api/core'

/**
 * Liquid Glass behind the sidebar card (macOS 26 and later, apps/desktop/src-tauri/src/glass.rs): the shell puts one
 * system glass view under the web view where the card is, so the page tells it where that is. While the shell says
 * the glass is on, the page leaves the card see-through (html.liquid-glass, AppShell); where it is not (before macOS 26,
 * turned off, Windows, Linux) the card is drawn as before and nothing more is sent.
 */

/** One glass shape, in CSS pixels from the page's top-left corner (GlassRect in glass.rs). */
export interface GlassRect {
  id: string
  x: number
  y: number
  width: number
  height: number
  radius: number
}

export interface GlassShell {
  invoke(command: 'set_glass', args: { rects: GlassRect[]; viewportWidth: number }): Promise<{ supported: boolean }>
}

/** The id of the sidebar card's glass. */
export const CARD_ID = 'sidebar'

/** The card's shape from its box on the page; the shell turns it into points (also when the page is zoomed). */
export function cardShape(box: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, radius: number): GlassRect {
  return { id: CARD_ID, x: box.left, y: box.top, width: box.width, height: box.height, radius }
}

export interface GlassOptions {
  /** The card while it may carry glass: shown, and the system not asked for less transparency; null otherwise. */
  card(): HTMLElement | null
  /** The card's corner radius in CSS pixels (frame.css). */
  radius: number
  /** Told once, with the shell's first answer. */
  onSupported(supported: boolean): void
  shell?: GlassShell
  view?: Pick<Window, 'addEventListener' | 'removeEventListener' | 'requestAnimationFrame' | 'cancelAnimationFrame' | 'innerWidth'>
  onError?(error: unknown): void
}

export interface GlassReporter {
  /** Sends where the card is now (an empty list when there is none); nothing when it did not move. */
  report(): void
  /** Sends the card's place every frame for `ms` (a slide), then once more. */
  follow(ms: number): void
  /** Sends every frame until `stopFollowing` (a drag of the card's edge). */
  startFollowing(): void
  stopFollowing(): void
  /** Removes the glass and stops listening (the shell left the page, a sign-out). */
  stop(): void
}

/**
 * Reports the card's place: at once, when the window is resized (and when the card's box changes size, through the
 * ResizeObserver the caller connects to `report`), and every frame only while it slides or its edge is dragged.
 */
export function startGlassReporter(options: GlassOptions): GlassReporter {
  const shell: GlassShell = options.shell ?? { invoke: (command, args) => invoke<{ supported: boolean }>(command, args) }
  const view = options.view ?? window
  const onError = options.onError ?? ((error: unknown) => console.error('Placing the sidebar glass failed', error))
  /** Null until the shell answers; false stops everything. */
  let supported: boolean | null = null
  let stopped = false
  let last: string | null = null
  let frame: number | null = null
  let until = 0
  let following = false

  function send(rects: GlassRect[]): void {
    const key = JSON.stringify(rects)
    if (key === last) {
      return
    }
    last = key
    shell
      .invoke('set_glass', { rects, viewportWidth: view.innerWidth })
      .then((answer) => {
        if (supported === null) {
          supported = answer.supported
          options.onSupported(answer.supported)
        }
        if (!answer.supported) {
          end()
        }
      })
      .catch((error: unknown) => {
        // Sent again with the next change.
        last = null
        onError(error)
      })
  }

  function report(): void {
    if (stopped) {
      return
    }
    const card = options.card()
    send(card === null ? [] : [cardShape(card.getBoundingClientRect(), options.radius)])
  }

  function tick(): void {
    frame = null
    report()
    if (!stopped && (following || performance.now() < until)) {
      frame = view.requestAnimationFrame(tick)
    }
  }

  function loop(): void {
    if (frame === null && !stopped) {
      frame = view.requestAnimationFrame(tick)
    }
  }

  function end(): void {
    stopped = true
    if (frame !== null) {
      view.cancelAnimationFrame(frame)
      frame = null
    }
    view.removeEventListener('resize', report)
  }

  view.addEventListener('resize', report)
  report()

  return {
    report,
    follow(ms) {
      until = Math.max(until, performance.now() + ms)
      loop()
    },
    startFollowing() {
      following = true
      loop()
    },
    stopFollowing() {
      following = false
      report()
    },
    stop() {
      if (supported !== false) {
        send([])
      }
      end()
    },
  }
}
