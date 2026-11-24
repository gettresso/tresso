import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import SettingsLayout from '../SettingsLayout.vue'

/** The settings navigation: one Apps entry in place of Meeting apps, Access tokens and Connected apps. */
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

  it('has Apps where Meeting apps, Access tokens and Connected apps were, and the other entries in their order', async () => {
    const wrapper = await at('/settings/accounts')
    expect(wrapper.findAll('nav a').map((link) => link.text())).toEqual(['Accounts', 'Signatures', 'Smart inboxes', 'Notifications', 'Batched delivery', 'Daily brief', 'Calendar', 'Apps'])
    expect(wrapper.get('nav a[href="/settings/apps"]').text()).toBe('Apps')
  })

  it('highlights Apps on every page under it, old addresses included', async () => {
    for (const path of ['/settings/apps', '/settings/apps/assistants', '/settings/apps/activity', '/settings/meeting-apps', '/settings/access-tokens']) {
      const wrapper = await at(path)
      const apps = wrapper.get('nav a[href="/settings/apps"]')
      expect({ path, active: apps.classes().includes('router-link-active'), current: apps.attributes('aria-current') }).toEqual({ path, active: true, current: 'page' })
      expect({ path, active: wrapper.findAll('nav a.router-link-active').map((link) => link.text()) }).toEqual({ path, active: ['Apps'] })
      wrapper.unmount()
    }
  })

  it('highlights Accounts on a list of accounts to add, and Apps on the Apps pages, each alone', async () => {
    let wrapper = await at('/settings/accounts/import/0190b4a0-0000-7000-8000-000000000000')
    expect(wrapper.findAll('nav a.router-link-active').map((link) => link.text())).toEqual(['Accounts'])
    wrapper.unmount()
    wrapper = await at('/settings/apps/activity')
    expect(wrapper.findAll('nav a.router-link-active').map((link) => link.text())).toEqual(['Apps'])
  })

  it('does not highlight Apps elsewhere', async () => {
    const wrapper = await at('/settings/calendar')
    expect(wrapper.get('nav a[href="/settings/apps"]').classes()).not.toContain('router-link-active')
    expect(wrapper.get('nav a[href="/settings/apps"]').attributes('aria-current')).toBeUndefined()
  })
})
