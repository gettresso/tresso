import { useColorScheme } from 'react-native'

// The web client's tokens (apps/web/src/assets/main.css), so both apps look like one product.
const light = {
  ground: '#f3f4f6',
  surface: '#ffffff',
  line: '#e3e5e9',
  /** Borders of controls (chips, buttons), a step stronger than dividers. */
  lineStrong: '#d5d8de',
  ink: '#16181d',
  ink2: '#4a505c',
  danger: '#b42318',
  accent: '#2341d6',
  onAccent: '#ffffff',
  /** The "do" verdict's color. */
  do: '#2341d6',
  doSoft: '#e8ecfc',
  /** The "hand over" verdict's color. */
  delegate: '#a44a06',
  delegateSoft: '#fceee2',
  /** The "know" verdict's color, also used for good news such as "no threats". */
  know: '#256b5d',
  knowSoft: '#e3f2ee',
  /** The three parts of the logo mark, as drawn in apps/web/src/components/TressoMark.vue. */
  markDo: '#2341d6',
  markDelegate: '#e0701b',
  markKnow: '#2f9c86',
  /** WhatsApp's mark (the badge on a chat row, the channel line of a chat). */
  whatsapp: '#256b5d',
  onWhatsapp: '#ffffff',
  /** Chat bubbles: someone else's, its edge, the user's own, and the time under them. */
  bubbleTheirs: '#ffffff',
  bubbleTheirsEdge: '#e3e5e9',
  bubbleMine: '#e3f2ee',
  bubbleMeta: '#4a505c',
  /** The colours group sender names are drawn in, by core's senderColor (SENDER_COLORS, in its order). */
  senders: ['#4b2f86', '#256b5d', '#1a31a8', '#7a3704', '#b42318', '#4a505c'] as readonly string[],
}

const dark: typeof light = {
  ground: '#0f1115',
  surface: '#171a20',
  line: '#2a2f38',
  lineStrong: '#3a3f4a',
  ink: '#eceef2',
  ink2: '#b5bbc6',
  danger: '#f97066',
  accent: '#8fa2ff',
  onAccent: '#0f1115',
  do: '#8fa2ff',
  doSoft: '#1f2645',
  delegate: '#f29a55',
  delegateSoft: '#3a2616',
  know: '#6cc7b2',
  knowSoft: '#16302b',
  markDo: '#8fa2ff',
  markDelegate: '#f29a55',
  markKnow: '#6cc7b2',
  whatsapp: '#256b5d',
  onWhatsapp: '#ffffff',
  bubbleTheirs: '#20242d',
  bubbleTheirsEdge: '#2a2f38',
  bubbleMine: '#15322c',
  bubbleMeta: '#b5bbc6',
  senders: ['#c3b4f5', '#6cc7b2', '#aeb9ff', '#f29a55', '#f97066', '#b5bbc6'],
}

export type Theme = typeof light

/** Both themes, for tests that check them. */
export const themes = { light, dark }

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light
}
