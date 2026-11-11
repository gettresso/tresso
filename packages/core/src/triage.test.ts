import { describe, expect, it } from 'vitest'
import { currentTriage, decideTriage, followTriage, lastTriageDecision, needsTriage, skipTriage, startTriage, triagePlacement, triageProgress, undoTriage, type TriageDecision, type TriageState } from './triage'

const smartInboxes = [
  { id: 'todo', builtin: 'todo' as const },
  { id: 'spam', builtin: 'spam' as const },
  { id: 'invoices', builtin: null },
]

describe('needsTriage', () => {
  it.each([
    [true, 'direct', true],
    [true, null, true],
    [true, 'sender_rule', true],
    [true, 'user', false],
    [false, 'direct', false],
  ])('in an inbox %s, reason %s: %s', (inbox, classificationReason, expected) => {
    expect(needsTriage({ inbox, classificationReason })).toBe(expected)
  })
})

describe('triagePlacement', () => {
  it('keeps the smart inbox and sets the verdict', () => {
    expect(triagePlacement('delegate', 'invoices', smartInboxes)).toEqual({ smartInboxId: 'invoices', verdict: 'delegate' })
  })

  it('puts a conversation in no smart inbox, or in Spam, in Todo', () => {
    expect(triagePlacement('do', null, smartInboxes)).toEqual({ smartInboxId: 'todo', verdict: 'do' })
    expect(triagePlacement('do', 'spam', smartInboxes)).toEqual({ smartInboxId: 'todo', verdict: 'do' })
    expect(triagePlacement('do', 'deleted', smartInboxes)).toEqual({ smartInboxId: 'todo', verdict: 'do' })
  })

  it('has no placement before the smart inboxes arrived', () => {
    expect(triagePlacement('do', null, [])).toBeNull()
  })
})

describe('a triage round', () => {
  let ids = 0
  const decide = (state: TriageState, decision: TriageDecision) => decideTriage(state, decision, ++ids)

  it('walks the queue and counts the decisions', () => {
    let state = startTriage(['a', 'b', 'c', 'd'])
    expect(currentTriage(state)).toBe('a')
    expect(triageProgress(state)).toEqual({ shown: 1, total: 4, counts: { do: 0, delegate: 0, know: 0 } })

    state = decide(state, 'do')
    state = skipTriage(state)
    state = decide(state, 'know')
    expect(currentTriage(state)).toBe('d')
    expect(triageProgress(state)).toEqual({ shown: 4, total: 4, counts: { do: 1, delegate: 0, know: 1 } })

    state = decide(state, 'delegate')
    expect(currentTriage(state)).toBeNull()
    expect(triageProgress(state)).toEqual({ shown: 4, total: 4, counts: { do: 1, delegate: 1, know: 1 } })
    expect(decide(state, 'do')).toBe(state)
  })

  it('takes back the last decision and shows that conversation again', () => {
    let state = decide(decide(startTriage(['a', 'b', 'c']), 'do'), 'know')
    expect(lastTriageDecision(state)).toMatchObject({ threadId: 'b', decision: 'know' })

    state = undoTriage(state)
    expect(currentTriage(state)).toBe('b')
    expect(triageProgress(state).counts).toEqual({ do: 1, delegate: 0, know: 0 })

    state = undoTriage(state)
    expect(currentTriage(state)).toBe('a')
    expect(lastTriageDecision(state)).toBeNull()
    expect(undoTriage(state)).toBe(state)
  })

  it('passes over conversations decided after one that was taken back', () => {
    let state = startTriage(['a', 'b', 'c', 'd'])
    state = decideTriage(state, 'do', 1)
    state = decideTriage(state, 'know', 2)
    state = decideTriage(state, 'know', 3)

    state = undoTriage(state, 1)
    expect(currentTriage(state)).toBe('a')
    state = decideTriage(state, 'do', 4)

    expect(currentTriage(state)).toBe('d')
    expect(triageProgress(state)).toMatchObject({ shown: 4, total: 4, counts: { do: 1, delegate: 0, know: 2 } })
  })

  it('takes back a decision by its id, not by its conversation', () => {
    let state = decideTriage(startTriage(['a', 'b']), 'do', 1)
    state = undoTriage(state, 1)
    state = decideTriage(state, 'know', 2)

    // The notice of the first decision on a, long gone.
    expect(undoTriage(state, 1)).toBe(state)
    state = undoTriage(state, 2)
    expect(currentTriage(state)).toBe('a')
    expect(state.decided).toEqual([])
  })

  it('passes over conversations that stopped waiting elsewhere, but keeps counting decided ones', () => {
    let state = decide(startTriage(['a', 'b', 'c', 'd']), 'do')
    // a was decided here (its placement leaves the queue), b was archived on another device.
    state = followTriage(state, new Set(['c', 'd']))
    expect(currentTriage(state)).toBe('c')
    expect(triageProgress(state)).toEqual({ shown: 2, total: 3, counts: { do: 1, delegate: 0, know: 0 } })
    expect(followTriage(state, new Set(['c', 'd']))).toBe(state)

    state = followTriage(state, new Set(['d']))
    expect(currentTriage(state)).toBe('d')
  })

  it('takes mail that arrived during the round in at its end', () => {
    let state = decide(startTriage(['a']), 'know')
    expect(currentTriage(state)).toBeNull()

    state = followTriage(state, new Set(), ['new', 'a'])
    expect(state.queue).toEqual(['a', 'new'])
    expect(currentTriage(state)).toBe('new')
    expect(triageProgress(state)).toEqual({ shown: 2, total: 2, counts: { do: 0, delegate: 0, know: 1 } })
  })

  it('brings a conversation that waits again after it was passed over back at the end', () => {
    let state = startTriage(['a', 'b', 'c'])
    state = followTriage(state, new Set(['b', 'c']))
    expect(currentTriage(state)).toBe('b')

    state = followTriage(state, new Set(['a', 'b', 'c']))
    expect(state.queue).toEqual(['b', 'c', 'a'])
    expect(currentTriage(state)).toBe('b')
    expect(triageProgress(state)).toEqual({ shown: 1, total: 3, counts: { do: 0, delegate: 0, know: 0 } })
  })

  it('keeps a conversation it did not look at as it was', () => {
    // A look that began while a was still decided; a was undone (and waits) before the look ended.
    let state = undoTriage(decide(startTriage(['a', 'b']), 'know'))

    state = followTriage(state, new Set(['b']), [], new Set(['b']))

    expect(currentTriage(state)).toBe('a')
  })

  it('shows an undone conversation again even when the list had already dropped it', () => {
    let state = decide(startTriage(['a', 'b']), 'know')
    state = followTriage(state, new Set(['b']))
    state = undoTriage(state)
    expect(currentTriage(state)).toBe('a')
  })

  it('is over at once when nothing waits', () => {
    const state = startTriage([])
    expect(currentTriage(state)).toBeNull()
    expect(triageProgress(state)).toEqual({ shown: 0, total: 0, counts: { do: 0, delegate: 0, know: 0 } })
  })
})
