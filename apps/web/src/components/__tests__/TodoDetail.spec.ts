import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { Todo, TodoUpdate } from '@tresso/core'
import { useTodosStore } from '@/stores/todos'
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
})
