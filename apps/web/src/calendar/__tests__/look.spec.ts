import { describe, expect, it } from 'vitest'
import type { SyncedCalendar } from '@tresso/core'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { calendarColor, THEME_COLORS } from '../look'

function calendar(color: string): SyncedCalendar {
  return { color } as SyncedCalendar
}

type Rgb = [number, number, number]

function rgb(hex: string): Rgb {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Rgb
}

function mix(a: Rgb, b: Rgb, share: number): Rgb {
  return a.map((channel, index) => channel * share + b[index]! * (1 - share)) as Rgb
}

function contrast(a: Rgb, b: Rgb): number {
  const lum = (c: Rgb) => {
    const [r, g, bl] = c.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)) as Rgb
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

/** The share of the calendar color in event text, per theme, read back from --cal-ink. */
function shares(ink: string): { light: number; dark: number } {
  const calc = /calc\((\d+)% \+ (-?\d+)% \* var\(--theme-dark\)\)/.exec(ink)
  if (calc) {
    return { light: Number(calc[1]), dark: Number(calc[1]) + Number(calc[2]) }
  }
  const plain = Number(/var\(--cal\) (\d+)%/.exec(ink)![1])
  return { light: plain, dark: plain }
}

describe('calendarColor', () => {
  it('keeps text on a yellow calendar readable: dark letters on its fill, and less yellow in the text on its tint', () => {
    const look = calendarColor(calendar('#F6BF26'))

    expect(look['--cal']).toBe('#F6BF26')
    expect(look['--cal-on']).toBe('var(--fill-text-dark)')
    expect(shares(look['--cal-ink']!).light).toBeLessThan(65)
  })

  it('puts white letters on a dark calendar, and lightens its text in the dark theme only', () => {
    const look = calendarColor(calendar('#000000'))

    expect(look['--cal-on']).toBe('var(--fill-text-light)')
    const { light, dark } = shares(look['--cal-ink']!)
    expect(light).toBe(65)
    expect(dark).toBeLessThan(65)
  })

  it('falls back to the default color for a value the browser would not understand', () => {
    expect(calendarColor(calendar('red'))['--cal']).toBe('#6E56CF')
    expect(calendarColor(calendar('#12345'))['--cal']).toBe('#6E56CF')
    expect(calendarColor(undefined)['--cal']).toBe('#6E56CF')
  })

  it('reaches 4.5:1 for event text on its tint in both themes', () => {
    for (const color of ['#F6BF26', '#000000', '#6E56CF', '#7986CB', '#33B679', '#E67C73', '#FFFFFF', '#D50000']) {
      const { light, dark } = shares(calendarColor(calendar(color))['--cal-ink']!)
      for (const [theme, share] of [
        ['light', light],
        ['dark', dark],
      ] as const) {
        const { paper, ink } = THEME_COLORS[theme]
        const tint = mix(rgb(color), rgb(paper), 0.16)
        const text = mix(rgb(color), rgb(ink), share / 100)
        expect(contrast(text, tint), `${color} in the ${theme} theme`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('works from the paper and ink main.css defines', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    const [light, dark] = [css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)')), css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))]
    const token = (block: string, name: string) => new RegExp(`--${name}: (#[0-9a-f]+);`, 'i').exec(block)![1]!.toLowerCase()

    expect({ paper: token(light, 'paper'), ink: token(light, 'ink') }).toEqual(THEME_COLORS.light)
    expect({ paper: token(dark, 'paper'), ink: token(dark, 'ink') }).toEqual(THEME_COLORS.dark)
  })
})
