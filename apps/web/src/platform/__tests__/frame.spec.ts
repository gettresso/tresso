import { describe, expect, it, vi } from 'vitest'
import frameCss from '@/assets/frame.css?raw'
import mainCss from '@/assets/main.css?raw'
import sidebar from '@/components/MailboxSidebar.vue?raw'
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_KEY,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  applySelectionAccent,
  clampSidebarWidth,
  followSelectionAccent,
  frameToken,
  readSidebarLayout,
  writeSidebarLayout,
  type SelectionColors,
} from '../frame'

/** WCAG 2 contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

/** A colour token of main.css's light theme. */
function lightToken(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`).exec(mainCss)
  if (match === null) {
    throw new Error(`main.css has no ${name}`)
  }
  return match[1]!
}

describe('the frame tokens (assets/frame.css)', () => {
  it('give the sidebar 190 to 300, 220 by default, read from the stylesheet', () => {
    expect([SIDEBAR_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX]).toEqual([190, 220, 300])
    expect(frameToken('frame-sidebar-motion', 'ms')).toBe(220)
    expect(() => frameToken('frame-nothing')).toThrow('frame.css has no --frame-nothing in px')
  })

  it('put the spec measurements where the spec measured them, at the default width', () => {
    const t = (name: string) => frameToken(name)
    const width = SIDEBAR_DEFAULT
    // Card: 8 in, 202 wide, 10 to the content.
    expect(width - t('frame-inset') - t('frame-sidebar-gap')).toBe(202)
    // Toggle centred at x 187 (13 from the card's right edge to the glyph), y 26.
    expect(width - t('frame-sidebar-gap') - t('frame-toggle-from-card') - t('frame-toggle-glyph-width') / 2).toBe(187)
    expect(t('frame-toggle-y')).toBe(26)
    // Rows from y 52, 32 high; the fill 182 wide from x 18, icon at x 30, label at x 54.
    expect(t('frame-first-row-y')).toBe(52)
    expect(t('frame-row-height')).toBe(32)
    expect(width - t('frame-inset') - t('frame-sidebar-gap') - 2 * t('frame-row-inset')).toBe(182)
    const fill = t('frame-inset') + t('frame-row-inset')
    expect(fill + t('frame-row-icon-x')).toBe(30)
    expect(fill + t('frame-row-icon-x') + t('frame-row-icon') + t('frame-row-label-gap')).toBe(54)
    // Title strip 52, title at x 230; capsules 36 high (y 8 to 44), two icons 70.
    expect(t('frame-title-height')).toBe(52)
    expect(width + t('frame-title-x')).toBe(230)
    expect((t('frame-title-height') - t('frame-capsule-height')) / 2).toBe(8)
    expect(2 * t('frame-capsule-icon')).toBe(70)
    expect(t('frame-capsule-single')).toBe(40)
    expect(t('frame-card-radius')).toBe(26 - t('frame-inset'))
  })

  it('change only colours in dark mode, never a size, radius or position', () => {
    const dark = frameCss.slice(frameCss.indexOf('@media (prefers-color-scheme: dark)'))
    const block = dark.slice(0, dark.indexOf('\n}\n'))
    const names = [...block.matchAll(/(--frame-[a-z-]+):/g)].map((match) => match[1])
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(name).toMatch(/fill|edge|shadow|accent/)
    }
  })

  it('keep the selected row readable: white on the fallback accent, Tresso text on the grey', () => {
    const accent = /--frame-selection-accent: var\(--frame-accent-light, (#[0-9a-f]{6})\)/.exec(frameCss)![1]!
    const grey = /--frame-selection-fill: (#[0-9a-f]{6});/.exec(frameCss)![1]!
    expect(accent).toBe('#0064e1')
    expect(grey).toBe('#dcdcdc')
    expect(contrast('#ffffff', accent)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(lightToken('ink'), grey)).toBeGreaterThanOrEqual(4.5)
    // The "New" badge on the selected row with the accent: the accent on white (MailboxSidebar.vue), the same pair.
    expect(sidebar).toMatch(/\.sidebar\.active \.item\[aria-current='page'\] \.new \{\s*background: var\(--frame-selection-text\);\s*color: var\(--frame-selection-accent\);/)
    expect(contrast(accent, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    // Tresso's own badge colour on the accent would not read.
    expect(contrast(lightToken('know'), accent)).toBeLessThan(2)
    // The counts and the account's address on the selected grey row.
    expect(contrast(lightToken('ink-2'), grey)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('the sidebar layout on this device', () => {
  it('starts shown at the default width, and keeps what the user set across launches', () => {
    const storage = new Map<string, string>()
    const store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) }
    expect(readSidebarLayout(store)).toEqual({ width: 220, shown: true })
    writeSidebarLayout({ width: 260, shown: false }, store)
    expect(storage.get(SIDEBAR_KEY)).toBe('{"width":260,"shown":false}')
    expect(readSidebarLayout(store)).toEqual({ width: 260, shown: false })
  })

  it('reads a damaged or out of range value as the nearest it can take, and survives a storage that refuses', () => {
    const kept = (value: string) => readSidebarLayout({ getItem: () => value })
    expect(kept('{"width":999,"shown":true}')).toEqual({ width: 300, shown: true })
    expect(kept('{"width":12}')).toEqual({ width: 190, shown: true })
    expect(kept('{"width":"wide","shown":"no"}')).toEqual({ width: 220, shown: true })
    expect(kept('not json')).toEqual({ width: 220, shown: true })
    expect(kept('null')).toEqual({ width: 220, shown: true })
    const refusing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('full')
      },
    }
    expect(readSidebarLayout(refusing)).toEqual({ width: 220, shown: true })
    expect(() => writeSidebarLayout({ width: 220, shown: true }, refusing)).not.toThrow()
  })

  it('clamps a width to 190 to 300 in whole pixels', () => {
    expect([clampSidebarWidth(100), clampSidebarWidth(250.6), clampSidebarWidth(400), clampSidebarWidth(Number.NaN)]).toEqual([190, 251, 300, 220])
  })
})

describe('the selection colour from the system', () => {
  it('sets both appearances at launch and reads them again when the window comes back', async () => {
    const root = document.createElement('div')
    const target = new EventTarget()
    let colors: SelectionColors | null = { light: '#0064e1', dark: '#0058d0' }
    const shell = { invoke: vi.fn<(command: 'selection_accent') => Promise<SelectionColors | null>>(async () => colors) }
    followSelectionAccent(shell, root, target as unknown as Window)
    await vi.waitFor(() => expect(root.style.getPropertyValue('--frame-accent-light')).toBe('#0064e1'))
    expect(root.style.getPropertyValue('--frame-accent-dark')).toBe('#0058d0')

    // The user picked purple in System Settings, then came back.
    colors = { light: '#7d2ae8', dark: '#a550e7' }
    target.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(root.style.getPropertyValue('--frame-accent-light')).toBe('#7d2ae8'))
    expect(shell.invoke).toHaveBeenCalledTimes(2)
    expect(shell.invoke).toHaveBeenCalledWith('selection_accent')
  })

  it('leaves the fallback where the system has no colour, and never sets anything but a hex colour', () => {
    const root = document.createElement('div')
    applySelectionAccent({ light: '#0064e1', dark: '#0058d0' }, root)
    applySelectionAccent(null, root)
    expect(root.style.getPropertyValue('--frame-accent-light')).toBe('')
    applySelectionAccent({ light: 'red; background: url(x)', dark: '#0058d0' }, root)
    expect(root.style.getPropertyValue('--frame-accent-light')).toBe('')
    expect(root.style.getPropertyValue('--frame-accent-dark')).toBe('#0058d0')
  })

  it('keeps the colour it has when the shell cannot answer', async () => {
    const root = document.createElement('div')
    root.style.setProperty('--frame-accent-light', '#0064e1')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const check = followSelectionAccent({ invoke: async () => Promise.reject(new Error('gone')) }, root, new EventTarget() as unknown as Window)
    await check()
    expect(root.style.getPropertyValue('--frame-accent-light')).toBe('#0064e1')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
