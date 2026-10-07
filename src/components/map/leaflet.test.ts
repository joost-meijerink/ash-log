// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_NATIVE_ZOOM, WORLD_BOUNDS, fromLatLng, tilesPerSide, toLatLng, toPixel } from '@/lib/projection'
import { iconKey, markerIconSpec, type MarkerIconSpec, type StackChild } from '@/lib/map-icons'
import type { MapCategory } from '@/lib/types'
import {
  L,
  clusterIcon,
  createClusterGroup,
  createGameCrs,
  createIconCache,
  questStartIcon,
  selectedIcon,
  worldBounds,
} from './leaflet'

// Vitest blanks CSS imports, so read the stylesheet from disk (typed locally: no Node types here).
// Vitest runs from the project root.
const fs = await vi.importActual<{ readFileSync(path: string, encoding: 'utf8'): string }>('node:fs')
const mapCss = fs.readFileSync('src/components/map/map.css', 'utf8')

const WINDMILL = { x: 16773, y: 171786 }

describe('game CRS', () => {
  const crs = createGameCrs()

  it('puts the Windmill on pixel (407.4, 4234.5) at zoom 4, in tile 1_16', () => {
    const p = crs.latLngToPoint(L.latLng(toLatLng(WINDMILL.x, WINDMILL.y)), 4)
    expect(p.x).toBeCloseTo(407.4, 1)
    expect(p.y).toBeCloseTo(4234.5, 1)
    expect(Math.floor(p.x / 256)).toBe(1)
    expect(Math.floor(p.y / 256)).toBe(16)
    // Same numbers as the pure helper.
    const q = toPixel(WINDMILL.x, WINDMILL.y, 4)
    expect(p.x).toBeCloseTo(q.px, 6)
    expect(p.y).toBeCloseTo(q.py, 6)
  })

  it('does not flip y: south (bigger y) is further down', () => {
    const north = crs.latLngToPoint(L.latLng(toLatLng(0, 0)), 2)
    const south = crs.latLngToPoint(L.latLng(toLatLng(0, 1000)), 2)
    expect(south.y).toBeGreaterThan(north.y)
  })

  it('maps the world bounds onto the tile grid', () => {
    const [[minLat, minLng], [maxLat, maxLng]] = WORLD_BOUNDS
    const topLeft = crs.latLngToPoint(L.latLng(minLat, minLng), MAX_NATIVE_ZOOM)
    const bottomRight = crs.latLngToPoint(L.latLng(maxLat, maxLng), MAX_NATIVE_ZOOM)
    expect(topLeft.x).toBeCloseTo(0, 6)
    expect(topLeft.y).toBeCloseTo(0, 6)
    expect(bottomRight.x).toBeCloseTo(6144, 6)
    expect(bottomRight.x / 256).toBeLessThanOrEqual(tilesPerSide(MAX_NATIVE_ZOOM))
  })

  it('round-trips pixels back to game coordinates', () => {
    const p = crs.latLngToPoint(L.latLng(toLatLng(WINDMILL.x, WINDMILL.y)), 3.5)
    const ll = crs.pointToLatLng(p, 3.5)
    const back = fromLatLng(ll.lat, ll.lng)
    expect(back.x).toBeCloseTo(WINDMILL.x, 3)
    expect(back.y).toBeCloseTo(WINDMILL.y, 3)
  })
})

describe('icons', () => {
  it('shares one Leaflet icon per spec', () => {
    const cache = createIconCache()
    const spec = { glyph: 'chest' as const, tone: 'ember' as const, found: false }
    expect(cache.get(spec)).toBe(cache.get({ ...spec }))
    expect(cache.get(spec)).not.toBe(cache.get({ ...spec, found: true }))
  })

  it('falls back to the glyph disc when a wiki image fails to load', () => {
    const icon = createIconCache().get({ file: 'Missing.png', glyph: 'resource', tone: 'muted', found: false })
    const el = icon.createIcon()
    expect(el.classList.contains('is-broken')).toBe(false)
    el.querySelector('img')!.dispatchEvent(new Event('error'))
    expect(el.classList.contains('is-broken')).toBe(true)
  })

  it('anchors the quest pin at its tip', () => {
    const icon = questStartIcon(1, false, false)
    expect(icon.options.iconAnchor).toEqual([14, 35])
  })

  it('builds a readable cluster icon', () => {
    const fake = { getChildCount: () => 1234 } as unknown as L.MarkerCluster
    const icon = clusterIcon(fake)
    expect(String(icon.options.html)).toContain('1.2k')
    expect(String(icon.options.html)).toContain('1234 points')
  })

  it('puts a broken image fallback on the marker inside the selection ring', () => {
    const el = selectedIcon({ file: 'Adamant_Ore.png', glyph: 'resource', tone: 'muted', found: false }).createIcon()
    el.querySelector('img')!.dispatchEvent(new Event('error'))
    expect(el.querySelector('.ash-marker')!.classList.contains('is-broken')).toBe(true)
  })
})

describe('stacks', () => {
  const kind = (id: string, label: string, icon?: string) => {
    const category: MapCategory = { id, label, group: 'resource', sources: [], count: 1, ...(icon ? { icon } : {}) }
    const spec: MarkerIconSpec = markerIconSpec({ id: `${id}:0:0`, categoryId: id, x: 0, y: 0 }, category, false)
    return { key: `${id}|${iconKey(spec)}`, spec, label, found: false } satisfies StackChild
  }
  const ash = kind('ash-tree', 'Ash Tree', 'Ash_Tree.png')
  const coal = kind('coal', 'Coal', 'Coal.png')
  /** A fake cluster of markers, and what each marker is. */
  function fake(kinds: StackChild[]) {
    const markers = kinds.map(() => L.marker([0, 0]))
    const childOf = (m: L.Marker) => kinds[markers.indexOf(m)]
    const cluster = { getChildCount: () => kinds.length, getAllChildMarkers: () => markers } as unknown as L.MarkerCluster
    return { cluster, childOf }
  }

  it('draws a cluster of one kind as its own sprite with a count', () => {
    const { cluster, childOf } = fake([ash, ash, ash])
    const icon = clusterIcon(cluster, childOf)
    expect(icon.options.className).toBe('ash-stack')
    expect(icon.options.iconSize).toEqual([32, 32])
    const html = String(icon.options.html)
    expect(html).toContain('src="/wiki-img/icons/Ash_Tree.png"')
    expect(html).toContain('<span class="ash-stack__count" aria-hidden="true">3</span>')
    expect(html).toContain('3 × Ash Tree, zoom in')
  })

  it('keeps the seal for mixed clusters and without a resolver', () => {
    const mixed = fake([ash, coal, ash])
    expect(clusterIcon(mixed.cluster, mixed.childOf).options.className).toMatch(/^ash-cluster /)
    expect(clusterIcon(fake([ash, ash]).cluster).options.className).toMatch(/^ash-cluster /)
  })

  it('dims a stack only when every marker in it is found', () => {
    const some = fake([{ ...ash, found: true }, ash])
    expect(String(clusterIcon(some.cluster, some.childOf).options.html)).not.toContain('is-found')
    const all = fake([{ ...ash, found: true }, { ...ash, found: true }])
    expect(String(clusterIcon(all.cluster, all.childOf).options.html)).toContain('is-found')
  })

  it('falls back to the glyph disc when the sprite is missing', () => {
    const { cluster, childOf } = fake([ash, ash])
    const el = clusterIcon(cluster, childOf).createIcon()
    el.querySelector('img')!.dispatchEvent(new Event('error'))
    expect(el.classList.contains('is-broken')).toBe(false)
    expect(el.querySelector('.ash-marker')!.classList.contains('is-broken')).toBe(true)
  })
})

describe('hit areas', () => {
  it('gives clusters, stacks and quest pins 44px and point markers a modest extra 4px', () => {
    expect(mapCss).toMatch(
      /\.leaflet-marker-icon\.ash-cluster::before,\s*\.leaflet-marker-icon\.ash-stack::before,\s*\.leaflet-marker-icon\.ash-quest-pin::before\s*\{[^}]*width: 44px;[^}]*height: 44px;/,
    )
    expect(mapCss).toMatch(/\.leaflet-marker-icon\.ash-marker::before\s*\{[^}]*inset: -4px;/)
  })

  it('outlines a focused stack like the other markers', () => {
    expect(mapCss).toMatch(/\.ash-stack:focus-visible,[^{]*\{[^}]*outline: 2px solid/)
  })

  it('leaves marker positioning to leaflet.css, so quest pins never enter the normal flow', () => {
    expect(mapCss).not.toMatch(/(^|\n)\.ash-quest-pin\s*\{[^}]*position:/)
  })
})

/* ---------------- cluster group ---------------- */

describe('cluster group with a minimum zoom that follows the window', () => {
  // Real points: lone ones, far from anything else at every cluster zoom.
  const DIARY = { x: 132249, y: 30611 }
  const DORIC = [
    { x: 10908, y: 184632 },
    { x: 142219, y: 92602 },
    { x: 194041, y: -42347 },
    { x: 228062, y: 54540 },
  ]
  const OPTIONS: L.MarkerClusterGroupOptions = {
    chunkedLoading: false,
    animate: false,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: false,
    removeOutsideVisibleBounds: true,
    disableClusteringAtZoom: 5,
    maxClusterRadius: (z: number) => (z < 2 ? 70 : z < 3.5 ? 55 : 40),
  }
  const marker = (p: { x: number; y: number }) => L.marker(toLatLng(p.x, p.y))
  const icons = (map: L.Map) => map.getContainer().querySelectorAll('.leaflet-marker-icon').length

  let map: L.Map
  beforeEach(() => {
    // jsdom has no layout: the map gets the size of the window where the bug showed.
    const sized = (el: Element) => el.hasAttribute('data-test-map')
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return sized(this) ? 1104 : 0
    })
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      return sized(this) ? 941 : 0
    })
    const el = document.createElement('div')
    el.setAttribute('data-test-map', '')
    document.body.append(el)
    const off = { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }
    map = L.map(el, { crs: createGameCrs(), minZoom: 0, maxZoom: 6, zoomSnap: 0.5, ...off })
  })
  afterEach(() => {
    map.getContainer().remove()
    map.remove()
    vi.restoreAllMocks()
  })

  /** As in the app: the group goes on at minimum zoom 0, then the window sets the real minimum. */
  function setup(minZoom: number) {
    map.setView(worldBounds().getCenter(), 0)
    const group = createClusterGroup(OPTIONS).addTo(map)
    map.setMinZoom(minZoom)
    const drawn = (m: L.Marker) => !!group.getVisibleParent(m)
    return { group, drawn }
  }

  for (const minZoom of [0, 0.5, 1, 1.5]) {
    it(`draws lone markers at minimum zoom ${minZoom}`, () => {
      const { group, drawn } = setup(minZoom)
      expect(map.getMinZoom()).toBe(minZoom)
      const diary = marker(DIARY)
      group.addLayers([diary])
      expect(drawn(diary)).toBe(true)
      group.removeLayers([diary])

      const doric = DORIC.map(marker)
      group.addLayers(doric)
      expect(doric.filter(drawn)).toHaveLength(4)
      expect(icons(map)).toBe(4)
    })
  }

  it('draws the markers built while the minimum zoom was already raised, as on start', () => {
    const group = createClusterGroup(OPTIONS).addTo(map)
    map.setMinZoom(0.5)
    map.setView(worldBounds().getCenter(), 0.5)
    const doric = DORIC.map(marker)
    group.addLayers(doric)
    expect(doric.filter((m) => !!group.getVisibleParent(m))).toHaveLength(4)
  })

  it('takes lone markers off the map when they leave the view, and back', () => {
    const { group, drawn } = setup(1.5)
    const doric = DORIC.map(marker)
    group.addLayers(doric)
    map.setView(doric[0]!.getLatLng(), 6)
    expect(doric.map(drawn)).toEqual([true, false, false, false])
    expect(icons(map)).toBe(1)
    map.setView(worldBounds().getCenter(), 0)
    expect(doric.filter(drawn)).toHaveLength(4)
    expect(icons(map)).toBe(4)
  })

  it('keeps the other marker of a pair drawn when its partner goes', () => {
    const { group, drawn } = setup(0.5)
    const pair = [marker(DIARY), marker({ x: DIARY.x + 500, y: DIARY.y + 500 })]
    group.addLayers(pair)
    expect(icons(map)).toBe(1)
    group.removeLayers([pair[1]!])
    expect(drawn(pair[0]!)).toBe(true)
    expect(icons(map)).toBe(1)
    group.removeLayers([pair[0]!])
    expect(icons(map)).toBe(0)
  })

  it('keeps working when the minimum zoom goes down after a clear', () => {
    const { group, drawn } = setup(1.5)
    const doric = DORIC.map(marker)
    group.addLayers(doric)
    // The bulk path of the app: clear, then add everything again.
    group.clearLayers()
    group.addLayers(doric.slice(0, 2))
    // The window got smaller: the grid for zoom 0 is needed now.
    map.setMinZoom(0.5)
    const diary = marker(DIARY)
    expect(() => group.addLayers([diary, ...doric.slice(2)])).not.toThrow()
    expect(() => group.removeLayers([doric[0]!])).not.toThrow()
    expect([diary, ...doric.slice(1)].filter(drawn)).toHaveLength(4)
    expect(icons(map)).toBe(4)
  })
})
