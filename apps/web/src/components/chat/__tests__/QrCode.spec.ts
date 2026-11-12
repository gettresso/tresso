import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { bridgeQr } from '@tresso/core'
import { QR_SIZE_25, QR_SIZE_57 } from '@tresso/core/testing/qr'
import QrCode from '../QrCode.vue'

/** The shell's form of a code: one string of 0 (light) and 1 (dark) per row (BridgeState.qr). */
function shellRows(lines: readonly string[]): string[] {
  return bridgeQr(lines).map((row) => row.map((dark) => (dark ? '1' : '0')).join(''))
}

/** The dark modules the SVG path draws, as `x,y`. */
function drawn(path: string): Set<string> {
  const cells = new Set<string>()
  for (const [, x, y, width] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let offset = 0; offset < Number(width); offset++) {
      cells.add(`${Number(x) + offset},${y}`)
    }
  }
  return cells
}

describe('QrCode', () => {
  it.each([
    ['a code of size 25', QR_SIZE_25, 33],
    ['a code of size 57', QR_SIZE_57, 65],
  ])('draws %s from qrterminal output exactly, with its quiet zone, dark on white', (_name, lines, side) => {
    const rows = shellRows(lines)
    expect(rows).toHaveLength(side)
    const wrapper = mount(QrCode, { props: { rows, label: 'QR code to scan with WhatsApp on your phone' } })

    const svg = wrapper.get('svg')
    // A whole number of pixels per module, at least 3: 33 x 7 = 231 and 65 x 4 = 260 for the default 232.
    expect(svg.attributes('width')).toBe(String(side === 33 ? 231 : 260))
    expect(svg.attributes('height')).toBe(svg.attributes('width'))
    expect(Number(svg.attributes('width')) % side).toBe(0)
    expect(Number(svg.attributes('width')) / side).toBeGreaterThanOrEqual(3)
    expect(svg.attributes('role')).toBe('img')
    expect(svg.attributes('aria-label')).toBe('QR code to scan with WhatsApp on your phone')
    expect(svg.attributes('viewBox')).toBe(`0 0 ${side} ${side}`)
    // Fixed colours, never theme tokens: a code must stay dark on light in dark mode too.
    expect(wrapper.get('rect').attributes('fill')).toBe('#ffffff')
    expect(wrapper.get('path').attributes('fill')).toBe('#000000')

    const expected = new Set<string>()
    rows.forEach((row, y) => [...row].forEach((module, x) => module === '1' && expected.add(`${x},${y}`)))
    expect(drawn(wrapper.get('path').attributes('d')!)).toEqual(expected)
    // The quiet zone: four light modules on every side.
    for (const index of [0, 1, 2, 3, side - 4, side - 1]) {
      expect(rows[index]).toBe('0'.repeat(side))
      expect(rows.every((row) => row[index] === '0')).toBe(true)
    }
    // The finder pattern's dark edge starts right inside it.
    expect(rows[4]!.slice(4, 11)).toBe('1111111')
  })

  it('draws a new code in place of the old one', async () => {
    const wrapper = mount(QrCode, { props: { rows: shellRows(QR_SIZE_25), label: 'QR code' } })
    const first = wrapper.get('path').attributes('d')
    await wrapper.setProps({ rows: shellRows(QR_SIZE_57) })
    expect(wrapper.findAll('svg')).toHaveLength(1)
    expect(wrapper.get('svg').attributes('viewBox')).toBe('0 0 65 65')
    expect(wrapper.get('path').attributes('d')).not.toBe(first)
  })

  it('draws nothing for rows that are not a whole code', () => {
    for (const rows of [[], ['0101'], shellRows(QR_SIZE_25).slice(0, 20), shellRows(QR_SIZE_25).map((row) => row.replace(/1/, '2'))]) {
      expect(mount(QrCode, { props: { rows, label: 'QR code' } }).find('svg').exists()).toBe(false)
    }
  })

  it('never draws a module under 3 pixels, also when asked for a small code', () => {
    const wrapper = mount(QrCode, { props: { rows: shellRows(QR_SIZE_57), label: 'QR code', size: 100 } })
    expect(wrapper.get('svg').attributes('width')).toBe(String(65 * 3))
  })
})
