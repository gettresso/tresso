/**
 * The bridge prints its QR code with `qrterminal.GenerateHalfBlock`: each character is two modules, one above the
 * other. The characters are named by what the code holds (black or white module), not by how a terminal draws them.
 */
const HALF_BLOCKS: Readonly<Record<string, readonly [boolean, boolean]>> = {
  ' ': [true, true],
  '▄': [true, false],
  '▀': [false, true],
  '█': [false, false],
}

/**
 * Rows of modules (true = black) from the bridge's half-block lines, quiet zone kept. Each line gives two rows; a
 * code with an odd number of rows ends in a row of white padding. Lines of unequal length or with any other
 * character give `[]`.
 */
export function parseHalfBlocks(lines: string[]): boolean[][] {
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
