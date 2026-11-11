import { describe, expect, it } from 'vitest'
import type { Todo } from './todos'
import type { SyncedMessage } from './sync/types'
import { compareTodos, dueLabel, groupTodos, parseQuickAdd, todoSection, todoSourceMessage } from './todos'

/** Tuesday 20 October 2026, 10:00 on this device. */
const now = new Date(2026, 9, 20, 10, 0)

function todo(id: string, extra: Partial<Todo> = {}): Todo {
  return {
    id,
    title: `Todo ${id}`,
    notes: '',
    dueDate: null,
    dueTime: null,
    durationMinutes: null,
    completedAt: null,
    position: 0,
    source: 'manual',
    messageId: null,
    threadId: null,
    plannedStart: null,
    plannedEnd: null,
    planState: null,
    createdAt: '2026-10-19T08:00:00+00:00',
    updatedAt: '2026-10-19T08:00:00+00:00',
    ...extra,
  }
}

describe('todos', () => {
  it('orders open todos by position and done ones after them, most recently done first', () => {
    const todos = [
      todo('done-early', { completedAt: '2026-10-18T08:00:00+00:00' }),
      todo('second', { position: 2 }),
      todo('done-late', { completedAt: '2026-10-19T08:00:00+00:00' }),
      todo('first', { position: 1 }),
      todo('first-too', { position: 1, createdAt: '2026-10-19T09:00:00+00:00' }),
    ]

    expect(todos.sort(compareTodos).map((t) => t.id)).toEqual(['first', 'first-too', 'second', 'done-late', 'done-early'])
  })

  it('puts a todo in overdue, today, this week, later or done', () => {
    expect(todoSection(todo('a', { dueDate: '2026-10-19' }), now)).toBe('overdue')
    expect(todoSection(todo('b', { dueDate: '2026-10-20', dueTime: '09:30' }), now)).toBe('overdue')
    expect(todoSection(todo('c', { dueDate: '2026-10-20', dueTime: '17:00' }), now)).toBe('today')
    expect(todoSection(todo('d', { dueDate: '2026-10-20' }), now)).toBe('today')
    expect(todoSection(todo('e', { dueDate: '2026-10-25' }), now)).toBe('thisWeek')
    expect(todoSection(todo('f', { dueDate: '2026-10-26' }), now)).toBe('later')
    expect(todoSection(todo('g'), now)).toBe('later')
    expect(todoSection(todo('h', { dueDate: '2026-10-19', completedAt: '2026-10-20T08:00:00+00:00' }), now)).toBe('done')
  })

  it('groups todos by section in list order and leaves empty sections out', () => {
    const groups = groupTodos([todo('later', { position: 1 }), todo('today', { dueDate: '2026-10-20' }), todo('done', { completedAt: '2026-10-20T08:00:00+00:00' }), todo('later-first', { position: 0 })], now)

    expect(groups.map((group) => [group.label, group.todos.map((t) => t.id)])).toEqual([
      ['Today', ['today']],
      ['Later', ['later-first', 'later']],
      ['Done', ['done']],
    ])
  })

  it('says when a todo is due in words', () => {
    expect(dueLabel(todo('a', { dueDate: '2026-10-20', dueTime: '17:00' }), now)).toBe('Today 17:00')
    expect(dueLabel(todo('b', { dueDate: '2026-10-21' }), now)).toBe('Tomorrow')
    expect(dueLabel(todo('c', { dueDate: '2026-10-19' }), now)).toBe('Yesterday')
    expect(dueLabel(todo('d', { dueDate: '2026-10-23', dueTime: '09:00' }), now)).toBe('Fri 23 Oct 09:00')
    expect(dueLabel(todo('e', { dueDate: '2027-01-04' }), now)).toBe('Mon 4 Jan 2027')
    expect(dueLabel(todo('f'), now)).toBeNull()
    expect(dueLabel(todo('g', { completedAt: new Date(2026, 9, 19, 15, 0).toISOString() }), now)).toBe('Done yesterday')
  })

  it('makes a todo from the newest email someone else sent, or the newest one when the user wrote them all', () => {
    const email = (id: string, from: string) => ({ id, from: { address: from, name: null } }) as SyncedMessage
    const anna = email('m1', 'anna@partner.example')
    const lisa = email('m2', 'lisa@partner.example')
    const reply = email('m3', 'Kim@Company.example')

    expect(todoSourceMessage([anna, lisa, reply], ['kim@company.example'])?.id).toBe('m2')
    expect(todoSourceMessage([reply], ['kim@company.example'])?.id).toBe('m3')
    expect(todoSourceMessage([], ['kim@company.example'])).toBeNull()
  })

  describe('quick add', () => {
    it('finds a weekday, today counting', () => {
      expect(parseQuickAdd('Call Anna friday', now)).toEqual({ title: 'Call Anna', dueDate: '2026-10-23', dueTime: null })
      expect(parseQuickAdd('Call Anna Tuesday', now)).toEqual({ title: 'Call Anna', dueDate: '2026-10-20', dueTime: null })
      expect(parseQuickAdd('Call Anna on monday', now)).toEqual({ title: 'Call Anna', dueDate: '2026-10-26', dueTime: null })
    })

    it('finds tomorrow with a time', () => {
      expect(parseQuickAdd('Send the slides tomorrow 9:00', now)).toEqual({ title: 'Send the slides', dueDate: '2026-10-21', dueTime: '09:00' })
      expect(parseQuickAdd('Send the slides tomorrow at 5pm', now)).toEqual({ title: 'Send the slides', dueDate: '2026-10-21', dueTime: '17:00' })
    })

    it('finds 29 February in the next year that has one, and no date for a day no year has', () => {
      expect(parseQuickAdd('Renew passport 29 feb', new Date(2027, 2, 1))).toEqual({ title: 'Renew passport', dueDate: '2028-02-29', dueTime: null })
      expect(parseQuickAdd('Renew passport 29 feb', new Date(2028, 1, 1))).toEqual({ title: 'Renew passport', dueDate: '2028-02-29', dueTime: null })
      expect(parseQuickAdd('Renew passport 31 apr', new Date(2027, 2, 1))).toMatchObject({ dueDate: null })
    })

    it('finds a day of a month, next year once it has passed', () => {
      expect(parseQuickAdd('Pay rent 27 oct', now)).toEqual({ title: 'Pay rent', dueDate: '2026-10-27', dueTime: null })
      expect(parseQuickAdd('Renew passport march 3', now)).toEqual({ title: 'Renew passport', dueDate: '2027-03-03', dueTime: null })
      expect(parseQuickAdd('Book 31 feb', now)).toEqual({ title: 'Book 31 feb', dueDate: null, dueTime: null })
    })

    it('puts a time without a day today, or tomorrow once it has passed', () => {
      expect(parseQuickAdd('Stand-up 11:30', now)).toEqual({ title: 'Stand-up', dueDate: '2026-10-20', dueTime: '11:30' })
      expect(parseQuickAdd('Stand-up 9:15', now)).toEqual({ title: 'Stand-up', dueDate: '2026-10-21', dueTime: '09:15' })
    })

    it('leaves words that only look like a day or time in the title', () => {
      expect(parseQuickAdd('Fix the sun shade', now)).toEqual({ title: 'Fix the sun shade', dueDate: null, dueTime: null })
      expect(parseQuickAdd('Call Monica about room 101', now)).toEqual({ title: 'Call Monica about room 101', dueDate: null, dueTime: null })
      expect(parseQuickAdd('Order 25:99 cables', now)).toEqual({ title: 'Order 25:99 cables', dueDate: null, dueTime: null })
    })
  })
})
