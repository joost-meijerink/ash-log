// In-page anchors for the Verzamelingen view (#vaults, #vault-<slug>, ...).
// <main> is the scroll container and the router has no scrollBehavior, so the view scrolls
// itself: it brings the target into view, focuses it and, for vault cards, highlights it for a
// moment.
//
// The view stays alive while another one is on screen (see useViewRoute), so there are three
// ways to get at an anchor, and one way that must do nothing:
//   - the first visit (the view is created for it): after a frame, without animation;
//   - a link from another view (a fresh arrival): at once when the view is back in the page,
//     without animation, also when the link names the anchor that was already in the address;
//   - the hash changes while the view is on screen (goTo, back and forward): smooth;
//   - coming back to where the view was left (a return): nothing. The shell puts <main> back,
//     and nothing here scrolls, focuses or highlights, whatever hash the address still holds.

import { inject, nextTick, onActivated, onBeforeUnmount, onMounted, provide, ref, watch, type InjectionKey, type Ref } from 'vue'
import { useViewRoute } from './useViewRoute'

export interface AnchorNavigator {
  /** Id of the element that is highlighted right now, if any. */
  highlighted: Readonly<Ref<string | null>>
  /** Go to an anchor on this page: sets the hash, or scrolls again when it is already set. */
  goTo(id: string): void
}

const KEY: InjectionKey<AnchorNavigator> = Symbol('collection-anchor')

export function hashToId(hash: string | undefined | null): string {
  if (!hash) return ''
  const raw = hash.replace(/^#/, '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export interface AnchorOptions {
  /** Which ids get the highlight. Default: none. */
  highlight?: (id: string) => boolean
  /** How long the highlight stays. Default 1800 ms. */
  durationMs?: number
}

/**
 * Set up anchor handling in the view; child components reach it with useAnchorNavigator().
 * Call it after provideViewRoute(): it reads the view's own route, never that of another view.
 */
export function useCollectionAnchor(options: AnchorOptions = {}): AnchorNavigator {
  const view = useViewRoute()
  const route = view.route
  const highlighted = ref<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame = 0
  /**
   * The last switch to this view that was dealt with. It starts at the one the view is created
   * for: that one is the first visit, handled on mount.
   */
  let handled = view.arrival.value?.seq

  /** Scrolls to the element, focuses it and highlights it. Returns it, or null when nothing was done. */
  function reveal(id: string, smooth: boolean): HTMLElement | null {
    // Away, this view is not in the page: nothing to scroll, and an id could hit another view.
    if (!view.active.value) return null
    const el = document.getElementById(id)
    if (!el) return null
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: smooth && !reduce ? 'smooth' : 'auto', block: 'start' })
    // Move keyboard focus along (targets carry tabindex="-1").
    if (el.hasAttribute('tabindex')) el.focus({ preventScroll: true })
    if (options.highlight?.(id)) {
      highlighted.value = id
      clearTimeout(timer)
      timer = setTimeout(() => (highlighted.value = null), options.durationMs ?? 1800)
    }
    return el
  }

  /**
   * An anchor reached without animation is where <main> belongs for this arrival. Telling the
   * shell makes that hold whether it already placed <main> (then this changes nothing) or still
   * has to (then it goes here instead of to the top).
   */
  function pinMain(el: HTMLElement) {
    const main = el.closest('main')
    if (main) view.scrollMain(main.scrollTop)
  }

  function goTo(id: string) {
    if (hashToId(route.hash) === id) reveal(id, true)
    else void view.push({ path: route.path, query: route.query, hash: `#${id}` })
  }

  // The hash of this view's own address changed.
  watch(
    () => route.hash,
    (hash) => {
      // It came with a link from another view: the activation below takes it, without the animation.
      const arrival = view.arrival.value
      if (arrival && arrival.seq !== handled) return
      const id = hashToId(hash)
      if (id) void nextTick(() => reveal(id, true))
    },
  )

  // The first visit.
  onMounted(() => {
    const id = hashToId(route.hash)
    if (!id) return
    // Wait a frame so layout (fonts, lists) has settled before jumping.
    frame = requestAnimationFrame(() => {
      const el = reveal(id, false)
      if (el) pinMain(el)
    })
  })

  // Back in the page after another view was on screen (this also runs on the first visit, which
  // is skipped here). The shell has placed <main> by now: a return stays there.
  onActivated(() => {
    const arrival = view.arrival.value
    if (!arrival || arrival.seq === handled) return
    handled = arrival.seq
    if (arrival.kind !== 'fresh') return
    const id = hashToId(route.hash)
    const el = id ? reveal(id, false) : null
    if (el) pinMain(el)
  })

  // Leaving: a highlight that is still on, or a jump that still has to happen, must not show up
  // when the view comes back.
  function settle() {
    cancelAnimationFrame(frame)
    clearTimeout(timer)
    highlighted.value = null
  }
  view.onLeave(settle)
  onBeforeUnmount(settle)

  const nav: AnchorNavigator = { highlighted, goTo }
  provide(KEY, nav)
  return nav
}

/** The view's anchor navigator, or null outside the Verzamelingen view. */
export function useAnchorNavigator(): AnchorNavigator | null {
  return inject(KEY, null)
}
