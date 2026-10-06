// Keeps the scroll position of a scroller inside a view while another view is on screen.
// A view that is not shown is detached from the page and a detached element forgets where it was
// scrolled to, so the position is recorded while the view is in the page (on every scroll, and
// once more in the navigation that leaves the view) and put back when the view is activated again.
//
//   const scroll = useKeptScroll(listEl)   // in the view or in any component inside it
//   scroll.reset()                         // a fresh navigation: start at the top instead
//
// A scroller that is hidden (display: none on it or above it, like the map's filter column) has no
// scroll position either: nothing is read from it and nothing is put on it. What was remembered
// stays, and goes back on the element with set() once it is shown again.
//
// <main> is not an inner scroller: the shell keeps that one (see scrollMain in useViewRoute).

import { onActivated, onBeforeUnmount, onDeactivated, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { useViewRoute } from './useViewRoute'

export interface ScrollPosition {
  top: number
  left: number
}

export interface KeptScroll {
  /** The position that is remembered right now. */
  position(): ScrollPosition
  /**
   * Scroll there: at once when the element is in the page, otherwise when the view is activated
   * or, in a view that is on screen, when the element appears. Replaces what was remembered.
   */
  set(position: Partial<ScrollPosition>): void
  /** Back to the start, in the same way: for a fresh navigation that should not restore. */
  reset(): void
}

export function useKeptScroll(target: MaybeRefOrGetter<HTMLElement | null | undefined>): KeptScroll {
  const view = useViewRoute()
  let el: HTMLElement | null = null
  let top = 0
  let left = 0
  /** The remembered position still has to be put back on the element. */
  let pending = false

  const inPage = () => !!el && el.isConnected && view.active.value
  /** No box at all: scrollTop reads 0 and cannot be set. (jsdom cannot tell; everything has a box there.) */
  const boxless = () => !!el && typeof el.checkVisibility === 'function' && !el.checkVisibility()

  function read() {
    if (!el || boxless()) return
    top = el.scrollTop
    left = el.scrollLeft
  }

  function apply() {
    if (!el) return
    // Hidden: it keeps waiting, the position is still the remembered one.
    if (boxless()) {
      pending = true
      return
    }
    el.scrollTop = top
    el.scrollLeft = left
    pending = false
    // Shorter content than before: remember where it really ended up.
    read()
  }

  function onScroll() {
    if (!inPage() || boxless()) return
    // It was hidden when its position should have gone back on it, and is scrolled now: that counts.
    pending = false
    read()
  }

  /** The element can come and go (v-if) or be replaced (a keyed card). */
  function adopt(next: HTMLElement | null) {
    if (next === el) return
    el?.removeEventListener('scroll', onScroll)
    el = next
    if (!el) return
    el.addEventListener('scroll', onScroll, { passive: true })
    if (!inPage()) return
    if (pending) apply()
    else read()
  }
  const current = () => toValue(target) ?? null
  watch(current, adopt, { immediate: true, flush: 'post' })

  // Leaving the view: the element is still in the page, so this is the exact position.
  view.onLeave(() => {
    if (pending) return
    if (el?.isConnected) read()
    pending = true
  })
  // Without a view around it (or without the store) there is only what the scroll events recorded.
  onDeactivated(() => {
    pending = true
  })
  onActivated(() => {
    // The watcher above may not have run yet for an element that came with this render.
    adopt(current())
    if (!pending) return
    if (inPage()) return apply()
    // Nothing to put it back on: an element that shows up later starts at the top.
    top = 0
    left = 0
    pending = false
  })
  onBeforeUnmount(() => el?.removeEventListener('scroll', onScroll))

  function set(position: Partial<ScrollPosition>) {
    adopt(current())
    if (position.top !== undefined) top = position.top
    if (position.left !== undefined) left = position.left
    if (inPage()) apply()
    else pending = true
  }

  return {
    position: () => ({ top, left }),
    set,
    reset: () => set({ top: 0, left: 0 }),
  }
}
