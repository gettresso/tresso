import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import TickCount from '@/components/TickCount.vue'
import { genie, inView } from '@/components/calendar/genie'
import { collapseLeave, expandEnter } from '@/components/listMotion'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }
}

/** A fake Web Animations API on an element, recording the keyframes and finishing at once. */
function animatable(element: HTMLElement) {
  const calls: { keyframes: Keyframe[]; options: KeyframeAnimationOptions }[] = []
  element.animate = ((keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    calls.push({ keyframes, options })
    const animation = { finished: Promise.resolve(), onfinish: null as null | (() => void), oncancel: null }
    queueMicrotask(() => animation.onfinish?.())
    return animation
  }) as unknown as HTMLElement['animate']
  return calls
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('genie', () => {
  it('flies the dialog into the target, ending on its box, then pulses the target', async () => {
    const dialog = document.createElement('dialog')
    const target = document.createElement('div')
    dialog.getBoundingClientRect = () => rect(100, 100, 600, 400)
    target.getBoundingClientRect = () => rect(400, 300, 120, 40)
    const flying = animatable(dialog)
    const pulsing = animatable(target)

    await genie(dialog, target)

    expect(flying[0]!.keyframes[flying[0]!.keyframes.length - 1]).toEqual({ transform: 'translate(300px, 200px) scale(0.2, 0.1)', opacity: 0 })
    expect(dialog.style.transformOrigin).toBe('top left')
    expect(pulsing).toHaveLength(1)
  })

  it('leaves a browser without the Web Animations API alone', async () => {
    const dialog = document.createElement('dialog')
    Object.defineProperty(dialog, 'animate', { value: undefined })
    await expect(genie(dialog, document.createElement('div'))).resolves.toBeUndefined()
  })

  it('counts an element scrolled out of its pane as out of view', () => {
    const pane = document.createElement('div')
    pane.style.overflowY = 'auto'
    const event = document.createElement('div')
    pane.append(event)
    document.body.append(pane)
    pane.getBoundingClientRect = () => rect(0, 0, 400, 300)

    event.getBoundingClientRect = () => rect(10, 50, 100, 30)
    expect(inView(event)).toBe(true)
    event.getBoundingClientRect = () => rect(10, 500, 100, 30)
    expect(inView(event)).toBe(false)
  })
})

describe('list motion', () => {
  it('folds a leaving row shut and says when it is done', async () => {
    const row = document.createElement('div')
    document.body.append(row)
    const calls = animatable(row)
    const done = vi.fn<() => void>()

    collapseLeave(row, done)
    await Promise.resolve()
    await Promise.resolve()

    expect(calls[0]!.keyframes[calls[0]!.keyframes.length - 1]).toMatchObject({ height: '0px', opacity: 0 })
    expect(done).toHaveBeenCalledOnce()
  })

  it('judges the rows that move together: a few open up, a whole page just appears', async () => {
    const few = Array.from({ length: 3 }, () => document.createElement('div'))
    const fewCalls = few.map((row) => animatable(row))
    few.forEach((row) => expandEnter(row, () => undefined))
    await Promise.resolve()
    expect(fewCalls.map((calls) => calls.length)).toEqual([1, 1, 1])

    const page = Array.from({ length: 6 }, () => document.createElement('div'))
    const pageCalls = page.map((row) => animatable(row))
    const done = vi.fn<() => void>()
    page.forEach((row) => expandEnter(row, done))
    await Promise.resolve()
    expect(pageCalls.map((calls) => calls.length)).toEqual([0, 0, 0, 0, 0, 0])
    expect(done).toHaveBeenCalledTimes(6)
  })

  it('lets a bulk archive just go instead of folding a hundred rows', async () => {
    const rows = Array.from({ length: 100 }, () => document.createElement('div'))
    const calls = rows.map((row) => animatable(row))
    const done = vi.fn<() => void>()
    rows.forEach((row) => collapseLeave(row, done))
    await Promise.resolve()

    expect(calls.every((call) => call.length === 0)).toBe(true)
    expect(done).toHaveBeenCalledTimes(100)
  })
})

describe('TickCount', () => {
  it('ticks when the count changes, not when it first shows', async () => {
    const wrapper = mount(TickCount, { props: { value: 3 } })
    const calls = animatable(wrapper.element as HTMLElement)

    await nextTick()
    expect(calls).toHaveLength(0)
    await wrapper.setProps({ value: 4 })
    expect(calls).toHaveLength(1)
    expect(wrapper.text()).toBe('4')
  })
})
