import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SignaturePreview from '../SignaturePreview.vue'

function prefersDark(matches: boolean): { change: (matches: boolean) => void } {
  let listener: ((event: MediaQueryListEvent) => void) | null = null
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      addEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => {
        listener = callback
      },
      removeEventListener: vi.fn<() => void>(),
    })),
  )

  return { change: (next) => listener?.({ matches: next } as MediaQueryListEvent) }
}

function frameDocument(wrapper: ReturnType<typeof mount>): string {
  return wrapper.get('iframe').attributes('srcdoc') ?? ''
}

describe('SignaturePreview', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('follows the dark look of the app without a background of its own', () => {
    prefersDark(true)
    const wrapper = mount(SignaturePreview, { props: { html: '<p>Kim</p>', background: 'app' } })

    expect(frameDocument(wrapper)).toContain('<meta name="color-scheme" content="dark">')
    expect(frameDocument(wrapper)).toContain('background:transparent;color:#F3F4F6')
  })

  it('switches along when the app turns light', async () => {
    const scheme = prefersDark(true)
    const wrapper = mount(SignaturePreview, { props: { html: '<p>Kim</p>', background: 'app' } })

    scheme.change(false)
    await wrapper.vm.$nextTick()

    expect(frameDocument(wrapper)).toContain('<meta name="color-scheme" content="light">')
    expect(frameDocument(wrapper)).toContain('background:transparent;color:#16181D')
  })

  it('keeps a fixed background when one is chosen', () => {
    prefersDark(true)
    const wrapper = mount(SignaturePreview, { props: { html: '<p>Kim</p>', background: 'light' } })

    expect(frameDocument(wrapper)).toContain('background:#fff;color:#16181D')
  })
})
