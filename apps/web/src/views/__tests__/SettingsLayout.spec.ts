import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import SettingsLayout from '../SettingsLayout.vue'
import source from '../SettingsLayout.vue?raw'

/** The declarations of one rule in the layout's style, by its exact selector. */
function block(selector: string): string {
  const style = source.slice(source.indexOf('<style scoped>'))
  const start = style.indexOf(`\n${selector} {`)
  if (start === -1) {
    throw new Error(`No rule ${selector} in the layout's style`)
  }
  return style.slice(start, style.indexOf('}', start))
}

/** The settings shell: one surface, a quiet menu with a label, the page beside it. */
describe('Settings navigation', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => (document.body.innerHTML = ''))

  async function at(path: string) {
    const stub = { template: '<div />' }
    const names = [
      'accounts',
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
          ],
        },
      ],
    })
    await router.push(path)
    const wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router] } })
    await flushPromises()
    return wrapper
  }

  const current = (wrapper: Awaited<ReturnType<typeof at>>) => wrapper.findAll('nav a[aria-current="page"]').map((link) => link.text())

  it('has Apps where Meeting apps, Access tokens and Connected apps were, and the other entries in their order', async () => {
    const wrapper = await at('/settings/accounts')
    expect(wrapper.findAll('nav a').map((link) => link.text())).toEqual(['Accounts', 'Signatures', 'Smart inboxes', 'Notifications', 'Batched delivery', 'Daily brief', 'Calendar', 'Apps'])
    expect(wrapper.get('nav a[href="/settings/apps"]').text()).toBe('Apps')
  })

  it('puts a small Settings label above the menu instead of a page title', async () => {
    const wrapper = await at('/settings/accounts')
    const nav = wrapper.get('nav[aria-label="Settings"]')
    const label = nav.element.firstElementChild!
    expect({ tag: label.tagName, text: label.textContent, class: label.className, hidden: label.getAttribute('aria-hidden') }).toEqual({ tag: 'SPAN', text: 'Settings', class: 'label', hidden: 'true' })
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(document.querySelector('#frame-title')).toBeNull()
  })

  it('marks the page the user is on, and only that one', async () => {
    for (const [path, entry] of [
      ['/settings/accounts', 'Accounts'],
      ['/settings/signatures', 'Signatures'],
      ['/settings/calendar', 'Calendar'],
      ['/settings/apps', 'Apps'],
    ] as const) {
      const wrapper = await at(path)
      expect({ path, current: current(wrapper) }).toEqual({ path, current: [entry] })
      wrapper.unmount()
    }
  })

  it('marks Apps on every page under it, old addresses included', async () => {
    for (const path of ['/settings/apps', '/settings/apps/assistants', '/settings/apps/activity', '/settings/meeting-apps', '/settings/access-tokens']) {
      const wrapper = await at(path)
      expect({ path, current: current(wrapper) }).toEqual({ path, current: ['Apps'] })
      wrapper.unmount()
    }
  })

  it('marks Accounts on a list of accounts to add and on the WhatsApp pages', async () => {
    for (const path of ['/settings/accounts/import/0190b4a0-0000-7000-8000-000000000000', '/settings/accounts/import', '/settings/whatsapp', '/settings/whatsapp/connect']) {
      const wrapper = await at(path)
      expect({ path, current: current(wrapper) }).toEqual({ path, current: ['Accounts'] })
      wrapper.unmount()
    }
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
})

/** The look of the shell (the "Settings: accounts" board), from the tokens so that dark mode follows. */
describe('Settings surface', () => {
  it('paints one surface, with no glass panel, band or line', () => {
    expect(block('.settings')).toContain('background: var(--stage);')
    expect(source).not.toMatch(/--surface|--glass|backdrop-filter|border-left|FrameTitle/)
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
  })

  it('centres a 184 wide menu and the page at the reading width, 40 apart', () => {
    expect(block('.group')).toContain('gap: 40px;')
    expect(block('.group')).toContain('max-width: calc(184px + 40px + var(--measure));')
    expect(block('.group')).toContain('margin: 0 auto;')
    expect(block('.nav')).toContain('flex: 0 0 184px;')
    expect(block('.content')).toContain('max-width: var(--measure);')
  })

  it('draws rows 32 high on the row radius, the current one as a quiet pill', () => {
    expect(block('.item')).toContain('min-height: 32px;')
    expect(block('.item')).toContain('border-radius: var(--radius-row);')
    expect(block('.item:hover')).toContain('background: var(--ground);')
    expect(block(".item[aria-current='page'],\n.item[aria-current='page']:hover")).toContain('background: var(--pill-quiet);')
    expect(block('.label')).toContain('font-size: 12px;')
    expect(block('.label')).toContain('color: var(--ink-2);')
  })
})
