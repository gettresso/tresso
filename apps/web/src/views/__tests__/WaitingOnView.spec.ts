import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import type { SyncedHandOver, SyncedOutgoingMessage } from '@tresso/core'
import { useHandOversStore } from '@/stores/handOvers'
import { useMailStore } from '@/stores/mail'
import WaitingOnView from '../WaitingOnView.vue'

function handOver(id: string, extra: Partial<SyncedHandOver> = {}): SyncedHandOver {
  return {
    id,
    mailAccountId: 'work',
    messageId: `m-${id}`,
    threadId: `t-${id}`,
    subject: `Subject ${id}`,
    delegate: { address: 'lisa@company.example', name: 'Lisa Bakker' },
    note: 'Can you take this?',
    dueAt: '2026-10-23T15:00:00Z',
    state: 'open',
    forwardId: `f-${id}`,
    overdueAt: null,
    notifiedAt: null,
    notifiedChannels: [],
    notifiedSilently: false,
    nudgedAt: null,
    lastNudgeId: null,
    replyMessageId: null,
    createdAt: '2026-10-20T08:00:00Z',
    closedAt: null,
    updatedAt: '2026-10-20T08:00:00Z',
    ...extra,
  }
}

/** Form validation runs asynchronously; let it finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('WaitingOnView', () => {
  let router: Router
  let mail: ReturnType<typeof useMailStore>
  let handOvers: ReturnType<typeof useHandOversStore>
  const outgoing = new Map<string, SyncedOutgoingMessage>()

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-24T09:00:00Z'))
    setActivePinia(createPinia())
    mail = useMailStore()
    handOvers = useHandOversStore()
    mail.accounts = [{ id: 'work', emailAddress: 'kim@company.example', displayName: 'Work', provider: 'imap', status: 'active', statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown', calendarStatusDetail: null }]
    mail.handOvers = [
      handOver('late', { dueAt: '2026-10-23T15:00:00Z', subject: 'Invoice question' }),
      handOver('nudged', { dueAt: '2026-10-28T15:00:00Z', nudgedAt: '2026-10-22T10:00:00Z', lastNudgeId: 'n1' }),
      handOver('fresh', { dueAt: '2026-10-30T15:00:00Z', delegate: { address: 'tom@company.example', name: null } }),
      handOver('answered', { state: 'replied', closedAt: '2026-10-21T10:00:00Z' }),
    ]
    outgoing.clear()
    outgoing.set('n1', { id: 'n1', mailAccountId: 'work', status: 'sent', subject: 'Re: Fwd', recipients: { to: [], cc: [], bcc: [] }, sendAt: '2026-10-22T10:00:00Z', sentAt: null, lastError: null, inReplyToMessageId: null })
    vi.spyOn(mail, 'thread').mockImplementation(async () => null)
    vi.spyOn(mail, 'outgoing').mockImplementation(async (id) => outgoing.get(id) ?? null)
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'unified', component: { template: '<div />' } },
        { path: '/inbox/:threadId', name: 'unified-thread', component: { template: '<div />' } },
        { path: '/waiting', name: 'waiting', component: WaitingOnView },
        { path: '/drafts', name: 'drafts', component: { template: '<div />' } },
        { path: '/todos', name: 'todos', component: { template: '<div />' } },
        { path: '/brief', name: 'brief', component: { template: '<div />' } },
        { path: '/calendar', name: 'calendar', component: { template: '<div />' } },
        { path: '/cleanup', name: 'cleanup', component: { template: '<div />' } },
        { path: '/triage', name: 'triage', component: { template: '<div />' } },
        { path: '/outbox', name: 'outbox', component: { template: '<div />' } },
        { path: '/settings/accounts', name: 'settings-accounts', component: { template: '<div />' } },
        { path: '/settings/accounts/new', name: 'settings-accounts-new', component: { template: '<div />' } },
        { path: '/settings/smart-inboxes/:smartInboxId', name: 'settings-smart-inbox', component: { template: '<div />' } },
        { path: '/smart/:smartInboxId', name: 'smart-inbox', component: { template: '<div />' } },
        { path: '/accounts/:accountId', name: 'account', component: { template: '<div />' } },
      ],
    })
    await router.push('/waiting')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function mountView(): Promise<ReturnType<typeof mount>> {
    const wrapper = mount(WaitingOnView, { global: { plugins: [router] }, attachTo: document.body })
    await settle()
    return wrapper
  }

  it('lists open hand-overs with their delegate, due date and how they stand, then closed ones', async () => {
    const wrapper = await mountView()

    expect(wrapper.text()).toContain('3 handed over, 1 past due')
    const rows = wrapper.findAll('.waiting .rows')[0]!.findAll('.row')
    expect(rows.map((row) => row.get('.subject').text())).toEqual(['Invoice question', 'Subject nudged', 'Subject fresh'])
    expect(rows.map((row) => row.get('.status').text())).toEqual(['Overdue', expect.stringMatching(/^Nudged /), 'Waiting'])
    expect(rows[2]!.get('.name').text()).toBe('tom@company.example')
    expect(rows[0]!.get('a').attributes('href')).toBe('/inbox/t-late')
    expect(wrapper.findAll('.waiting .rows')[1]!.text()).toContain('Replied')
    wrapper.unmount()
  })

  it('does not count a nudge that was cancelled', async () => {
    outgoing.set('n1', { ...outgoing.get('n1')!, status: 'cancelled' })
    const wrapper = await mountView()

    expect(wrapper.findAll('.row')[1]!.get('.status').text()).toBe('Waiting')
    wrapper.unmount()
  })

  it('drafts a follow-up on Nudge and sends what the user leaves in it', async () => {
    const nudge = vi.spyOn(handOvers, 'nudge').mockImplementation(async () => {})
    const wrapper = await mountView()

    await wrapper.findAll('button.nudge')[0]!.trigger('click')
    await settle()

    expect(router.currentRoute.value.query.nudge).toBe('late')
    const text = wrapper.get('.followup textarea').element as HTMLTextAreaElement
    expect(text.value).toContain('Hi Lisa,')
    expect(text.value).toContain('"Invoice question"')
    expect(text.value).toContain('It was due')
    expect(wrapper.get('.followup').text()).toContain('from kim@company.example')

    await wrapper.get('.followup textarea').setValue('Hi Lisa, any news?')
    await wrapper.get('.followup form.draft').trigger('submit')
    await settle()

    expect(nudge).toHaveBeenCalledWith(expect.objectContaining({ id: 'late' }), 'Hi Lisa, any news?')
    expect(router.currentRoute.value.query.nudge).toBeUndefined()
    wrapper.unmount()
  })

  it('nudges once when Cmd+Enter is pressed again while the first is on its way', async () => {
    let finish!: () => void
    const nudge = vi.spyOn(handOvers, 'nudge').mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
    await router.push({ name: 'waiting', query: { nudge: 'late' } })
    const wrapper = await mountView()

    await wrapper.get('.followup form.draft').trigger('keydown', { key: 'Enter', metaKey: true })
    await wrapper.get('.followup form.draft').trigger('keydown', { key: 'Enter', metaKey: true })
    await settle()
    await wrapper.get('.followup form.draft').trigger('keydown', { key: 'Enter', metaKey: true })
    await settle()

    expect(nudge).toHaveBeenCalledTimes(1)
    finish()
    wrapper.unmount()
  })

  it('opens the follow-up in the composer to edit it first', async () => {
    const editFollowUp = vi.spyOn(handOvers, 'editFollowUp').mockImplementation(async () => {})
    await router.push({ name: 'waiting', query: { nudge: 'late' } })
    const wrapper = await mountView()

    await wrapper.findAll('.followup .buttons button')[1]!.trigger('click')
    await settle()

    expect(editFollowUp).toHaveBeenCalledWith(expect.objectContaining({ id: 'late' }), expect.stringContaining('Hi Lisa,'))
    wrapper.unmount()
  })

  it('stops waiting when the user says so', async () => {
    const markDone = vi.spyOn(handOvers, 'markDone').mockImplementation(async () => true)
    await router.push({ name: 'waiting', query: { nudge: 'fresh' } })
    const wrapper = await mountView()

    await wrapper.findAll('.followup .buttons button')[2]!.trigger('click')
    await settle()

    expect(markDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'fresh' }))
    expect(router.currentRoute.value.query.nudge).toBeUndefined()
    wrapper.unmount()
  })

  it('moves the due date to a day ahead', async () => {
    const reschedule = vi.spyOn(handOvers, 'reschedule').mockImplementation(async () => true)
    await router.push({ name: 'waiting', query: { nudge: 'late' } })
    const wrapper = await mountView()

    await wrapper.get('.move-due input').setValue('2026-10-29')
    await wrapper.get('.move-due').trigger('submit')
    await settle()

    expect(reschedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'late' }), new Date(2026, 9, 29, 17, 0))
    wrapper.unmount()
  })

  it('puts a closed hand-over back', async () => {
    const reopen = vi.spyOn(handOvers, 'reopen').mockImplementation(async () => true)
    const wrapper = await mountView()

    await wrapper.findAll('.waiting .rows')[1]!.get('button').trigger('click')

    expect(reopen).toHaveBeenCalledWith(expect.objectContaining({ id: 'answered' }))
    wrapper.unmount()
  })
})
