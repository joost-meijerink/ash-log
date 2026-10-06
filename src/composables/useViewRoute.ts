// A view's own route. The three views stay alive while another one is on screen (<KeepAlive> in
// App.vue), but useRoute() is global: read it in a view that is not on screen and you get the
// route of another view. So a view, and everything inside it, reads its route here instead.
//
//   const view = provideViewRoute('quests')   // once, first thing in the view's setup
//   const view = useViewRoute()               // in the view's composables and child components
//   const active = useViewActive()            // shared components that only ask: is my view on screen?
//
// `view.route` has the shape of useRoute() and follows the router only while the route belongs to
// this view; otherwise it keeps its last value. It never holds another view's route, not even for
// a sync watcher: the switch happens in the navigation itself (src/stores/viewMemory.ts).
//
// Outside the three views (a component mounted on its own, a router without named view routes)
// useViewRoute() follows the global route and is always active.

import {
  computed,
  getCurrentInstance,
  getCurrentScope,
  inject,
  onScopeDispose,
  provide,
  shallowReactive,
  type ComponentInternalInstance,
  type ComputedRef,
  type InjectionKey,
} from 'vue'
import { useRouter, type RouteLocationNormalizedLoaded, type RouteLocationRaw, type Router } from 'vue-router'
import { useViewMemoryStore, type MainPosition, type ViewArrival, type ViewName } from '@/stores/viewMemory'

export interface ViewRoute {
  /** The view this belongs to; null outside the three views. */
  readonly name: ViewName | null
  /** Like useRoute(), for this view only: keeps its last value while another view is on screen. */
  readonly route: RouteLocationNormalizedLoaded
  /**
   * True while the current route belongs to this view. It flips inside the navigation, so before
   * any watcher, render or activation hook. On the way in the view's DOM is back in the page from
   * onActivated on, not yet in a watcher that runs before the render.
   */
  readonly active: ComputedRef<boolean>
  /** The last switch to this view ('return' or 'fresh'); null outside the three views. */
  readonly arrival: ComputedRef<ViewArrival | null>
  /**
   * router.replace() that does nothing while this view is not on screen, or while a navigation to
   * another view is on its way (it would cancel that one). What could not be written then has to
   * be brought in line when the view is back.
   */
  replace(to: RouteLocationRaw): ReturnType<Router['replace']>
  /** router.push() with the same limits as replace(). */
  push(to: RouteLocationRaw): ReturnType<Router['push']>
  /**
   * Runs inside the navigation that leaves this view, while its DOM is still in the page (after
   * that it is detached and scroll positions are gone). Read, do not navigate. Removed with the
   * component that registered it, and at the latest with the view.
   */
  onLeave(hook: () => void): void
  /**
   * Where <main> goes for this view: 'top', 'saved' (where this view left it) or a pixel offset.
   * The shell restores the saved position on a return and goes to the top on a fresh navigation;
   * this overrides that, whether it is called before or after the shell did its part.
   */
  scrollMain(position: MainPosition): void
}

const KEY: InjectionKey<ViewRoute> = Symbol('ashenfall-view-route')
/** provide() is not visible to inject() in the same component, so the view itself is looked up here. */
const ownContext = new WeakMap<ComponentInternalInstance, ViewRoute>()

const ROUTE_KEYS = ['fullPath', 'path', 'query', 'hash', 'name', 'params', 'matched', 'meta', 'redirectedFrom'] as const

/** An object like the one useRoute() returns, reading from `source` on every access. */
function routeView(source: () => RouteLocationNormalizedLoaded): RouteLocationNormalizedLoaded {
  const out = {}
  for (const key of ROUTE_KEYS) Object.defineProperty(out, key, { get: () => source()[key], enumerable: true })
  return shallowReactive(out) as RouteLocationNormalizedLoaded
}

function followGlobal(router: Router, name: ViewName | null): ViewRoute {
  return {
    name,
    route: routeView(() => router.currentRoute.value),
    active: computed(() => true),
    arrival: computed(() => null),
    replace: (to) => router.replace(to),
    push: (to) => router.push(to),
    onLeave: () => undefined,
    scrollMain: () => undefined,
  }
}

/**
 * Sets up the own route of a view and shares it with everything inside the view.
 * Call it once, first thing in the setup of QuestsView, MapView or CollectionsView.
 */
export function provideViewRoute(name: ViewName): ViewRoute {
  const router = useRouter()
  let ctx: ViewRoute
  if (!router.hasRoute(name)) {
    // A router without this view (a component test): nothing to keep apart.
    ctx = followGlobal(router, name)
  } else {
    const memory = useViewMemoryStore()
    memory.attach(router)
    memory.mount(name)
    /** Leave hooks still registered; all of them go when the view itself goes. */
    const hooks = new Set<() => void>()
    onScopeDispose(() => {
      memory.unmount(name)
      for (const remove of hooks) remove()
    })
    const active = computed(() => memory.active === name)
    /** The address is this view's to write: it is on screen and not on its way out. */
    const mayNavigate = () => active.value && !memory.isLeaving(name)
    ctx = {
      name,
      route: routeView(() => memory.routes[name] ?? router.currentRoute.value),
      active,
      arrival: computed(() => memory.arrivals[name]),
      replace: (to) => (mayNavigate() ? router.replace(to) : Promise.resolve(undefined)),
      push: (to) => (mayNavigate() ? router.push(to) : Promise.resolve(undefined)),
      onLeave: (hook) => {
        const stop = memory.onLeave(name, hook)
        const remove = () => {
          stop()
          hooks.delete(remove)
        }
        hooks.add(remove)
        // Registered by a component inside the view: gone when that component is.
        if (getCurrentScope()) onScopeDispose(remove)
      },
      scrollMain: (position) => memory.scrollMain(name, position),
    }
  }
  const instance = getCurrentInstance()
  if (instance) ownContext.set(instance, ctx)
  // Focus must not stay behind in a view that leaves the page. Not every browser sends a blur for
  // an element that is taken out of the document, and whatever listens for that blur keeps going:
  // Leaflet keeps its keydown listener on the document (and swallows 6, -, = and the arrow keys
  // everywhere), a tooltip that was opened by focus stays up. So let go of the focus here, in the
  // navigation, while the view is still in the page. A click on a header tab moved it already.
  ctx.onLeave(() => {
    const root = instance?.proxy?.$el as Node | null | undefined
    const focused = document.activeElement
    if (focused && focused !== document.body && root?.contains(focused)) (focused as HTMLElement).blur?.()
  })
  provide(KEY, ctx)
  return ctx
}

const ALWAYS = computed(() => true)

/**
 * Whether the view this component lives in is on screen. Always true outside the three views.
 * For shared components that only need this (no router is needed for it): anything they draw in
 * the body (a tooltip) has to go when their view does.
 */
export function useViewActive(): ComputedRef<boolean> {
  const instance = getCurrentInstance()
  const own = instance ? ownContext.get(instance) : undefined
  return (own ?? inject(KEY, null))?.active ?? ALWAYS
}

/** The own route of the view this component lives in. Works in the view itself and anywhere below it. */
export function useViewRoute(): ViewRoute {
  const instance = getCurrentInstance()
  const own = instance ? ownContext.get(instance) : undefined
  return own ?? inject(KEY, null) ?? followGlobal(useRouter(), null)
}
