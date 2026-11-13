import { describe, expect, it } from 'vitest'
import { SENDER_COLORS, senderColor } from '@tresso/core'
import { clockTime } from '@/chat/texts'
import { timelineRows, windowReplies, type BubbleRow } from '@/chat/timelineRows'
import { message, reply } from './fixtures'

const NOW = new Date('2026-11-13T12:00:00.000Z')
const at = (iso: string) => clockTime(Date.parse(iso))

function bubbles(rows: ReturnType<typeof timelineRows>): BubbleRow[] {
  return rows.filter((row): row is BubbleRow => row.kind === 'bubble')
}

describe('timelineRows', () => {
  it('shows theirs and mine with times and reply states, after a day row', () => {
    const rows = timelineRows(
      [message('m1', 'c1', '2026-11-13T09:58:00.000Z', { text: 'Are we still on?' }), message('m2', 'c1', '2026-11-13T10:02:00.000Z', { fromMe: true, text: 'Yes, Saturday from 10.' })],
      [reply('r1', 'c1', { text: "I'll bring the drill", createdAt: '2026-11-13T10:31:00.000Z' })],
      { group: false, name: 'Bram Visser', relayOnline: false, now: NOW },
    )

    expect(rows[0]).toMatchObject({ kind: 'day', label: 'Today' })
    const [theirs, mine, waiting] = bubbles(rows)
    expect(theirs).toMatchObject({ mine: false, meta: at('2026-11-13T09:58:00.000Z'), state: 'none', sender: null, label: `Bram Visser, ${at('2026-11-13T09:58:00.000Z')}, Are we still on?` })
    expect(mine).toMatchObject({ mine: true, state: 'none', label: `You, ${at('2026-11-13T10:02:00.000Z')}, Yes, Saturday from 10.` })
    expect(waiting).toMatchObject({ mine: true, state: 'waiting', meta: `${at('2026-11-13T10:31:00.000Z')}, waiting for your Mac`, reply: { id: 'r1' } })
    expect(waiting?.label).toBe(`You, ${at('2026-11-13T10:31:00.000Z')}, waiting for your Mac, I'll bring the drill`)
  })

  it('names group senders above their first bubble in a row, each in their colour', () => {
    const rows = bubbles(
      timelineRows(
        [
          message('m1', 'c1', '2026-11-13T08:40:00.000Z', { sender: { id: '316111@s.whatsapp.net', name: 'Mom' }, text: 'Dinner at 18:00 on Sunday?' }),
          message('m2', 'c1', '2026-11-13T08:41:00.000Z', { sender: { id: '316111@s.whatsapp.net', name: 'Mom' }, text: 'Bring dessert' }),
          message('m3', 'c1', '2026-11-13T08:45:00.000Z', { sender: { id: '316222@s.whatsapp.net', name: null }, text: 'Sure' }),
        ],
        [],
        { group: true, name: 'Family', relayOnline: true, now: NOW },
      ),
    )

    expect(rows[0]?.sender).toEqual({ label: 'Mom', tone: SENDER_COLORS.indexOf(senderColor('316111@s.whatsapp.net')) })
    expect(rows[1]).toMatchObject({ sender: null, grouped: true })
    expect(rows[2]?.sender?.label).toBe('Unknown sender')
    expect(rows[2]?.label.startsWith('Unknown sender, ')).toBe(true)
  })

  it('shows a file as its kind and size, and where it stands', () => {
    const [photo] = bubbles(timelineRows([message('m1', 'c1', '2026-11-13T10:14:00.000Z', { text: '', mediaKind: 'image', mediaName: 'image_1.jpg', mediaSize: 184_320 })], [], { group: false, name: 'Bram', relayOnline: true, now: NOW }))

    expect(photo?.media?.id).toBe('m1')
    expect(photo?.text).toBe('')
    expect(photo?.label).toBe(`Bram, ${at('2026-11-13T10:14:00.000Z')}, Photo, 180 KB. Photo, on your Mac`)
  })

  it('shows a file queued from a device by its name', () => {
    const [sent] = bubbles(timelineRows([], [{ id: 'r1', chatId: 'c1', chatAccountId: 'a1', text: '', status: 'waiting', error: null, createdAt: '2026-11-13T10:14:00.000Z', claimedAt: null, sentAt: null, file: { name: 'plan.pdf', size: 31 } }], { group: false, name: 'Bram', relayOnline: false, now: NOW }))

    expect(sent?.text).toBe('File: plan.pdf')
    expect(sent?.label).toContain('File: plan.pdf')
  })

  it('puts a day row before each new day', () => {
    const rows = timelineRows(
      [message('m1', 'c1', '2026-11-12T10:00:00.000Z'), message('m2', 'c1', '2026-11-13T10:00:00.000Z')],
      [],
      { group: false, name: 'Bram', relayOnline: true, now: NOW },
    )

    expect(rows.map((row) => (row.kind === 'day' ? row.label : row.key))).toEqual(['Yesterday', 'm1', 'Today', 'm2'])
  })

  it('leaves out a cancelled reply, and a sent one the bridge stored too', () => {
    const rows = bubbles(
      timelineRows(
        [message('m1', 'c1', '2026-11-13T10:02:30.000Z', { fromMe: true, text: 'On my way' })],
        [reply('r1', 'c1', { status: 'cancelled' }), reply('r2', 'c1', { status: 'sent', text: 'On my way', sentAt: '2026-11-13T10:02:00.000Z', createdAt: '2026-11-13T10:01:00.000Z' })],
        { group: false, name: 'Bram', relayOnline: true, now: NOW },
      ),
    )

    expect(rows.map((row) => row.key)).toEqual(['m1'])
  })
})

describe('windowReplies', () => {
  const messages = [message('m1', 'c1', '2026-11-13T10:00:00.000Z')]

  it('keeps every reply once the oldest message is read', () => {
    const old = reply('r1', 'c1', { status: 'sent', sentAt: '2026-11-01T10:00:00.000Z' })
    expect(windowReplies(messages, [old], false)).toEqual([old])
  })

  it('keeps sent replies from the window on, and every reply that is not sent', () => {
    const old = reply('r1', 'c1', { status: 'sent', sentAt: '2026-11-01T10:00:00.000Z' })
    const recent = reply('r2', 'c1', { status: 'sent', sentAt: '2026-11-13T10:05:00.000Z' })
    const waiting = reply('r3', 'c1', { status: 'waiting', createdAt: '2026-11-01T10:00:00.000Z' })
    expect(windowReplies(messages, [old, recent, waiting], true)).toEqual([recent, waiting])
  })
})
