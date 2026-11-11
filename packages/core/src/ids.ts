/**
 * A UUIDv7 (RFC 9562): the first 48 bits are the time in epoch milliseconds, the rest random apart from the version
 * and variant bits. Ids of this kind sort by when they were made, and a server can tell how old one is (the API takes
 * an outgoing message's id only when it was made about now).
 */
export function uuidV7(at: number = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const ms = Math.max(0, Math.floor(at))
  // 48 bits do not fit a bitwise operation: the high 16 and low 32 bits are written apart.
  const high = Math.floor(ms / 2 ** 32)
  const low = ms % 2 ** 32
  bytes[0] = (high >>> 8) & 0xff
  bytes[1] = high & 0xff
  bytes[2] = (low >>> 24) & 0xff
  bytes[3] = (low >>> 16) & 0xff
  bytes[4] = (low >>> 8) & 0xff
  bytes[5] = low & 0xff
  bytes[6] = 0x70 | (bytes[6]! & 0x0f)
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** When a UUIDv7 was made (epoch ms), or null for any other id. */
export function uuidV7Time(id: string): number | null {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(id)
  return match === null ? null : parseInt(match[1]! + match[2]!, 16)
}
