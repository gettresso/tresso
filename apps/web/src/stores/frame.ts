import { ref } from 'vue'
import { defineStore } from 'pinia'
import { clampSidebarWidth, readSidebarLayout, writeSidebarLayout } from '@/platform/frame'

/**
 * The desktop frame's sidebar (platform/frame.ts): its width and whether it shows, kept on this device. The toggle, the
 * drag handle and View > Hide Sidebar change it; the browser build never reads it.
 */
export const useFrameStore = defineStore('frame', () => {
  const kept = readSidebarLayout()
  const width = ref(kept.width)
  const shown = ref(kept.shown)

  function keep(): void {
    writeSidebarLayout({ width: width.value, shown: shown.value })
  }

  /** Sets the width within its limits; `remember: false` while a drag is under way, which keeps it once it ends. */
  function setWidth(next: number, remember = true): void {
    width.value = clampSidebarWidth(next)
    if (remember) {
      keep()
    }
  }

  function toggle(): void {
    shown.value = !shown.value
    keep()
  }

  return { width, shown, setWidth, toggle, keep }
})
