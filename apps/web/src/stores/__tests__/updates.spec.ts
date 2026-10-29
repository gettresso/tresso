import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

type Event = { event: 'Started'; data: { contentLength?: number } } | { event: 'Progress'; data: { chunkLength: number } } | { event: 'Finished' }

const platform = vi.hoisted(() => ({
  channel: 'tauri' as 'sparkle' | 'tauri' | 'none',
  found: null as null | { version: string; body?: string; download: (onEvent: (event: Event) => void) => Promise<void>; install: () => Promise<void>; close: () => Promise<void> },
  checks: 0,
  nativeChecks: 0,
  restarts: 0,
  restartFails: false,
  fail: null as Error | null,
  /** What answerRelaunch was called with (macOS). */
  answers: [] as boolean[],
  /** What answerRelaunch resolves: false when Sparkle no longer holds the relaunch. */
  relaunchHeld: true,
  relaunchRequested: null as null | (() => void),
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
  onRelaunchRequested: async (handler: () => void) => {
    platform.relaunchRequested = handler
    return () => {
      platform.relaunchRequested = null
    }
  },
  answerRelaunch: async (proceed: boolean) => {
    platform.answers.push(proceed)
    return proceed && platform.relaunchHeld
  },
  restart: async () => {
    platform.restarts += 1
    if (platform.restartFails) {
      throw new Error('no permission')
    }
  },
}))

// The compose window: what a restart would cut short, and its save of the open draft.
vi.mock('@/stores/compose', async () => {
  const { reactive } = await import('vue')
  const compose = reactive({
    unfinished: null as 'files' | 'sending' | null,
    saves: 0,
    saveFails: false,
    saveHangs: false,
    async saveNow() {
      compose.saves += 1
      if (compose.saveHangs) {
        await new Promise(() => undefined)
      }
      if (compose.saveFails) {
        throw new Error('disk full')
      }
    },
  })
  return { useComposeStore: () => compose }
})

const { useUpdatesStore, CHECK_EVERY_MS, SAVE_TIMEOUT_MS } = await import('../updates')
const { useComposeStore } = await import('@/stores/compose')
const compose = useComposeStore() as unknown as { unfinished: 'files' | 'sending' | null; saves: number; saveFails: boolean; saveHangs: boolean }

const closed: string[] = []

const installed: string[] = []
const downloads: string[] = []

function release(version: string, download: (onEvent: (event: Event) => void) => Promise<void> = async () => undefined, install: () => Promise<void> = async () => undefined) {
  return {
    version,
    body: 'New things',
    download: async (onEvent: (event: Event) => void) => {
      downloads.push(version)
      await download(onEvent)
    },
    install: async () => {
      await install()
      installed.push(version)
    },
    close: async () => {
      closed.push(version)
    },
  }
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
    platform.restartFails = false
    platform.answers = []
    platform.relaunchHeld = true
    platform.relaunchRequested = null
    closed.length = 0
    installed.length = 0
    downloads.length = 0
    compose.unfinished = null
    compose.saves = 0
    compose.saveFails = false
    compose.saveHangs = false
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
    // The open draft is saved on this device before the installer runs (Windows quits the app when it starts).
    expect(compose.saves).toBe(1)
    expect(installed).toEqual(['0.3.0'])
    expect(platform.restarts).toBe(1)
  })

  it('reports a failed download and does not restart', async () => {
    platform.found = release('0.3.0', async () => {
      throw new Error('signature mismatch')
    })
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    await updates.install()

    expect(updates.phase).toBe('failed')
    expect(updates.error).toBe('Downloading Tresso 0.3.0 failed: signature mismatch')
    expect(installed).toEqual([])
    expect(platform.restarts).toBe(0)
  })

  it('reports a failed install, and tries the install again without downloading again', async () => {
    let fails = true
    platform.found = release('0.3.0', undefined, async () => {
      if (fails) {
        throw new Error('access denied')
      }
    })
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    await updates.install()
    expect(updates.phase).toBe('failed')
    expect(updates.error).toBe('Installing Tresso 0.3.0 failed: access denied')
    expect(platform.restarts).toBe(0)

    fails = false
    await updates.install()
    expect(downloads).toEqual(['0.3.0'])
    expect(installed).toEqual(['0.3.0'])
    expect(platform.restarts).toBe(1)
  })

  it('waits with the restart until the files on their way are attached, then saves again and restarts', async () => {
    platform.found = release('0.3.0')
    compose.unfinished = 'files'
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    const installing = updates.install()
    await vi.waitFor(() => expect(updates.phase).toBe('waiting'))
    expect(updates.waitingFor).toBe('files')
    expect(installed).toEqual([])

    compose.unfinished = 'sending'
    await vi.waitFor(() => expect(updates.waitingFor).toBe('sending'))
    compose.unfinished = null
    await installing

    // Once before waiting, once for what the files changed in the draft.
    expect(compose.saves).toBe(2)
    expect(updates.waitingFor).toBeNull()
    expect(installed).toEqual(['0.3.0'])
    expect(platform.restarts).toBe(1)
  })

  it('lets "Later" keep working while the restart waits, and installs the download it has on the next try', async () => {
    platform.found = release('0.3.0')
    compose.unfinished = 'files'
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    const installing = updates.install()
    await vi.waitFor(() => expect(updates.phase).toBe('waiting'))
    updates.later()
    await installing

    expect(updates.phase).toBe('ready')
    expect(installed).toEqual([])
    expect(platform.restarts).toBe(0)

    compose.unfinished = null
    await updates.install()
    expect(downloads).toEqual(['0.3.0'])
    expect(installed).toEqual(['0.3.0'])
    expect(platform.restarts).toBe(1)
  })

  it('restarts at once with "Restart now", leaving what is still under way', async () => {
    platform.found = release('0.3.0')
    compose.unfinished = 'sending'
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    const installing = updates.install()
    await vi.waitFor(() => expect(updates.phase).toBe('waiting'))
    updates.restartNow()
    await installing

    expect(installed).toEqual(['0.3.0'])
    expect(platform.restarts).toBe(1)
  })

  it('does not restart when the draft cannot be saved', async () => {
    platform.found = release('0.3.0')
    compose.saveFails = true
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    await updates.install()

    expect(updates.phase).toBe('ready')
    expect(updates.error).toContain('The draft could not be saved, so Tresso did not restart: disk full')
    expect(installed).toEqual([])
    expect(platform.restarts).toBe(0)
  })

  it('lets Sparkle relaunch once the draft is saved (macOS)', async () => {
    platform.channel = 'sparkle'
    const updates = useUpdatesStore()
    await updates.start(true)
    expect(platform.relaunchRequested).not.toBeNull()

    platform.relaunchRequested?.()

    await vi.waitFor(() => expect(platform.answers).toEqual([true]))
    expect(compose.saves).toBe(1)
    expect(updates.phase).toBe('idle')

    // The install failed after all (a cancelled authorization) and Sparkle offers it again: it is answered again.
    platform.relaunchRequested?.()
    await vi.waitFor(() => expect(platform.answers).toEqual([true, true]))
  })

  it('holds Sparkle\'s relaunch while files are on their way, and keeps it held after "Later" (macOS)', async () => {
    platform.channel = 'sparkle'
    compose.unfinished = 'files'
    const updates = useUpdatesStore()
    await updates.start(true)

    platform.relaunchRequested?.()
    await vi.waitFor(() => expect(updates.phase).toBe('waiting'))
    // A second request while it waits (the menu item) does not ask twice.
    platform.relaunchRequested?.()
    updates.later()

    await vi.waitFor(() => expect(platform.answers).toEqual([false]))
    expect(updates.phase).toBe('idle')

    compose.unfinished = null
    platform.relaunchRequested?.()
    await vi.waitFor(() => expect(platform.answers).toEqual([false, true]))
  })

  it('goes back when Sparkle gave the relaunch up meanwhile (macOS)', async () => {
    platform.channel = 'sparkle'
    platform.relaunchHeld = false
    const updates = useUpdatesStore()
    await updates.start(true)

    platform.relaunchRequested?.()

    await vi.waitFor(() => expect(platform.answers).toEqual([true]))
    await vi.waitFor(() => expect(updates.phase).toBe('idle'))
  })

  it('keeps Sparkle\'s relaunch held when the draft cannot be saved (macOS)', async () => {
    platform.channel = 'sparkle'
    compose.saveFails = true
    const updates = useUpdatesStore()
    await updates.start(true)

    platform.relaunchRequested?.()

    await vi.waitFor(() => expect(platform.answers).toEqual([false]))
    expect(updates.error).toBe('The draft could not be saved, so Tresso did not restart for the update: disk full')
    updates.later()
    expect(updates.error).toBeNull()
  })

  it('does not restart when saving the draft hangs', async () => {
    vi.useFakeTimers()
    platform.found = release('0.3.0')
    compose.saveHangs = true
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    const installing = updates.install()
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    await installing

    expect(updates.error).toContain('saving it is taking too long')
    expect(installed).toEqual([])
    expect(platform.restarts).toBe(0)
  })

  it('prepares one restart at a time, so "Later" holds even after a second click', async () => {
    platform.found = release('0.3.0')
    compose.unfinished = 'files'
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    const first = updates.install()
    const second = updates.install()
    await vi.waitFor(() => expect(updates.phase).toBe('waiting'))
    updates.later()
    await Promise.all([first, second])

    compose.unfinished = null
    await vi.waitFor(() => expect(compose.saves).toBe(1))
    expect(downloads).toEqual(['0.3.0'])
    expect(installed).toEqual([])
    expect(platform.restarts).toBe(0)
    expect(updates.phase).toBe('ready')
  })

  it('keeps looking for releases while a download waits, keeping it unless a newer one is out', async () => {
    platform.found = release('0.3.0')
    compose.unfinished = 'files'
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)
    const installing = updates.install()
    await vi.waitFor(() => expect(updates.phase).toBe('waiting'))
    updates.later()
    await installing

    // The same release again: the download stays, the check's copy goes.
    platform.found = release('0.3.0')
    await updates.checkNow(false)
    expect(platform.checks).toBe(2)
    expect(updates.phase).toBe('ready')
    expect(closed).toEqual(['0.3.0'])

    platform.found = release('0.3.1')
    await updates.checkNow(false)
    expect(updates.phase).toBe('available')
    expect(updates.update?.version).toBe('0.3.1')
    expect(closed).toEqual(['0.3.0', '0.3.0'])

    compose.unfinished = null
    await updates.install()
    expect(downloads).toEqual(['0.3.0', '0.3.1'])
    expect(installed).toEqual(['0.3.1'])
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

  it('closes the release a newer check replaces', async () => {
    platform.found = release('0.3.0')
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    platform.found = release('0.3.1')
    await updates.checkNow(true)

    expect(closed).toEqual(['0.3.0'])
    expect(updates.update?.version).toBe('0.3.1')
  })

  it('tells an installed update apart from a failed one when only the restart fails', async () => {
    platform.found = release('0.3.0')
    platform.restartFails = true
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    await updates.install()

    expect(updates.phase).toBe('installing')
    expect(installed).toEqual(['0.3.0'])
    expect(updates.error).toContain('is installed. Quit and open Tresso')
  })

  it('lets "Later" put a failed download aside too', async () => {
    platform.found = release('0.3.0', async () => {
      throw new Error('disk full')
    })
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)
    await updates.install()

    updates.later()

    expect(updates.phase).toBe('available')
    expect(updates.error).toBeNull()
    expect(updates.dismissed).toBe('0.3.0')
  })

  it('calls the release through no proxy: the plugin keeps its handle in a private field', async () => {
    // Like the plugin's Update (a Resource whose rid is a #private field): a reactive proxy cannot read it.
    class PrivateRelease {
      #rid = 7
      version = '0.3.0'
      body = ''
      downloadedWith: number | null = null
      installedWith: number | null = null
      closedWith: number | null = null
      async download(onEvent: (event: Event) => void): Promise<void> {
        this.downloadedWith = this.#rid
        onEvent({ event: 'Finished' })
      }
      async install(): Promise<void> {
        this.installedWith = this.#rid
      }
      async close(): Promise<void> {
        this.closedWith = this.#rid
      }
    }
    const first = new PrivateRelease()
    platform.found = first
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    await updates.install()
    expect(first.downloadedWith).toBe(7)
    expect(first.installedWith).toBe(7)
    expect(updates.error).toBeNull()

    // A newer release replaces it (the same version would keep the download).
    const second = new PrivateRelease()
    second.version = '0.3.1'
    platform.found = second
    updates.phase = 'available'
    await updates.checkNow(true)
    expect(first.closedWith).toBe(7)
  })

  it('keeps a known release on offer when a check the user asked for fails', async () => {
    platform.found = release('0.3.0')
    const updates = useUpdatesStore()
    await updates.start(false)
    await updates.checkNow(true)

    platform.fail = new Error('offline')
    await updates.checkNow(true)

    expect(updates.phase).toBe('available')
    expect(updates.error).toContain('offline')
  })
})
