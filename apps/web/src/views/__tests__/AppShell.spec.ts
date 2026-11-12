import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useBatchesStore } from '@/stores/batches'
import { useMailStore } from '@/stores/mail'
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

  it('marks an account whose sign-in failed, with a link to where it is fixed', async () => {
    useAuthStore().tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 }
    const router = makeRouter()
    await router.push('/')
    const wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router] } })
    const account = { emailAddress: 'kim@company.example', provider: 'imap', statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null }
    useMailStore().accounts = [
      { ...account, id: 'work', displayName: 'Work', status: 'auth_failed' },
      { ...account, id: 'home', displayName: 'Home', emailAddress: 'kim@mail.example', status: 'active' },
    ]
    await flushPromises()

    const [work, home] = wrapper.findAll('nav.sidebar .account-row')
    expect(work!.get('.account-address').text()).toBe('Sign-in failed')
    expect(work!.get('.account-address').classes()).toContain('problem')
    expect(work!.get('a.fix').attributes('href')).toBe('/settings/accounts')
    expect(home!.get('.account-address').classes()).not.toContain('problem')
    expect(home!.find('a.fix').exists()).toBe(false)
  })

  describe('signing out with drafts that never reached the server', () => {
    async function signedIn() {
      useAuthStore().tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 }
      const signOut = vi.spyOn(useAuthStore(), 'signOut').mockResolvedValue()
      const router = makeRouter()
      await router.push('/')
      const wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router] } })
      await flushPromises()
      const button = (label: string) => wrapper.findAll('button').find((candidate) => candidate.text() === label)!
      return { wrapper, signOut, button }
    }
    const unsent = (id: string) => ({ id, pendingSave: true }) as Awaited<ReturnType<ReturnType<typeof useMailStore>['unsavedDrafts']>>[number]

    it('signs out at once when every draft is on the server', async () => {
      const { wrapper, signOut } = await signedIn()
      vi.spyOn(useMailStore(), 'unsavedDrafts').mockResolvedValue([])

      await wrapper.get('nav.sidebar .sign-out').trigger('click')
      await flushPromises()

      expect(signOut).toHaveBeenCalledOnce()
      expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    })

    it('asks first, and stays signed in on Cancel', async () => {
      const { wrapper, signOut, button } = await signedIn()
      vi.spyOn(useMailStore(), 'unsavedDrafts').mockResolvedValue([unsent('d1'), unsent('d2')])

      await wrapper.get('nav.sidebar .sign-out').trigger('click')
      await flushPromises()

      expect(wrapper.get('[role="alertdialog"]').text()).toContain('2 drafts on this device were never saved to the server. Sign out and delete them?')
      await button('Cancel').trigger('click')
      await flushPromises()
      expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
      expect(signOut).not.toHaveBeenCalled()
    })

    it('signs out anyway when the user says so', async () => {
      const { wrapper, signOut, button } = await signedIn()
      vi.spyOn(useMailStore(), 'unsavedDrafts').mockResolvedValue([unsent('d1')])

      await wrapper.get('nav.sidebar .sign-out').trigger('click')
      await flushPromises()
      expect(wrapper.get('[role="alertdialog"]').text()).toContain('1 draft on this device was never saved to the server. Sign out and delete it?')
      await button('Sign out anyway').trigger('click')
      await flushPromises()

      expect(signOut).toHaveBeenCalledOnce()
    })

    it('tries to save them first, and signs out once they reached the server', async () => {
      const { wrapper, signOut, button } = await signedIn()
      vi.spyOn(useMailStore(), 'unsavedDrafts').mockResolvedValue([unsent('d1'), unsent('d2')])
      const save = vi.spyOn(useMailStore(), 'saveUnsavedDrafts').mockResolvedValue([])

      await wrapper.get('nav.sidebar .sign-out').trigger('click')
      await flushPromises()
      await button('Try to save them first').trigger('click')
      await flushPromises()

      expect(save).toHaveBeenCalledWith(15_000)
      expect(signOut).toHaveBeenCalledOnce()
    })

    it('asks again when saving did not bring them all up, and does not sign out by itself', async () => {
      const { wrapper, signOut, button } = await signedIn()
      vi.spyOn(useMailStore(), 'unsavedDrafts').mockResolvedValue([unsent('d1'), unsent('d2')])
      vi.spyOn(useMailStore(), 'saveUnsavedDrafts').mockResolvedValue([unsent('d2')])

      await wrapper.get('nav.sidebar .sign-out').trigger('click')
      await flushPromises()
      await button('Try to save them first').trigger('click')
      await flushPromises()

      const dialog = wrapper.get('[role="alertdialog"]')
      expect(dialog.text()).toContain('1 draft on this device was never saved to the server.')
      expect(dialog.get('[role="alert"]').text()).toBe('Saving did not work for all of them. Try again once you are online, or sign out anyway.')
      expect(signOut).not.toHaveBeenCalled()
    })
  })
})
