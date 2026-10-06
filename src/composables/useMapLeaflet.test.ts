// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, KeepAlive, nextTick, ref, shallowRef, type VNode } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import { L } from '@/components/map/leaflet'
import type { QuestStartGroup } from '@/lib/map-links'
import { toLatLng } from '@/lib/projection'
import type { MapCategory, MapPoint } from '@/lib/types'
import { useViewMemoryStore, type ViewName } from '@/stores/viewMemory'
import { useMapLeaflet } from './useMapLeaflet'
import { provideViewRoute } from './useViewRoute'

const categories: MapCategory[] = [
  { id: 'lore-scraps', label: 'Lore Scraps', group: 'lore', sources: [], count: 2 },
  { id: 'ash-tree', label: 'Ash Tree', group: 'resource', sources: [], count: 3 },
]

function pt(categoryId: string, x: number, y: number): MapPoint {
  return { id: `${categoryId}:${x}:${y}`, categoryId, x, y }
}

const lore = [pt('lore-scraps', 1000, 2000), pt('lore-scraps', 3000, 4000)]
const trees = [pt('ash-tree', 10000, 10000), pt('ash-tree', 20000, 20000), pt('ash-tree', 30000, 30000)]

function setup() {
  const visible = shallowRef<MapPoint[]>([])
  const found = shallowRef<ReadonlySet<string>>(new Set())
  const questStarts = shallowRef<QuestStartGroup[]>([])
  const onPointClick = vi.fn()
  let api!: ReturnType<typeof useMapLeaflet>
  const Host = defineComponent({
    setup() {
      const el = ref<HTMLElement | null>(null)
      api = useMapLeaflet({
        container: el,
        visiblePoints: visible,
        categoryById: ref(new Map(categories.map((c) => [c.id, c]))),
        found,
        dataVersion: ref('v1'),
        questStarts,
        highlightQuest: ref(undefined),
        selectedPoint: ref(null),
        pinMode: ref(false),
        landExtent: ref({ minX: 0, minY: 0, maxX: 40000, maxY: 40000 }),
        onPointClick,
        onQuestStartClick: vi.fn(),
        onMapClick: vi.fn(),
      })
      return () => h('div', { ref: el, style: 'width: 800px; height: 600px' })
    },
  })
  // A router without the three views: the map follows the global route and is always on screen.
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: Host }] })
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  return { wrapper, visible, found, questStarts, onPointClick, api: () => api }
}

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('useMapLeaflet', () => {
  it('creates the map with the game CRS and cleans up on unmount', () => {
    const s = setup()
    wrapper = s.wrapper
    const map = s.api().map.value
    expect(map).toBeInstanceOf(L.Map)
    expect(map!.options.crs!.latLngToPoint(L.latLng(171786, 16773), 4).x).toBeCloseTo(407.4, 1)
    s.wrapper.unmount()
    wrapper = undefined
    expect(s.api().map.value).toBeNull()
  })

  it('adds and removes markers in bulk and builds each marker once', async () => {
    const s = setup()
    wrapper = s.wrapper
    s.visible.value = [...lore, ...trees]
    await nextTick()
    expect(s.api().stats()).toMatchObject({ built: 5, shown: 5, inCluster: 5 })

    s.visible.value = [...trees]
    await nextTick()
    expect(s.api().stats()).toMatchObject({ built: 5, shown: 3, inCluster: 3 })

    // Back on: the cached markers are reused, nothing new is built.
    s.visible.value = [...lore, ...trees.slice(0, 1)]
    await nextTick()
    expect(s.api().stats()).toMatchObject({ built: 5, shown: 3, inCluster: 3 })

    s.visible.value = []
    await nextTick()
    expect(s.api().stats()).toMatchObject({ shown: 0, inCluster: 0 })
  })

  it('dims found lore markers without rebuilding them', async () => {
    const s = setup()
    wrapper = s.wrapper
    s.visible.value = [...lore, ...trees]
    await nextTick()
    const map = s.api().map.value!
    const marker = (id: string) => {
      let found: L.Marker | undefined
      map.eachLayer((layer) => {
        if (layer instanceof L.MarkerClusterGroup) {
          for (const m of layer.getLayers() as L.Marker[]) if (m.options.title === 'Lore Scraps' && m.getLatLng().lng === Number(id)) found = m
        }
      })
      return found
    }
    const before = marker('1000')!
    expect((before.options.icon as L.DivIcon).options.className).not.toContain('is-found')

    s.found.value = new Set([lore[0]!.id])
    await nextTick()
    const after = marker('1000')!
    expect(after).toBe(before)
    expect((after.options.icon as L.DivIcon).options.className).toContain('is-found')
    expect(s.api().stats().built).toBe(5)
  })

  it('draws one pin per quest start spot', async () => {
    const s = setup()
    wrapper = s.wrapper
    const quest = { id: 'Ratcatcher', name: 'Ratcatcher', kind: 'primary', start: { x: 15183, y: 178853, source: 'wiki' } }
    s.questStarts.value = [{ key: '15183:178853', x: 15183, y: 178853, quests: [quest as never] }]
    await nextTick()
    expect(s.api().stats().questPins).toBe(1)
    s.questStarts.value = []
    await nextTick()
    expect(s.api().stats().questPins).toBe(0)
  })
})

/* ---------------- kept alive ---------------- */

/** jsdom has no layout: the map container gets this size while it is in the page, and none when detached. */
let size = { width: 800, height: 600 }
/** Callbacks of the ResizeObservers the map created. */
let resizeCallbacks: Array<() => void> = []
const fireResize = () => resizeCallbacks.forEach((cb) => cb())

class FakeResizeObserver {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const KeptViews = defineComponent({
  setup: () => () =>
    h(RouterView, null, {
      default: ({ Component }: { Component?: VNode }) => h(KeepAlive, null, { default: () => (Component ? h(Component) : null) }),
    }),
})

/** The map as a kept-alive view next to a second view, as in App.vue. */
async function keptSetup() {
  const visible = shallowRef<MapPoint[]>([...lore, ...trees])
  const dataVersion = ref('v1')
  let api!: ReturnType<typeof useMapLeaflet>
  const MapHost = defineComponent({
    name: 'MapHost',
    setup() {
      provideViewRoute('map')
      const el = ref<HTMLElement | null>(null)
      api = useMapLeaflet({
        container: el,
        visiblePoints: visible,
        categoryById: ref(new Map(categories.map((c) => [c.id, c]))),
        found: shallowRef<ReadonlySet<string>>(new Set()),
        dataVersion,
        questStarts: shallowRef<QuestStartGroup[]>([]),
        highlightQuest: ref(undefined),
        selectedPoint: ref(null),
        pinMode: ref(false),
        landExtent: ref({ minX: 0, minY: 0, maxX: 40000, maxY: 40000 }),
        onPointClick: vi.fn(),
        onQuestStartClick: vi.fn(),
        onMapClick: vi.fn(),
      })
      return () => h('div', { ref: el, 'data-map': '' })
    },
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/map', name: 'map', component: MapHost },
      { path: '/quests', name: 'quests', component: { render: () => h('p', 'quests') } },
    ],
  })
  const memory = useViewMemoryStore()
  memory.attach(router)
  await router.push('/map')
  const mounted = mount(KeptViews, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return { wrapper: mounted, router, visible, dataVersion, api, map: api.map.value! }
}

/** A header tab: back to where that view was left. */
async function tab(router: Router, view: ViewName) {
  const memory = useViewMemoryStore()
  const to = memory.linkTo(view)
  memory.announceReturn(view)
  await router.push(to)
  await flushPromises()
}

/** Where a spot sits in the container, relative to its middle. */
function offCentre(map: L.Map, spot: L.LatLng) {
  const off = map.latLngToContainerPoint(spot).subtract(map.getSize().divideBy(2))
  return Math.max(Math.abs(off.x), Math.abs(off.y))
}

describe('useMapLeaflet in a kept-alive view', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    size = { width: 800, height: 600 }
    resizeCallbacks = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const sized = (el: Element) => el.isConnected && el.hasAttribute('data-map')
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return sized(this) ? size.width : 0
    })
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      return sized(this) ? size.height : 0
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** Somewhere on the land, zoomed in, and dragged a bit so the centre is not a round one. */
  function moveSomewhere(map: L.Map) {
    map.setView(L.latLng(toLatLng(21000, 150500)), 3.5, { animate: false })
    map.panBy([37, -21], { animate: false })
    return { center: map.getCenter(), zoom: map.getZoom() }
  }

  it('is the same map with exactly the same centre and zoom after a switch, and Leaflet is left alone', async () => {
    const s = await keptSetup()
    wrapper = s.wrapper
    const before = moveSomewhere(s.map)
    expect(s.map.getSize()).toEqual(L.point(800, 600))
    expect(s.api.onScreen.value).toBe(true)
    const invalidate = vi.spyOn(s.map, 'invalidateSize')
    const setView = vi.spyOn(s.map, 'setView')
    const fitBounds = vi.spyOn(s.map, 'fitBounds')
    const flyTo = vi.spyOn(s.map, 'flyTo')

    await tab(s.router, 'quests')
    expect(s.wrapper.find('[data-map]').exists()).toBe(false)
    expect(s.api.onScreen.value).toBe(false)
    // The observer reports the detached container (no size), and the window is resized too.
    fireResize()
    window.dispatchEvent(new Event('resize'))
    await new Promise((r) => setTimeout(r, 30))
    expect(invalidate).not.toHaveBeenCalled()
    expect(s.map.getSize()).toEqual(L.point(800, 600))

    await tab(s.router, 'map')
    // Attached again: the observer reports the old size.
    fireResize()
    expect(s.api.map.value).toBe(s.map)
    expect(s.api.onScreen.value).toBe(true)
    expect(s.map.getCenter().lat).toBe(before.center.lat)
    expect(s.map.getCenter().lng).toBe(before.center.lng)
    expect(s.map.getZoom()).toBe(before.zoom)
    expect(s.api.zoom.value).toBe(before.zoom)
    expect(invalidate).not.toHaveBeenCalled()
    expect(setView).not.toHaveBeenCalled()
    expect(fitBounds).not.toHaveBeenCalled()
    expect(flyTo).not.toHaveBeenCalled()
  })

  it('does not listen to window resizes through Leaflet itself', async () => {
    const s = await keptSetup()
    wrapper = s.wrapper
    expect(s.map.options.trackResize).toBe(false)
  })

  it('takes over a size that changed while away, once, and keeps the centre and zoom', async () => {
    const s = await keptSetup()
    wrapper = s.wrapper
    const before = moveSomewhere(s.map)
    const invalidate = vi.spyOn(s.map, 'invalidateSize')
    const moveend = vi.fn()
    s.map.on('moveend', moveend)

    await tab(s.router, 'quests')
    // The phone was rotated while another view was on screen.
    size = { width: 601, height: 803 }
    fireResize()
    expect(invalidate).not.toHaveBeenCalled()
    expect(moveend).not.toHaveBeenCalled()

    await tab(s.router, 'map')
    expect(s.map.getSize()).toEqual(L.point(601, 803))
    expect(invalidate).toHaveBeenCalledTimes(1)
    // Settled at once, no debounced moveend that would show markers and tiles late.
    expect(moveend).toHaveBeenCalled()
    expect(offCentre(s.map, before.center)).toBeLessThanOrEqual(1)
    expect(s.map.getZoom()).toBe(before.zoom)

    // The observer's own report of the new size finds nothing left to do.
    fireResize()
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('goes to the new minimum zoom when the window grew while away', async () => {
    const s = await keptSetup()
    wrapper = s.wrapper
    s.map.setView(L.latLng(toLatLng(200000, 90000)), s.api.minZoom.value, { animate: false })
    const before = { center: s.map.getCenter(), zoom: s.map.getZoom(), min: s.api.minZoom.value }

    await tab(s.router, 'quests')
    size = { width: 3200, height: 2400 }
    await tab(s.router, 'map')

    expect(s.api.minZoom.value).toBeGreaterThan(before.min)
    // jsdom has no 3D transforms, so Leaflet snaps to whole zoom levels here: the first one that is allowed.
    expect(s.map.getZoom()).toBe(Math.ceil(s.api.minZoom.value))
    expect(s.api.zoom.value).toBe(s.map.getZoom())
    expect(offCentre(s.map, before.center)).toBeLessThanOrEqual(1)
  })

  it('puts the map back when something moved it while away', async () => {
    const s = await keptSetup()
    wrapper = s.wrapper
    const before = moveSomewhere(s.map)

    await tab(s.router, 'quests')
    s.map.setView(L.latLng(toLatLng(300000, 20000)), 5, { animate: false })
    await tab(s.router, 'map')

    expect(s.map.getZoom()).toBe(before.zoom)
    expect(offCentre(s.map, before.center)).toBeLessThanOrEqual(1)
  })

  it('lets a move that was under way when you left end where it was going', async () => {
    const s = await keptSetup()
    wrapper = s.wrapper
    moveSomewhere(s.map)
    const target = L.latLng(toLatLng(300000, 20000))

    // A fly has started: Leaflet fires movestart, and moveend only when it arrives.
    s.map.fire('movestart')
    await tab(s.router, 'quests')
    s.map.setView(target, 5, { animate: false })
    await tab(s.router, 'map')

    expect(s.map.getZoom()).toBe(5)
    expect(offCentre(s.map, target)).toBeLessThanOrEqual(1)
  })

  it('still follows a resize while the map is on screen, keeping the centre', async () => {
    const s = await keptSetup()
    wrapper = s.wrapper
    const before = moveSomewhere(s.map)
    size = { width: 1100, height: 500 }
    fireResize()
    expect(s.map.getSize()).toEqual(L.point(1100, 500))
    expect(offCentre(s.map, before.center)).toBeLessThanOrEqual(1)
    expect(s.map.getZoom()).toBe(before.zoom)
  })

  it('ignores a container without a size, also on screen', async () => {
    const s = await keptSetup()
    wrapper = s.wrapper
    const before = moveSomewhere(s.map)
    const invalidate = vi.spyOn(s.map, 'invalidateSize')
    size = { width: 0, height: 0 }
    fireResize()
    expect(invalidate).not.toHaveBeenCalled()
    expect(s.map.getCenter()).toEqual(before.center)
  })

  it('drops the cursor readout when the view is left', async () => {
    const s = await keptSetup()
    wrapper = s.wrapper
    s.api.cursor.value = { x: 1, y: 2 }
    await tab(s.router, 'quests')
    expect(s.api.cursor.value).toBeNull()
  })

  it('has the right markers after the data changed while away', async () => {
    const s = await keptSetup()
    wrapper = s.wrapper
    expect(s.api.stats()).toMatchObject({ built: 5, shown: 5, inCluster: 5 })

    await tab(s.router, 'quests')
    // A sync finished: new data, and a point less.
    s.visible.value = [...lore, ...trees.slice(0, 2)]
    s.dataVersion.value = 'v2'
    await flushPromises()
    await tab(s.router, 'map')

    expect(s.api.stats()).toMatchObject({ built: 4, shown: 4, inCluster: 4 })
  })
})
