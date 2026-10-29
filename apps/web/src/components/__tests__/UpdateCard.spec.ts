import { beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('offers the restart for a download put off with "Later"', () => {
    const updates = useUpdatesStore()
    updates.channel = 'tauri'
    updates.update = release('0.3.0')
    updates.phase = 'ready'

    const card = mount(UpdateCard)

    expect(card.text()).toContain('Tresso 0.3.0 is ready')
    expect(card.get('button.button-primary').text()).toBe('Restart to update')
  })

  it('says what the restart waits for, on macOS too, with a way to go now or later', async () => {
    const updates = useUpdatesStore()
    updates.channel = 'sparkle'
    updates.phase = 'waiting'
    updates.waitingFor = 'files'
    const restartNow = vi.spyOn(updates, 'restartNow').mockImplementation(() => undefined)
    const later = vi.spyOn(updates, 'later').mockImplementation(() => undefined)

    const card = mount(UpdateCard)

    expect(card.text()).toContain('The update is ready')
    expect(card.text()).toContain('Tresso restarts once your files are attached, so they are not lost.')
    updates.waitingFor = 'sending'
    await card.vm.$nextTick()
    expect(card.text()).toContain('Tresso restarts once your message is on its way.')

    const [now, notNow] = card.findAll('button')
    await now!.trigger('click')
    await notNow!.trigger('click')
    expect(restartNow).toHaveBeenCalledOnce()
    expect(later).toHaveBeenCalledOnce()
  })

  it('shows the release notes without their Markdown', () => {
    const updates = useUpdatesStore()
    updates.channel = 'tauri'
    updates.update = { version: '0.3.0', body: "## What's new\n\n- **New:** Billing per organization\n- **Fixed:** A stuck key" } as Update
    updates.phase = 'available'

    const card = mount(UpdateCard)

    expect(card.get('.notes').text()).toBe('- New: Billing per organization\n- Fixed: A stuck key')
  })

  it('says why Sparkle did not restart when the draft could not be saved, with a way to try again', async () => {
    const updates = useUpdatesStore()
    updates.channel = 'sparkle'
    updates.error = 'The draft could not be saved, so Tresso did not restart for the update: disk full'
    const checkNow = vi.spyOn(updates, 'checkNow').mockResolvedValue(undefined)

    const card = mount(UpdateCard)

    expect(card.get('[role="alert"]').text()).toContain('disk full')
    await card.get('button.button-primary').trigger('click')
    expect(checkNow).toHaveBeenCalledWith(true)
  })

  it('says the update is installed when only the restart failed', () => {
    const updates = useUpdatesStore()
    updates.channel = 'tauri'
    updates.update = release('0.3.0')
    updates.phase = 'installing'
    updates.error = 'Tresso 0.3.0 is installed. Quit and open Tresso to start it (no permission).'

    const card = mount(UpdateCard)

    expect(card.get('[role="alert"]').text()).toContain('is installed. Quit and open Tresso')
    expect(card.text()).not.toContain('restarts in a moment')
  })
})
