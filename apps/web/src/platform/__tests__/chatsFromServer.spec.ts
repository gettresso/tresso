import { afterEach, describe, expect, it, vi } from 'vitest'

/** Where the chats come from: the server in the browser, the Mac's own WhatsApp in the desktop app. */
describe('chatsFromServer', () => {
  afterEach(() => {
    vi.doUnmock('@/platform/desktop')
    vi.resetModules()
  })

  for (const desktop of [false, true]) {
    it(`is ${!desktop} ${desktop ? 'in the desktop app' : 'in the browser'}`, async () => {
      vi.resetModules()
      vi.doMock('@/platform/desktop', async (original) => ({ ...(await original<typeof import('@/platform/desktop')>()), isDesktop: desktop }))
      const { chatsFromServer } = await import('@/platform/whatsapp')
      expect(chatsFromServer).toBe(!desktop)
    })
  }
})
