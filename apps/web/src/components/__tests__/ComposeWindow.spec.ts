import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import type { Draft } from '@/mail/db'
import ComposeWindow from '../ComposeWindow.vue'

const draft: Draft = { id: 'd1', mailAccountId: 'work', to: [], cc: [], bcc: [], subject: 'Hello', html: '<p>Hi</p>', signatureId: null, quoteHtml: '', inReplyToMessageId: null, kind: 'new', version: 0, pendingSave: false, remoteVersion: null, outgoingId: null, noticedStatus: null, updatedAt: 1, attachments: [] }

const { compose } = vi.hoisted(() => ({ compose: { current: null as Record<string, unknown> | null } }))
vi.mock('@/stores/compose', () => ({ useComposeStore: () => compose.current }))

describe('ComposeWindow', () => {
  it('shrinks to its title bar when minimized and comes back when expanded', async () => {
    compose.current = reactive({ draft, minimized: false, savedAt: null, conflict: false, revision: 0, close: vi.fn<() => void>(), resolveConflict: vi.fn<(choice: 'mine' | 'theirs') => void>() })
    const wrapper = mount(ComposeWindow, { global: { stubs: { ComposeForm: { template: '<form class="form" />' } } } })

    await wrapper.get('button[aria-label="Minimize"]').trigger('click')

    // The minimized class is what turns the window into a bar along the bottom edge, also on a phone.
    expect(wrapper.get('section').classes()).toContain('minimized')
    expect(wrapper.get('.form').attributes('style')).toContain('display: none')

    await wrapper.get('button[aria-label="Expand"]').trigger('click')
    expect(wrapper.get('section').classes()).not.toContain('minimized')
  })
})
