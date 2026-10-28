import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import UpdateCard from '@/components/UpdateCard.vue'
import { useUpdatesStore } from '@/stores/updates'
import type { Update } from '@/platform/updates'

function release(version: string): Update {
  return { version, body: 'Faster search' } as Update
}

describe('UpdateCard', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('offers a newer release on Windows and Linux, with its notes', async () => {
    const updates = useUpdatesStore()
    updates.channel = 'tauri'
    updates.version = '0.2.0'
    updates.update = release('0.3.0')
    updates.phase = 'available'

    const card = mount(UpdateCard)

    expect(card.text()).toContain('Tresso 0.3.0 is available')
    expect(card.text()).toContain('You have 0.2.0.')
    expect(card.text()).toContain('Faster search')
    expect(card.get('button.button-primary').text()).toBe('Install and relaunch')
  })

  it('shows the download as it goes', async () => {
    const updates = useUpdatesStore()
    updates.channel = 'tauri'
    updates.update = release('0.3.0')
    updates.phase = 'downloading'
    updates.progress = 0.42

    const card = mount(UpdateCard)

    expect(card.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('42')
    expect(card.text()).toContain('Downloading… 42%')
    expect(card.find('button').exists()).toBe(false)
  })

  it('stays away on macOS, where Sparkle shows its own window, and after "Later"', async () => {
    const updates = useUpdatesStore()
    updates.channel = 'sparkle'
    updates.update = release('0.3.0')
    updates.phase = 'available'
    const card = mount(UpdateCard)
    expect(card.find('.update').exists()).toBe(false)

    updates.channel = 'tauri'
    updates.dismissed = '0.3.0'
    await card.vm.$nextTick()
    expect(card.find('.update').exists()).toBe(false)
  })
})
