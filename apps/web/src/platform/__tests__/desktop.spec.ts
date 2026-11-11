import { beforeEach, describe, expect, it, vi } from 'vitest'

const shell = vi.hoisted(() => ({
  calls: [] as string[],
  answers: [] as { resolve: (value: unknown) => void; reject: (error: Error) => void }[],
  current: null as string[] | null,
  listener: null as ((urls: string[]) => void) | null,
}))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: (command: string, args?: { tokens?: string }) => {
    shell.calls.push(args?.tokens === undefined ? command : `${command} ${args.tokens}`)
    return new Promise((resolve, reject) => shell.answers.push({ resolve, reject }))
  },
}))

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: async () => shell.current,
  onOpenUrl: async (listener: (urls: string[]) => void) => {
    shell.listener = listener
  },
}))

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: async () => undefined }))

/** A fresh module, as a new page load has. */
async function desktop() {
  vi.resetModules()
  return import('../desktop')
}

describe('desktop shell bridge', () => {
  beforeEach(() => {
    shell.calls = []
    shell.answers = []
    shell.current = null
    shell.listener = null
    sessionStorage.clear()
  })

  it('runs the keychain commands one after another, in the order they were asked for', async () => {
    const { clearKeychainTokens, saveKeychainTokens } = await desktop()

    const saved = saveKeychainTokens('{"accessToken":"a"}')
    const cleared = clearKeychainTokens()
    await vi.waitFor(() => expect(shell.calls).toEqual(['save_tokens {"accessToken":"a"}']))

    shell.answers[0]!.reject(new Error('User canceled the operation.'))
    await expect(saved).rejects.toThrow('User canceled the operation.')
    await vi.waitFor(() => expect(shell.calls).toEqual(['save_tokens {"accessToken":"a"}', 'clear_tokens']))
    shell.answers[1]!.resolve(undefined)
    await expect(cleared).resolves.toBeUndefined()
  })

  it('handles the link the app was started with once, not again after the window reloads', async () => {
    shell.current = ['tresso://auth/callback?code=c&state=s']
    const handled: string[] = []

    await (await desktop()).onDeepLinks((url) => handled.push(url))
    await (await desktop()).onDeepLinks((url) => handled.push(url))

    expect(handled).toEqual(['tresso://auth/callback?code=c&state=s'])
  })

  it('handles every link that arrives while the app runs, also one it saw before', async () => {
    const handled: string[] = []
    await (await desktop()).onDeepLinks((url) => handled.push(url))

    shell.listener!(['tresso://auth/callback?code=c&state=s'])
    shell.listener!(['tresso://auth/callback?code=c&state=s'])

    expect(handled).toEqual(['tresso://auth/callback?code=c&state=s', 'tresso://auth/callback?code=c&state=s'])
  })

  it('does not handle a link again after a reload once it arrived while the app ran', async () => {
    const handled: string[] = []
    await (await desktop()).onDeepLinks((url) => handled.push(url))
    shell.listener!(['tresso://auth/callback?code=c&state=s'])

    shell.current = ['tresso://auth/callback?code=c&state=s']
    await (await desktop()).onDeepLinks((url) => handled.push(url))

    expect(handled).toEqual(['tresso://auth/callback?code=c&state=s'])
  })
})
