import { describe, expect, it } from 'vitest'
import {
  buildSearchIndex,
  categoryMatches,
  collectPowers,
  countCategories,
  defaultVaultCategoryIds,
  hiddenAsFound,
  isInWorld,
  isPointVisible,
  matchesPower,
  matchesRegion,
  normalizeSearch,
  orderRegions,
  pointsExtent,
  searchIndex,
  searchTerms,
  splitByWorld,
  visiblePoints,
  type VisibilityFilter,
} from './map-filter'
import { WORLD_BOUNDS } from './projection'
import type { MapCategory, MapGroup, MapPoint } from './types'

function cat(id: string, group: MapGroup, label = id, count = 0): MapCategory {
  return { id, label, group, sources: [], count }
}

function pt(categoryId: string, x: number, y: number, extra: Partial<MapPoint> = {}): MapPoint {
  return { id: `${categoryId}:${Math.round(x)}:${Math.round(y)}`, categoryId, x, y, ...extra }
}

const none: VisibilityFilter = { powers: new Set(), regions: new Set(), hideFound: false, found: new Set() }

describe('world bounds', () => {
  const [[minLat, minLng], [maxLat, maxLng]] = WORLD_BOUNDS

  it('accepts the Windmill and the edges, rejects instanced areas', () => {
    expect(isInWorld({ x: 16773, y: 171786 })).toBe(true)
    expect(isInWorld({ x: minLng, y: minLat })).toBe(true)
    expect(isInWorld({ x: maxLng, y: maxLat })).toBe(true)
    // A vault interior from the real data.
    expect(isInWorld({ x: -442621.7, y: 76190.87 })).toBe(false)
    expect(isInWorld({ x: 424683.84, y: 450678.72 })).toBe(false)
    expect(isInWorld({ x: minLng - 1, y: 0 })).toBe(false)
  })

  it('splits points into drawable and skipped per category', () => {
    const { drawable, skipped } = splitByWorld([
      pt('gypsum-node', 100, 100),
      pt('gypsum-node', -500000, 70000),
      pt('gypsum-node', -500001, 70001),
      pt('coal-node', 200, 200),
    ])
    expect(drawable.get('gypsum-node')).toHaveLength(1)
    expect(drawable.get('coal-node')).toHaveLength(1)
    expect(skipped.get('gypsum-node')).toBe(2)
    expect(skipped.has('coal-node')).toBe(false)
  })

  it('never draws a point outside the world, whatever the filters', () => {
    expect(isPointVisible(pt('gypsum-node', -500000, 70000), 'resource', none)).toBe(false)
  })

  it('computes the extent of the land', () => {
    expect(pointsExtent([])).toBeNull()
    expect(pointsExtent([{ x: 5, y: -3 }, { x: -2, y: 8 }])).toEqual({ minX: -2, minY: -3, maxX: 5, maxY: 8 })
  })
})

describe('power level filter', () => {
  it('shows everything without a selection', () => {
    expect(matchesPower(3, new Set())).toBe(true)
    expect(matchesPower(undefined, new Set())).toBe(true)
  })

  it('hides points with another level, keeps points without one', () => {
    const sel = new Set([5, 6])
    expect(matchesPower(5, sel)).toBe(true)
    expect(matchesPower(2, sel)).toBe(false)
    expect(matchesPower(undefined, sel)).toBe(true)
  })

  it('hides points without a level too in strict mode, only while a level is picked', () => {
    const sel = new Set([3])
    expect(matchesPower(undefined, sel, true)).toBe(false)
    expect(matchesPower(3, sel, true)).toBe(true)
    expect(matchesPower(4, sel, true)).toBe(false)
    expect(matchesPower(undefined, new Set(), true)).toBe(true)
    const chest = pt('buried-treasure', 1, 1)
    expect(isPointVisible(chest, 'chest', { ...none, powers: sel })).toBe(true)
    expect(isPointVisible(chest, 'chest', { ...none, powers: sel, strictPower: true })).toBe(false)
  })

  it('uses the effective power passed in (a vault point without its own level)', () => {
    const vault = pt('vaults', 37482, 191753)
    const filter = { ...none, powers: new Set([5]) }
    expect(isPointVisible(vault, 'vault', filter)).toBe(true)
    expect(isPointVisible(vault, 'vault', filter, 2)).toBe(false)
  })

  it('collects distinct levels in order', () => {
    expect(collectPowers([6, undefined, 2, 6, 9, Number.NaN])).toEqual([2, 6, 9])
  })
})

describe('region filter', () => {
  it('keeps only points in a selected region, stated or guessed', () => {
    const sel = new Set(['Brynmoor'])
    expect(matchesRegion('Brynmoor', sel)).toBe(true)
    expect(matchesRegion('Fellhollow', sel)).toBe(false)
    expect(matchesRegion(undefined, sel)).toBe(false)
    expect(matchesRegion(undefined, new Set())).toBe(true)
    const guessed = pt('ash-tree', 100, 100, { region: 'Brynmoor', regionGuessed: true })
    expect(isPointVisible(guessed, 'resource', { ...none, regions: sel })).toBe(true)
  })

  it('orders regions by the hints, then alphabetically', () => {
    const hints = ['Temple Woods', 'Brynmoor', 'Ghornfell', 'Fellhollow', 'Dowdun Reach', 'Umbral Sands']
    expect(orderRegions(['Umbral Sands', 'Scorned Wilderness', 'Brynmoor', undefined, 'Atlantis', 'Fellhollow', 'Brynmoor'], hints)).toEqual([
      'Brynmoor',
      'Fellhollow',
      'Umbral Sands',
      'Atlantis',
      'Scorned Wilderness',
    ])
  })
})

describe('hide found', () => {
  const found = new Set(['lore-scraps:1:1', 'treasure-chest:2:2'])

  it('only hides found lore and unique points', () => {
    const filter = { hideFound: true, found }
    expect(hiddenAsFound('lore-scraps:1:1', 'lore', filter)).toBe(true)
    expect(hiddenAsFound('treasure-chest:2:2', 'chest', filter)).toBe(false)
    expect(hiddenAsFound('lore-scraps:9:9', 'lore', filter)).toBe(false)
    expect(hiddenAsFound('lore-scraps:1:1', 'lore', { hideFound: false, found })).toBe(false)
  })
})

describe('visiblePoints', () => {
  const categories = [cat('lore-scraps', 'lore'), cat('treasure-chest', 'chest'), cat('ash-tree', 'resource')]
  const byId = new Map(categories.map((c) => [c.id, c]))
  const points = [
    pt('lore-scraps', 1, 1, { region: 'Brynmoor' }),
    pt('lore-scraps', 2, 2, { region: 'Fellhollow' }),
    pt('treasure-chest', 3, 3, { power: 2, region: 'Brynmoor' }),
    pt('treasure-chest', 4, 4, { power: 6, region: 'Brynmoor' }),
    pt('treasure-chest', -900000, 4, { power: 6 }),
    pt('ash-tree', 5, 5, { region: 'Brynmoor' }),
  ]
  const { drawable } = splitByWorld(points)

  it('draws only enabled categories', () => {
    const out = visiblePoints(['lore-scraps', 'unknown'], byId, drawable, none)
    expect(out.map((p) => p.id)).toEqual(['lore-scraps:1:1', 'lore-scraps:2:2'])
  })

  it('combines power, region and hide found', () => {
    const out = visiblePoints(['lore-scraps', 'treasure-chest', 'ash-tree'], byId, drawable, {
      powers: new Set([6]),
      regions: new Set(['Brynmoor']),
      hideFound: true,
      found: new Set(['lore-scraps:1:1']),
    })
    expect(out.map((p) => p.id).sort()).toEqual(['ash-tree:5:5', 'treasure-chest:4:4'])
  })

  it('counts per category after power and region, with found among them', () => {
    const counts = countCategories(categories, drawable, {
      powers: new Set(),
      regions: new Set(['Brynmoor']),
      found: new Set(['lore-scraps:1:1', 'treasure-chest:3:3']),
    })
    expect(counts.get('lore-scraps')).toEqual({ total: 1, found: 1 })
    // Chests reset: never a found count.
    expect(counts.get('treasure-chest')).toEqual({ total: 2, found: 0 })
    expect(countCategories(categories, drawable, { powers: new Set(), regions: new Set(), found: new Set() }).get('lore-scraps')).toEqual({
      total: 2,
      found: 0,
    })
  })

  it('shows and counts the same chests in strict power mode', () => {
    // Like a chest overview cell: 'PL 6 in Brynmoor' must match what the map shows.
    const filter = { powers: new Set([6]), strictPower: true, regions: new Set(['Brynmoor']), hideFound: false, found: new Set<string>() }
    const shown = visiblePoints(['lore-scraps', 'treasure-chest', 'ash-tree'], byId, drawable, filter)
    expect(shown.map((p) => p.id)).toEqual(['treasure-chest:4:4'])
    const counts = countCategories(categories, drawable, filter)
    expect(counts.get('treasure-chest')).toEqual({ total: 1, found: 0 })
    expect(counts.get('lore-scraps')).toEqual({ total: 0, found: 0 })
    expect(counts.get('ash-tree')).toEqual({ total: 0, found: 0 })
  })
})

describe('defaultVaultCategoryIds', () => {
  it('picks the vaults page and skips per-vault pages on the same spots', () => {
    const categories = [
      cat('vaults', 'vault'),
      cat('crasorak-kara', 'vault'),
      cat('chaktan-kara', 'vault'),
      cat('lonely-kara', 'vault'),
      cat('ash-tree', 'resource'),
    ]
    const { drawable } = splitByWorld([
      pt('vaults', 37482, 191753),
      pt('vaults', 15712, 79152),
      pt('crasorak-kara', 37482, 191753),
      pt('chaktan-kara', 15712.4, 79151.8),
      pt('lonely-kara', 90000, 90000),
      pt('ash-tree', 1, 1),
    ])
    expect(defaultVaultCategoryIds(categories, drawable)).toEqual(['lonely-kara', 'vaults'])
  })

  it('returns nothing without vault data', () => {
    expect(defaultVaultCategoryIds([cat('ash-tree', 'resource')], new Map())).toEqual([])
  })
})

describe('search', () => {
  const categories = [
    cat('ash-tree', 'resource', 'Ash Tree'),
    cat('childs-storybook', 'lore', 'Child’s Storybook'),
    cat('net-fishing-spot', 'resource', 'Net Fishing Spot'),
    cat('crasorak-kara', 'vault', 'Crasorak Kara'),
  ]
  const trees = Array.from({ length: 30 }, (_, i) => pt('ash-tree', i * 10, i * 10))
  const { drawable } = splitByWorld([
    ...trees,
    pt('childs-storybook', 5, 5),
    pt('net-fishing-spot', 7, 7, { name: 'Net Fishing Spot (Lobster)', region: 'Brynmoor' }),
    pt('net-fishing-spot', 8, 8, { name: 'Net Fishing Spot (Shrimp)' }),
    pt('crasorak-kara', 37482, 191753, { description: 'The location of the Crasorak Kara vault in Temple Woods' }),
  ])
  const index = buildSearchIndex(categories, drawable)

  it('normalizes accents, case and apostrophes', () => {
    expect(normalizeSearch('Child’s Storybook')).toBe('childs storybook')
    expect(searchTerms("  Child's  STORY ")).toEqual(['childs', 'story'])
  })

  it('indexes named points and small categories, not every ash tree', () => {
    expect(index.some((e) => e.category.id === 'ash-tree')).toBe(false)
    expect(index.find((e) => e.category.id === 'childs-storybook')?.title).toBe('Child’s Storybook')
  })

  it('needs every term to match', () => {
    expect(searchIndex(index, 'fishing lobster').hits.map((h) => h.title)).toEqual(['Net Fishing Spot (Lobster)'])
    expect(searchIndex(index, "child's").hits).toHaveLength(1)
    expect(searchIndex(index, 'temple woods').hits.map((h) => h.category.id)).toEqual(['crasorak-kara'])
    expect(searchIndex(index, '   ')).toEqual({ hits: [], total: 0 })
  })

  it('caps the list and reports the total', () => {
    const r = searchIndex(index, 'net', 1)
    expect(r.hits).toHaveLength(1)
    expect(r.total).toBe(2)
  })

  it('ranks titles that start with the query first', () => {
    const many = buildSearchIndex(
      [cat('a', 'lore', 'A'), cat('b', 'lore', 'B')],
      splitByWorld([pt('a', 1, 1, { name: 'Old Gold Mine' }), pt('b', 2, 2, { name: 'Gold Nugget' })]).drawable,
    )
    expect(searchIndex(many, 'gold').hits.map((h) => h.title)).toEqual(['Gold Nugget', 'Old Gold Mine'])
  })

  it('matches categories by label', () => {
    expect(categoryMatches(categories[0]!, searchTerms('ash'))).toBe(true)
    expect(categoryMatches(categories[0]!, searchTerms('oak'))).toBe(false)
    expect(categoryMatches(categories[0]!, [])).toBe(true)
  })
})
