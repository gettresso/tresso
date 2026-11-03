/** Fraction of the cycle at which a part is fully out, starts back, and is back at rest. */
interface Turn {
  out: number
  hold: number
  back: number
}

/** Matches the web loader (apps/web/src/components/LogoLoader.vue): 2.4 s, each part out by 12%, held to 22%, back by 36%. */
export const MOTION = { duration: 2400, turn: { out: 0.12, hold: 0.22, back: 0.36 } } as const
/** Reduced motion: nothing moves, the parts only light up in turn, slower. */
export const REDUCED = { duration: 3600, turn: { out: 0.15, hold: 0.25, back: 0.4 } } as const

/** The parts take their turn a third of a cycle apart: do, hand over, know. */
export const PART_OFFSETS = [0, 1 / 3, 2 / 3] as const

const SAMPLES = 48

function amount(t: number, turn: Turn, ease: (t: number) => number): number {
  if (t < turn.out) return ease(t / turn.out)
  if (t < turn.hold) return 1
  if (t < turn.back) return 1 - ease((t - turn.hold) / (turn.back - turn.hold))
  return 0
}

/**
 * How far out one part is (0 at rest, 1 fully out) over one cycle, sampled for `Animated.Value.interpolate`. The native
 * driver interpolates linearly, so the easing (the web loader's cubic-bezier(.65, 0, .35, 1)) is baked into the samples;
 * `offset` shifts the part's turn in the cycle.
 */
export function loaderFrames(offset: number, turn: Turn, ease: (t: number) => number): { inputRange: number[]; outputRange: number[] } {
  const inputRange: number[] = []
  const outputRange: number[] = []
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES
    inputRange.push(t)
    outputRange.push(amount((t - offset + 1) % 1, turn, ease))
  }
  return { inputRange, outputRange }
}
