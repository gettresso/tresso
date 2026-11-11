import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { Todo, TodoUpdate } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'
import { useComposeStore } from '@/stores/compose'
import { useTodosStore } from '@/stores/todos'
import { ApiError } from '@/api/errors'
import TodoDetail from '../TodoDetail.vue'

function todo(id: string, extra: Partial<Todo> = {}): Todo {
  return {
    id,
    title: `Todo ${id}`,
    notes: '',
    dueDate: '2026-11-20',
    dueTime: '10:00',
    durationMinutes: 30,
    completedAt: null,
    position: 0,
    source: 'manual',
    messageId: null,
    threadId: null,
    plannedStart: null,
    plannedEnd: null,
    planState: null,
    createdAt: '2026-10-19T08:00:00Z',
    updatedAt: '2026-10-19T08:00:00Z',
    ...extra,
  }
}

describe('TodoDetail', () => {
  let update: MockInstance<(id: string, changes: TodoUpdate) => Promise<Todo>>

  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }
    update = vi.spyOn(useTodosStore(), 'update').mockImplementation(async (id) => todo(id))
  })

  afterEach(() => vi.restoreAllMocks())

  async function detail(of: Todo) {
    const screen = { template: '<div />' }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: screen },
        { path: '/todos', name: 'todos', component: screen },
        { path: '/calendar/:view?/:date?', name: 'calendar', component: screen },
        { path: '/inbox/:threadId', name: 'unified-thread', component: screen },
      ],
    })
    await router.push('/')
    return mount(TodoDetail, { props: { todo: of, message: null }, global: { plugins: [router] } })
  }

  it('sends only what the user changed, not the old values of what another device changed meanwhile', async () => {
    const wrapper = await detail(todo('a', { title: 'Call Anna' }))
    await wrapper.get('textarea').setValue('About the contract')

    // The phone renames it and moves its due date while the notes are being written here.
    await wrapper.setProps({ todo: todo('a', { title: 'Call Anna back', dueDate: '2026-11-21', dueTime: '11:00', durationMinutes: 45 }) })
    await wrapper.get('form.detail').trigger('submit')
    await vi.waitFor(() => expect(update).toHaveBeenCalled())

    expect(update).toHaveBeenCalledExactlyOnceWith('a', { notes: 'About the contract' })
  })

  it('saves the edits of a todo the user leaves for another one', async () => {
    const wrapper = await detail(todo('a', { title: 'Call Anna' }))
    await wrapper.get('textarea').setValue('About the contract')

    await wrapper.setProps({ todo: todo('b', { title: 'Book the train' }) })
    await flushPromises()

    expect(update).toHaveBeenCalledExactlyOnceWith('a', { notes: 'About the contract' })
    expect((wrapper.get('input.title').element as HTMLInputElement).value).toBe('Book the train')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('says so when the edits of a todo the user left could not be saved', async () => {
    update.mockRejectedValueOnce(new Error('Not now.'))
    const wrapper = await detail(todo('a', { title: 'Call Anna' }))
    await wrapper.get('textarea').setValue('About the contract')

    await wrapper.setProps({ todo: todo('b', { title: 'Book the train' }) })
    await flushPromises()

    expect(wrapper.text()).toContain('Your changes to "Call Anna" were not saved: Not now.')
  })
  it('shows what another device changed once the save is done', async () => {
    const wrapper = await detail(todo('a', { title: 'Call Anna' }))
    // The server answers with the phone's new title along with the notes saved here.
    update.mockImplementationOnce(async (id) => todo(id, { title: 'Call Anna back', notes: 'About the contract' }))
    await wrapper.get('textarea').setValue('About the contract')

    await wrapper.get('form.detail').trigger('submit')
    await vi.waitFor(() => expect((wrapper.get('input.title').element as HTMLInputElement).value).toBe('Call Anna back'))

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('About the contract')
  })

  it('keeps the form of the todo picked while a save ran, and saves what was typed after the save began', async () => {
    let answer!: () => void
    update.mockImplementationOnce(
      (id) =>
        new Promise((resolve) => {
          answer = () => resolve(todo(id))
        }),
    )
    const wrapper = await detail(todo('a', { title: 'Call Anna' }))
    await wrapper.get('textarea').setValue('About the contract')
    await wrapper.get('form.detail').trigger('submit')
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce())

    await wrapper.get('textarea').setValue('About the contract, and the invoice')
    await wrapper.setProps({ todo: todo('b', { title: 'Book the train' }) })
    answer()
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    await flushPromises()

    expect(update.mock.calls).toEqual([
      ['a', { notes: 'About the contract' }],
      ['a', { notes: 'About the contract, and the invoice' }],
    ])
    expect((wrapper.get('input.title').element as HTMLInputElement).value).toBe('Book the train')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('saves the edits when the detail closes, and says so in a notice when that fails', async () => {
    const notify = vi.spyOn(useComposeStore(), 'notify')
    const wrapper = await detail(todo('a', { title: 'Call Anna' }))
    await wrapper.get('textarea').setValue('About the contract')

    wrapper.unmount()
    await flushPromises()
    expect(update).toHaveBeenCalledExactlyOnceWith('a', { notes: 'About the contract' })
    expect(notify).not.toHaveBeenCalled()

    update.mockRejectedValueOnce(new Error('Not now.'))
    const again = await detail(todo('a', { title: 'Call Anna' }))
    await again.get('textarea').setValue('About the invoice')
    again.unmount()
    await flushPromises()
    expect(notify).toHaveBeenCalledExactlyOnceWith({ text: 'Your changes to "Call Anna" were not saved: Not now.', tone: 'error' })
  })
  /** Holds the next save until the test answers it with the todo the server returns. */
  function holdSave(): (answer: Todo) => void {
    let answer!: (todo: Todo) => void
    update.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    return (todo) => answer(todo)
  }

  it('shows the saved edit, and never sends the old value back, after the user went to another todo and came back during the save', async () => {
    const answer = holdSave()
    const wrapper = await detail(todo('a', { title: 'Call Anna' }))
    await wrapper.get('textarea').setValue('About the contract')
    await wrapper.get('form.detail').trigger('submit')
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce())

    await wrapper.setProps({ todo: todo('b', { title: 'Book the train' }) })
    // Back on the first todo, as the copy has it before the save is done.
    await wrapper.setProps({ todo: todo('a', { title: 'Call Anna' }) })
    const saved = todo('a', { title: 'Call Anna', notes: 'About the contract' })
    answer(saved)
    await wrapper.setProps({ todo: saved })
    await flushPromises()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('About the contract')
    await wrapper.get('input.title').setValue('Call Anna today')
    await wrapper.get('form.detail').trigger('submit')
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update.mock.calls[1]).toEqual(['a', { title: 'Call Anna today' }])
  })

  it('shows what the server saved even when the pull after the save failed', async () => {
    update.mockImplementationOnce(async (id) => todo(id, { title: 'Call Anna', notes: 'About the contract' }))
    const wrapper = await detail(todo('a', { title: 'Call Anna' }))
    await wrapper.get('textarea').setValue('About the contract')

    await wrapper.get('form.detail').trigger('submit')
    await vi.waitFor(() => expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined())

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('About the contract')
  })

  it('leaves no unsaved changes after saving a title with a space at its end', async () => {
    update.mockImplementationOnce(async (id) => todo(id, { title: 'Call Anna' }))
    const wrapper = await detail(todo('a', { title: 'Call' }))
    await wrapper.get('input.title').setValue('Call Anna ')

    await wrapper.get('form.detail').trigger('submit')
    await vi.waitFor(() => expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined())

    expect(update).toHaveBeenCalledExactlyOnceWith('a', { title: 'Call Anna' })
    expect((wrapper.get('input.title').element as HTMLInputElement).value).toBe('Call Anna')
  })

  it("says nothing on the next todo's form when the save of the one left failed", async () => {
    let refuse!: (error: Error) => void
    update.mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)))
    update.mockRejectedValueOnce(new Error('Not now.'))
    const wrapper = await detail(todo('a', { title: 'Call Anna' }))
    await wrapper.get('textarea').setValue('About the contract')
    await wrapper.get('form.detail').trigger('submit')
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce())

    await wrapper.setProps({ todo: todo('b', { title: 'Book the train' }) })
    refuse(new ApiError(422, 'The notes are too long.', { notes: 'Use fewer characters.' }))
    await flushPromises()

    // Said once, by the edits carried away from the first todo, and not as an error of the second.
    expect(wrapper.findAll('[role="alert"]').map((alert) => alert.text())).toEqual(['Your changes to "Call Anna" were not saved: Not now.'])
    expect(wrapper.text()).not.toContain('Use fewer characters.')
  })

  it('saves nothing of a todo the user deleted, or at a sign-out', async () => {
    const remove = vi.spyOn(useTodosStore(), 'remove').mockResolvedValue()
    const notify = vi.spyOn(useComposeStore(), 'notify')
    const wrapper = await detail(todo('a', { title: 'Call Anna' }))
    await wrapper.get('textarea').setValue('About the contract')
    await wrapper.findAll('button').find((button) => button.text() === 'Delete')!.trigger('click')
    await wrapper.findAll('button').find((button) => button.text() === 'Delete todo')!.trigger('click')
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
    wrapper.unmount()
    await flushPromises()

    const next = await detail(todo('b', { title: 'Book the train' }))
    await next.get('textarea').setValue('First class')
    useAuthStore().tokens = null
    next.unmount()
    await flushPromises()

    expect(update).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})
