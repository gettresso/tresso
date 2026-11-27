import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { compileStyle, parse } from 'vue/compiler-sfc'
import { createMemoryHistory, createRouter } from 'vue-router'
import SettingsLayout from '../SettingsLayout.vue'
import source from '../SettingsLayout.vue?raw'

/** The layout's style compiled the way the build does, as its rules: selector and declarations (@media included). */
function compiledRules(): { selector: string; body: string }[] {
  const { descriptor } = parse(source, { filename: 'SettingsLayout.vue' })
  const results = descriptor.styles.map((style) => compileStyle({ source: style.content, filename: 'SettingsLayout.vue', id: 'data-v-test', scoped: style.scoped }))
  expect(results.flatMap((result) => result.errors)).toEqual([])
  const css = results
    .map((result) => result.code)
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) =>
    match[1]!
      .split(/,(?![^(]*\))/)
      .map((selector) => ({ selector: selector.trim(), body: match[2]!.replace(/\s+/g, ' ').trim() })),
  )
}

/** The declarations of the first compiled rule with this exact selector. */
function rule(selector: string): string {
  const found = compiledRules().find((candidate) => candidate.selector === selector)
  if (!found) {
    throw new Error(`No compiled rule ${selector}`)
  }
  return found.body
}

/** The settings shell: one surface, a quiet menu under a small heading, the page beside it. */
describe('Settings navigation', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => (document.body.innerHTML = ''))

  async function at(path: string) {
    const stub = { template: '<div />' }
    const names = [
      'accounts',
      'accounts/new',
      'signatures',
      'smart-inboxes',
      'notifications',
      'batches',
      'brief',
      'calendar',
      'apps',
      'apps/assistants',
      'apps/activity',
      'meeting-apps',
      'access-tokens',
      'connected-apps',
      'updates',
      'billing',
      'whatsapp',
      'whatsapp/connect',
    ]
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/settings',
          component: SettingsLayout,
          children: [
            ...names.map((name) => ({ path: name, name: `settings-${name.replace('/', '-')}`, component: stub })),
            { path: 'accounts/import/:importId?', name: 'settings-accounts-import', component: stub },
            { path: 'smart-inboxes/:smartInboxId', name: 'settings-smart-inbox', component: stub },
          ],
        },
      ],
    })
    await router.push(path)
    const wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router] } })
    await flushPromises()
    return wrapper
  }

  /** Each marked entry with its aria-current. */
  const marked = (wrapper: Awaited<ReturnType<typeof at>>) => wrapper.findAll('nav a[aria-current]').map((link) => [link.text(), link.attributes('aria-current')])

  it('has Apps where Meeting apps, Access tokens and Connected apps were, and the other entries in their order', async () => {
    const wrapper = await at('/settings/accounts')
    expect(wrapper.findAll('nav a').map((link) => link.text())).toEqual(['Accounts', 'Signatures', 'Smart inboxes', 'Notifications', 'Batched delivery', 'Daily brief', 'Calendar', 'Apps'])
    expect(wrapper.get('nav a[href="/settings/apps"]').text()).toBe('Apps')
  })

  it('heads the menu with a Settings heading, the only one the layout renders', async () => {
    const wrapper = await at('/settings/accounts')
    const nav = wrapper.get('nav[aria-label="Settings"]')
    const heading = nav.element.firstElementChild!
    expect({ tag: heading.tagName, text: heading.textContent, class: heading.className, hidden: heading.getAttribute('aria-hidden') }).toEqual({ tag: 'H1', text: 'Settings', class: 'label', hidden: null })
    expect(wrapper.findAll('h1')).toHaveLength(1)
  })

  it('renders no frame title, so the desktop title strip stays empty', async () => {
    const wrapper = await at('/settings/accounts')
    expect(wrapper.findComponent({ name: 'FrameTitle' }).exists()).toBe(false)
    expect(source).not.toMatch(/FrameTitle|Teleport/)
  })

  it('marks the page the user is on as the page, and only that one', async () => {
    for (const [path, entry] of [
      ['/settings/accounts', 'Accounts'],
      ['/settings/signatures', 'Signatures'],
      ['/settings/smart-inboxes', 'Smart inboxes'],
      ['/settings/calendar', 'Calendar'],
      ['/settings/apps', 'Apps'],
    ] as const) {
      const wrapper = await at(path)
      expect({ path, marked: marked(wrapper) }).toEqual({ path, marked: [[entry, 'page']] })
      wrapper.unmount()
    }
  })

  it('marks Apps as the current section on every page under it, old addresses included', async () => {
    for (const path of ['/settings/apps/assistants', '/settings/apps/activity', '/settings/meeting-apps', '/settings/access-tokens']) {
      const wrapper = await at(path)
      expect({ path, marked: marked(wrapper) }).toEqual({ path, marked: [['Apps', 'true']] })
      wrapper.unmount()
    }
  })

  it('marks Accounts as the current section on adding accounts and on the WhatsApp pages', async () => {
    for (const path of [
      '/settings/accounts/new',
      '/settings/accounts/import/0190b4a0-0000-7000-8000-000000000000',
      '/settings/accounts/import',
      '/settings/whatsapp',
      '/settings/whatsapp/connect',
    ]) {
      const wrapper = await at(path)
      expect({ path, marked: marked(wrapper) }).toEqual({ path, marked: [['Accounts', 'true']] })
      wrapper.unmount()
    }
  })

  it('marks Smart inboxes as the current section on one smart inbox', async () => {
    const wrapper = await at('/settings/smart-inboxes/0190b4a0-0000-7000-8000-000000000001')
    expect(marked(wrapper)).toEqual([['Smart inboxes', 'true']])
  })

  it('does not mark Apps elsewhere', async () => {
    const wrapper = await at('/settings/calendar')
    expect(wrapper.get('nav a[href="/settings/apps"]').attributes('aria-current')).toBeUndefined()
  })

  it('shows the page beside the menu, in one group', async () => {
    const wrapper = await at('/settings/accounts')
    const group = wrapper.get('.settings > .group')
    expect([...group.element.children].map((child) => child.tagName)).toEqual(['NAV', 'MAIN'])
  })

  it('widens the group on the five pages designed wider, and only there', async () => {
    const wide = ['/settings/apps', '/settings/apps/assistants', '/settings/apps/activity', '/settings/signatures', '/settings/smart-inboxes']
    const measure = [
      '/settings/accounts',
      '/settings/accounts/new',
      '/settings/whatsapp',
      '/settings/smart-inboxes/0190b4a0-0000-7000-8000-000000000001',
      '/settings/notifications',
      '/settings/batches',
      '/settings/brief',
      '/settings/calendar',
      '/settings/meeting-apps',
      '/settings/access-tokens',
      '/settings/updates',
      '/settings/billing',
    ]
    for (const path of [...wide, ...measure]) {
      const wrapper = await at(path)
      expect({ path, wide: wrapper.get('.group').classes().includes('wide') }).toEqual({ path, wide: wide.includes(path) })
      wrapper.unmount()
    }
  })
})

/** The look of the shell (the "Settings: accounts" board), from the tokens so that dark mode follows. */
describe('Settings surface', () => {
  it('paints one surface, with no glass panel, band or line', () => {
    expect(rule('.settings[data-v-test]')).toContain('background: var(--stage);')
    expect(source).not.toMatch(/--surface|--glass|backdrop-filter|border-left/)
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
  })

  it('starts under the desktop title strip on Settings alone, and paints the strip with the same surface', () => {
    const rules = compiledRules()
    // The 52 from the top is the strip in the desktop app: only this view's root drops it, never the whole document.
    expect(rule('.frame-shell .settings[data-v-test]')).toBe('padding-top: 0;')
    expect(rules.filter((candidate) => /^(\.frame-shell|html|:root|body)[^\s>+~]*$/.test(candidate.selector))).toEqual([])
    // The strip is AppShell's: its column takes the stage, only while it holds Settings.
    expect(rule(':root .app.frame-shell > .stage:has(> .settings)')).toBe('background: var(--stage);')
    expect(rules.filter((candidate) => !candidate.selector.startsWith('@') && !candidate.selector.includes('[data-v-test]')).map((candidate) => candidate.selector)).toEqual([':root .app.frame-shell > .stage:has(> .settings)'])
  })

  it('centres a 184 wide menu and the page at the reading width, 40 apart, or at 960 on a wide page', () => {
    const group = rule('.group[data-v-test]')
    expect(group).toContain('--settings-page-width: var(--measure);')
    expect(group).toContain('gap: 40px;')
    expect(group).toContain('max-width: calc(184px + 40px + var(--settings-page-width));')
    expect(group).toContain('margin: 0 auto;')
    expect(rule('.group.wide[data-v-test]')).toBe('--settings-page-width: 960px;')
    expect(rule('.nav[data-v-test]')).toContain('flex: 0 0 184px;')
    expect(rule('.content[data-v-test]')).toContain('max-width: var(--settings-page-width);')
  })

  it('draws rows 32 high on the row radius, the current one as a quiet pill', () => {
    expect(rule('.item[data-v-test]')).toContain('min-height: 32px;')
    expect(rule('.item[data-v-test]')).toContain('border-radius: var(--radius-row);')
    expect(rule('.item[data-v-test]:hover')).toContain('background: var(--ground);')
    expect(rule('.item[aria-current][data-v-test]')).toContain('background: var(--pill-quiet);')
    expect(rule('.item[aria-current][data-v-test]:hover')).toContain('background: var(--pill-quiet);')
    expect(rule('.label[data-v-test]')).toContain('font-size: 12px;')
    expect(rule('.label[data-v-test]')).toContain('color: var(--ink-2);')
  })
})
