import { describe, expect, it } from 'vitest'
import { uuidV7, uuidV7Time } from './ids'

describe('uuidV7', () => {
  it('writes the time in its first 48 bits, with the version and variant of a UUIDv7', () => {
    const at = Date.parse('2026-11-11T10:00:00.123Z')
    const id = uuidV7(at)

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(uuidV7Time(id)).toBe(at)
    expect(id.slice(0, 13)).toBe(`${at.toString(16).padStart(12, '0').slice(0, 8)}-${at.toString(16).padStart(12, '0').slice(8)}`)
  })

  it('makes a different id each time, sorting by when it was made', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuidV7(1_000)))
    expect(ids.size).toBe(100)
    expect(uuidV7(1_000) < uuidV7(2_000)).toBe(true)
  })

  it('tells no time for an id of another kind', () => {
    expect(uuidV7Time(crypto.randomUUID().replace(/^(.{14})./, '$14'))).toBeNull()
  })
})
