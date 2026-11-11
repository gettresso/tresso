import { createContext, useContext, type ComponentRef } from 'react'
import type { HostInstance, ScrollView } from 'react-native'

/** Scrolls the screen so this offset inside the view is at the top. */
export type ScrollToPlace = (view: HostInstance, offset: number) => void

const PlaceScrollContext = createContext<ScrollToPlace | null>(null)

/** Lets the web views in a scrolling screen bring a place in their mail into view (see frameLinks). */
export const PlaceScrollProvider = PlaceScrollContext.Provider

/** How a web view in this screen scrolls to a place in its mail; null where nothing scrolls around it. */
export function usePlaceScroll(): ScrollToPlace | null {
  return useContext(PlaceScrollContext)
}

/** Scrolls this scroll view so the offset inside the view, which is in its content, is at the top. */
export function scrollToPlaceIn(list: ComponentRef<typeof ScrollView> | null, view: HostInstance, offset: number): void {
  const content = list?.getInnerViewRef() ?? null
  if (list === null || content === null) {
    return
  }
  view.measureLayout(content, (_left, top) => list.scrollTo({ y: Math.max(0, top + offset), animated: true }))
}
