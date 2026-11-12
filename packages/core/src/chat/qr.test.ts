import { describe, expect, it } from 'vitest'
import { parseHalfBlocks } from './qr'

const B = true
const W = false

describe('parseHalfBlocks', () => {
  it('turns each line into two rows of modules', () => {
    // A space is black over black, a full block white over white, an upper half white over black, a lower half
    // black over white.
    expect(parseHalfBlocks([' ▀▄█', '▀ █▄'])).toEqual([
      [B, W, B, W],
      [B, B, W, W],
      [W, B, W, B],
      [B, B, W, W],
    ])
  })

  it('keeps the white padding row of a code with an odd number of rows', () => {
    // Three rows: B W B, W B W, B B W. The last line holds the third row above a white padding row.
    expect(parseHalfBlocks(['▄▀▄', '▄▄█'])).toEqual([
      [B, W, B],
      [W, B, W],
      [B, B, W],
      [W, W, W],
    ])
  })

  it('gives nothing for a line with another character', () => {
    expect(parseHalfBlocks(['▄▀', '▄x'])).toEqual([])
    expect(parseHalfBlocks(['\u001b[47m▄▀'])).toEqual([])
  })

  it('gives nothing for lines of unequal length', () => {
    expect(parseHalfBlocks(['▄▀▄', '▄▀'])).toEqual([])
  })

  it('gives nothing for no lines or an empty first line', () => {
    expect(parseHalfBlocks([])).toEqual([])
    expect(parseHalfBlocks([''])).toEqual([])
  })
})
