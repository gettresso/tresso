import { describe, expect, it } from 'vitest'
import { themes, type Theme } from '@/theme'

/** WCAG 2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

type Token = Exclude<keyof Theme, 'senders'>

/** Text and its background as the chat screens draw them. */
const PAIRS: [Token, Token, string][] = [
  ['ink', 'bubbleTheirs', 'text of a message'],
  ['ink', 'bubbleMine', 'text of a reply'],
  ['bubbleMeta', 'bubbleTheirs', 'time under a message'],
  ['bubbleMeta', 'bubbleMine', 'time under a reply'],
  ['delegate', 'bubbleMine', 'waiting for your Mac'],
  ['danger', 'bubbleMine', 'Not sent, tap to retry'],
  ['danger', 'ground', 'why a reply was not sent'],
  ['accent', 'ground', 'Try again, Show older messages'],
  ['ink', 'ground', 'a file row'],
  ['bubbleMeta', 'ground', 'a file row, second line'],
  ['onWhatsapp', 'whatsapp', 'the WhatsApp badge'],
  ['know', 'surface', 'WhatsApp under the chat name'],
  ['ink', 'delegateSoft', 'the banner'],
  ['delegate', 'delegateSoft', 'the avatar initials'],
  ['ink2', 'surface', 'a day row, the counter, a preview'],
  ['danger', 'surface', 'why a reply cannot be sent'],
]

describe('the chat colours', () => {
  for (const [name, theme] of Object.entries(themes)) {
    it(`keep text readable (4.5:1 or more) in the ${name} theme`, () => {
      const low = PAIRS.map(([text, ground, where]) => ({ where, ratio: contrast(theme[text], theme[ground]) })).filter(({ ratio }) => ratio < 4.5)
      expect(low).toEqual([])
      for (const [index, sender] of theme.senders.entries()) {
        expect(contrast(sender, theme.bubbleTheirs), `sender colour ${index}`).toBeGreaterThanOrEqual(4.5)
      }
    })
  }
})

/** Text and its background in an event's meeting link (src/calendar/MeetingLink.tsx). */
const MEETING_PAIRS: [Token, Token, string][] = [
  ['surface', 'ink', 'the Join button'],
  ['ink', 'ground', 'the link and Copy link'],
  ['ink', 'surface', 'the app name, Making the link'],
  ['ink2', 'surface', 'the line under the link, the hints'],
  ['danger', 'surface', 'Could not make the link, could not copy'],
]

describe('the meeting link colours', () => {
  for (const [name, theme] of Object.entries(themes)) {
    it(`keep text readable (4.5:1 or more) and the Copied check visible (3:1) in the ${name} theme`, () => {
      const low = MEETING_PAIRS.map(([text, ground, where]) => ({ where, ratio: contrast(theme[text], theme[ground]) })).filter(({ ratio }) => ratio < 4.5)
      expect(low).toEqual([])
      expect(contrast(theme.know, theme.ground)).toBeGreaterThanOrEqual(3)
    })
  }
})
