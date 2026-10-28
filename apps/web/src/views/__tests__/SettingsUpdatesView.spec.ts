import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsUpdatesView from '@/views/SettingsUpdatesView.vue'
import { useUpdatesStore } from '@/stores/updates'

describe('SettingsUpdatesView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows the version and opens Sparkle on macOS', async () => {
    const updates = useUpdatesStore()
    updates.channel = 'sparkle'
    updates.version = '0.3.0'
    const checkNow = vi.spyOn(updates, 'checkNow').mockResolvedValue()

    const view = mount(SettingsUpdatesView)
    await view.get('button').trigger('click')

    expect(view.text()).toContain('You have Tresso 0.3.0.')
    expect(view.text()).toContain('Sparkle asks before it installs anything.')
    expect(checkNow).toHaveBeenCalledWith(true)
  })

  it('says when Windows or Linux is up to date, and offers a found release', async () => {
    const updates = useUpdatesStore()
    updates.channel = 'tauri'
    updates.phase = 'latest'
    const view = mount(SettingsUpdatesView)
    expect(view.text()).toContain('Tresso is up to date.')

    updates.phase = 'available'
    updates.update = { version: '0.4.0' } as never
    await view.vm.$nextTick()
    expect(view.text()).toContain('Tresso 0.4.0 is available.')
    expect(view.findAll('button').map((button) => button.text())).toContain('Install and relaunch')
  })

  it('explains a build that does not update itself', () => {
    const view = mount(SettingsUpdatesView)

    expect(view.text()).toContain('This build does not update itself.')
    expect(view.find('button').exists()).toBe(false)
  })
})
