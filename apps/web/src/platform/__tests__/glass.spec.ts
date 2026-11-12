import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cardShape, startGlassReporter, type GlassRect, type GlassShell } from '../glass'

/** A window whose frames run when the test says so. */
function fakeView(width = 1240) {
  const target = new EventTarget()
  let frames: FrameRequestCallback[] = []
  return {
    innerWidth: width,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
    cancelAnimationFrame: () => {
      frames = []
    },
    frame() {
      const now = frames
      frames = []
      now.forEach((callback) => callback(performance.now()))
    },
    pending: () => frames.length,
  }
}

function fakeShell(supported = true) {
  const calls: { rects: GlassRect[]; viewportWidth: number }[] = []
  const shell: GlassShell = {
    invoke: vi.fn<GlassShell['invoke']>(async (_command, args) => {
      calls.push(args)
      return { supported }
    }),
  }
  return { shell, calls }
}

function card(box: { left: number; top: number; width: number; height: number }): HTMLElement {
  const element = document.createElement('nav')
  element.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box })
  return element
}

describe('the sidebar glass reporter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('makes the card\'s shape from its box', () => {
    expect(cardShape({ left: 8, top: 8, width: 202, height: 764 }, 18)).toEqual({ id: 'sidebar', x: 8, y: 8, width: 202, height: 764, radius: 18 })
  })

  it('reports the card at once and on a window resize, with the page\'s width, and nothing when it did not move', async () => {
    const view = fakeView()
    const { shell, calls } = fakeShell()
    let box = { left: 8, top: 8, width: 202, height: 764 }
    const supported = vi.fn<(supported: boolean) => void>()
    startGlassReporter({ card: () => card(box), radius: 18, onSupported: supported, shell, view })
    await vi.waitFor(() => expect(supported).toHaveBeenCalledWith(true))
    expect(calls).toEqual([{ rects: [{ id: 'sidebar', x: 8, y: 8, width: 202, height: 764, radius: 18 }], viewportWidth: 1240 }])

    view.dispatchEvent(new Event('resize'))
    expect(calls).toHaveLength(1)
    box = { ...box, height: 900 }
    view.dispatchEvent(new Event('resize'))
    expect(calls[1]!.rects[0]!.height).toBe(900)
    expect(supported).toHaveBeenCalledOnce()
  })

  it('follows the card every frame while it slides, then sends an empty list once it is hidden', () => {
    const view = fakeView()
    const { calls, shell } = fakeShell()
    let shown = true
    let left = 8
    const reporter = startGlassReporter({ card: () => (shown || left > -210 ? card({ left, top: 8, width: 202, height: 764 }) : null), radius: 18, onSupported: () => {}, shell, view })

    shown = false
    reporter.follow(270)
    for (const step of [-50, -120, -200]) {
      left = step
      view.frame()
    }
    expect(calls.map((call) => call.rects[0]?.x)).toEqual([8, -50, -120, -200])
    left = -210
    vi.advanceTimersByTime(300)
    view.frame()
    expect(calls[calls.length - 1]!.rects).toEqual([])
    expect(view.pending()).toBe(0)
  })

  it('follows a drag of the edge until it ends, and stops asking for frames', () => {
    const view = fakeView()
    const { calls, shell } = fakeShell()
    let width = 202
    const reporter = startGlassReporter({ card: () => card({ left: 8, top: 8, width, height: 764 }), radius: 18, onSupported: () => {}, shell, view })
    reporter.startFollowing()
    for (const next of [210, 240, 282]) {
      width = next
      view.frame()
    }
    reporter.stopFollowing()
    view.frame()
    expect(calls.map((call) => call.rects[0]!.width)).toEqual([202, 210, 240, 282])
    expect(view.pending()).toBe(0)
  })

  it('sends nothing more once the shell says the glass is off (before macOS 26, turned off)', async () => {
    const view = fakeView()
    const { calls, shell } = fakeShell(false)
    let left = 8
    const supported = vi.fn<(supported: boolean) => void>()
    const reporter = startGlassReporter({ card: () => card({ left, top: 8, width: 202, height: 764 }), radius: 18, onSupported: supported, shell, view })
    await vi.waitFor(() => expect(supported).toHaveBeenCalledWith(false))
    left = 20
    view.dispatchEvent(new Event('resize'))
    reporter.follow(270)
    view.frame()
    reporter.stop()
    expect(calls).toHaveLength(1)
  })

  it('removes the glass when it stops (a sign-out) and when there is no card', async () => {
    const view = fakeView()
    const { calls, shell } = fakeShell()
    let present = true
    const reporter = startGlassReporter({ card: () => (present ? card({ left: 8, top: 8, width: 202, height: 764 }) : null), radius: 18, onSupported: () => {}, shell, view })
    await Promise.resolve()
    present = false
    reporter.report()
    expect(calls[calls.length - 1]!.rects).toEqual([])
    present = true
    reporter.report()
    reporter.stop()
    expect(calls[calls.length - 1]!.rects).toEqual([])
    view.dispatchEvent(new Event('resize'))
    expect(calls).toHaveLength(4)
  })
})
