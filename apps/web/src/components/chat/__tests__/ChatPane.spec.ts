import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { LocalChatBackend, type SqliteMailStore, type SyncedChatOutgoing } from '@tresso/core'
import type { WhatsAppCommands } from '@/platform/whatsapp'
import { at, copyWith, DIRECT, DIRECT_ID, direct, fakeMail, fakeRelay, fakeShell, GROUP, GROUP_ID, group, incoming, LINKED, NOW, STOPPED } from '@/stores/__tests__/chatFixtures'

const fakes = vi.hoisted(() => ({ relay: null as unknown, mail: null as unknown, shell: null as unknown, todos: { create: null as unknown }, selection: { active: false }, compose: { draft: null as unknown, minimized: false, notify: () => undefined } }))
vi.mock('@/stores/whatsappRelay', () => ({ useWhatsAppRelayStore: () => fakes.relay }))
vi.mock('@/stores/mail', () => ({ useMailStore: () => fakes.mail }))
vi.mock('@/stores/todos', () => ({ useTodosStore: () => fakes.todos }))
vi.mock('@/stores/compose', () => ({ useComposeStore: () => fakes.compose }))
vi.mock('@/platform/notifier', () => ({ notifier: null }))
vi.mock('@/stores/selection', () => ({ useSelectionStore: () => fakes.selection }))
vi.mock('@/platform/whatsapp', async (original) => ({
  ...(await original<typeof import('@/platform/whatsapp')>()),
  whatsAppShell: (): Partial<WhatsAppCommands> => {
    const shell = fakes.shell as ReturnType<typeof fakeShell>
    return {
      download: async () => {
        shell.calls.push('download')
        return shell.downloadAnswer()
      },
      openFile: async (path: string) => void shell.calls.push(`open ${path}`),
      chooseFile: async () => shell.chosen,
      send: async (recipient: string, text: string, mediaPath: string | null = null) => {
        shell.sent.push({ recipient, text, mediaPath })
        return shell.sendAnswer()
      },
    }
  },
}))

const { default: ChatPane } = await import('../ChatPane.vue')

describe('ChatPane', () => {
  let relay: ReturnType<typeof fakeRelay>
  let mail: ReturnType<typeof fakeMail>
  let shell: ReturnType<typeof fakeShell>
  let router: Router
  let store: SqliteMailStore
  let wrapper: VueWrapper | null

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    relay = fakeRelay()
    mail = fakeMail()
    shell = fakeShell()
    fakes.relay = relay
    fakes.mail = mail
    fakes.shell = shell
    fakes.selection.active = false
    fakes.compose.draft = null
    fakes.compose.minimized = false
    fakes.todos.create = vi.fn<(todo: { title: string }) => Promise<object>>(async () => ({}))
    setActivePinia(createPinia())
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'unified', component: { template: '<p>List</p>' } },
        { path: '/chats/:chatId', name: 'unified-chat', component: { template: '<p>Chat</p>' } },
        { path: '/settings/whatsapp', name: 'settings-whatsapp', component: { template: '<p>Settings</p>' } },
      ],
    })
    await router.push('/chats/x')
    wrapper = null
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.useRealTimers()
  })

  async function open(chatId: string, copy: SqliteMailStore): Promise<VueWrapper> {
    store = copy
    mail.store = copy
    mail.currentStore = () => mail.store
    wrapper = mount(ChatPane, { props: { chatId, backTo: '/' }, global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  const bubbles = (view: VueWrapper) => view.findAll('.bubbles > li.item')
  const metaOf = (view: VueWrapper) => bubbles(view).map((item) => item.get('.meta').text())

  async function withReply(row: Partial<SyncedChatOutgoing>): Promise<VueWrapper> {
    const copy = await copyWith([direct], [incoming('A1', DIRECT, -10)])
    await copy.putChatOutgoing([{ id: 'r1', chatId: DIRECT_ID, chatAccountId: 'wa:account', text: 'On my way', status: 'waiting', error: null, createdAt: at(-1), claimedAt: null, sentAt: null, ...row }])
    return open(DIRECT_ID, copy)
  }

  it('shows a direct chat as the board does, and reads it', async () => {
    const view = await open(DIRECT_ID, await copyWith([direct], [incoming('A1', DIRECT, -10, { text: 'Hey Kim!\nAre we still on?' }), incoming('A2', DIRECT, -2, { fromMe: true, text: 'Yes' })]))
    expect(view.get('article').attributes('aria-label')).toBe('WhatsApp chat with Bram Visser')
    expect(view.get('h2').text()).toBe('Bram Visser')
    expect(view.get('.subtitle').text()).toBe('+31612345678')
    expect(view.get('.pill').text()).toBe('WhatsApp')
    expect(view.get('.verdict.do').text()).toContain('Do')
    expect(view.get('.verdict.do').attributes('aria-keyshortcuts')).toBe('D')
    expect(view.get('.verdict.know').attributes('aria-keyshortcuts')).toBe('K')
    expect(view.get('[aria-keyshortcuts="E"]').attributes('title')).toBe('Archive (E)')
    expect(view.get('.day').text()).toBe('Today')
    const [theirs, mine] = bubbles(view)
    expect(theirs!.classes()).not.toContain('mine')
    expect(mine!.classes()).toContain('mine')
    expect(theirs!.get('.text').text()).toBe('Hey Kim!\nAre we still on?')
    expect(theirs!.get('[role="group"]').attributes('aria-label')).toMatch(/^Bram Visser, \d{1,2}:\d\d(?: [AP]M)?$/)
    expect(mine!.get('[role="group"]').attributes('aria-label')).toMatch(/^You, \d{1,2}:\d\d(?: [AP]M)?$/)
    expect(view.find('.sender').exists()).toBe(false)
    expect(view.find('.notice').exists()).toBe(false)
    // Focus goes to the chat's name when it opens.
    expect(document.activeElement).toBe(view.get('h2').element)
    expect((await store.chats())[0]!.unread).toBe(0)
  })

  it('shows a group with each sender named above their first bubble in their colour', async () => {
    const view = await open(
      GROUP_ID,
      await copyWith(
        [group],
        [
          incoming('G1', GROUP, -10, { sender: { id: '31611111111', name: 'Mom' }, text: 'Dinner at 18:00 on Sunday?' }),
          incoming('G2', GROUP, -9, { sender: { id: '31611111111', name: 'Mom' }, text: 'At ours' }),
          incoming('G3', GROUP, -8, { sender: { id: '31622222222', name: 'Joost' }, text: 'I can, bringing dessert' }),
          incoming('G4', GROUP, -7, { sender: { id: '999', name: null }, text: 'Hi' }),
        ],
      ),
    )
    expect(view.get('.subtitle').text()).toBe('Group')
    const senders = bubbles(view).map((item) => (item.find('.sender').exists() ? item.get('.sender').text() : null))
    expect(senders).toEqual(['Mom', null, 'Joost', 'Unknown sender'])
    expect(bubbles(view)[1]!.classes()).toContain('grouped')
    expect(bubbles(view)[0]!.get('.sender').classes().some((name) => /^sender-[0-5]$/.test(name))).toBe(true)
    expect(bubbles(view)[2]!.get('[role="group"]').attributes('aria-label')).toMatch(/^Joost, \d{1,2}:\d\d(?: [AP]M)?$/)

    // A name learned later shows for the message stored without it.
    relay.senderNames = new Map([['999', 'Oma']])
    await flushPromises()
    expect(bubbles(view)[3]!.get('.sender').text()).toBe('Oma')
  })

  it('says each reply state as the boards do, with Cancel only while it waits', async () => {
    relay.relayRunning = false
    let view = await withReply({ status: 'waiting' })
    expect(metaOf(view)[1]).toMatch(/^\d{1,2}:\d\d(?: [AP]M)?, waiting for the bridge$/)
    expect(bubbles(view)[1]!.get('.meta').classes()).toContain('waiting')
    expect(bubbles(view)[1]!.findAll('button').map((button) => button.text())).toEqual(['Cancel'])
    view.unmount()

    relay.relayRunning = true
    view = await withReply({ status: 'waiting' })
    expect(metaOf(view)[1]).toMatch(/, sending$/)
    expect(bubbles(view)[1]!.findAll('button')).toEqual([])
    view.unmount()

    view = await withReply({ status: 'sending', claimedAt: at(-1) })
    expect(metaOf(view)[1]).toMatch(/, sending$/)
    expect(bubbles(view)[1]!.findAll('button')).toEqual([])
    view.unmount()

    view = await withReply({ status: 'sent', claimedAt: at(-1), sentAt: at(-1) })
    expect(metaOf(view)[1]).toMatch(/^\d{1,2}:\d\d(?: [AP]M)?, sent$/)
    expect(bubbles(view)[1]!.get('[role="group"]').attributes('aria-label')).toMatch(/^You, \d{1,2}:\d\d(?: [AP]M)?, sent$/)
    view.unmount()

    for (const [error, why] of [
      ['bridge_stopped', 'The bridge is not running.'],
      ['not_linked', 'WhatsApp is not linked.'],
      ['refused', 'WhatsApp refused the message.'],
    ] as const) {
      view = await withReply({ status: 'failed', error })
      const failed = bubbles(view)[1]!
      expect(failed.get('button.meta').text()).toBe('Not sent, click to retry')
      expect(failed.get('.why').text()).toBe(why)
      expect(failed.findAll('.under button').map((button) => button.text())).toEqual(['Try again', 'Delete'])
      view.unmount()
    }

    // Unconfirmed: it may have gone out, so nothing says "not sent" and the meta is no retry button.
    view = await withReply({ status: 'failed', error: 'unconfirmed', claimedAt: at(-1) })
    const unconfirmed = bubbles(view)[1]!
    expect(unconfirmed.get('.meta').text()).toMatch(/^\d{1,2}:\d\d(?: [AP]M)?, not confirmed$/)
    expect(unconfirmed.find('button.meta').exists()).toBe(false)
    expect(unconfirmed.get('.why').text()).toBe('Tresso could not confirm this was sent. Check WhatsApp on your phone before trying again.')
    expect(unconfirmed.findAll('.under button').map((button) => button.text())).toEqual(['Try again', 'Delete'])
    wrapper = view
  })

  it('cancels a waiting reply and tries a failed one again, and says the change', async () => {
    relay.relayRunning = false
    let view = await withReply({ status: 'waiting' })
    await bubbles(view)[1]!.get('.under button').trigger('click')
    await flushPromises()
    expect((await store.chat(DIRECT_ID))!.outgoing[0]!.status).toBe('cancelled')
    expect(bubbles(view)).toHaveLength(1)
    view.unmount()

    view = await withReply({ status: 'failed', error: 'refused' })
    await bubbles(view)[1]!.get('button.meta').trigger('click')
    await flushPromises()
    expect((await store.chat(DIRECT_ID))!.outgoing[0]).toMatchObject({ status: 'waiting', error: null })
    expect(view.get('.composer .visually-hidden[role="status"]').text()).toBe('Waiting for the bridge.')
    wrapper = view
  })

  it('shows the notice that applies, with its action', async () => {
    const start = vi.spyOn(relay, 'start')
    relay.bridge = { ...LINKED, link: 'unlinked' }
    relay.linked = false
    let view = await open(DIRECT_ID, await copyWith([direct], [incoming('A1', DIRECT, -10)]))
    expect(view.get('.notice .text').text()).toBe('WhatsApp is not linked. Until it is linked again nothing comes in or goes out.')
    expect(view.get('.notice button').text()).toBe('Show how')
    expect(view.get('.notice').attributes('role')).toBe('status')
    expect(view.get<HTMLTextAreaElement>('textarea').element.disabled).toBe(true)
    await view.get('.notice button').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('settings-whatsapp')
    view.unmount()

    relay.bridge = STOPPED
    view = await open(DIRECT_ID, store)
    expect(view.get('.notice .text').text()).toBe('The bridge is not running. New messages are not picked up until it runs.')
    expect(view.get('.notice button').text()).toBe('Start again')
    await view.get('.notice button').trigger('click')
    expect(start).toHaveBeenCalled()
    wrapper = view
  })

  it('shows a file row in each state, and refuses a file that is not the message\'s', async () => {
    const photo = { kind: 'image' as const, name: 'image_20261106_101422.jpg', size: 184_320 }
    const view = await open(
      DIRECT_ID,
      await copyWith([direct], [incoming('A1', DIRECT, -10, { text: '', media: photo }), incoming('A2', DIRECT, -9, { text: '', media: photo }), incoming('A3', DIRECT, -8, { text: '', media: photo })]),
    )
    const media = (index: number) => view.findAll('.media')[index]!
    expect(media(0).get('.title').text()).toBe('Photo, 180 KB')
    expect(media(0).get('.line').text()).toBe('Photo, not downloaded')
    expect(view.find('[aria-label="Play voice message"]').exists()).toBe(false)

    let finish!: (file: { path: string; verified: boolean }) => void
    shell.downloadAnswer = () => new Promise((resolve) => (finish = resolve))
    await media(0).get('button').trigger('click')
    await flushPromises()
    expect(media(0).get('.line').text()).toBe('Downloading')
    finish({ path: '/m/abc.jpg', verified: true })
    await flushPromises()
    expect(media(0).get('button').text()).toBe('Open')
    await media(0).get('button').trigger('click')
    await flushPromises()
    expect(shell.calls).toEqual(['download', 'open /m/abc.jpg'])

    shell.downloadAnswer = () => Promise.reject('mismatch')
    await media(1).get('button').trigger('click')
    await flushPromises()
    expect(media(1).get('.line').text()).toBe("WhatsApp gave another file than this message's. It was not opened.")
    expect(media(1).get('.line').attributes('role')).toBe('alert')
    expect(media(1).find('button').exists()).toBe(false)

    shell.downloadAnswer = () => Promise.reject('failed')
    await media(2).get('button').trigger('click')
    await flushPromises()
    expect(media(2).get('.line').text()).toBe('Could not download. The phone that sent it may be offline.')
    expect(media(2).get('button').text()).toBe('Try again')
  })

  it('sends with Enter, never a blank reply, and counts from 3,900 characters', async () => {
    const pollNow = vi.spyOn(relay, 'pollNow')
    const view = await open(DIRECT_ID, await copyWith([direct], [incoming('A1', DIRECT, -10)]))
    expect(view.get('.composer .note').text()).toBe('Sent on WhatsApp from this Mac. No signature, no subject.')
    expect(view.get('textarea').attributes('aria-label')).toBe('Reply to Bram Visser')
    expect(view.find('button[aria-label="Attach a file"]').exists()).toBe(true)

    const field = view.get<HTMLTextAreaElement>('textarea')
    await field.setValue('   ')
    expect(view.get<HTMLButtonElement>('button[type="submit"]').element.disabled).toBe(true)
    await field.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect((await store.chat(DIRECT_ID))!.outgoing).toEqual([])

    await field.setValue('x'.repeat(3_899))
    expect(view.find('#chat-composer-counter').exists()).toBe(false)
    await field.setValue('x'.repeat(3_900))
    expect(view.get('#chat-composer-counter').text()).toBe('3,900 of 4,096 characters')
    await field.setValue('x'.repeat(4_097))
    expect(view.get('#chat-composer-counter').classes()).toContain('over')
    expect(view.get<HTMLButtonElement>('button[type="submit"]').element.disabled).toBe(true)

    await field.setValue('On my way')
    // Shift+Enter is a new line, not a send.
    await field.trigger('keydown', { key: 'Enter', shiftKey: true })
    await flushPromises()
    expect((await store.chat(DIRECT_ID))!.outgoing).toEqual([])
    await field.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect((await store.chat(DIRECT_ID))!.outgoing).toEqual([expect.objectContaining({ text: 'On my way', status: 'waiting' })])
    expect(pollNow).toHaveBeenCalled()
    expect(field.element.value).toBe('')
  })

  it('Do opens a todo titled after the chat for the user to confirm; nothing else of the chat goes in', async () => {
    const view = await open(DIRECT_ID, await copyWith([direct], [incoming('A1', DIRECT, -10)]))
    await view.get('.verdict.do').trigger('click')
    await flushPromises()
    const field = view.get<HTMLInputElement>('#chat-todo')
    expect(field.element.value).toBe('Reply to Bram Visser')
    expect(document.activeElement).toBe(field.element)
    await field.setValue('Reply to Bram about the drill')
    await view.get('form.todo').trigger('submit')
    await flushPromises()
    expect(fakes.todos.create).toHaveBeenCalledWith({ title: 'Reply to Bram about the drill' })
    expect(view.find('#chat-todo').exists()).toBe(false)

    // D does the same, also K and E: not while typing.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))
    await flushPromises()
    expect(view.get<HTMLInputElement>('#chat-todo').element.value).toBe('Reply to Bram Visser')
  })

  it('Noted and Archive set the chat\'s own state and go back to the list', async () => {
    let view = await open(DIRECT_ID, await copyWith([direct], [incoming('A1', DIRECT, -10)]))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }))
    await flushPromises()
    expect((await store.chat(DIRECT_ID))!.chat).toMatchObject({ readThrough: at(-10), archivedThrough: at(-10) })
    expect(router.currentRoute.value.path).toBe('/')
    view.unmount()

    view = await open(DIRECT_ID, await copyWith([direct], [incoming('A1', DIRECT, -10)]))
    await view.get('[aria-keyshortcuts="E"]').trigger('click')
    await flushPromises()
    expect((await store.chat(DIRECT_ID))!.chat.archivedThrough).toBe(at(-10))
    wrapper = view
  })

  it('leaves a chat out after a confirmation, and goes back to the list', async () => {
    const leaveOut = vi.spyOn(relay, 'leaveOut')
    const view = await open(DIRECT_ID, await copyWith([direct], [incoming('A1', DIRECT, -10)]))
    await view.get('[aria-haspopup="menu"]').trigger('click')
    await flushPromises()
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!
    expect(item.textContent).toBe('Leave this chat out')
    item.click()
    await flushPromises()
    const confirm = view.get('[role="alertdialog"]')
    expect(confirm.text()).toContain('Leave this chat out?')
    expect(confirm.text()).toContain('Tresso removes its copy and stops reading it. The chat stays in WhatsApp.')
    expect(document.activeElement?.textContent).toBe('Cancel')
    await confirm.findAll('button')[0]!.trigger('click')
    await flushPromises()
    expect(leaveOut).toHaveBeenCalledWith(DIRECT)
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('reads a long chat in windows: the newest first, older ones on scrolling up, keeping the scroll position', async () => {
    const messages = Array.from({ length: 120 }, (_, index) => incoming(`M${String(index).padStart(3, '0')}`, DIRECT, -300 + index))
    const copy = await copyWith([direct], messages)
    const spy = vi.spyOn(copy, 'chatPage')
    const view = await open(DIRECT_ID, copy)
    expect(bubbles(view)).toHaveLength(50)
    expect(bubbles(view)[49]!.get('.text').text()).toBe('Text M119')
    expect(spy.mock.calls[0]![1]).toEqual({ limit: 50 })

    // The timeline is 100 px a bubble; scrolled near the top, older messages come in above.
    const scroller = view.get<HTMLElement>('.timeline').element
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scroller.querySelectorAll('li.item').length * 100 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 600 })
    scroller.scrollTop = 40
    await view.get('.timeline').trigger('scroll')
    await flushPromises()
    expect(bubbles(view)).toHaveLength(100)
    // 50 bubbles came in above: what was at 40 px is now 5,000 px further down.
    expect(scroller.scrollTop).toBe(5_040)

    await view.get('button.older').trigger('click')
    await flushPromises()
    expect(bubbles(view)).toHaveLength(120)
    expect(view.find('button.older').exists()).toBe(false)
    expect(bubbles(view)[0]!.get('.text').text()).toBe('Text M000')

    // New messages keep the window and add to its end.
    await new LocalChatBackend(copy, { includeGroups: true, leftOut: [], importSince: 0 }, { number: null, name: null, deviceId: 'd', deviceName: 'Mac' }).ingest([direct], [incoming('NEW', DIRECT, 1)], false)
    relay.revision++
    await flushPromises()
    expect(bubbles(view)).toHaveLength(121)
    expect(bubbles(view)[120]!.get('.text').text()).toBe('Text NEW')
  })

  it('says when a chat was left out, or is not here', async () => {
    const copy = await copyWith([direct], [incoming('A1', DIRECT, -10)])
    const { setLocalChatState } = await import('@tresso/core')
    await setLocalChatState(copy, DIRECT_ID, { leftOut: true })
    let view = await open(DIRECT_ID, copy)
    expect(view.text()).toContain('You left this chat out. Take it back in under Settings, WhatsApp.')
    view.unmount()
    view = await open('wa:999@s.whatsapp.net', copy)
    expect(view.text()).toContain('This chat is not on this Mac any more.')
    wrapper = view
  })

  it('never sends the Enter that confirms an input method composition, in the reply or in the todo field', async () => {
    const view = await open(DIRECT_ID, await copyWith([direct], [incoming('A1', DIRECT, -10)]))
    const field = view.get<HTMLTextAreaElement>('textarea')
    await field.setValue('こんにちは')
    // WKWebView: after compositionend, isComposing false but keyCode 229.
    await field.trigger('keydown', { key: 'Enter', keyCode: 229 })
    await field.trigger('keydown', { key: 'Enter', isComposing: true })
    await flushPromises()
    expect((await store.chat(DIRECT_ID))!.outgoing).toEqual([])
    expect(field.element.value).toBe('こんにちは')

    await view.get('.verdict.do').trigger('click')
    await flushPromises()
    const todo = view.get<HTMLInputElement>('#chat-todo')
    const composed = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, cancelable: true, bubbles: true })
    todo.element.dispatchEvent(composed)
    expect(composed.defaultPrevented).toBe(true)
    const plain = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true })
    todo.element.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
  })

  it('sends one reply for Enter twice or Send twice', async () => {
    const view = await open(DIRECT_ID, await copyWith([direct], [incoming('A1', DIRECT, -10)]))
    const field = view.get<HTMLTextAreaElement>('textarea')
    await field.setValue('Once')
    void field.trigger('keydown', { key: 'Enter' })
    void field.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await field.setValue('Twice')
    void view.get('form.composer').trigger('submit')
    void view.get('form.composer').trigger('submit')
    await flushPromises()
    expect((await store.chat(DIRECT_ID))!.outgoing.map((row) => row.text).sort()).toEqual(['Once', 'Twice'])
  })

  it('keeps what was typed per chat when the user looks at another chat and comes back', async () => {
    const copy = await copyWith([direct, group], [incoming('A1', DIRECT, -10), incoming('G1', GROUP, -9, { sender: { id: '1', name: 'Mom' } })])
    let view = await open(DIRECT_ID, copy)
    await view.get('textarea').setValue('Half a thought')
    view.unmount()
    view = await open(GROUP_ID, copy)
    expect(view.get<HTMLTextAreaElement>('textarea').element.value).toBe('')
    view.unmount()
    view = await open(DIRECT_ID, copy)
    expect(view.get<HTMLTextAreaElement>('textarea').element.value).toBe('Half a thought')

    // Sent: the draft goes.
    await view.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    view.unmount()
    view = await open(DIRECT_ID, copy)
    expect(view.get<HTMLTextAreaElement>('textarea').element.value).toBe('')

    // A chat left out takes its draft along.
    await view.get('textarea').setValue('Never mind')
    const { setLocalChatState } = await import('@tresso/core')
    vi.spyOn(relay, 'leaveOut').mockImplementation(async () => {
      await setLocalChatState(copy, DIRECT_ID, { leftOut: true })
      return true
    })
    const { useChatsStore } = await import('@/stores/chats')
    await useChatsStore().leaveChatOut((await copy.chat(DIRECT_ID))!.chat)
    expect(useChatsStore().draftOf(DIRECT_ID)).toBe('')
    wrapper = view
  })

  it('leaves K and E to the bulk bar while mail is ticked', async () => {
    fakes.selection.active = true
    const view = await open(DIRECT_ID, await copyWith([direct], [incoming('A1', DIRECT, -10)]))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }))
    await flushPromises()
    expect((await store.chat(DIRECT_ID))!.chat.archivedThrough).toBeNull()
    expect(router.currentRoute.value.path).toBe('/chats/x')
    wrapper = view
  })

  it('keeps the older messages it loaded when a reload started before them lands after', async () => {
    const messages = Array.from({ length: 80 }, (_, index) => incoming(`M${String(index).padStart(3, '0')}`, DIRECT, -300 + index))
    const copy = await copyWith([direct], messages)
    const view = await open(DIRECT_ID, copy)
    expect(bubbles(view)).toHaveLength(50)

    // A reload starts (the chats changed) and is held; older messages load meanwhile; then the reload lands.
    const real = copy.chatPage.bind(copy)
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const spy = vi.spyOn(copy, 'chatPage').mockImplementationOnce(async (...args) => {
      const page = await real(...args)
      await held
      return page
    })
    relay.revision++
    await flushPromises()
    await view.get('button.older').trigger('click')
    await flushPromises()
    expect(bubbles(view)).toHaveLength(80)
    release()
    await flushPromises()
    // The overtaken reload ran again from the window as it is now: nothing loaded vanished.
    expect(bubbles(view)).toHaveLength(80)
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3)
    wrapper = view
  })

  it('reads the open chat once the window has the focus, the same way on opening and on new messages', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const view = await open(DIRECT_ID, await copyWith([direct], [incoming('A1', DIRECT, -10)]))
    expect((await store.chats())[0]!.unread).toBe(1)
    focus.mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect((await store.chats())[0]!.unread).toBe(0)
    wrapper = view
  })

  it('shows a reply that waits or failed even when it is older than the window', async () => {
    const messages = Array.from({ length: 60 }, (_, index) => incoming(`M${String(index).padStart(3, '0')}`, DIRECT, -300 + index))
    const copy = await copyWith([direct], messages)
    await copy.putChatOutgoing([
      { id: 'old-failed', chatId: DIRECT_ID, chatAccountId: 'wa:account', text: 'Failed long ago', status: 'failed', error: 'refused', createdAt: at(-299), claimedAt: at(-299), sentAt: null },
      { id: 'old-sent', chatId: DIRECT_ID, chatAccountId: 'wa:account', text: 'Sent long ago', status: 'sent', error: null, createdAt: at(-299), claimedAt: at(-299), sentAt: at(-299) },
    ])
    const view = await open(DIRECT_ID, copy)
    const texts = bubbles(view).map((item) => item.find('.text').exists() ? item.get('.text').text() : '')
    expect(texts).toContain('Failed long ago')
    expect(texts).not.toContain('Sent long ago')
    wrapper = view
  })

  it('says a file\'s fate only in the chat it was attached in, and forgets it once the user types', async () => {
    const copy = await copyWith([direct, group], [incoming('A1', DIRECT, -10), incoming('G1', GROUP, -9, { sender: { id: '1', name: 'Mom' } })])
    let view = await open(DIRECT_ID, copy)
    await view.get('button[aria-label="Attach a file"]').trigger('click')
    await flushPromises()
    expect(view.get('.attach-line').text()).toBe('plan.pdf was sent.')
    expect(view.get('.attach-line').attributes('role')).toBe('status')
    view.unmount()
    view = await open(GROUP_ID, copy)
    expect(view.get('.attach-line').text()).toBe('')
    view.unmount()
    view = await open(DIRECT_ID, copy)
    expect(view.get('.attach-line').text()).toBe('plan.pdf was sent.')
    await view.get('textarea').setValue('x')
    expect(view.get('.attach-line').text()).toBe('')
    wrapper = view
  })

  it('shows markup and direction overrides from WhatsApp as text, kept inside their bubble', async () => {
    const view = await open(
      GROUP_ID,
      await copyWith([group], [incoming('G1', GROUP, -10, { sender: { id: '1', name: '‮Mom<b>' }, text: '<img src=x onerror=alert(1)>‮dlrow olleh' })]),
    )
    const bubble = bubbles(view)[0]!
    expect(bubble.find('img').exists()).toBe(false)
    expect(bubble.get('.text').text()).toBe('<img src=x onerror=alert(1)>‮dlrow olleh')
    expect(bubble.get('.text').attributes('dir')).toBe('auto')
    // The name is cleaned of the override; the text is isolated, so an override in it ends at the bubble.
    expect(bubble.get('.sender').text()).toBe('Mom<b>')
    expect(view.get('h2').text()).toBe('Family')
    expect(view.get('.timeline').attributes('role')).toBe('region')
  })

  it('reads older messages again once when a reload that started during their read overtook them', async () => {
    const messages = Array.from({ length: 80 }, (_, index) => incoming(`M${String(index).padStart(3, '0')}`, DIRECT, -300 + index))
    const copy = await copyWith([direct], messages)
    const view = await open(DIRECT_ID, copy)
    const real = copy.chatPage.bind(copy)
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    // The older page is held; a reload starts and lands meanwhile; then the older page lands, overtaken.
    vi.spyOn(copy, 'chatPage').mockImplementationOnce(async (...args) => {
      const page = await real(...args)
      await held
      return page
    })
    await view.get('button.older').trigger('click')
    await flushPromises()
    relay.revision++
    await flushPromises()
    expect(bubbles(view)).toHaveLength(50)
    release()
    await flushPromises()
    expect(bubbles(view)).toHaveLength(80)
    wrapper = view
  })

  it('says incoming messages that land at the newest end, and nothing for own messages or the first load', async () => {
    const copy = await copyWith([direct], [incoming('A1', DIRECT, -10)])
    const view = await open(DIRECT_ID, copy)
    const live = () => view.get('.incoming')
    expect(live().attributes('aria-live')).toBe('polite')
    expect(live().text()).toBe('')
    const backend = new LocalChatBackend(copy, { includeGroups: true, leftOut: [], importSince: 0 }, { number: null, name: null, deviceId: 'd', deviceName: 'Mac' })

    await backend.ingest([direct], [incoming('A2', DIRECT, 1, { text: 'Can you bring\nthe drill?' })], false)
    relay.revision++
    await flushPromises()
    expect(live().text()).toBe('Bram Visser: Can you bring the drill?')

    await backend.ingest([direct], [incoming('A3', DIRECT, 2), incoming('A4', DIRECT, 3), incoming('A5', DIRECT, 4)], false)
    relay.revision++
    await flushPromises()
    expect(live().text()).toBe('3 new messages')

    await backend.ingest([direct], [incoming('A6', DIRECT, 5, { fromMe: true, text: 'Typed on the phone' })], false)
    relay.revision++
    await flushPromises()
    expect(live().text()).toBe('3 new messages')
    wrapper = view
  })

  it('names the sender in a group, and a file by its kind', async () => {
    const copy = await copyWith([group], [incoming('G1', GROUP, -10, { sender: { id: '1', name: 'Mom' } })])
    const view = await open(GROUP_ID, copy)
    const backend = new LocalChatBackend(copy, { includeGroups: true, leftOut: [], importSince: 0 }, { number: null, name: null, deviceId: 'd', deviceName: 'Mac' })
    await backend.ingest([group], [incoming('G2', GROUP, 1, { sender: { id: '2', name: 'Joost' }, text: '', media: { kind: 'image', name: 'image_1.jpg', size: 1 } })], false)
    relay.revision++
    await flushPromises()
    expect(view.get('.incoming').text()).toBe('Joost: Photo')
    wrapper = view
  })

  it('follows the mail pane\'s rules for D, K and E: not with the compose window open or a modal layer on the page', async () => {
    const view = await open(DIRECT_ID, await copyWith([direct], [incoming('A1', DIRECT, -10)]))
    const pressE = async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }))
      await flushPromises()
      return (await store.chat(DIRECT_ID))!.chat.archivedThrough
    }

    fakes.compose.draft = {}
    expect(await pressE()).toBeNull()
    // Minimized, it holds nothing.
    fakes.compose.minimized = true
    fakes.compose.draft = null

    const dialog = document.body.appendChild(document.createElement('dialog'))
    dialog.setAttribute('open', '')
    expect(await pressE()).toBeNull()
    dialog.remove()
    const question = document.body.appendChild(document.createElement('div'))
    question.setAttribute('role', 'alertdialog')
    expect(await pressE()).toBeNull()
    question.remove()

    expect(await pressE()).toBe(at(-10))
    wrapper = view
  })
})
