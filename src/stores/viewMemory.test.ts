// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { router as appRouter } from '@/router'
import { isViewName, sameLocation, TAB_REPEAT_MS, useViewMemoryStore, VIEW_NAMES, VIEW_PATHS } from './viewMemory'

const page = { render: () => null }

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/quests' },
      { path: '/quests/:questId?', name: 'quests', component: page },
      { path: '/map', name: 'map', component: page },
      { path: '/collections', name: 'collections', component: page },
      { path: '/los', name: 'other', component: page },
      { path: '/:pathMatch(.*)*', redirect: '/quests' },
    ],
  })
}

/** A store that follows a fresh router from before its first navigation, like main.ts does. */
function setup() {
  const router = testRouter()
  const memory = useViewMemoryStore()
  memory.attach(router)
  return { router, memory }
}

/** The header tab of a view: announce, then go where the tab links to. */
async function tab(router: Router, memory: ReturnType<typeof useViewMemoryStore>, view: (typeof VIEW_NAMES)[number]) {
  const to = memory.linkTo(view)
  memory.announceReturn(view)
  await router.push(to)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('view memory: locations and own routes', () => {
  it('knows the three views and where they live', () => {
    expect(VIEW_NAMES).toEqual(['quests', 'map', 'collections'])
    expect(isViewName('map')).toBe(true)
    expect(isViewName('other')).toBe(false)
    expect(isViewName(undefined)).toBe(false)
    const router = testRouter()
    for (const name of VIEW_NAMES) expect(router.resolve(VIEW_PATHS[name]).name).toBe(name)
  })

  it('matches the routes of the app: every view is a named route at its base path', () => {
    for (const name of VIEW_NAMES) {
      expect(appRouter.hasRoute(name)).toBe(true)
      expect(appRouter.resolve(VIEW_PATHS[name]).name).toBe(name)
    }
    expect(appRouter.resolve('/quests/First%20Steps?q=a').name).toBe('quests')
  })

  it('starts empty and takes the first navigation, through a redirect, as a fresh first arrival', async () => {
    const { router, memory } = setup()
    expect(memory.active).toBeNull()
    expect(memory.arrival).toBeNull()
    expect(memory.locations).toEqual({ quests: null, map: null, collections: null })

    await router.push('/')
    expect(memory.active).toBe('quests')
    expect(memory.locations.quests).toBe('/quests')
    expect(memory.routes.quests).toBe(router.currentRoute.value)
    expect(memory.arrival).toEqual({ seq: 1, view: 'quests', from: null, kind: 'fresh', via: 'link', first: true, fullPath: '/quests' })
    expect(memory.arrivals.quests).toBe(memory.arrival)
    expect(memory.arrivals.map).toBeNull()
  })

  it('follows navigation inside a view (replace and push) without a new arrival', async () => {
    const { router, memory } = setup()
    await router.push('/quests')
    const first = memory.arrival
    // The default quest, as the view does it.
    await router.replace('/quests/First%20Steps')
    expect(memory.locations.quests).toBe('/quests/First%20Steps')
    await router.replace({ query: { q: 'rune' } })
    expect(memory.locations.quests).toBe('/quests/First%20Steps?q=rune')
    await router.push('/quests/Rune%20Mysteries?q=rune')
    expect(memory.locations.quests).toBe('/quests/Rune%20Mysteries?q=rune')
    expect(memory.routes.quests).toBe(router.currentRoute.value)
    expect(memory.arrival).toBe(first)
  })

  it('keeps the own route of a view while another view is on screen', async () => {
    const { router, memory } = setup()
    await router.push('/quests/First%20Steps?q=rune')
    const questsRoute = memory.routes.quests
    await router.push('/map?focus=a')
    await router.replace('/map?focus=a&c=vaults')
    expect(memory.active).toBe('map')
    expect(memory.routes.quests).toBe(questsRoute)
    expect(memory.routes.quests?.fullPath).toBe('/quests/First%20Steps?q=rune')
    expect(memory.routes.map?.fullPath).toBe('/map?focus=a&c=vaults')
    expect(memory.locations).toEqual({ quests: '/quests/First%20Steps?q=rune', map: '/map?focus=a&c=vaults', collections: null })
  })

  it('has no active view on a route outside the three views', async () => {
    const { router, memory } = setup()
    await router.push('/map')
    await router.push('/los')
    expect(memory.active).toBeNull()
    expect(memory.arrival?.view).toBe('map')
    await router.push('/map')
    expect(memory.arrival).toMatchObject({ seq: 2, view: 'map', from: null })
  })

  it('picks up the current route when it is attached after the first navigation, and attaches once', async () => {
    const router = testRouter()
    await router.push('/map?c=vaults')
    const memory = useViewMemoryStore()
    memory.attach(router)
    memory.attach(router)
    expect(memory.active).toBe('map')
    expect(memory.arrival).toMatchObject({ seq: 1, view: 'map', kind: 'fresh', first: true })
    await router.push('/quests')
    expect(memory.arrival).toMatchObject({ seq: 2, view: 'quests', from: 'map' })
  })

  it('lets go of a router when it is attached to another one', async () => {
    const { router, memory } = setup()
    await router.push('/map')
    const other = testRouter()
    memory.attach(other)
    await router.push('/collections')
    expect(memory.active).toBe('map')
    await other.push('/quests')
    expect(memory.active).toBe('quests')
  })
})

describe('view memory: return or fresh', () => {
  async function questsThenMap() {
    const ctx = setup()
    await ctx.router.push('/quests/First%20Steps?q=rune')
    ctx.memory.mount('quests')
    await ctx.router.push('/map?quest=First%20Steps')
    ctx.memory.mount('map')
    return ctx
  }

  it('a header tab to a mounted view at its remembered location is a return; its route stays the same object', async () => {
    const { router, memory } = await questsThenMap()
    const questsRoute = memory.routes.quests
    await tab(router, memory, 'quests')
    expect(router.currentRoute.value.fullPath).toBe('/quests/First%20Steps?q=rune')
    expect(memory.arrival).toEqual({
      seq: 3,
      view: 'quests',
      from: 'map',
      kind: 'return',
      via: 'tab',
      first: false,
      fullPath: '/quests/First%20Steps?q=rune',
    })
    expect(memory.routes.quests).toBe(questsRoute)
    expect(memory.routes.quests).not.toBe(router.currentRoute.value)
  })

  it('a link to another address of the view is fresh and the own route follows', async () => {
    const { router, memory } = await questsThenMap()
    await router.push('/quests/Rune%20Mysteries')
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'fresh', via: 'link', first: false })
    expect(memory.routes.quests).toBe(router.currentRoute.value)
    expect(memory.locations.quests).toBe('/quests/Rune%20Mysteries')
  })

  it('a link to exactly the remembered address is still fresh: its target is handled again', async () => {
    const { router, memory } = await questsThenMap()
    await tab(router, memory, 'quests')
    const mapRoute = memory.routes.map
    // 'Show on map' for the same quest as before.
    await router.push('/map?quest=First%20Steps')
    expect(memory.arrival).toMatchObject({ view: 'map', kind: 'fresh', via: 'link', first: false })
    // Same address: the own route object stays, so only the arrival tells the view about it.
    expect(memory.routes.map).toBe(mapRoute)
  })

  it('a view that is not mounted cannot be returned to', async () => {
    const { router, memory } = setup()
    await router.push('/quests/First%20Steps')
    await router.push('/map')
    await tab(router, memory, 'quests')
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'fresh', via: 'tab', first: true })

    // Mounted, then gone again (the views are dropped when the shell shows another screen).
    memory.mount('quests')
    await tab(router, memory, 'map')
    memory.unmount('quests')
    await tab(router, memory, 'quests')
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'fresh', first: true })
    expect(memory.routes.quests?.fullPath).toBe(router.currentRoute.value.fullPath)
  })

  it('an announced tab that goes somewhere else does not make a later link a return', async () => {
    const { router, memory } = await questsThenMap()
    memory.announceReturn('quests')
    await router.push('/quests/Rune%20Mysteries')
    expect(memory.arrival).toMatchObject({ kind: 'fresh', via: 'link' })
    await router.push('/map')
    await router.push('/quests/Rune%20Mysteries')
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'fresh', via: 'link' })
  })

  it('an announced tab whose navigation is cancelled is forgotten', async () => {
    const { router, memory } = await questsThenMap()
    const stop = router.beforeEach(() => false)
    memory.announceReturn('quests')
    await router.push('/quests/First%20Steps?q=rune')
    stop()
    expect(memory.active).toBe('map')
    await router.push('/quests/First%20Steps?q=rune')
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'fresh', via: 'link' })
  })

  it('the tab of the active view is never a return', async () => {
    const { router, memory } = await questsThenMap()
    expect(memory.linkTo('map')).toBe('/map')
    const before = memory.arrival
    await tab(router, memory, 'map')
    expect(router.currentRoute.value.fullPath).toBe('/map')
    expect(memory.arrival).toBe(before)
    expect(memory.routes.map).toBe(router.currentRoute.value)
    expect(memory.locations.map).toBe('/map')
  })

  it('back and forward: the remembered location is a return, another one is fresh', async () => {
    const { router, memory } = setup()
    await router.push('/quests/A')
    memory.mount('quests')
    await router.push('/quests/B')
    await router.push('/map?focus=p1')
    memory.mount('map')

    router.back()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests/B')
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'return', via: 'history' })

    // Inside the view: no switch.
    const seq = memory.arrival!.seq
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests/A')
    expect(memory.arrival!.seq).toBe(seq)
    expect(memory.locations.quests).toBe('/quests/A')

    router.go(2)
    await flushPromises()
    expect(memory.arrival).toMatchObject({ view: 'map', kind: 'return', via: 'history', fullPath: '/map?focus=p1' })

    // The entry before it is /quests/B, but quests was left at /quests/A.
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests/B')
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'fresh', via: 'history', first: false })
    expect(memory.routes.quests).toBe(router.currentRoute.value)
  })
})

describe('view memory: the same place written differently', () => {
  it('compares name, params, query and hash, not the spelling of the address', () => {
    const router = testRouter()
    const at = (to: string) => router.resolve(to)
    expect(sameLocation(at("/quests/A?q=it's"), at('/quests/A?q=it%27s'))).toBe(true)
    expect(sameLocation(at('/quests/Mirror%2C%20Mirror'), at('/quests/Mirror,%20Mirror'))).toBe(true)
    expect(sameLocation(at('/map?c=a&c=b#x'), at('/map?c=a&c=b#x'))).toBe(true)
    expect(sameLocation(at('/map?c=a&c=b'), at('/map?c=b&c=a'))).toBe(false)
    expect(sameLocation(at('/map?c=a'), at('/map?c=a&p=1'))).toBe(false)
    expect(sameLocation(at('/map?c=a'), at('/map?c'))).toBe(false)
    expect(sameLocation(at('/quests/A'), at('/quests/B'))).toBe(false)
    expect(sameLocation(at('/quests/A'), at('/quests'))).toBe(false)
    expect(sameLocation(at('/collections#vault-a'), at('/collections#vault-b'))).toBe(false)
    expect(sameLocation(at('/map'), at('/collections'))).toBe(false)
  })

  it('back to a history entry that the browser spelled differently is still a return', async () => {
    const { router, memory } = setup()
    await router.push({ path: '/quests/A', query: { q: "it's" } })
    memory.mount('quests')
    const questsRoute = memory.routes.quests
    expect(questsRoute?.fullPath).toBe("/quests/A?q=it's")
    await router.push('/map')
    memory.mount('map')

    // What a browser makes of that entry: the quote escaped. Put it in the history and go back to it.
    const history = router.options.history
    history.push('/quests/A?q=it%27s')
    history.push('/map')
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/quests/A?q=it%27s')
    expect(memory.arrival).toMatchObject({ view: 'quests', kind: 'return', via: 'history' })
    expect(memory.routes.quests).toBe(questsRoute)
    // The tab links to the address as the browser has it now.
    expect(memory.locations.quests).toBe('/quests/A?q=it%27s')
  })
})

describe('view memory: timing', () => {
  it('is up to date inside the navigation: for sync watchers on the route and for afterEach', async () => {
    const { router, memory } = setup()
    const seen: string[] = []
    const snapshot = (who: string) =>
      seen.push(`${who} ${router.currentRoute.value.fullPath} active=${memory.active} kind=${memory.arrival?.kind} loc=${memory.locations.map}`)
    const stop = watch(router.currentRoute, () => snapshot('sync'), { flush: 'sync' })
    router.afterEach(() => void snapshot('after'))

    await router.push('/quests')
    memory.mount('quests')
    await router.push('/map?c=vaults')
    memory.mount('map')
    await tab(router, memory, 'quests')
    await tab(router, memory, 'map')
    stop()

    expect(seen).toEqual([
      'sync /quests active=quests kind=fresh loc=null',
      'after /quests active=quests kind=fresh loc=null',
      'sync /map?c=vaults active=map kind=fresh loc=/map?c=vaults',
      'after /map?c=vaults active=map kind=fresh loc=/map?c=vaults',
      'sync /quests active=quests kind=return loc=/map?c=vaults',
      'after /quests active=quests kind=return loc=/map?c=vaults',
      'sync /map?c=vaults active=map kind=return loc=/map?c=vaults',
      'after /map?c=vaults active=map kind=return loc=/map?c=vaults',
    ])
  })

  it('runs leave hooks inside the navigation, while the old view still counts as active', async () => {
    const { router, memory } = setup()
    await router.push('/quests')
    const calls: string[] = []
    const remove = memory.onLeave('quests', () => calls.push(`quests active=${memory.active}`))
    memory.onLeave('map', () => calls.push('map'))
    memory.onLeave('quests', () => {
      throw new Error('broken hook')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await router.replace('/quests/A')
    expect(calls).toEqual([])
    await router.push('/map')
    expect(calls).toEqual(['quests active=quests'])
    // A broken hook does not stop the navigation or the other hooks.
    expect(error).toHaveBeenCalledTimes(1)
    expect(memory.active).toBe('map')

    remove()
    await router.push('/quests')
    expect(calls).toEqual(['quests active=quests', 'map'])
    await router.push('/map')
    expect(calls).toEqual(['quests active=quests', 'map'])
    error.mockRestore()
  })
})

describe('view memory: header links', () => {
  it('links to the base path without a memory, and for the view you are on', async () => {
    const { router, memory } = setup()
    expect(VIEW_NAMES.map((v) => memory.linkTo(v))).toEqual(['/quests', '/map', '/collections'])
    await router.push('/quests/First%20Steps?q=rune')
    expect(VIEW_NAMES.map((v) => memory.linkTo(v))).toEqual(['/quests', '/map', '/collections'])
  })

  it('links to where another view was left, hash included', async () => {
    const { router, memory } = setup()
    await router.push('/quests/First%20Steps?q=rune')
    await router.push('/collections?kind=spell#vault-a')
    expect(VIEW_NAMES.map((v) => memory.linkTo(v))).toEqual(['/quests/First%20Steps?q=rune', '/map', '/collections'])
    await router.push('/map')
    expect(memory.linkTo('collections')).toBe('/collections?kind=spell#vault-a')
    // The link resolves to exactly the remembered address.
    expect(router.resolve(memory.linkTo('collections')).fullPath).toBe(memory.locations.collections)
    expect(router.resolve(memory.linkTo('quests')).fullPath).toBe(memory.locations.quests)
  })
})

describe('view memory: a second click on the tab that just brought a view back', () => {
  it('knows for a short while that a tab brought the view on screen', async () => {
    const { router, memory } = setup()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    await router.push('/quests/A?q=rune')
    expect(memory.cameByTab('quests')).toBe(false)
    await router.push('/map')
    await tab(router, memory, 'quests')
    expect(memory.arrival).toMatchObject({ view: 'quests', via: 'tab' })
    expect(memory.cameByTab('quests')).toBe(true)
    // Only for the view that is on screen now.
    expect(memory.cameByTab('map')).toBe(false)
    now.mockReturnValue(1_000_000 + TAB_REPEAT_MS - 1)
    expect(memory.cameByTab('quests')).toBe(true)
    now.mockReturnValue(1_000_000 + TAB_REPEAT_MS)
    expect(memory.cameByTab('quests')).toBe(false)
    now.mockRestore()
  })

  it('does not count a link or back and forward', async () => {
    const { router, memory } = setup()
    await router.push('/quests/A')
    await router.push('/map?focus=p1')
    expect(memory.cameByTab('map')).toBe(false)
    router.back()
    await flushPromises()
    expect(memory.arrival).toMatchObject({ view: 'quests', via: 'history' })
    expect(memory.cameByTab('quests')).toBe(false)
    // A tab long ago, the view left and reached again by a link: not by a tab.
    await tab(router, memory, 'map')
    expect(memory.cameByTab('map')).toBe(true)
    await router.push('/quests/B')
    await router.push('/map?focus=p2')
    expect(memory.cameByTab('map')).toBe(false)
  })
})

describe('view memory: a navigation to another view that is on its way', () => {
  /** A view whose code is still loading: the navigation to it waits for `loaded()`. */
  function slowRouter() {
    let loaded!: () => void
    const router = testRouter()
    router.addRoute({ path: '/slow', name: 'collections', component: () => new Promise((resolve) => (loaded = () => resolve(page))) })
    const memory = useViewMemoryStore()
    memory.attach(router)
    return { router, memory, loaded: () => loaded() }
  }

  it('says that the view on screen is being left, until the navigation lands', async () => {
    const { router, memory, loaded } = slowRouter()
    await router.push('/quests/A')
    expect(memory.isLeaving('quests')).toBe(false)
    const going = router.push('/slow')
    await flushPromises()
    expect(memory.active).toBe('quests')
    expect(memory.isLeaving('quests')).toBe(true)
    expect(memory.isLeaving('collections')).toBe(false)
    loaded()
    await going
    expect(memory.active).toBe('collections')
    expect(memory.isLeaving('quests')).toBe(false)
  })

  it('forgets it when a newer navigation inside the view takes its place', async () => {
    const { router, memory } = slowRouter()
    await router.push('/quests/A')
    void router.push('/slow')
    await flushPromises()
    expect(memory.isLeaving('quests')).toBe(true)
    // You click a quest while the other view is still loading.
    await router.push('/quests/B')
    expect(router.currentRoute.value.fullPath).toBe('/quests/B')
    expect(memory.isLeaving('quests')).toBe(false)
  })

  it('forgets it when the navigation is refused or fails', async () => {
    const { router, memory } = setup()
    await router.push('/quests/A')
    const stop = router.beforeEach((to) => (to.name === 'map' ? false : true))
    await router.push('/map')
    expect(memory.active).toBe('quests')
    expect(memory.isLeaving('quests')).toBe(false)
    stop()

    router.addRoute({ path: '/broken', name: 'collections', component: () => Promise.reject(new Error('no chunk')) })
    router.onError(() => undefined)
    await router.push('/broken').catch(() => undefined)
    expect(memory.active).toBe('quests')
    expect(memory.isLeaving('quests')).toBe(false)
  })

  it('is not set by navigation inside a view', async () => {
    const { router, memory } = setup()
    await router.push('/quests/A')
    const seen: boolean[] = []
    router.beforeResolve(() => {
      seen.push(memory.isLeaving('quests'))
    })
    await router.push('/quests/B?q=a')
    await router.replace({ query: { q: 'ab' } })
    expect(seen).toEqual([false, false])
  })
})

describe('view memory: the scroll position of main', () => {
  async function withMain() {
    const ctx = setup()
    const main = document.createElement('main')
    await ctx.router.push('/quests/A')
    ctx.memory.mount('quests')
    ctx.memory.setMain(main)
    return { ...ctx, main }
  }

  it('saves the position of the view that is left and restores it on a return', async () => {
    const { router, memory, main } = await withMain()
    main.scrollTop = 300
    await router.push('/map')
    memory.mount('map')
    expect(memory.savedMain('quests')).toBe(300)
    // Not before the shell says the new view is in the page.
    expect(main.scrollTop).toBe(300)
    memory.settleMain()
    expect(main.scrollTop).toBe(0)

    main.scrollTop = 40
    await tab(router, memory, 'quests')
    memory.settleMain()
    expect(main.scrollTop).toBe(300)
    expect(memory.savedMain('map')).toBe(40)

    await tab(router, memory, 'map')
    memory.settleMain()
    expect(main.scrollTop).toBe(40)
  })

  it('goes to the top on a fresh navigation and leaves navigation inside a view alone', async () => {
    const { router, memory, main } = await withMain()
    main.scrollTop = 300
    await router.replace('/quests/A?q=x')
    await router.push('/quests/B')
    memory.settleMain()
    expect(main.scrollTop).toBe(300)

    await router.push('/map')
    memory.mount('map')
    memory.settleMain()
    await router.push('/quests/C')
    memory.settleMain()
    expect(main.scrollTop).toBe(0)
    expect(memory.savedMain('quests')).toBe(300)
  })

  it('settles once per arrival', async () => {
    const { router, memory, main } = await withMain()
    await router.push('/map')
    memory.settleMain()
    main.scrollTop = 120
    memory.settleMain()
    expect(main.scrollTop).toBe(120)
  })

  it('lets the view decide, before and after the shell settled', async () => {
    const { router, memory, main } = await withMain()
    main.scrollTop = 300
    await router.push('/map')
    memory.mount('map')
    memory.settleMain()

    // Before: a return that should not restore.
    await tab(router, memory, 'quests')
    memory.scrollMain('quests', 'top')
    expect(main.scrollTop).toBe(0)
    memory.settleMain()
    expect(main.scrollTop).toBe(0)
    expect(memory.savedMain('quests')).toBe(300)

    // After: at once.
    memory.scrollMain('quests', 'saved')
    expect(main.scrollTop).toBe(300)
    memory.scrollMain('quests', 75)
    expect(main.scrollTop).toBe(75)

    // Before, on a fresh navigation that keeps the place.
    await tab(router, memory, 'map')
    memory.settleMain()
    await router.push('/quests/B')
    memory.scrollMain('quests', 'saved')
    memory.settleMain()
    expect(main.scrollTop).toBe(75)
  })

  it('ignores a view that is not on screen, and a wish for an older arrival', async () => {
    const { router, memory, main } = await withMain()
    main.scrollTop = 300
    memory.scrollMain('map', 10)
    expect(main.scrollTop).toBe(300)

    await router.push('/map')
    memory.mount('map')
    memory.scrollMain('map', 55)
    // The wish was for the arrival at the map; quests arrives before the shell got to it.
    await tab(router, memory, 'quests')
    memory.settleMain()
    expect(main.scrollTop).toBe(300)
  })

  it('settles a waiting arrival when main is registered, and does nothing without main', async () => {
    const { router, memory } = setup()
    await router.push('/quests')
    memory.scrollMain('quests', 90)
    memory.settleMain()
    const main = document.createElement('main')
    memory.setMain(main)
    expect(main.scrollTop).toBe(90)

    memory.setMain(null)
    await router.push('/map')
    memory.settleMain()
    memory.scrollMain('map', 5)
    expect(main.scrollTop).toBe(90)
    expect(memory.savedMain('quests')).toBe(0)
  })
})
