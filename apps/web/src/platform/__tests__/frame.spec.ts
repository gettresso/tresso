import { describe, expect, it, vi } from 'vitest'
import frameCss from '@/assets/frame.css?raw'
import mainCss from '@/assets/main.css?raw'
import frameScroll from '@/components/FrameScroll.vue?raw'
import sidebar from '@/components/MailboxSidebar.vue?raw'
import appShell from '@/views/AppShell.vue?raw'
import { SIDEBAR_DEFAULT, SIDEBAR_KEY, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebarWidth, frameToken, readSidebarLayout, writeSidebarLayout } from '../frame'

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

/** `rgb(r g b / a%)` laid over the solid #rrggbb under it, as #rrggbb. */
function over(rgba: string, under: string): string {
  const [, r, g, b, alpha] = /^rgb\((\d+) (\d+) (\d+) \/ (\d+(?:\.\d+)?)%\)$/.exec(rgba)!.map(Number)
  const a = alpha! / 100
  return `#${[r!, g!, b!]
    .map((channel, index) => {
      const base = Number.parseInt(under.slice(1 + index * 2, 3 + index * 2), 16)
      return Math.round(a * channel + (1 - a) * base)
        .toString(16)
        .padStart(2, '0')
    })
    .join('')}`
}

/** The first block of frame.css's dark appearance. */
function darkBlock(): string {
  const dark = frameCss.slice(frameCss.indexOf('@media (prefers-color-scheme: dark)'))
  return dark.slice(0, dark.indexOf('\n}\n'))
}

const block = (source: string, selector: string) => source.slice(source.indexOf(`${selector} {`), source.indexOf('}', source.indexOf(`${selector} {`)))

/** A token of main.css: its light value (the first), or the one its dark block gives it. */
function mainToken(name: string, theme: 'light' | 'dark' = 'light'): string {
  const source = theme === 'light' ? mainCss : mainCss.slice(mainCss.indexOf('@media (prefers-color-scheme: dark)'))
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(source)
  if (match === null) {
    throw new Error(`main.css has no ${theme} ${name}`)
  }
  return match[1]!
}

describe('the frame tokens (assets/frame.css)', () => {
  it('give the sidebar 190 to 300, 220 by default, read from the stylesheet', () => {
    expect([SIDEBAR_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX]).toEqual([190, 220, 300])
    expect(frameToken('frame-sidebar-motion', 0, 'ms')).toBe(220)
  })

  it('has every token the code reads, and a missing one falls back to the spec value instead of stopping the app', () => {
    // Everything the app reads at load (platform/frame.ts, AppShell.vue), as written in frame.css.
    for (const token of ['--frame-sidebar-min: 190px;', '--frame-sidebar-default: 220px;', '--frame-sidebar-max: 300px;', '--frame-sidebar-motion: 220ms;', '--frame-card-radius: 18px;']) {
      expect(frameCss).toContain(token)
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(frameToken('frame-sidebar-min', 190, 'px', ':root {}')).toBe(190)
    expect(error).toHaveBeenCalledWith('frame.css has no --frame-sidebar-min in px; using 190px')
    error.mockRestore()
  })

  it('put the spec measurements where the spec measured them, at the default width', () => {
    // NaN as the fallback: a missing token fails these sums instead of passing with the spec's own number.
    const t = (name: string) => frameToken(name, Number.NaN)
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

  it('end the window\'s drag strip where the scrolling rows start, so no row drags the window', () => {
    const t = (name: string) => frameToken(name, Number.NaN)
    expect(block(appShell, '.frame-sidebar-drag')).toContain('height: calc(var(--frame-first-row-y) - var(--frame-scroll-inset));')
    // The card's top padding plus the card's inset: the scroller starts at the same y, under the card's 32 high band.
    expect(block(sidebar, '.frame-shell .sidebar')).toContain('padding: calc(var(--frame-first-row-y) - var(--frame-inset) - var(--frame-scroll-inset))')
    expect(t('frame-first-row-y') - t('frame-scroll-inset')).toBe(40)
    expect(t('frame-first-row-y') - t('frame-inset') - t('frame-scroll-inset')).toBe(32)
    // The scroller's own padding brings the first row back to y 52.
    expect(block(sidebar, '.frame-shell .frame-scroll')).toContain('padding: var(--frame-scroll-inset) var(--frame-row-inset);')
    expect(t('frame-first-row-y') - t('frame-scroll-inset') + t('frame-scroll-inset')).toBe(52)
    // Compose keeps its 40 when the rows overflow.
    expect(block(sidebar, '.frame-shell .compose')).toContain('flex: none;')
  })

  it('change only colours in dark mode, never a size, radius or position', () => {
    const dark = frameCss.slice(frameCss.indexOf('@media (prefers-color-scheme: dark)'))
    const block = dark.slice(0, dark.indexOf('\n}\n'))
    const names = [...block.matchAll(/(--frame-[a-z-]+):/g)].map((match) => match[1])
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(name).toMatch(/fill|edge|shadow/)
    }
  })

  it('hold the values of the glass sidebar board', () => {
    const t = (name: string) => frameToken(name, Number.NaN)
    expect(t('frame-scroll-inset')).toBe(12)
    expect(t('frame-group-label-size')).toBe(12)
    for (const token of [
      '--frame-card-solid-fill: #fcfcfc;',
      '--frame-card-fill: var(--frame-card-solid-fill);',
      '--frame-card-edge: inset 0 1px 0 rgb(255 255 255 / 90%), inset 0 0 0 1px rgb(255 255 255 / 55%);',
      '--frame-card-shadow: 0 0 0 1px rgb(22 24 29 / 6%), 0 1px 2px rgb(22 24 29 / 5%), 0 8px 24px rgb(22 24 29 / 8%);',
      '--frame-selection-fill: var(--pill);',
      '--frame-selection-edge: var(--pill-edge);',
    ]) {
      expect(frameCss).toContain(token)
    }
    // Over the glass the light card keeps its 72%; the dark one is a tint of its own, and solid --paper without glass.
    expect(frameCss).toMatch(/html\.vibrant \{\s*--frame-window-fill: transparent;\s*--frame-card-fill: rgb\(255 255 255 \/ 72%\);\s*\}/)
    const dark = darkBlock()
    for (const token of ['--frame-card-solid-fill: var(--paper);', '--frame-card-edge: var(--glass-edge);', '--frame-card-shadow: 0 0 0 1px rgb(0 0 0 / 45%), 0 8px 24px rgb(0 0 0 / 35%);']) {
      expect(dark).toContain(token)
    }
    expect(dark).toMatch(/html\.vibrant \{\s*--frame-card-fill: rgb\(32 36 45 \/ 60%\);\s*\}/)
    // The selected row keeps the pill in the dark too: main.css gives --pill and --pill-edge their dark values.
    expect(dark).not.toContain('--frame-selection-')
    // "Reduce transparency" turns the card solid in either appearance.
    expect(frameCss).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\s*html\.vibrant \{\s*--frame-card-fill: var\(--frame-card-solid-fill\);/)
    expect(frameCss).toMatch(/html\.vibrant\.reduce-transparency \{\s*--frame-card-fill: var\(--frame-card-solid-fill\);\s*\}/)
  })

  it('draw the selected row as the glass pill, never an accent fill, and keep its text readable on it', () => {
    // No accent colour and no white text for the selected row, with or without focus in the sidebar.
    for (const source of [frameCss, sidebar]) {
      expect(source).not.toMatch(/frame-selection-(accent|text)|frame-accent-(light|dark)|\.sidebar\.active/)
    }
    expect(block(sidebar, ".frame-shell .item[aria-current='page']")).toContain('background: var(--frame-selection-fill);')
    expect(block(sidebar, ".frame-shell .item[aria-current='page']")).toContain('box-shadow: var(--frame-selection-edge);')
    // The pill over the solid card: the label (ink) and the count and address (the second ink) on it, in both themes.
    const light = over(mainToken('pill'), /--frame-card-solid-fill: (#[0-9a-f]{6});/.exec(frameCss)![1]!)
    expect(contrast(mainToken('ink'), light)).toBeGreaterThanOrEqual(14.7)
    expect(contrast(mainToken('ink-2'), light)).toBeGreaterThanOrEqual(6.7)
    // In the dark the solid card is --paper (the dark block above checks it), and the pill a tint of white over it.
    expect(darkBlock()).toContain('--frame-card-solid-fill: var(--paper);')
    const dark = over(mainToken('pill', 'dark'), mainToken('paper', 'dark'))
    expect(contrast(mainToken('ink', 'dark'), dark)).toBeGreaterThanOrEqual(11.2)
    expect(contrast(mainToken('ink-2', 'dark'), dark)).toBeGreaterThanOrEqual(6.7)
  })

  it('fade the rows out at both ends of the scroller over the scroll inset, with a mask and no script', () => {
    const fade = 'linear-gradient(to bottom, transparent 0, #000 var(--frame-scroll-inset), #000 calc(100% - var(--frame-scroll-inset)), transparent 100%);'
    expect(block(frameScroll, '.frame-scroll')).toContain(`-webkit-mask-image: ${fade}`)
    expect(block(frameScroll, '.frame-scroll')).toContain(`\n  mask-image: ${fade}`)
    expect(frameScroll).not.toMatch(/addEventListener|@scroll|onScroll/)
    // A row the keyboard brings into view stops past the fade, so its focus ring is never faded.
    expect(block(sidebar, '.frame-shell .frame-scroll')).toContain('scroll-padding-block: var(--frame-scroll-inset);')
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
