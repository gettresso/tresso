import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { MessageAttachment } from '@tresso/core'
import { useMailStore } from '@/stores/mail'
import AttachmentList from '../AttachmentList.vue'

const desktop = vi.hoisted(() => ({ isDesktop: false, opened: [] as string[] }))

vi.mock('@/platform/desktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/desktop')>()),
  get isDesktop() {
    return desktop.isDesktop
  },
  openInBrowser: async (url: string) => {
    desktop.opened.push(url)
  },
}))

function attachment(id: string, override: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id,
    filename: `file-${id}.pdf`,
    contentType: 'application/pdf',
    size: 2048,
    inline: false,
    contentId: null,
    scanStatus: 'clean',
    access: 'allowed',
    scanSignature: null,
    scanFailure: null,
    url: `http://localhost:8080/content/attachments/${id}?_hash=x`,
    ...override,
  }
}

describe('AttachmentList', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    desktop.isDesktop = false
    desktop.opened = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lets clean files download', () => {
    const wrapper = mount(AttachmentList, { props: { attachments: [attachment('1')] } })

    expect(wrapper.text()).toContain('2.0 KB, scanned, no threats found')
    expect(wrapper.get('a[aria-label="Download file-1.pdf"]').attributes('href')).toBe('http://localhost:8080/content/attachments/1?_hash=x')
  })

  it('shows files that are still being scanned without a download', () => {
    const wrapper = mount(AttachmentList, { props: { attachments: [attachment('1', { scanStatus: 'pending', access: 'scanning', url: null })] } })

    expect(wrapper.text()).toContain('2.0 KB, scanning…')
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(true)
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.get('button[aria-label="Download available after scan"]').attributes('disabled')).toBeDefined()
  })

  it('blocks infected files and names the malware', () => {
    const wrapper = mount(AttachmentList, {
      props: { attachments: [attachment('1', { filename: 'invoice.zip', scanStatus: 'infected', access: 'blocked', scanSignature: 'Win.Test.EICAR_HDB-1', url: null })] },
    })

    expect(wrapper.text()).toContain('Blocked: malware found.')
    expect(wrapper.get('.signature').text()).toBe('Win.Test.EICAR_HDB-1')
    expect(wrapper.text()).toContain('Quarantined')
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.get('button.unavailable').attributes('disabled')).toBeDefined()
  })

  it('downloads files that could not be scanned only after a warning, through a link asked for then', async () => {
    const link = vi.spyOn(useMailStore(), 'unscannedLink').mockResolvedValue('http://localhost:8080/content/attachments/1?unscanned=1&_hash=y')
    const tab = { opener: {}, location: { href: '' }, close: vi.fn<() => void>() }
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    const wrapper = mount(AttachmentList, { props: { attachments: [attachment('1', { scanStatus: 'failed', access: 'confirm', scanFailure: 'too_large', url: null })] } })

    expect(wrapper.text()).toContain('2.0 KB, not scanned, too large to scan')
    expect(wrapper.find('a').exists()).toBe(false)
    await wrapper.get('button[aria-label="Download file-1.pdf, not scanned"]').trigger('click')
    expect(wrapper.text()).toContain('Not checked for malware.')
    expect(link).not.toHaveBeenCalled()

    await wrapper.get('button.confirm-link').trigger('click')
    await flushPromises()

    expect(link).toHaveBeenCalledWith('1')
    expect(tab.location.href).toBe('http://localhost:8080/content/attachments/1?unscanned=1&_hash=y')
    expect(tab.opener).toBeNull()
  })

  it('downloads an unscanned file in the browser in the desktop app, which neither opens a window nor leaves its page', async () => {
    desktop.isDesktop = true
    vi.spyOn(useMailStore(), 'unscannedLink').mockResolvedValue('http://localhost:8080/content/attachments/1?unscanned=1&_hash=y')
    const open = vi.spyOn(window, 'open')
    const before = window.location.href
    const wrapper = mount(AttachmentList, { props: { attachments: [attachment('1', { scanStatus: 'failed', access: 'confirm', scanFailure: 'too_large', url: null })] } })

    await wrapper.get('button[aria-label="Download file-1.pdf, not scanned"]').trigger('click')
    await wrapper.get('button.confirm-link').trigger('click')
    await flushPromises()

    expect(desktop.opened).toEqual(['http://localhost:8080/content/attachments/1?unscanned=1&_hash=y'])
    expect(open).not.toHaveBeenCalled()
    expect(window.location.href).toBe(before)
  })

  it('opens a renewed link in the browser in the desktop app, which neither opens a window nor leaves its page', async () => {
    desktop.isDesktop = true
    const open = vi.spyOn(window, 'open')
    const before = window.location.href
    const renewed = attachment('1', { url: 'http://localhost:8080/content/attachments/1?_hash=fresh' })
    const wrapper = mount(AttachmentList, {
      props: { attachments: [attachment('1', { url: 'http://localhost:8080/content/attachments/1?_hash=old' })], renewLinks: () => Promise.resolve([renewed]) },
    })

    await wrapper.get('a[aria-label="Download file-1.pdf"]').trigger('click')
    await flushPromises()

    expect(desktop.opened).toEqual(['http://localhost:8080/content/attachments/1?_hash=fresh'])
    expect(open).not.toHaveBeenCalled()
    expect(window.location.href).toBe(before)
  })

  it('offers nothing for unscanned files on a server that requires scans', () => {
    const wrapper = mount(AttachmentList, { props: { attachments: [attachment('1', { scanStatus: 'failed', access: 'blocked', scanFailure: 'unavailable', url: null })] } })

    expect(wrapper.text()).toContain('not scanned, the scanner was not available')
    expect(wrapper.get('button[aria-label="Download unavailable: not scanned"]').attributes('disabled')).toBeDefined()
  })

  it('counts every attachment', () => {
    const wrapper = mount(AttachmentList, { props: { attachments: [attachment('1'), attachment('2', { scanStatus: 'infected', access: 'blocked', scanSignature: 'X', url: null })] } })

    expect(wrapper.get('h2').text()).toBe('2 attachments')
  })
})
