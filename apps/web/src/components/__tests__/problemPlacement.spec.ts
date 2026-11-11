import { describe, expect, it } from 'vitest'
import { problemPlacement } from '../problemPlacement'

describe('problemPlacement', () => {
  it('keeps the banner along the bottom edge while no draft is open', () => {
    expect(problemPlacement(null)).toEqual({ 'with-draft': false, 'with-minimized-draft': false })
  })

  it('moves it out of an open draft', () => {
    expect(problemPlacement({ minimized: false })).toEqual({ 'with-draft': true, 'with-minimized-draft': false })
  })

  it('moves it out of a minimized draft', () => {
    expect(problemPlacement({ minimized: true })).toEqual({ 'with-draft': false, 'with-minimized-draft': true })
  })
})
