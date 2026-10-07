import { describe, expect, it } from 'vitest'
import { buildChestMatrix, chestCategories, mapFilterHref, mapFilterLocation, type ChestPowerOf, type MapFilter } from './collections-chests'
import { splitByWorld, visiblePoints } from './map-filter'
import { pointPower, powerEstimates } from './map-power'
import { emptyFilters, parseMapQuery, type MapUrlKnown } from './map-url'
import { WORLD_BOUNDS } from './projection'
import type { MapCategory, MapPoint } from './types'

const cat = (id: string, label: string, group: MapCategory['group']): MapCategory => ({
  id,
  label,
  group,
  sources: [],
  count: 0,
})

const categories = [
  cat('treasure-chest', 'Treasure Chest', 'chest'),
  cat('buried-treasure', 'Buried Treasure', 'chest'),
  cat('gold-ore-node', 'Gold Ore Node', 'resource'),
  cat('spectral-chest', 'Spectral Chest', 'other'),
]

let n = 0
const pt = (categoryId: string, region?: string, power?: number): MapPoint => {
  n++
  return { id: `${categoryId}:${n}:${n}`, categoryId, x: n, y: n, region, power }
}

describe('chestCategories', () => {
  it('picks the chest group, sorted by label', () => {
    expect(chestCategories(categories).map((c) => c.id)).toEqual(['buried-treasure', 'treasure-chest'])
  })

  it('respects the categoryGroup override', () => {
    const overrides = { categoryGroup: { 'spectral-chest': 'chest' as const, 'buried-treasure': 'other' as const } }
    expect(chestCategories(categories, overrides).map((c) => c.id)).toEqual(['spectral-chest', 'treasure-chest'])
  })
})

describe('buildChestMatrix', () => {
  const points = [
    pt('treasure-chest', 'Dowdun Reach', 6),
    pt('treasure-chest', 'Dowdun Reach', 6),
    pt('treasure-chest', 'Brynmoor', 2),
    pt('treasure-chest', 'Brynmoor'),
    pt('buried-treasure', 'Brynmoor', 3),
    pt('buried-treasure', 'Umbral Sands'),
    pt('treasure-chest', 'Scorned Wilderness', 2),
    pt('treasure-chest', undefined, 4),
  ]

  it('builds rows per region in play order with power columns and an unknown column', () => {
    const m = buildChestMatrix(points, new Set(['treasure-chest', 'buried-treasure']))
    expect(m.powers).toEqual([2, 3, 4, 6])
    expect(m.hasUnknown).toBe(true)
    expect(m.rows.map((r) => [r.region, r.cells, r.unknown, r.total])).toEqual([
      ['Brynmoor', [1, 1, 0, 0], 1, 3],
      ['Dowdun Reach', [0, 0, 0, 2], 0, 2],
      ['Umbral Sands', [0, 0, 0, 0], 1, 1],
      ['Scorned Wilderness', [1, 0, 0, 0], 0, 1],
      [null, [0, 0, 1, 0], 0, 1],
    ])
    expect(m.totals).toEqual({ cells: [2, 1, 1, 2], estimated: [0, 0, 0, 0], unknown: 2, total: 8 })
  })

  it('only counts selected categories but keeps the table shape', () => {
    const m = buildChestMatrix(points, new Set(['buried-treasure']))
    expect(m.powers).toEqual([2, 3, 4, 6])
    expect(m.rows.map((r) => r.region)).toEqual(['Brynmoor', 'Dowdun Reach', 'Umbral Sands', 'Scorned Wilderness', null])
    expect(m.rows[0]).toMatchObject({ cells: [0, 1, 0, 0], unknown: 0, total: 1 })
    expect(m.totals.total).toBe(2)
  })

  it('handles no points at all', () => {
    expect(buildChestMatrix([], new Set())).toEqual({
      powers: [],
      hasUnknown: false,
      rows: [],
      totals: { cells: [], estimated: [], unknown: 0, total: 0 },
    })
  })

  it('has no unknown column when every point has a power level', () => {
    expect(buildChestMatrix([pt('treasure-chest', 'Brynmoor', 2)], new Set(['treasure-chest'])).hasUnknown).toBe(false)
  })

  it('counts estimated levels with powerOf and marks them per cell', () => {
    const own = pt('treasure-chest', 'Dowdun Reach', 6)
    const guess = pt('treasure-chest', 'Dowdun Reach')
    const far = pt('treasure-chest', 'Fellhollow')
    const none = pt('buried-treasure', 'Fellhollow')
    const powerOf = (p: MapPoint) =>
      p.power !== undefined ? { level: p.power } : p === guess ? { level: 6, estimate: {} } : p === far ? { level: 5, estimate: {} } : undefined
    const m = buildChestMatrix([own, guess, far, none], new Set(['treasure-chest', 'buried-treasure']), powerOf)
    expect(m.powers).toEqual([5, 6])
    expect(m.rows.map((r) => [r.region, r.cells, r.estimated, r.unknown])).toEqual([
      ['Fellhollow', [1, 0], [1, 0], 1],
      ['Dowdun Reach', [0, 2], [0, 1], 0],
    ])
    expect(m.totals).toMatchObject({ cells: [1, 2], estimated: [1, 1], unknown: 1, total: 4 })
  })
})

describe('map links', () => {
  it('builds the /map location with c, r and p', () => {
    expect(
      mapFilterLocation({ categories: ['buried-treasure', 'treasure-chest'], regions: ['Dowdun Reach'], powers: [6] }),
    ).toEqual({ path: '/map', query: { c: 'buried-treasure,treasure-chest', r: 'Dowdun Reach', p: '6' } })
  })

  it('leaves out empty filters', () => {
    expect(mapFilterLocation({ categories: ['treasure-chest'] })).toEqual({ path: '/map', query: { c: 'treasure-chest' } })
    expect(mapFilterLocation({ categories: [], regions: [], powers: [] })).toEqual({ path: '/map', query: {} })
  })

  it('adds ps=1 for a strict power filter, only together with powers', () => {
    expect(mapFilterLocation({ categories: ['treasure-chest'], regions: ['Ghornfell'], powers: [3], strictPower: true })).toEqual({
      path: '/map',
      query: { c: 'treasure-chest', r: 'Ghornfell', p: '3', ps: '1' },
    })
    expect(mapFilterLocation({ categories: ['treasure-chest'], regions: ['Ghornfell'], strictPower: true }).query).toEqual({
      c: 'treasure-chest',
      r: 'Ghornfell',
    })
    expect(mapFilterLocation({ categories: ['treasure-chest'], powers: [], strictPower: true }).query).toEqual({ c: 'treasure-chest' })
    expect(mapFilterHref({ categories: ['treasure-chest'], powers: [4], strictPower: true })).toBe('/map?c=treasure-chest&p=4&ps=1')
  })

  it('renders an href with encoded values and literal commas', () => {
    expect(mapFilterHref({ categories: ['a', 'b'], regions: ['Dowdun Reach'], powers: [2, 3] })).toBe(
      '/map?c=a,b&r=Dowdun%20Reach&p=2,3',
    )
    expect(mapFilterHref({ categories: [] })).toBe('/map')
  })
})

describe('matrix links agree with the map', () => {
  const [[minLat, minLng], [maxLat, maxLng]] = WORLD_BOUNDS
  const cx = (minLng + maxLng) / 2
  const cy = (minLat + maxLat) / 2
  let k = 0
  const chest = (categoryId: string, region: string, power?: number): MapPoint => {
    k++
    return { id: `${categoryId}:${k}:${k}`, categoryId, x: cx + k, y: cy + k, region, power }
  }
  const cats = [cat('treasure-chest', 'Treasure Chest', 'chest'), cat('buried-treasure', 'Buried Treasure', 'chest')]
  const ids = cats.map((c) => c.id).sort()
  const categoryById = new Map(cats.map((c) => [c.id, c]))
  const known: MapUrlKnown = {
    category: (id) => categoryById.has(id),
    power: () => true,
    region: () => true,
    point: () => false,
    quest: () => false,
  }

  /** Every cell and total opens a map with exactly that many chests; returns the map counter. */
  function expectAgreement(points: MapPoint[], powerOf?: ChestPowerOf) {
    const matrix = buildChestMatrix(points, new Set(ids), powerOf)
    const { drawable } = splitByWorld(points)
    const level = powerOf ? (p: MapPoint) => powerOf(p)?.level : undefined
    const onMap = (filter: MapFilter) => {
      const f = parseMapQuery(mapFilterLocation(filter).query, known, emptyFilters())
      const visibility = { powers: new Set(f.powers), strictPower: f.strictPower, regions: new Set(f.regions), hideFound: false, found: new Set<string>() }
      return visiblePoints(f.categories, categoryById, drawable, visibility, level).length
    }
    for (const row of matrix.rows) {
      row.cells.forEach((count, i) => {
        expect(onMap({ categories: ids, regions: [row.region!], powers: [matrix.powers[i]!], strictPower: true })).toBe(count)
      })
      expect(onMap({ categories: ids, regions: [row.region!] })).toBe(row.total)
    }
    matrix.totals.cells.forEach((count, i) => {
      expect(onMap({ categories: ids, powers: [matrix.powers[i]!], strictPower: true })).toBe(count)
    })
    expect(onMap({ categories: ids })).toBe(matrix.totals.total)
    return { matrix, onMap }
  }

  it('opens a map that shows exactly the chests counted in each cell', () => {
    const points = [
      chest('treasure-chest', 'Ghornfell', 3),
      chest('treasure-chest', 'Ghornfell', 3),
      chest('treasure-chest', 'Ghornfell', 4),
      chest('treasure-chest', 'Ghornfell'),
      chest('buried-treasure', 'Ghornfell'),
      chest('buried-treasure', 'Brynmoor', 2),
      chest('treasure-chest', 'Brynmoor'),
    ]
    const { onMap } = expectAgreement(points)
    // Without ps=1 the chests without a level would leak into a power level link.
    expect(onMap({ categories: ids, regions: ['Ghornfell'], powers: [3] })).toBe(4)
  })

  it('still agrees when chests carry estimated levels (map-power.ts)', () => {
    const points = [
      chest('treasure-chest', 'Dowdun Reach', 6),
      chest('treasure-chest', 'Dowdun Reach'),
      chest('treasure-chest', 'Fellhollow'),
      chest('buried-treasure', 'Fellhollow'),
      chest('treasure-chest', 'Scorned Wilderness'),
    ]
    const estimates = powerEstimates(points, (id) => categoryById.get(id)?.group, [{ region: 'Fellhollow', power: 5 }])
    const powerOf = (p: MapPoint) => pointPower(p, categoryById.get(p.categoryId)?.group, p.power, estimates)
    const { matrix } = expectAgreement(points, powerOf)
    expect(matrix.powers).toEqual([5, 6])
    expect(matrix.totals).toMatchObject({ cells: [1, 2], estimated: [1, 1], unknown: 2 })
  })
})
