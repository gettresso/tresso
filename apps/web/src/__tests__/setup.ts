import { afterEach } from 'vitest'
import { config, enableAutoUnmount } from '@vue/test-utils'

// Every component a test mounts goes when the test ends. One left mounted keeps its window listeners, watchers and
// requests running in the tests after it, against stores those tests already stopped.
enableAutoUnmount(afterEach)

// Menus teleport to the body in the app (anchoredMenu); in tests they stay in place, so a wrapper still finds them.
config.global.stubs = { ...config.global.stubs, teleport: true }
