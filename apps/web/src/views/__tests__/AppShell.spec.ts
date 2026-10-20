import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useBatchesStore } from '@/stores/batches'
import AppShell from '@/views/AppShell.vue'

const screen = (name: string) => ({ template: `<section class="screen">${name}</section>` })

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        component: AppShell,
        children: [
          { path: '', name: 'unified', component: screen('Inbox') },
          { path: 'inbox/:threadId', name: 'unified-thread', component: screen('Inbox') },
          { path: 'accounts/:accountId', name: 'account', component: screen('Account') },
          { path: 'smart/:smartInboxId', name: 'smart-inbox', component: screen('Smart inbox') },
          { path: 'batches', name: 'batches', component: screen('Batches') },
          { path: 'cleanup', name: 'cleanup', component: screen('Clean up') },
          { path: 'brief', name: 'brief', component: screen('Daily brief') },
          { path: 'todos', name: 'todos', component: screen('Todos') },
          { path: 'todos/:todoId', name: 'todo', component: screen('Todo') },
          { path: 'waiting', name: 'waiting', component: screen('Waiting on') },
          { path: 'calendar', name: 'calendar', component: screen('Calendar') },
          { path: 'triage', name: 'triage', component: screen('Triage') },
          { path: 'drafts', name: 'drafts', component: screen('Drafts') },
          { path: 'outbox', name: 'outbox', component: screen('Outbox') },
          {
            path: 'settings',
            component: { template: '<RouterView />' },
            children: [
              { path: 'accounts', name: 'settings-accounts', component: screen('Accounts settings') },
              { path: 'accounts/new', name: 'settings-accounts-new', component: screen('Add account') },
              { path: 'smart-inboxes/:smartInboxId', name: 'settings-smart-inbox', component: screen('Smart inbox settings') },
            ],
          },
        ],
      },
    ],
  })
}

describe('AppShell', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setActivePinia(createPinia())
    vi.spyOn(useBatchesStore(), 'load').mockResolvedValue()
  })

  it('offers sign in when signed out, without the sidebar', async () => {
    const router = makeRouter()
    await router.push('/')
    const wrapper = mount(AppShell, { global: { plugins: [router] } })
    await flushPromises()

    expect(wrapper.text()).toContain('Sign in')
    expect(wrapper.find('nav.sidebar').exists()).toBe(false)
  })

  it('keeps the same sidebar on every screen and marks the one on screen', async () => {
    useAuthStore().tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 }
    const router = makeRouter()
    await router.push('/')
    const wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router] } })
    await flushPromises()
    const sidebar = wrapper.get('nav.sidebar').element

    const marked = async (path: string): Promise<string | undefined> => {
      await router.push(path)
      await flushPromises()
      // The sidebar is not built again: it is the very same element, so it never blinks or loses its scroll.
      expect(wrapper.get('nav.sidebar').element).toBe(sidebar)
      return wrapper.find('nav.sidebar .item[aria-current="page"]').text() || undefined
    }

    expect(await marked('/')).toContain('Unified Inbox')
    expect(await marked('/todos')).toContain('Todos')
    expect(await marked('/todos/t1')).toContain('Todos')
    expect(await marked('/calendar')).toContain('Calendar')
    expect(await marked('/triage')).toContain('Triage')
    expect(await marked('/drafts')).toContain('Drafts')
    expect(await marked('/brief')).toContain('Daily brief')
    expect(await marked('/waiting')).toContain('Waiting on')
    expect(await marked('/cleanup')).toContain('Clean up')
    expect(await marked('/settings/accounts')).toContain('Settings')
    expect(wrapper.get('.stage').text()).toBe('Accounts settings')
    expect(wrapper.findAll('nav.sidebar .item[aria-current="page"]')).toHaveLength(1)
  })
})
