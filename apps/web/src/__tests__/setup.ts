import { afterEach } from 'vitest'
import { config, enableAutoUnmount } from '@vue/test-utils'

// Every component a test mounts goes when the test ends. One left mounted keeps its window listeners, watchers and
// requests running in the tests after it, against stores those tests already stopped.
enableAutoUnmount(afterEach)

// The sign-in (auth.tokens) lives in localStorage, which outlives a test in its file: a test that seeds a tab's
// sessionStorage would otherwise find the previous test's tokens, which win over it. Registered first, so it runs last,
// after a test's own clean-up gave back the real localStorage.
afterEach(() => {
  try {
    localStorage.clear()
  } catch {
    // A test left a stub without clear(); the next test brings its own.
  }
})

// Menus teleport to the body in the app (anchoredMenu); in tests they stay in place, so a wrapper still finds them.
config.global.stubs = { ...config.global.stubs, teleport: true }
