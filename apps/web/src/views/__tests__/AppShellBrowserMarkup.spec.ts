import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { SqliteMailStore } from '@tresso/core'
import { memorySql } from '@tresso/core/testing/sql'
import { useAuthStore } from '@/stores/auth'
import { useBatchesStore } from '@/stores/batches'
import { useChatsStore } from '@/stores/chats'
import { useMailStore } from '@/stores/mail'
import { ACCOUNT_ID, FakeChatServer } from '@/stores/__tests__/chatServerFixture'
import AppShell from '@/views/AppShell.vue'

/**
 * The browser build (app.gettresso.com) keeps its sidebar and shell exactly as they were before the desktop window
 * frame: the snapshot was recorded from the shell before the frame existed, so any change to the browser's markup or
 * classes shows up here. The desktop frame lives in its own classes and elements, which the browser never renders.
 */
const screen = (name: string) => ({ template: `<section class="screen">${name}</section>` })

describe('the shell in the browser', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setActivePinia(createPinia())
    vi.spyOn(useBatchesStore(), 'load').mockResolvedValue()
  })

  it('renders the sidebar and the stage with the markup and classes it had before the desktop frame', async () => {
    expect(await render(null)).toMatchSnapshot()
  })

  it('adds the WhatsApp row for a user whose chats a Mac relays to the server', async () => {
    const server = new FakeChatServer()
    await server.connect({ deviceId: 'other-device', deviceName: "Kim's MacBook Pro", address: '31698765432', displayName: 'Kim', includeGroups: true, notify: false })
    await server.relayMessages(ACCOUNT_ID, {
      deviceId: 'other-device',
      firstImport: false,
      chats: [{ jid: '31612345678@s.whatsapp.net', name: 'Bram Visser', kind: 'direct' }],
      messages: [{ chatJid: '31612345678@s.whatsapp.net', waId: 'S1', fromMe: false, sender: null, text: 'Can you bring the drill?', sentAt: new Date().toISOString(), media: null }],
    })
    const copy = await SqliteMailStore.open(await memorySql())
    await server.deliver(copy)
    const markup = await render(copy)
    expect(markup).toContain('2 mail accounts, WhatsApp')
    expect(markup).toContain('+31698765432, via Kim')
    expect(markup).toMatchSnapshot()
  })

  /** The shell in the browser with two mail accounts, and the copy (null: none open) the chats come from. */
  async function render(copy: SqliteMailStore | null): Promise<string> {
    useAuthStore().tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/',
          component: AppShell,
          children: [
            { path: '', name: 'unified', component: screen('Inbox') },
            { path: 'accounts/:accountId', name: 'account', component: screen('Account') },
            { path: 'smart/:smartInboxId', name: 'smart-inbox', component: screen('Smart inbox') },
            { path: 'batches', name: 'batches', component: screen('Batches') },
            { path: 'cleanup', name: 'cleanup', component: screen('Clean up') },
            { path: 'brief', name: 'brief', component: screen('Daily brief') },
            { path: 'todos', name: 'todos', component: screen('Todos') },
            { path: 'waiting', name: 'waiting', component: screen('Waiting on') },
            { path: 'calendar', name: 'calendar', component: screen('Calendar') },
            { path: 'triage', name: 'triage', component: screen('Triage') },
            { path: 'drafts', name: 'drafts', component: screen('Drafts') },
            { path: 'outbox', name: 'outbox', component: screen('Outbox') },
            { path: 'whatsapp', name: 'whatsapp', component: screen('WhatsApp') },
            { path: 'settings/accounts', name: 'settings-accounts', component: screen('Accounts settings') },
            { path: 'settings/accounts/new', name: 'settings-accounts-new', component: screen('Add account') },
            { path: 'settings/smart-inboxes/:smartInboxId', name: 'settings-smart-inbox', component: screen('Smart inbox settings') },
          ],
        },
      ],
    })
    await router.push('/')
    const wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router] } })
    const mail = useMailStore()
    const account = { emailAddress: 'kim@company.example', provider: 'imap', statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null }
    mail.accounts = [
      { ...account, id: 'work', displayName: 'Work', status: 'auth_failed' },
      { ...account, id: 'home', displayName: 'Home', emailAddress: 'kim@mail.example', status: 'active' },
    ]
    mail.smartInboxes = [{ id: 'news', builtin: null, name: 'Newsletters', instructions: '', includeSenders: [], excludeSenders: [], verdict: 'know', autoCreateTodo: false, position: 0 }]
    if (copy !== null) {
      vi.spyOn(mail, 'currentStore').mockReturnValue(copy)
      mail.ready = true
      const chats = useChatsStore()
      await vi.waitFor(() => {
        if (chats.unread !== 1) {
          throw new Error('The chats are not read yet.')
        }
      })
    }
    await flushPromises()

    // Vue's placeholders for elements that are not rendered (<!--v-if-->) are no markup; they are left out, so a
    // desktop-only element adds nothing here.
    const markup = wrapper
      .html()
      .replace(/<!--[^]*?-->/g, '')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .join('\n')
    wrapper.unmount()
    return markup
  }
})
