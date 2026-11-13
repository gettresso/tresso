import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { MeetingPreferences } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'
import { useMeetingAppsStore } from '@/stores/meetingApps'

const STORED: MeetingPreferences = { ownLink: 'https://meet.example.com/kim', addWithGuests: true, defaults: {}, defaultOther: null, disabled: [], apps: ['meet', 'teams', 'own'] }

describe('meeting preferences', () => {
  const calls: string[] = []

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    calls.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)
        const body = init?.body ? (JSON.parse(String(init.body)) as Partial<MeetingPreferences>) : {}
        return new Response(JSON.stringify({ ...STORED, ...body }))
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('reads them once for callers at the same time, and takes the answer of a change', async () => {
    const store = useMeetingAppsStore()
    await Promise.all([store.ensureLoaded(), store.ensureLoaded()])
    await store.ensureLoaded()
    expect(calls).toEqual(['GET /api/v1/calendar/meeting-preferences'])
    expect(store.preferences?.ownLink).toBe('https://meet.example.com/kim')
    await store.update({ addWithGuests: false })
    expect(calls[1]).toBe('PATCH /api/v1/calendar/meeting-preferences')
    expect(store.preferences?.addWithGuests).toBe(false)
  })

  it('forgets them when another user signs in', async () => {
    const store = useMeetingAppsStore()
    await store.ensureLoaded()
    useAuthStore().generation++
    await nextTick()
    expect(store.preferences).toBeNull()
  })

  it('drops an answer that arrives after another user signed in', async () => {
    const store = useMeetingAppsStore()
    const reading = store.reload()
    useAuthStore().generation++
    await reading
    expect(store.preferences).toBeNull()
  })

  it('applies answers in the order the changes were asked for', async () => {
    const store = useMeetingAppsStore()
    await store.ensureLoaded()
    const first = store.update({ addWithGuests: false })
    const second = store.update((current) => ({ defaultOther: current.addWithGuests ? 'own' : 'none' }))
    await Promise.all([first, second])
    expect(calls.slice(1)).toEqual(['PATCH /api/v1/calendar/meeting-preferences', 'PATCH /api/v1/calendar/meeting-preferences'])
    // The second was built from the first answer.
    expect(store.preferences?.defaultOther).toBe('none')
  })
})
