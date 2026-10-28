import { isDesktop } from '@/platform/desktop'

/**
 * The macOS desktop app draws its own title bar over a see-through window with the system's sidebar vibrancy
 * (tauri.macos.conf.json): the page leaves its background out there and keeps a strip free for the window buttons.
 */
export const vibrant = isDesktop && /Macintosh|Mac OS X/.test(navigator.userAgent)
