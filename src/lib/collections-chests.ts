// Treasure chests on the collections page: a region x power level matrix with map links.
// Chests reset, so there is no found/total here, only where they are. Pure functions only.

import { compareNames, compareRegions } from './collections-shared'
import type { MapCategory, MapGroup, MapPoint, Overrides } from './types'

/** Group of a category after the manual categoryGroup override. */
export function effectiveGroup(category: MapCategory, overrides?: Pick<Overrides, 'categoryGroup'>): MapGroup {
  return overrides?.categoryGroup?.[category.id] ?? category.group
}

/** Categories with group 'chest', by label. */
export function chestCategories(
  categories: readonly MapCategory[],
  overrides?: Pick<Overrides, 'categoryGroup'>,
): MapCategory[] {
  return categories
    .filter((c) => effectiveGroup(c, overrides) === 'chest')
    .sort((a, b) => compareNames(a.label, b.label))
}

export interface ChestRow {
  /** Top-level region, or null for points without one. */
  region: string | null
  /** Counts per power level, aligned with ChestMatrix.powers. */
  cells: number[]
  /** Points without a power level. */
  unknown: number
  total: number
}

export interface ChestMatrix {
  /** Power levels that occur in the chest points, ascending (the columns). */
  powers: number[]
  /** True when some chest point has no power level ('Unknown' column). */
  hasUnknown: boolean
  /** One row per region in play order; regions without any chest point are left out. */
  rows: ChestRow[]
  /** Column totals over all regions. */
  totals: Omit<ChestRow, 'region'>
}

/**
 * Counts `points` (all chest points) per region and power level. Only points in `selected`
 * categories are counted, but rows and columns come from all points, so the table keeps
 * its shape when a category is switched off.
 */
export function buildChestMatrix(points: readonly MapPoint[], selected: ReadonlySet<string>): ChestMatrix {
  const powerSet = new Set<number>()
  const regionSet = new Set<string | null>()
  let hasUnknown = false
  for (const p of points) {
    if (typeof p.power === 'number' && Number.isFinite(p.power)) powerSet.add(p.power)
    else hasUnknown = true
    regionSet.add(p.region?.trim() || null)
  }
  const powers = [...powerSet].sort((a, b) => a - b)
  const column = new Map(powers.map((pw, i) => [pw, i]))
  const regions = [...regionSet].sort(compareRegions)
  const rowByRegion = new Map<string | null, ChestRow>(
    regions.map((region) => [region, { region, cells: powers.map(() => 0), unknown: 0, total: 0 }]),
  )
  const totals = { cells: powers.map(() => 0), unknown: 0, total: 0 }

  for (const p of points) {
    if (!selected.has(p.categoryId)) continue
    const row = rowByRegion.get(p.region?.trim() || null)!
    const col = typeof p.power === 'number' ? column.get(p.power) : undefined
    if (col === undefined) {
      row.unknown++
      totals.unknown++
    } else {
      row.cells[col]!++
      totals.cells[col]!++
    }
    row.total++
    totals.total++
  }

  return { powers, hasUnknown, rows: [...rowByRegion.values()], totals }
}

export interface MapFilter {
  /** Category ids (?c=). */
  categories: readonly string[]
  /** Top-level regions (?r=). */
  regions?: readonly string[]
  /** Power levels (?p=). */
  powers?: readonly number[]
  /**
   * Strict power (?ps=1): also hide points without a power level, so the map shows exactly
   * the chests counted in a power level cell. Only written together with powers.
   */
  strictPower?: boolean
}

/** Vue Router location for /map?c=...&r=...&p=...&ps=1 (empty lists are left out). */
export function mapFilterLocation(filter: MapFilter): { path: '/map'; query: Record<string, string> } {
  const query: Record<string, string> = {}
  if (filter.categories.length) query.c = filter.categories.join(',')
  if (filter.regions?.length) query.r = filter.regions.join(',')
  if (filter.powers?.length) {
    query.p = filter.powers.join(',')
    if (filter.strictPower) query.ps = '1'
  }
  return { path: '/map', query }
}

/** The same location as a URL string, e.g. '/map?c=treasure-chest&r=Dowdun%20Reach&p=2&ps=1'. */
export function mapFilterHref(filter: MapFilter): string {
  const { path, query } = mapFilterLocation(filter)
  const parts = Object.entries(query).map(
    ([k, v]) => `${k}=${v.split(',').map(encodeURIComponent).join(',')}`,
  )
  return parts.length ? `${path}?${parts.join('&')}` : path
}
