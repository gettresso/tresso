import { describe, expect, it } from 'vitest'
import { bridgeQr, parseHalfBlocks } from './qr'
import { QR_SIZE_25, QR_SIZE_57 } from './qr.fixtures'

const B = true
const W = false

/** The finder pattern: a dark 7 by 7 ring, a light ring inside it, a dark 3 by 3 centre. */
function finderAt(rows: boolean[][], top: number, left: number): boolean {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
      if (rows[top + r]?.[left + c] !== (ring !== 2)) {
        return false
      }
    }
  }
  return true
}

/** A light quiet zone of 4 modules on every side. */
function quietZone(rows: boolean[][]): boolean {
  const side = rows.length
  return rows.every((row, r) => row.every((dark, c) => !dark || (r >= 4 && r < side - 4 && c >= 4 && c < side - 4)))
}

describe('parseHalfBlocks', () => {
  it('turns each line into two rows of modules', () => {
    // A space is dark over dark, a full block light over light, an upper half light over dark, a lower half dark
    // over light.
    expect(parseHalfBlocks([' ▀▄█', '▀ █▄'])).toEqual([
      [B, W, B, W],
      [B, B, W, W],
      [W, B, W, B],
      [B, B, W, W],
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

describe('bridgeQr', () => {
  it('reads the bridge output of a size 25 code as a 33 by 33 square with its quiet zone', () => {
    const rows = bridgeQr(QR_SIZE_25)
    expect(rows).toHaveLength(33)
    expect(rows.every((row) => row.length === 33)).toBe(true)
    expect(quietZone(rows)).toBe(true)
    expect(finderAt(rows, 4, 4)).toBe(true)
    expect(finderAt(rows, 4, 22)).toBe(true)
    expect(finderAt(rows, 22, 4)).toBe(true)
  })

  it('reads a size 57 code as a 65 by 65 square', () => {
    const rows = bridgeQr(QR_SIZE_57)
    expect(rows).toHaveLength(65)
    expect(rows.every((row) => row.length === 65)).toBe(true)
    expect(quietZone(rows)).toBe(true)
    expect(finderAt(rows, 4, 4)).toBe(true)
    expect(finderAt(rows, 4, 54)).toBe(true)
    expect(finderAt(rows, 54, 4)).toBe(true)
  })

  it('gives nothing for a code that came in only in part', () => {
    expect(bridgeQr(QR_SIZE_25.slice(0, 7))).toEqual([])
    expect(bridgeQr(QR_SIZE_25.slice(0, -1))).toEqual([])
  })

  it('gives nothing for two codes after each other', () => {
    expect(bridgeQr([...QR_SIZE_25, ...QR_SIZE_25])).toEqual([])
  })

  it('gives nothing when a header, an empty line, a log line or a carriage return is in the block', () => {
    expect(bridgeQr(['Scan this QR code with your WhatsApp app:', ...QR_SIZE_25])).toEqual([])
    expect(bridgeQr(['', ...QR_SIZE_25])).toEqual([])
    expect(bridgeQr([...QR_SIZE_25.slice(0, 8), '12:00:00.000 [Client INFO] Connected', ...QR_SIZE_25.slice(8)])).toEqual(
      [],
    )
    expect(bridgeQr(QR_SIZE_25.map((line) => `${line}\r`))).toEqual([])
  })

  it('gives nothing when a line lost characters at its end', () => {
    expect(bridgeQr(QR_SIZE_25.map((line, i) => (i === 2 ? line.slice(0, -4) : line)))).toEqual([])
  })

  it('gives nothing when the last line is not the dark closing row', () => {
    expect(bridgeQr([...QR_SIZE_25.slice(0, -1), '█'.repeat(33)])).toEqual([])
  })
})
