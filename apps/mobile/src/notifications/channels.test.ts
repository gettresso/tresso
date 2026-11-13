import { beforeEach, describe, expect, it, vi } from 'vitest'

const created = vi.hoisted(() => new Map<string, Record<string, unknown>>())

vi.mock('expo-notifications', () => ({
  AndroidImportance: { LOW: 2, DEFAULT: 3, HIGH: 4 },
  setNotificationChannelAsync: async (id: string, channel: Record<string, unknown>) => {
    created.set(id, channel)
    return { id, ...channel }
  },
}))

const { createNotificationChannels } = await import('./channels')

describe('createNotificationChannels', () => {
  beforeEach(() => created.clear())

  it('creates the channels the API sends reminders, mail and WhatsApp messages on: a banner with sound, and a silent twin of each', async () => {
    await createNotificationChannels('android')

    expect([...created.keys()]).toEqual(['reminders', 'reminders_silent', 'mail', 'mail_silent', 'whatsapp', 'whatsapp_silent'])
    expect(created.get('whatsapp')).toMatchObject({ importance: 4, sound: 'default' })
    expect(created.get('whatsapp_silent')).toMatchObject({ importance: 2, sound: null, enableVibrate: false })
    expect(created.get('reminders')).toMatchObject({ importance: 4, sound: 'default' })
    expect(created.get('reminders_silent')).toMatchObject({ importance: 2, sound: null, enableVibrate: false })
    expect(created.get('mail')).toMatchObject({ importance: 4, sound: 'default' })
    expect(created.get('mail_silent')).toMatchObject({ importance: 2, sound: null, enableVibrate: false })
  })

  it('creates none on iOS', async () => {
    await createNotificationChannels('ios')

    expect(created.size).toBe(0)
  })
})
