// The Leaflet map: tiles, clustered markers, quest start pins, the selection ring, pin mode.
// Markers are built lazily (only for points that become visible), cached per point, and
// added or removed in bulk when the visible set changes. Nothing is rebuilt per keystroke.
//
// The map view stays alive while another view is on screen (<KeepAlive> in App.vue), so the map is
// the same Leaflet map when you come back: same centre, zoom, tiles and markers. While it is away
// its container is detached and has no size, so nothing here reacts to a resize then; the size is
// taken over once, when the map is back in the page.

import { onActivated, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import {
  L,
  clusterIcon,
  createGameCrs,
  createIconCache,
  questStartIcon,
  selectedIcon,
  worldBounds,
} from '@/components/map/leaflet'
import { isTrackableGroup } from '@/lib/map-groups'
import { markerIconSpec } from '@/lib/map-icons'
import type { QuestStartGroup } from '@/lib/map-links'
import {
  MAX_NATIVE_ZOOM,
  MIN_NATIVE_ZOOM,
  TILE_SIZE,
  TILE_URL,
  WORLD_BOUNDS,
  fromLatLng,
  toLatLng,
} from '@/lib/projection'
import type { MapCategory, MapPoint } from '@/lib/types'
import { createSeaLayer, featherTile } from '@/components/map/sea-layer'
import { useViewRoute } from './useViewRoute'

export const MAX_ZOOM = 6
/** Zoom used when flying to a point or quest start. */
export const FOCUS_ZOOM = 3.5
/** From this zoom on every marker stands alone. */
const NO_CLUSTER_ZOOM = 5

export interface MapLeafletInput {
  container: Readonly<Ref<HTMLElement | null>>
  /** Points to draw as markers, already filtered. */
  visiblePoints: Readonly<Ref<readonly MapPoint[]>>
  categoryById: Readonly<Ref<ReadonlyMap<string, MapCategory>>>
  found: Readonly<Ref<ReadonlySet<string>>>
  /** Changes when a sync delivered new map data: the marker cache is rebuilt. */
  dataVersion: Readonly<Ref<string>>
  /** Quest start pins to draw. */
  questStarts: Readonly<Ref<readonly QuestStartGroup[]>>
  /** Quest whose pin is highlighted. */
  highlightQuest: Readonly<Ref<string | undefined>>
  /** Point drawn with the gold selection ring, on top of everything. */
  selectedPoint: Readonly<Ref<MapPoint | null>>
  pinMode: Readonly<Ref<boolean>>
  /** First view: the land, in game coordinates. */
  landExtent: Readonly<Ref<{ minX: number; minY: number; maxX: number; maxY: number } | null>>
  onPointClick(pointId: string): void
  onQuestStartClick(group: QuestStartGroup): void
  /** A click on the map itself (not on a marker). */
  onMapClick(pos: { x: number; y: number }, inWorld: boolean): void
}

interface MarkerEntry {
  marker: L.Marker
  point: MapPoint
  found: boolean
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** Where the map stood when its view was left. */
interface LeftView {
  center: L.LatLng
  zoom: number
  /** False when the map was still moving (a fly, a zoom): it ends where it was going. */
  settled: boolean
}

export function useMapLeaflet(input: MapLeafletInput) {
  const view = useViewRoute()
  const map = shallowRef<L.Map | null>(null)
  /**
   * The map is in the page and has its real size. False from the navigation that leaves the view
   * until the view is activated again: a fly has to wait for this.
   */
  const onScreen = ref(false)
  const zoom = ref(0)
  const minZoom = ref(0)
  const cursor = ref<{ x: number; y: number } | null>(null)
  const center = ref<{ x: number; y: number } | null>(null)

  let cluster: L.MarkerClusterGroup | null = null
  let questLayer: L.LayerGroup | null = null
  let selectedLayer: L.LayerGroup | null = null
  let resizeObserver: ResizeObserver | null = null
  let stopWindowResize: (() => void) | null = null
  let cursorFrame = 0
  /** Between Leaflet's movestart and moveend: a drag, a fly, a zoom or pan animation. */
  let moving = false
  let left: LeftView | null = null
  const icons = createIconCache()
  const world = worldBounds()

  /** Every marker built so far, by point id. */
  let entries = new Map<string, MarkerEntry>()
  /** Point id per marker, for the single click listener on the cluster group. */
  let idByMarker = new WeakMap<L.Layer, string>()
  /** Markers currently in the cluster group. */
  let shown = new Map<string, L.Marker>()

  function categoryOf(point: MapPoint) {
    return input.categoryById.value.get(point.categoryId)
  }

  function entryFor(point: MapPoint): MarkerEntry {
    let entry = entries.get(point.id)
    if (!entry) {
      const category = categoryOf(point)
      const found = input.found.value.has(point.id)
      const marker = L.marker(toLatLng(point.x, point.y), {
        icon: icons.get(markerIconSpec(point, category, found)),
        title: point.name ?? category?.label ?? '',
        keyboard: true,
        riseOnHover: true,
      })
      idByMarker.set(marker, point.id)
      entry = { marker, point, found }
      entries.set(point.id, entry)
    }
    return entry
  }

  /* ---------------- markers ---------------- */

  function syncMarkers() {
    if (!cluster) return
    const next = new Map<string, L.Marker>()
    for (const p of input.visiblePoints.value) next.set(p.id, entryFor(p).marker)

    const remove: L.Layer[] = []
    for (const [id, m] of shown) if (!next.has(id)) remove.push(m)
    const add: L.Layer[] = []
    for (const [id, m] of next) if (!shown.has(id)) add.push(m)

    if (remove.length > 0 && remove.length > shown.size / 2) {
      // Dropping most of the markers: a clear and one bulk add is much faster than removeLayers.
      cluster.clearLayers()
      cluster.addLayers([...next.values()])
    } else {
      if (remove.length) cluster.removeLayers(remove)
      if (add.length) cluster.addLayers(add)
    }
    shown = next
  }

  /** Found lore and unique markers are dimmed; update only the ones that changed. */
  function syncFound() {
    const found = input.found.value
    for (const entry of entries.values()) {
      const category = categoryOf(entry.point)
      if (!isTrackableGroup(category?.group)) continue
      const isFound = found.has(entry.point.id)
      if (isFound === entry.found) continue
      entry.found = isFound
      entry.marker.setIcon(icons.get(markerIconSpec(entry.point, category, isFound)))
    }
  }

  function resetMarkers() {
    cluster?.clearLayers()
    entries = new Map()
    idByMarker = new WeakMap()
    shown = new Map()
    icons.clear()
    syncMarkers()
  }

  /* ---------------- quest starts and selection ---------------- */

  function syncQuestStarts() {
    if (!questLayer) return
    questLayer.clearLayers()
    const highlight = input.highlightQuest.value
    for (const group of input.questStarts.value) {
      const lit = !!highlight && group.quests.some((q) => q.id === highlight)
      const manual = group.quests.some((q) => q.start?.source === 'override')
      const names = group.quests.map((q) => q.name).join(', ')
      const marker = L.marker(toLatLng(group.x, group.y), {
        icon: questStartIcon(group.quests.length, lit, manual),
        title: `Queststart: ${names}`,
        keyboard: true,
        zIndexOffset: lit ? 2000 : 1000,
        riseOnHover: true,
      })
      marker.on('click', () => {
        if (input.pinMode.value) return input.onMapClick({ x: group.x, y: group.y }, true)
        input.onQuestStartClick(group)
      })
      questLayer.addLayer(marker)
    }
  }

  function syncSelected() {
    if (!selectedLayer) return
    selectedLayer.clearLayers()
    const point = input.selectedPoint.value
    if (!point || !world.contains(toLatLng(point.x, point.y))) return
    const category = categoryOf(point)
    const spec = markerIconSpec(point, category, input.found.value.has(point.id))
    const marker = L.marker(toLatLng(point.x, point.y), {
      icon: selectedIcon(spec),
      keyboard: false,
      zIndexOffset: 3000,
      title: point.name ?? category?.label ?? '',
    })
    // Clicking the ring keeps the card open instead of closing it through the map click.
    marker.on('click', () => {
      if (input.pinMode.value) input.onMapClick({ x: point.x, y: point.y }, true)
    })
    selectedLayer.addLayer(marker)
  }

  /* ---------------- view ---------------- */

  function updateMinZoom(animate = true) {
    const m = map.value
    if (!m) return
    // A half step below the zoom where the whole world fits, never below 0.
    const fit = m.getBoundsZoom(world, false)
    const next = Math.max(MIN_NATIVE_ZOOM, Math.min(1.5, Math.floor(fit * 2) / 2 - 0.5))
    minZoom.value = next
    // Below the new minimum: go there at once, setMinZoom would animate the zoom.
    if (!animate && m.getZoom() < next) m.setView(m.getCenter(), next, { animate: false })
    m.setMinZoom(next)
  }

  function fitLand(animate = false) {
    const m = map.value
    if (!m) return
    const e = input.landExtent.value
    const bounds = e ? L.latLngBounds([toLatLng(e.minX, e.minY), toLatLng(e.maxX, e.maxY)]) : world
    m.fitBounds(bounds, { padding: [24, 24], animate: animate && !prefersReducedMotion() })
  }

  /**
   * Centers a game position. `offset` (px) moves the view so the spot is not hidden under a card:
   * [180, 0] puts it 180px left of the center.
   */
  function flyTo(x: number, y: number, opts: { zoom?: number; offset?: [number, number] } = {}) {
    const m = map.value
    if (!m) return
    const target = opts.zoom ?? Math.max(m.getZoom(), FOCUS_ZOOM)
    let latlng = L.latLng(toLatLng(x, y))
    if (opts.offset) latlng = m.unproject(m.project(latlng, target).add(L.point(opts.offset)), target)
    if (prefersReducedMotion()) m.setView(latlng, target, { animate: false })
    else m.flyTo(latlng, target, { duration: 0.8 })
  }

  function zoomIn() {
    map.value?.zoomIn(1)
  }

  function zoomOut() {
    map.value?.zoomOut(1)
  }

  /**
   * Takes over the size of the container when it changed, keeping the centre. Returns false when
   * there was nothing to do. A container without a size (detached, hidden) is left alone: Leaflet
   * would pan the map to a corner and drop its tiles and markers.
   * `live`: a resize while you look at it (animated min zoom, moveend debounced).
   */
  function syncSize(live: boolean): boolean {
    const m = map.value
    const el = input.container.value
    if (!m || !el || !el.isConnected) return false
    const width = el.clientWidth
    const height = el.clientHeight
    if (!width || !height) return false
    const size = m.getSize()
    if (size.x === width && size.y === height) return false
    m.invalidateSize({ debounceMoveend: live })
    updateMinZoom(live)
    return true
  }

  function invalidateSize() {
    if (onScreen.value) syncSize(true)
  }

  /** Puts the map back where it was left, without animation, if anything moved it in the meantime. */
  function restoreView(was: LeftView) {
    const m = map.value
    if (!m) return
    // A larger window can have a higher minimum zoom than the one the map was left at.
    const zoom = Math.max(was.zoom, m.getMinZoom())
    if (m.getZoom() === zoom) {
      if (m.getCenter().equals(was.center)) return
      // Leaflet pans in whole pixels: within a pixel of the middle is as close as it gets.
      const off = m.latLngToContainerPoint(was.center).subtract(m.getSize().divideBy(2))
      if (Math.abs(off.x) <= 1 && Math.abs(off.y) <= 1) return
    }
    m.setView(was.center, zoom, { animate: false })
  }

  function readCenter() {
    const m = map.value
    if (!m) return
    const c = m.getCenter()
    center.value = fromLatLng(c.lat, c.lng)
    zoom.value = m.getZoom()
  }

  /* ---------------- lifecycle ---------------- */

  onMounted(() => {
    const el = input.container.value
    if (!el) return
    const reduced = prefersReducedMotion()
    el.classList.toggle('is-pinning', input.pinMode.value)

    const m = L.map(el, {
      crs: createGameCrs(),
      minZoom: 0,
      maxZoom: MAX_ZOOM,
      zoomSnap: 0.5,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 120,
      zoomControl: false,
      attributionControl: false,
      maxBounds: world.pad(0.25),
      maxBoundsViscosity: 0.8,
      // Leaflet's own window resize handler would also run while the map is not in the page.
      trackResize: false,
      zoomAnimation: !reduced,
      fadeAnimation: !reduced,
      markerZoomAnimation: !reduced,
    })
    map.value = m

    // The open sea beyond the tiles, under them.
    createSeaLayer({ minZoom: 0, maxZoom: MAX_ZOOM }).addTo(m)
    L.tileLayer(TILE_URL, {
      zIndex: 1,
      tileSize: TILE_SIZE,
      minNativeZoom: MIN_NATIVE_ZOOM,
      maxNativeZoom: MAX_NATIVE_ZOOM,
      minZoom: 0,
      maxZoom: MAX_ZOOM,
      noWrap: true,
      bounds: L.latLngBounds(WORLD_BOUNDS),
      keepBuffer: 4,
    })
      // Open water on the world's edge fades into the sea layer; land and coasts stay as they are.
      .on('tileload', (e: L.TileEvent) => featherTile(e.tile, e.coords))
      .addTo(m)

    cluster = L.markerClusterGroup({
      chunkedLoading: true,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: false,
      removeOutsideVisibleBounds: true,
      animate: !reduced,
      disableClusteringAtZoom: NO_CLUSTER_ZOOM,
      maxClusterRadius: (z: number) => (z < 2 ? 70 : z < 3.5 ? 55 : 40),
      iconCreateFunction: clusterIcon,
    })
    cluster.on('click', (e: L.LeafletEvent) => {
      const layer = (e as L.LeafletMouseEvent & { layer: L.Layer }).layer
      const id = idByMarker.get(layer)
      if (!id) return
      const entry = entries.get(id)
      if (input.pinMode.value && entry) return input.onMapClick({ x: entry.point.x, y: entry.point.y }, true)
      input.onPointClick(id)
    })
    cluster.addTo(m)

    questLayer = L.layerGroup().addTo(m)
    selectedLayer = L.layerGroup().addTo(m)

    m.on('click', (e: L.LeafletMouseEvent) => {
      input.onMapClick(fromLatLng(e.latlng.lat, e.latlng.lng), world.contains(e.latlng))
    })
    m.on('mousemove', (e: L.LeafletMouseEvent) => {
      if (cursorFrame) return
      cursorFrame = requestAnimationFrame(() => {
        cursorFrame = 0
        const p = fromLatLng(e.latlng.lat, e.latlng.lng)
        cursor.value = { x: Math.round(p.x), y: Math.round(p.y) }
      })
    })
    m.on('mouseout', () => {
      cursor.value = null
    })
    m.on('zoomend moveend', readCenter)
    m.on('movestart', () => {
      moving = true
    })
    m.on('moveend', () => {
      moving = false
    })

    updateMinZoom()
    fitLand()
    readCenter()

    syncMarkers()
    syncQuestStarts()
    syncSelected()

    // Also fires when the view is detached (size 0) and attached again: ignored while away.
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => invalidateSize())
      resizeObserver.observe(el)
    } else {
      window.addEventListener('resize', invalidateSize)
      stopWindowResize = () => window.removeEventListener('resize', invalidateSize)
    }
    onScreen.value = true
  })

  // Leaving the view, while the map is still in the page: remember where it stands.
  view.onLeave(() => {
    onScreen.value = false
    if (cursorFrame) cancelAnimationFrame(cursorFrame)
    cursorFrame = 0
    // No mouseout comes from a container that is taken out of the page.
    cursor.value = null
    const m = map.value
    left = m ? { center: m.getCenter(), zoom: m.getZoom(), settled: !moving } : null
    // Leaflet listens for keys on the document from the moment its container gets focus until it
    // loses it, and stops them there (arrows, plus, minus and 6). The view lets go of the focus
    // when it leaves (useViewRoute); this makes sure Leaflet's listener is gone even when the
    // browser sent no blur for that. Firing it again when it did is harmless.
    m?.fire('blur')
  })

  // Back in the page (also runs right after the first mount, with nothing to put back).
  onActivated(() => {
    if (!view.active.value) return
    const was = left
    left = null
    if (map.value) {
      // The window was resized or rotated in the meantime: no animation, the map was not in view.
      syncSize(false)
      if (was?.settled) restoreView(was)
    }
    onScreen.value = true
  })

  watch(input.visiblePoints, syncMarkers)
  watch(input.found, () => {
    syncFound()
    syncSelected()
  })
  watch(input.dataVersion, resetMarkers)
  watch([input.questStarts, input.highlightQuest], syncQuestStarts)
  watch(input.selectedPoint, syncSelected)
  watch(
    input.pinMode,
    (on) => {
      input.container.value?.classList.toggle('is-pinning', on)
    },
    { immediate: true, flush: 'post' },
  )

  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    stopWindowResize?.()
    onScreen.value = false
    if (cursorFrame) cancelAnimationFrame(cursorFrame)
    map.value?.remove()
    map.value = null
    cluster = null
    questLayer = null
    selectedLayer = null
    entries.clear()
    shown.clear()
    icons.clear()
  })

  /** Marker bookkeeping, for tests and debugging. */
  function stats() {
    return { built: entries.size, shown: shown.size, inCluster: cluster?.getLayers().length ?? 0, questPins: questLayer?.getLayers().length ?? 0 }
  }

  return { map, onScreen, zoom, minZoom, maxZoom: MAX_ZOOM, cursor, center, flyTo, fitLand, zoomIn, zoomOut, invalidateSize, stats }
}
