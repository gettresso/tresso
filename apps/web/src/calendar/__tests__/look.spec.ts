import { describe, expect, it } from 'vitest'
import type { SyncedCalendar } from '@tresso/core'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { calendarColor, FILL_TEXT, THEME_COLORS } from '../look'

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
  const both = /^color-mix\(in srgb, color-mix\(in srgb, var\(--cal\) (\d+)%, var\(--ink\)\) var\(--theme-light-share\), color-mix\(in srgb, var\(--cal\) (\d+)%, var\(--ink\)\)\)$/.exec(ink)
  if (both) {
    return { light: Number(both[1]), dark: Number(both[2]) }
  }
  const plain = Number(/^color-mix\(in srgb, var\(--cal\) (\d+)%, var\(--ink\)\)$/.exec(ink)![1])
  return { light: plain, dark: plain }
}

/** Colours around the hue circle at several lightnesses and saturations, as #rrggbb. */
function sweep(): string[] {
  const colours: string[] = []
  for (let hue = 0; hue < 360; hue += 10) {
    for (const saturation of [0.3, 0.6, 1]) {
      for (const lightness of [0.2, 0.35, 0.45, 0.5, 0.55, 0.65, 0.8]) {
        const c = (1 - Math.abs(2 * lightness - 1)) * saturation
        const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
        const m = lightness - c / 2
        const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]
        colours.push(`#${[r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`)
      }
    }
  }
  return colours
}

/** The colours, with the theme, whose event text falls below 4.5:1 on its tint. */
function tooLow(colours: string[]): string[] {
  const low: string[] = []
  for (const color of colours) {
    const { light, dark } = shares(calendarColor(calendar(color))['--cal-ink']!)
    for (const [theme, share] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      const { paper, ink } = THEME_COLORS[theme]
      const hex = color.toLowerCase()
      if (contrast(mix(rgb(hex), rgb(ink), share / 100), mix(rgb(hex), rgb(paper), 0.16)) < 4.5) {
        low.push(`${color} in the ${theme} theme`)
      }
    }
  }
  return low
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
    expect(tooLow(['#F6BF26', '#000000', '#6E56CF', '#7986CB', '#33B679', '#E67C73', '#FFFFFF', '#D50000'])).toEqual([])
  })

  it('puts letters on a fill of any colour at 4.5:1 or more', () => {
    const low = [...sweep(), '#DC4164', '#FF0000', '#F6BF26'].filter((color) => {
      const on = calendarColor(calendar(color))['--cal-on'] === 'var(--fill-text-light)' ? FILL_TEXT.light : FILL_TEXT.dark
      return contrast(rgb(on), rgb(color.toLowerCase())) < 4.5
    })
    expect(low).toEqual([])
  })

  it('reaches 4.5:1 for event text on its tint around the hue circle, in both themes', () => {
    expect(tooLow(sweep())).toEqual([])
  })

  it('works from the paper and ink main.css defines', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    const [light, dark] = [css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)')), css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))]
    const token = (block: string, name: string) => new RegExp(`--${name}: (#[0-9a-f]+);`, 'i').exec(block)![1]!.toLowerCase()

    expect({ paper: token(light, 'paper'), ink: token(light, 'ink') }).toEqual(THEME_COLORS.light)
    expect({ paper: token(dark, 'paper'), ink: token(dark, 'ink') }).toEqual(THEME_COLORS.dark)
    expect({ light: token(light, 'fill-text-light'), dark: token(light, 'fill-text-dark') }).toEqual(FILL_TEXT)
  })
})
