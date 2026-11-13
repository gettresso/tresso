import { describe, expect, it, vi } from 'vitest'
import { CalendarCapabilityCache } from '@/calendar/capabilities'

describe('the calendar capabilities on the phone', () => {
  it('offer Leave only when the server says meetingRequestDrop is true', async () => {
    for (const [body, offered] of [
      [{ meetingRequestDrop: true }, true],
      [{ meetingRequestDrop: false }, false],
      [{ eventDrafts: true }, false],
      [{ meetingRequestDrop: 'true' }, false],
      [null, false],
    ] as const) {
      const cache = new CalendarCapabilityCache(async () => body)
      expect(await cache.meetingRequestDrop('u1'), JSON.stringify(body)).toBe(offered)
    }
  })

  it('read once per signed-in user', async () => {
    const read = vi.fn(async () => ({ meetingRequestDrop: true }))
    const cache = new CalendarCapabilityCache(read)

    await cache.meetingRequestDrop('u1')
    await cache.meetingRequestDrop('u1')
    expect(read).toHaveBeenCalledOnce()

    await cache.meetingRequestDrop('u2')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('offer nothing while signed out, and read again after a sign-out', async () => {
    const read = vi.fn(async () => ({ meetingRequestDrop: true }))
    const cache = new CalendarCapabilityCache(read)

    await cache.meetingRequestDrop('u1')
    expect(await cache.meetingRequestDrop(null)).toBe(false)
    await cache.meetingRequestDrop('u1')
    expect(read).toHaveBeenCalledTimes(2)

    cache.clear()
    await cache.meetingRequestDrop('u1')
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('offer nothing when the read fails, and do not keep the failure', async () => {
    const read = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce({ meetingRequestDrop: true })
    const cache = new CalendarCapabilityCache(read)

    expect(await cache.meetingRequestDrop('u1')).toBe(false)
    expect(await cache.meetingRequestDrop('u1')).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
