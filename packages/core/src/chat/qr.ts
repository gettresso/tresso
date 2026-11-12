/**
 * The bridge prints its QR code with qrterminal v1.0.1 `GenerateHalfBlock` (whatsapp-bridge main.go:1009): each
 * character is two modules, one above the other. The characters are named by what the code holds (dark or light
 * module), not by how a terminal draws them.
 */
const HALF_BLOCKS: Readonly<Record<string, readonly [boolean, boolean]>> = {
  ' ': [true, true],
  '▄': [true, false],
  '▀': [false, true],
  '█': [false, false],
}

/**
 * The raw mapping: rows of modules (true = dark) from half-block lines, two rows per line, nothing dropped. Lines
 * of unequal length or with any other character (a carriage return, a log line, an empty line) give `[]`. Lines are
 * never trimmed: a space is two dark modules.
 */
export function parseHalfBlocks(lines: readonly string[]): boolean[][] {
  const width = lines[0] === undefined ? 0 : Array.from(lines[0]).length
  if (width === 0) {
    return []
  }
  const rows: boolean[][] = []
  for (const line of lines) {
    const characters = Array.from(line)
    if (characters.length !== width) {
      return []
    }
    const top: boolean[] = []
    const bottom: boolean[] = []
    for (const character of characters) {
      const modules = HALF_BLOCKS[character]
      if (modules === undefined) {
        return []
      }
      top.push(modules[0])
      bottom.push(modules[1])
    }
    rows.push(top, bottom)
  }
  return rows
}

/** The smallest QR code (version 1) is 21 modules wide; each version adds 4. */
const SMALLEST_CODE = 21
/** qrterminal draws a quiet zone of 4 modules on every side. */
const QUIET_ZONES = 8

/**
 * One whole QR code from the bridge's half-block block, as a square of modules (true = dark) with its quiet zone,
 * side `21 + 4n + 8`. qrterminal ends every code with a line of `▀` whose lower half is a dark row that is not part
 * of the code; it is dropped here. The block therefore ends at that line, not at an empty line. Anything that is not
 * exactly one whole code (a part of one, two codes after each other, a header or log line, an empty line, a carriage
 * return) gives `[]`.
 */
export function bridgeQr(lines: readonly string[]): boolean[][] {
  const rows = parseHalfBlocks(lines)
  const width = rows[0]?.length ?? 0
  if (width < SMALLEST_CODE + QUIET_ZONES || (width - SMALLEST_CODE - QUIET_ZONES) % 4 !== 0) {
    return []
  }
  if (rows.length !== width + 1 || !rows[width]!.every((dark) => dark)) {
    return []
  }
  return rows.slice(0, width)
}
