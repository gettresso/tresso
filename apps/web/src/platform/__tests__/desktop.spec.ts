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
})
