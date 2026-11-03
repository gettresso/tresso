import { describe, expect, it } from 'vitest'
import { loaderFrames, MOTION, PART_OFFSETS, REDUCED } from '@/components/loaderFrames'

const linear = (t: number) => t

/** How far out a part is at fraction `t` of the cycle, read off the samples. */
function at(frames: { inputRange: number[]; outputRange: number[] }, t: number): number {
  const index = frames.inputRange.findIndex((input) => Math.abs(input - t) < 1e-9)
  if (index === -1) throw new Error(`no sample at ${t}`)
  return frames.outputRange[index]!
}

describe('the loader frames', () => {
  it('covers one whole cycle in rising steps, as the native driver needs', () => {
    const { inputRange, outputRange } = loaderFrames(0, MOTION.turn, linear)
    expect(inputRange[0]).toBe(0)
    expect(inputRange.at(-1)).toBe(1)
    expect(inputRange.every((input, index) => index === 0 || input > inputRange[index - 1]!)).toBe(true)
    expect(outputRange).toHaveLength(inputRange.length)
  })

  it('has the first part out early in the cycle and at rest by the end', () => {
    const frames = loaderFrames(PART_OFFSETS[0], MOTION.turn, linear)
    expect(at(frames, 0)).toBe(0)
    expect(at(frames, 1 / 6)).toBe(1)
    expect(at(frames, 0.5)).toBe(0)
    expect(at(frames, 1)).toBe(0)
  })

  it('gives each part its turn a third of a cycle after the one before', () => {
    const handOver = loaderFrames(PART_OFFSETS[1], MOTION.turn, linear)
    const know = loaderFrames(PART_OFFSETS[2], MOTION.turn, linear)
    expect(at(handOver, 1 / 6)).toBe(0)
    expect(at(handOver, 1 / 3 + 1 / 6)).toBe(1)
    expect(at(know, 2 / 3 + 1 / 6)).toBe(1)
    expect(at(know, 1 / 6)).toBe(0)
  })

  it('runs slower with reduced motion', () => {
    expect(REDUCED.duration).toBeGreaterThan(MOTION.duration)
    expect(at(loaderFrames(0, REDUCED.turn, linear), 0.1875)).toBe(1)
  })
})
