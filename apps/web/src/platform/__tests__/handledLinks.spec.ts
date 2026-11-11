import { beforeEach, describe, expect, it } from 'vitest'
import { markHandled, wasHandled } from '../handledLinks'

describe('handled links', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('remembers a link as handled', () => {
    expect(wasHandled('tresso://auth/callback?code=a')).toBe(false)

    markHandled('tresso://auth/callback?code=a')

    expect(wasHandled('tresso://auth/callback?code=a')).toBe(true)
    expect(wasHandled('tresso://auth/callback?code=b')).toBe(false)
  })

  it('keeps the latest twenty links', () => {
    for (let index = 0; index < 25; index++) {
      markHandled(`tresso://auth/callback?code=${index}`)
    }

    expect(wasHandled('tresso://auth/callback?code=4')).toBe(false)
    expect(wasHandled('tresso://auth/callback?code=5')).toBe(true)
    expect(wasHandled('tresso://auth/callback?code=24')).toBe(true)
  })

  it('starts over when what it kept cannot be read', () => {
    sessionStorage.setItem('desktop.handledLinks', '{not json')

    expect(wasHandled('tresso://auth/callback?code=a')).toBe(false)
    markHandled('tresso://auth/callback?code=a')
    expect(wasHandled('tresso://auth/callback?code=a')).toBe(true)
  })
})
