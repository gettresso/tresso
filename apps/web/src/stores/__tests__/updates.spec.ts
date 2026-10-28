import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

type Event = { event: 'Started'; data: { contentLength?: number } } | { event: 'Progress'; data: { chunkLength: number } } | { event: 'Finished' }

const platform = vi.hoisted(() => ({
  channel: 'tauri' as 'sparkle' | 'tauri' | 'none',
  found: null as null | { version: string; body?: string; downloadAndInstall: (onEvent: (event: Event) => void) => Promise<void> },
  checks: 0,
  nativeChecks: 0,
  restarts: 0,
  fail: null as Error | null,
}))

vi.mock('@/platform/updates', () => ({
  updateChannel: async () => platform.channel,
  appVersion: async () => '0.2.0',
  checkNatively: async () => {
    platform.nativeChecks += 1
  },
  findUpdate: async () => {
    platform.checks += 1
    if (platform.fail !== null) {
      throw platform.fail
    }
    return platform.found
  },
  restart: async () => {
    platform.restarts += 1
  },
}))

const { useUpdatesStore, CHECK_EVERY_MS } = await import('../updates')

function release(version: string, install: (onEvent: (event: Event) => void) => Promise<void> = async () => undefined) {
  return { version, body: 'New things', downloadAndInstall: install }
}

describe('updates store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    platform.channel = 'tauri'
    platform.found = null
    platform.checks = 0
    platform.nativeChecks = 0
    platform.restarts = 0
    platform.fail = null
  })

  afterEach(() => {
    useUpdatesStore().stop()
    vi.useRealTimers()
  })

  it('checks at launch and every few hours on Windows and Linux, in a release build', async () => {
    vi.useFakeTimers()
    const updates = useUpdatesStore()

    await updates.start(true)
    await vi.waitFor(() => expect(platform.checks).toBe(1))
    expect(updates.version).toBe('0.2.0')
    expect(updates.phase).toBe('latest')

    platform.found = release('0.3.0')
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS)

    expect(platform.checks).toBe(2)
    expect(updates.phase).toBe('available')
    expect(updates.update?.version).toBe('0.3.0')
  })

  it('does not look on its own in a development build, which is always behind', async () => {
    const updates = useUpdatesStore()

    await updates.start(false)

    expect(platform.checks).toBe(0)
    expect(updates.channel).toBe('tauri')
  })

  it('leaves macOS to Sparkle: no checks of its own, and a manual check opens Sparkle', async () => {
    platform.channel = 'sparkle'
    const updates = useUpdatesStore()

    await updates.start(true)
    await updates.checkNow(true)

    expect(platform.checks).toBe(0)
    expect(platform.nativeChecks).toBe(1)
  })

  it('stays quiet when a check in the background fails, and says so when the user asked', async () => {
    platform.fail = new Error('offline')
    const updates = useUpdatesStore()
    await updates.start(false)

    await updates.checkNow(false)
    expect(updates.phase).toBe('idle')
    expect(updates.error).toBeNull()

    await updates.checkNow(true)
    expect(updates.phase).toBe('failed')
    expect(updates.error).toContain('offline')
  })

  it('downloads with progress, installs, and restarts into the new version', async () => {
    const seen: (number | null)[] = []
    platform.found = release('0.3.0', async (onEvent) => {
      onEvent({ event: 'Started', data: { contentLength: 200 } })
      seen.push(useUpdatesStore().progress)
      onEvent({ event: 'Progress', data: { chunkLength: 50 } })
      seen.push(useUpdatesStore().progress)
      onEvent({ event: 'Progress', data: { chunkLength: 150 } })
      seen.push(useUpdatesStore().progress)
      onEvent({ event: 'Finished' })
    })
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    await updates.install()

    expect(seen).toEqual([0, 0.25, 1])
    expect(updates.phase).toBe('installing')
    expect(platform.restarts).toBe(1)
  })

  it('reports a failed install and does not restart', async () => {
    platform.found = release('0.3.0', async () => {
      throw new Error('signature mismatch')
    })
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    await updates.install()

    expect(updates.phase).toBe('failed')
    expect(updates.error).toContain('signature mismatch')
    expect(platform.restarts).toBe(0)
  })

  it('puts a release aside with "Later" until the user checks again', async () => {
    platform.found = release('0.3.0')
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(false)

    updates.later()
    expect(updates.dismissed).toBe('0.3.0')
    await updates.checkNow(false)
    expect(updates.dismissed).toBe('0.3.0')

    await updates.checkNow(true)
    expect(updates.dismissed).toBeNull()
  })
})
