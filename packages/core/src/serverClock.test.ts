import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerClock } from './serverClock'

describe('ServerClock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("is the device's clock until an answer told the server's, set against the middle of the round trip", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-11T10:00:00.400Z'))
    const clock = new ServerClock()
    expect(clock.now()).toBe(Date.parse('2026-11-11T10:00:00.400Z'))

    // The server is ten minutes behind this device: sent at .000, answered at .400, its header says 09:50:00.
    clock.note('Wed, 11 Nov 2026 09:50:00 GMT', Date.parse('2026-11-11T10:00:00.000Z'), Date.parse('2026-11-11T10:00:00.400Z'))
    vi.advanceTimersByTime(3_000)

    // 09:50:00.500 was the middle of the round trip (10:00:00.200 here), so the offset is 600 s less 300 ms.
    expect(clock.now()).toBe(Date.parse('2026-11-11T09:50:03.700Z'))
  })

  it('takes clocks that agree within two seconds for the same, so a right clock is never set back', () => {
    const clock = new ServerClock()
    const sent = Date.parse('2026-11-11T10:00:01.900Z')

    clock.note('Wed, 11 Nov 2026 10:00:01 GMT', sent, sent + 50)

    expect(clock.now() - Date.now()).toBe(0)
  })

  it('ignores an answer without a readable date, or one that took too long to say when it was written', () => {
    const clock = new ServerClock()
    const sent = Date.parse('2026-11-11T10:00:00.000Z')
    clock.note('Wed, 11 Nov 2026 09:50:00 GMT', sent, sent)
    const offset = clock.now() - Date.now()

    clock.note(null, sent, sent)
    clock.note('not a date', sent, sent)
    // A tab that slept with the answer on its way: an hour late.
    clock.note('Wed, 11 Nov 2026 08:00:00 GMT', sent, sent + 3_600_000)

    expect(clock.now() - Date.now()).toBe(offset)
  })
})
