import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useFocusReturn } from '../focusReturn'

describe('useFocusReturn', () => {
  it('gives focus back to what had it when the layer opened, once asked after the layer left', async () => {
    const opener = document.createElement('button')
    const inside = document.createElement('input')
    document.body.append(opener, inside)
    const open = ref(false)
    const scope = effectScope()
    const focus = scope.run(() => useFocusReturn(() => open.value))!

    opener.focus()
    open.value = true
    await nextTick()
    inside.focus()
    open.value = false
    await nextTick()
    // Nothing moves until the layer has left the page.
    expect(document.activeElement).toBe(inside)

    focus.restore()
    expect(document.activeElement).toBe(opener)
    scope.stop()
    opener.remove()
    inside.remove()
  })

  it('leaves focus alone when the opener is gone, or when nothing had focus', async () => {
    const opener = document.createElement('button')
    const inside = document.createElement('input')
    document.body.append(opener, inside)
    const open = ref(false)
    const scope = effectScope()
    const focus = scope.run(() => useFocusReturn(() => open.value))!

    opener.focus()
    open.value = true
    await nextTick()
    opener.remove()
    inside.focus()
    focus.restore()
    expect(document.activeElement).toBe(inside)

    open.value = false
    await nextTick()
    inside.blur()
    open.value = true
    await nextTick()
    inside.focus()
    focus.restore()
    expect(document.activeElement).toBe(inside)
    scope.stop()
    inside.remove()
  })
})
