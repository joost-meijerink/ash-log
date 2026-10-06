// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { MAX_NATIVE_ZOOM, WORLD_BOUNDS, fromLatLng, tilesPerSide, toLatLng, toPixel } from '@/lib/projection'
import { L, clusterIcon, createGameCrs, createIconCache, questStartIcon } from './leaflet'

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
})

describe('hit areas', () => {
  it('gives clusters and quest pins 44px and point markers a modest extra 4px', () => {
    expect(mapCss).toMatch(
      /\.leaflet-marker-icon\.ash-cluster::before,\s*\.leaflet-marker-icon\.ash-quest-pin::before\s*\{[^}]*width: 44px;[^}]*height: 44px;/,
    )
    expect(mapCss).toMatch(/\.leaflet-marker-icon\.ash-marker::before\s*\{[^}]*inset: -4px;/)
  })

  it('leaves marker positioning to leaflet.css, so quest pins never enter the normal flow', () => {
    expect(mapCss).not.toMatch(/(^|\n)\.ash-quest-pin\s*\{[^}]*position:/)
  })
})
