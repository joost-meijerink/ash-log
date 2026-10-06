// What the three views (quests, map, collections) need to pick up where they were left, in memory
// only (nothing is written to disk). The views stay alive (<KeepAlive> in App.vue); this store
// follows the router and keeps, per view:
//   - its last location (fullPath), where the header tab of another view links to;
//   - its own route: the global route is shared, so a view that is not on screen must never see
//     the route of another view (see src/composables/useViewRoute.ts);
//   - how it was reached last: a return to where it was left, or a fresh navigation;
//   - the scroll position of <main>, which all views share.
//
// Timing: everything here changes inside the navigation itself (a sync watcher on the router's
// current route, registered before the app mounts), so watchers, renders and activation hooks of
// the views always see the new state.

import { defineStore } from 'pinia'
import { effectScope, reactive, shallowReactive, shallowRef, watch } from 'vue'
import { START_LOCATION, type RouteLocationNormalized, type RouteLocationNormalizedLoaded, type Router } from 'vue-router'

export const VIEW_NAMES = ['quests', 'map', 'collections'] as const
export type ViewName = (typeof VIEW_NAMES)[number]

/** Where each view lives; the tab of the view you are on links here. Route names: see src/router.ts. */
export const VIEW_PATHS: Readonly<Record<ViewName, string>> = {
  quests: '/quests',
  map: '/map',
  collections: '/collections',
}

export function isViewName(name: unknown): name is ViewName {
  return typeof name === 'string' && (VIEW_NAMES as readonly string[]).includes(name)
}

/** One switch to a view: from another view, or the first navigation of the session. */
export interface ViewArrival {
  /** Counts up with every switch, over all views. */
  readonly seq: number
  readonly view: ViewName
  /** The view that was left; null on the first navigation. */
  readonly from: ViewName | null
  /**
   * 'return': back where the view was left (the header tab, or back/forward to its remembered
   * location). The view restores and does nothing else; its own route did not change.
   * 'fresh': a link with a target, or no view to come back to. The target is handled as always.
   */
  readonly kind: 'return' | 'fresh'
  /** How the navigation started: a header tab, the browser's back/forward, or anything else. */
  readonly via: 'tab' | 'history' | 'link'
  /** No view was mounted to come back to: it is created for this arrival. */
  readonly first: boolean
  readonly fullPath: string
}

/**
 * How long after a header tab brought a view back a click on that same tab is taken for the
 * second click of a double click (or an impatient second tap) instead of a wish for the base path.
 */
export const TAB_REPEAT_MS = 500

/** Where <main> ends up: at the top, where this view left it, or at a pixel offset. */
export type MainPosition = 'top' | 'saved' | number

/** The parts of a route location that say where it is (a current route, or what router.resolve() returns). */
type Place = Pick<RouteLocationNormalizedLoaded, 'fullPath' | 'hash' | 'params' | 'query'> & { name?: unknown }

function sameValue(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && sameValue(a[k], b[k]))
}

/**
 * The same place, however the address is written: a browser escapes a few characters more than
 * the router does (a quote in a search text), so the fullPath of a history entry can differ from
 * the one that was pushed.
 */
export function sameLocation(a: Place, b: Place): boolean {
  if (a.fullPath === b.fullPath) return true
  return a.name === b.name && a.hash === b.hash && sameRecord(a.params, b.params) && sameRecord(a.query, b.query)
}

type PerView<T> = Record<ViewName, T>
const perView = <T>(make: () => T): PerView<T> => ({ quests: make(), map: make(), collections: make() })

export const useViewMemoryStore = defineStore('viewMemory', () => {
  /** The view of the current route; null before the first navigation. */
  const active = shallowRef<ViewName | null>(null)
  /** Last location (fullPath) of each view, updated on every navigation inside it. */
  const locations = reactive(perView<string | null>(() => null))
  /** Each view's own route: follows the router only while the route belongs to that view. */
  const routes = shallowReactive(perView<RouteLocationNormalizedLoaded | null>(() => null))
  /** The last switch between views. */
  const arrival = shallowRef<ViewArrival | null>(null)
  /** The last switch to each view. */
  const arrivals = shallowReactive(perView<ViewArrival | null>(() => null))

  let seq = 0
  /** Mounted instances per view (a counter, so a hot reload cannot leave it wrong). */
  const mounted = perView(() => 0)
  const leaveHooks = perView(() => new Set<() => void>())
  /** A navigation that may be a return: announced by a header tab, or seen coming from the history. */
  let expected: { fullPath: string; via: 'tab' | 'history' } | null = null
  /** The last time a header tab switched to a view. */
  let tabArrival: { view: ViewName; at: number } | null = null
  /**
   * A navigation to another view that is under way: its guards run, or the code of a view that was
   * not shown before is still loading. The view that is being left is on screen until it lands.
   */
  let leaving: { view: ViewName; to: RouteLocationNormalized } | null = null

  let mainEl: HTMLElement | null = null
  const mainSaved = perView(() => 0)
  /** The arrival whose <main> position has been applied. */
  let settledSeq = 0
  /** A view's own wish for <main>, made before the shell applied the position for that arrival. */
  let wish: { seq: number; position: MainPosition } | null = null

  const viewOf = (route: { name?: unknown }): ViewName | null => (isViewName(route.name) ? route.name : null)

  /* ---------------- following the router ---------------- */

  let attached: Router | null = null
  let detach: (() => void) | null = null

  /**
   * Start following a router. Safe to call more than once. Call it before the router starts its
   * first navigation (src/main.ts), so this store is updated before anything else reacts.
   */
  function attach(router: Router) {
    if (attached === router) return
    detach?.()
    attached = router
    // Detached: whoever calls this first (a component, in tests) must not take the watcher along
    // when it unmounts.
    const scope = effectScope(true)
    scope.run(() => watch(router.currentRoute, onRoute, { flush: 'sync' }))
    const stops = [
      // Back and forward. The router resolves the location the same way.
      router.options.history.listen((to) => {
        expected = { fullPath: router.resolve(to).fullPath, via: 'history' }
      }),
      // A navigation that leaves the current view starts. A newer one takes its place.
      router.beforeEach((to, from) => {
        const view = viewOf(from)
        leaving = view && viewOf(to) !== view ? { view, to } : null
      }),
      // Also runs for a navigation that failed or was cancelled by a newer one.
      router.afterEach((to) => {
        // An announced navigation that ended without changing the route (cancelled, failed).
        if (expected?.fullPath === to.fullPath) expected = null
        if (leaving?.to === to) leaving = null
      }),
      router.onError(() => {
        expected = null
        leaving = null
      }),
    ]
    detach = () => {
      scope.stop()
      for (const stop of stops) stop()
      attached = null
      detach = null
      leaving = null
    }
    // Attached late (tests): take the route that is already there as the first navigation.
    const now = router.currentRoute.value
    if (now !== START_LOCATION) onRoute(now, START_LOCATION)
  }

  function onRoute(to: RouteLocationNormalizedLoaded, from: RouteLocationNormalizedLoaded) {
    const toView = viewOf(to)
    const fromView = viewOf(from)
    const via = expected && expected.fullPath === to.fullPath ? expected.via : 'link'
    expected = null
    const switched = fromView !== toView

    // The view that is left is still in the page here: last chance to read its DOM.
    if (fromView && switched) leave(fromView)

    if (!toView) {
      active.value = null
      return
    }
    const alive = mounted[toView] > 0
    // The view's own route is its remembered location.
    const known = routes[toView]
    const same = !!known && sameLocation(known, to)
    const back = switched && alive && via !== 'link' && same
    // The same place leaves the view's route untouched, so on a return none of its route watchers fire.
    if (!same) routes[toView] = to
    locations[toView] = to.fullPath
    if (switched) {
      const next: ViewArrival = Object.freeze({
        seq: ++seq,
        view: toView,
        from: fromView,
        kind: back ? 'return' : 'fresh',
        via,
        first: !alive,
        fullPath: to.fullPath,
      })
      arrivals[toView] = next
      arrival.value = next
      tabArrival = via === 'tab' ? { view: toView, at: Date.now() } : null
    }
    active.value = toView
  }

  function leave(view: ViewName) {
    if (mainEl) mainSaved[view] = mainEl.scrollTop
    for (const hook of [...leaveHooks[view]]) {
      try {
        hook()
      } catch (err) {
        console.error(err)
      }
    }
  }

  /* ---------------- for the header ---------------- */

  /** Where the header tab of a view goes: its base path when you are on it, else where it was left. */
  function linkTo(view: ViewName): string {
    if (active.value === view) return VIEW_PATHS[view]
    return locations[view] ?? VIEW_PATHS[view]
  }

  /**
   * The header tab of a view was clicked: arriving at its remembered location is a return.
   * Any other link to the same address is a fresh navigation that handles its target again.
   */
  function announceReturn(view: ViewName) {
    if (active.value === view) return
    expected = { fullPath: linkTo(view), via: 'tab' }
  }

  /**
   * A header tab brought this view on screen a moment ago. The tab now links to the base path
   * (the view is the active one), so the second click of a double click would throw away what the
   * first one just brought back: the header ignores a click on the tab while this holds.
   */
  function cameByTab(view: ViewName): boolean {
    if (active.value !== view || tabArrival?.view !== view) return false
    const age = Date.now() - tabArrival.at
    return age >= 0 && age < TAB_REPEAT_MS
  }

  /* ---------------- for the views (through useViewRoute) ---------------- */

  /**
   * This view is being left: a navigation to another view is on its way. A navigation of the view
   * itself (bringing its address in line) would cancel that one, so the tab click would be lost.
   */
  function isLeaving(view: ViewName): boolean {
    return leaving?.view === view
  }

  /** A view instance exists: from now on it can be returned to. */
  function mount(view: ViewName) {
    mounted[view]++
  }

  function unmount(view: ViewName) {
    mounted[view] = Math.max(0, mounted[view] - 1)
  }

  /**
   * Runs inside the navigation that leaves a view, while its DOM is still in the page: the
   * moment to read scroll positions. Returns a function that removes the hook.
   */
  function onLeave(view: ViewName, hook: () => void): () => void {
    leaveHooks[view].add(hook)
    return () => {
      leaveHooks[view].delete(hook)
    }
  }

  /* ---------------- <main>, the scroller all views share ---------------- */

  function applyMain(view: ViewName, position: MainPosition) {
    if (!mainEl) return
    mainEl.scrollTop = position === 'saved' ? mainSaved[view] : position === 'top' ? 0 : position
  }

  /** The shell registers <main> (and null when it goes away). */
  function setMain(el: HTMLElement | null) {
    mainEl = el
    if (el) settleMain()
  }

  /**
   * Puts <main> where it belongs for the last arrival, once: the saved position on a return, the
   * top on a fresh navigation, or what the view asked for. The shell calls this after the new
   * view is in the page.
   */
  function settleMain() {
    const a = arrival.value
    if (!mainEl || !a || settledSeq === a.seq) return
    settledSeq = a.seq
    const position = wish?.seq === a.seq ? wish.position : a.kind === 'return' ? 'saved' : 'top'
    wish = null
    applyMain(a.view, position)
  }

  /**
   * A view decides where <main> goes. Works at any moment: before the shell settled the arrival
   * it replaces the default, after that it scrolls at once. Ignored from a view that is not on screen.
   */
  function scrollMain(view: ViewName, position: MainPosition) {
    if (active.value !== view) return
    const a = arrival.value
    if (a && settledSeq !== a.seq) wish = { seq: a.seq, position }
    else applyMain(view, position)
  }

  /** The position of <main> when this view was last left (0 when it never was). */
  function savedMain(view: ViewName): number {
    return mainSaved[view]
  }

  return {
    active,
    locations,
    routes,
    arrival,
    arrivals,
    attach,
    linkTo,
    announceReturn,
    cameByTab,
    isLeaving,
    mount,
    unmount,
    onLeave,
    setMain,
    settleMain,
    scrollMain,
    savedMain,
  }
})
