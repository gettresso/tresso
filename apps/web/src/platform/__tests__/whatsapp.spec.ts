import { describe, expect, it, vi } from 'vitest'
import { WHATSAPP_EVENT, whatsAppShell, type BridgeState, type WhatsAppConfig, type WhatsAppShell } from '../whatsapp'

function fakeShell(answer: unknown = null) {
  let handler: ((event: { payload: unknown }) => void) | null = null
  const unlisten = vi.fn<() => void>()
  const shell = {
    invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => answer),
    listen: vi.fn<WhatsAppShell['listen']>(async (event, listener) => {
      expect(event).toBe(WHATSAPP_EVENT)
      handler = listener
      return unlisten
    }),
    send: (payload: unknown) => handler?.({ payload }),
    unlisten,
  }
  return shell as typeof shell & WhatsAppShell
}

const config: WhatsAppConfig = {
  mode: 'local',
  deviceId: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  deviceName: "Kim's MacBook Pro",
  linkedAt: null,
  importSince: '2026-10-13T13:40:02.000Z',
  includeGroups: true,
  notify: false,
  leftOut: [],
  moved: false,
}

describe('the WhatsApp shell commands', () => {
  it('passes every argument through under the name the shell expects', async () => {
    const shell = fakeShell()
    const whatsapp = whatsAppShell(shell)
    const calls: [() => Promise<unknown>, string, Record<string, unknown> | undefined][] = [
      [() => whatsapp.available(), 'whatsapp_available', undefined],
      [() => whatsapp.device(), 'whatsapp_device', undefined],
      [() => whatsapp.loadConfig('u1'), 'whatsapp_config_load', { userId: 'u1' }],
      [() => whatsapp.saveConfig('u1', config), 'whatsapp_config_save', { userId: 'u1', config }],
      [() => whatsapp.clearConfig('u1'), 'whatsapp_config_clear', { userId: 'u1' }],
      [() => whatsapp.keepOnlyConfig('u1'), 'whatsapp_config_keep_only', { userId: 'u1' }],
      [() => whatsapp.start('u1'), 'whatsapp_start', { userId: 'u1' }],
      [() => whatsapp.stop(), 'whatsapp_stop', undefined],
      [() => whatsapp.state(), 'whatsapp_state', undefined],
      [() => whatsapp.identity(), 'whatsapp_identity', undefined],
      [() => whatsapp.read(1200, 500), 'whatsapp_read', { afterRowid: 1200, limit: 500 }],
      [() => whatsapp.names(['31612345678']), 'whatsapp_names', { ids: ['31612345678'] }],
      [() => whatsapp.send('31612345678', 'Hi'), 'whatsapp_send', { recipient: '31612345678', text: 'Hi', mediaPath: null }],
      [() => whatsapp.send('120363000000000001@g.us', '', '/Users/kim/photo.jpg'), 'whatsapp_send', { recipient: '120363000000000001@g.us', text: '', mediaPath: '/Users/kim/photo.jpg' }],
      [() => whatsapp.download('3EB0ABC', '31612345678@s.whatsapp.net'), 'whatsapp_download', { messageId: '3EB0ABC', chatJid: '31612345678@s.whatsapp.net' }],
      [() => whatsapp.openFile('/x/whatsapp-media/a.jpg'), 'whatsapp_open_file', { path: '/x/whatsapp-media/a.jpg' }],
      [() => whatsapp.chooseFile(), 'whatsapp_choose_file', undefined],
    ]
    for (const [call, command, args] of calls) {
      shell.invoke.mockClear()
      await call()
      expect(shell.invoke).toHaveBeenCalledOnce()
      expect(shell.invoke.mock.calls[0]).toEqual(args === undefined ? [command] : [command, args])
    }
  })

  it('hands on what the shell answers and the codes it rejects with', async () => {
    const rows = { rows: [], maxRowid: 7, storeId: '16777232.4242:1:31612345678@s.whatsapp.net/A1' }
    expect(await whatsAppShell(fakeShell(rows)).read(0, 10)).toBe(rows)
    const shell = fakeShell()
    shell.invoke.mockRejectedValueOnce('busy')
    await expect(whatsAppShell(shell).read(0, 10)).rejects.toBe('busy')
  })

  it('hands every state the shell sends to the listener, until it stops listening', async () => {
    const shell = fakeShell()
    const states: BridgeState[] = []
    const stop = await whatsAppShell(shell).onState((state) => states.push(state))
    const waiting: BridgeState = { process: 'owned', port: null, loopbackOnly: null, link: 'waiting_for_scan', qr: ['0000', '0110'], error: null }
    const linked: BridgeState = { ...waiting, port: 8741, loopbackOnly: true, link: 'linked', qr: null }
    const signedOut: BridgeState = { process: 'stopped', port: null, loopbackOnly: null, link: 'unlinked', qr: null, error: 'logged_out' }
    shell.send(waiting)
    shell.send(linked)
    shell.send(signedOut)
    expect(states).toEqual([waiting, linked, signedOut])
    stop()
    expect(shell.unlisten).toHaveBeenCalledOnce()
  })
})
