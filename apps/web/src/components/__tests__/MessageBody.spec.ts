import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageFrame from '../MessageFrame.vue'
import PlainTextBody from '../PlainTextBody.vue'

describe('MessageFrame', () => {
  it('renders mail in a frame that cannot run scripts', () => {
    const frame = mount(MessageFrame, { props: { html: '<p>Hi</p>', allowRemoteContent: false } }).get('iframe')

    const sandbox = (frame.attributes('sandbox') ?? '').split(/\s+/)
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-forms')
    expect(sandbox).not.toContain('allow-top-navigation')
    expect(frame.attributes('srcdoc')).toContain('<body><p>Hi</p></body>')
    expect(frame.attributes('srcdoc')).toContain("default-src 'none'")
    expect(frame.attributes('srcdoc')).toContain('img-src http://localhost:8080 data:;')
  })

  // The desktop app opens these in the user's browser from one place, its new-window handler (apps/desktop lib.rs):
  // every link must ask for a new window, and the frame must be allowed to ask.
  it('sends every link in the mail to a new window', () => {
    const frame = mount(MessageFrame, { props: { html: '<a href="https://example.test">x</a>', allowRemoteContent: false } }).get('iframe')

    expect(frame.attributes('srcdoc')).toContain('<base target="_blank">')
    expect((frame.attributes('sandbox') ?? '').split(/\s+/)).toContain('allow-popups')
  })

  it('opens images to the internet only when allowed', () => {
    const frame = mount(MessageFrame, { props: { html: '<p>Hi</p>', allowRemoteContent: true } }).get('iframe')

    expect(frame.attributes('srcdoc')).toContain('img-src http://localhost:8080 data: https: http:')
  })
})

describe('PlainTextBody', () => {
  it('shows markup as text and links only web and mail addresses', () => {
    const wrapper = mount(PlainTextBody, {
      props: { text: 'See https://example.test/a?b=1. <script>x</script> javascript:alert(1) mailto:kim@example.test' },
    })

    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.text()).toContain('<script>x</script>')
    expect(wrapper.findAll('a').map((a) => a.attributes('href'))).toEqual(['https://example.test/a?b=1', 'mailto:kim@example.test'])
    expect(wrapper.get('a').attributes('rel')).toBe('noopener noreferrer')
  })
})
