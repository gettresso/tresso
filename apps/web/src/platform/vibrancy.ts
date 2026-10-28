import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from '@/platform/desktop'

/**
 * The macOS desktop app draws its own title bar over a see-through window with the system's sidebar vibrancy
 * (tauri.macos.conf.json): the page leaves its background out there and keeps a strip free for the window buttons.
 */
export const vibrant = isDesktop && /Macintosh|Mac OS X/.test(navigator.userAgent)

/**
 * Turns the glass solid while the user asks the system for less transparency. WebKit cannot tell the page, so the
 * shell is asked, at launch and whenever the window comes back, as the setting may change while Tresso runs.
 */
export function followReducedTransparency(): void {
  if (!vibrant) {
    return
  }
  const check = async () => {
    try {
      document.documentElement.classList.toggle('reduce-transparency', await invoke<boolean>('reduce_transparency'))
    } catch (error) {
      // The glass stays as it is; the window's own vibrancy still follows the setting.
      console.error('Reading the transparency setting failed', error)
    }
  }
  void check()
  window.addEventListener('focus', () => void check())
}
