import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerClock } from './serverClock'

describe('ServerClock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("is the device's clock until an answer told the server's", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-11T10:00:00Z'))
    const clock = new ServerClock()
    expect(clock.now()).toBe(Date.parse('2026-11-11T10:00:00Z'))

    // The server is ten minutes behind this device.
    clock.note('Wed, 11 Nov 2026 09:50:00 GMT')
    vi.advanceTimersByTime(3_000)

    expect(clock.now()).toBe(Date.parse('2026-11-11T09:50:03Z'))
  })

  it('ignores an answer without a readable date', () => {
    const clock = new ServerClock()
    clock.note('Wed, 11 Nov 2026 09:50:00 GMT', Date.parse('2026-11-11T10:00:00Z'))
    clock.note(null)
    clock.note('not a date')

    expect(clock.now() - Date.now()).toBe(-600_000)
  })
})
