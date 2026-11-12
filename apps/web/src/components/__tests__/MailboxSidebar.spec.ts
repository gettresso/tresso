import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describeSync, type SyncFacts } from '@tresso/core'
import { useMailStore } from '@/stores/mail'
import MailboxSidebar from '../MailboxSidebar.vue'

const NOW = Date.UTC(2026, 10, 12, 14, 30)
const time = (at: number) => new Date(at).toISOString().slice(11, 16)

function facts(change: Partial<SyncFacts>): SyncFacts {
  return { copy: 'open', confirmed: true, afterUpdate: false, pull: null, origin: null, error: null, stream: 'live', wasLive: true, online: true, lastSyncedAt: NOW - 28 * 60_000, now: NOW, ...change }
}

describe('MailboxSidebar', () => {
  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  function sidebar() {
    return mount(MailboxSidebar, {
      props: { displayName: 'Kim', email: 'kim@example.test', accounts: [], unreadCounts: new Map(), mailbox: null, smartInboxes: [], smartInboxCounts: new Map(), smartInbox: null, batches: false, nextBatch: null },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
  }

  it('says at its foot what the sync is doing, in every state, and no longer "Connecting…" while it pulls', async () => {
    const mail = useMailStore()
    const wrapper = sidebar()
    const states: [Partial<SyncFacts>, string][] = [
      [{ copy: 'opening' }, 'Opening your mail…'],
      [{ confirmed: false, stream: 'off' }, 'Showing mail kept on this device'],
      [{ stream: 'connecting', wasLive: false, pull: { from: 0, cursor: 6200, latest: 10_000, items: 9000, pages: 18, hasMore: true }, origin: 0, lastSyncedAt: null }, 'Getting your mail, 62%'],
      [{ afterUpdate: true, pull: { from: 0, cursor: 2500, latest: 10_000, items: 5000, pages: 10, hasMore: true }, origin: 0 }, 'Updating your mail on this device after the update, 25%'],
      [{ pull: { from: 50_000, cursor: 50_600, latest: 63_000, items: 500, pages: 1, hasMore: true }, origin: 50_000 }, 'Catching up: 12,400 changes to go'],
      [{}, 'Up to date'],
      [{ stream: 'connecting', wasLive: false }, 'Connecting…'],
      [{ stream: 'retrying' }, 'Reconnecting… Last synced 14:02'],
      [{ online: false, stream: 'retrying' }, 'Offline. Last synced 14:02'],
      [{ error: 'Bad gateway' }, 'Sync stopped. Last synced 14:02'],
    ]
    for (const [change, text] of states) {
      mail.syncStatus = describeSync(facts(change), time)
      await wrapper.vm.$nextTick()
      expect(wrapper.get('.sync-status .line').text()).toBe(text)
    }
    expect(wrapper.get('.sync-status [role="status"]').text()).toBe('Sync stopped')
  })
})
