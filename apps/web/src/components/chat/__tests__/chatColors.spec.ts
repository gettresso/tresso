// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SENDER_COLORS } from '@tresso/core'

/**
 * Every text the chat screens put on a bubble, a day pill or the WhatsApp mark keeps 4.5:1 (WCAG AA for small text) in
 * both themes, worked out from the tokens in main.css as the app gets them.
 */
const css = readFileSync(fileURLToPath(new URL('../../../assets/main.css', import.meta.url)), 'utf8')

/** The token values of the first `:root { ... }` block, and those the dark theme sets over them. */
function themes(): { light: Map<string, string>; dark: Map<string, string> } {
  const block = (source: string) => new Map([...source.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((match) => [match[1]!, match[2]!.toLowerCase()]))
  const rootStart = css.indexOf(':root {')
  const light = block(css.slice(rootStart, css.indexOf('\n}\n', rootStart)))
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)')
  const dark = new Map([...light, ...block(css.slice(darkStart, css.indexOf('\n}\n', darkStart)))])
  return { light, dark }
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

const TEXT_ON: Record<string, string[]> = {
  'bubble-theirs': ['ink', 'bubble-meta', 'danger', 'sender-0', 'sender-1', 'sender-2', 'sender-3', 'sender-4', 'sender-5'],
  'bubble-mine': ['ink', 'bubble-meta', 'delegate', 'danger'],
  'chat-day': ['ink-2'],
  whatsapp: ['whatsapp-text'],
}

describe('chat colours', () => {
  it('keep the sender colours of core in the light theme, in order', () => {
    const { light } = themes()
    expect(SENDER_COLORS.map((_, index) => light.get(`sender-${index}`))).toEqual(SENDER_COLORS.map((color) => color.toLowerCase()))
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`keep 4.5:1 for every text on a bubble in the ${theme} theme`, () => {
      const tokens = themes()[theme]
      const low: string[] = []
      for (const [fill, texts] of Object.entries(TEXT_ON)) {
        for (const text of texts) {
          const ratio = contrast(tokens.get(text)!, tokens.get(fill)!)
          if (!(ratio >= 4.5)) {
            low.push(`${text} on ${fill}: ${ratio.toFixed(2)}`)
          }
        }
      }
      expect(low).toEqual([])
    })
  }
})
