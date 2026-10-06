// Filter rules for the map: what is drawable, what a filter hides, search and counters.
// Pure, no DOM and no Leaflet: this file is also type-checked by the Node config.

import { WORLD_BOUNDS } from './projection'
import { compareLabels, isTrackableGroup } from './map-groups'
import type { MapCategory, MapGroup, MapPoint } from './types'

/* ------------------------------------------------------------------ */
/* World bounds                                                         */
/* ------------------------------------------------------------------ */

const [[MIN_LAT, MIN_LNG], [MAX_LAT, MAX_LNG]] = WORLD_BOUNDS

/**
 * True when a point lies on the overworld tiles. Vault interiors and other instanced areas use
 * coordinates far outside the map; those are out of scope and never drawn.
 */
export function isInWorld(point: { x: number; y: number }): boolean {
  return point.y >= MIN_LAT && point.y <= MAX_LAT && point.x >= MIN_LNG && point.x <= MAX_LNG
}

export interface SplitPoints {
  /** Points that can be drawn, per category id. */
  drawable: Map<string, MapPoint[]>
  /** Points outside the world bounds, per category id (only categories that have any). */
  skipped: Map<string, number>
}

/** Splits every category's points into drawable ones and a count of skipped ones. */
export function splitByWorld(points: readonly MapPoint[]): SplitPoints {
  const drawable = new Map<string, MapPoint[]>()
  const skipped = new Map<string, number>()
  for (const p of points) {
    if (isInWorld(p)) {
      const list = drawable.get(p.categoryId)
      if (list) list.push(p)
      else drawable.set(p.categoryId, [p])
    } else {
      skipped.set(p.categoryId, (skipped.get(p.categoryId) ?? 0) + 1)
    }
  }
  return { drawable, skipped }
}

/** Game-coordinate box around the given points, or null for an empty list. */
export function pointsExtent(points: Iterable<{ x: number; y: number }>): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}

/* ------------------------------------------------------------------ */
/* Power level, region and found                                        */
/* ------------------------------------------------------------------ */

export interface VisibilityFilter {
  /** Selected power levels. Empty = no power filter. */
  powers: ReadonlySet<number>
  /** With levels selected, also hide points without a power level (URL ps=1). */
  strictPower?: boolean
  /** Selected top-level regions. Empty = no region filter. */
  regions: ReadonlySet<string>
  /** Hide found lore and unique points. */
  hideFound: boolean
  /** Ids of found points, from foundPointIds in map-found.ts (aliases and reward links applied). */
  found: { has(id: string): boolean }
}

/**
 * Power filter: with any level selected, a point that has a power level must match one of them.
 * Points without a power level (most resources, NPCs, lore) stay visible, unless `strict` is on:
 * then only points with one of the selected levels remain (the chest overview links use that).
 */
export function matchesPower(power: number | undefined, powers: ReadonlySet<number>, strict = false): boolean {
  return powers.size === 0 || (power === undefined ? !strict : powers.has(power))
}

/**
 * Region filter: with any region selected, only points in one of those regions stay visible,
 * stated or guessed. Points without a region do not match.
 */
export function matchesRegion(region: string | undefined, regions: ReadonlySet<string>): boolean {
  return regions.size === 0 || (region !== undefined && regions.has(region))
}

/** 'Hide what I've found' only hides lore and unique points; chests reset. */
export function hiddenAsFound(pointId: string, group: MapGroup | undefined, filter: Pick<VisibilityFilter, 'hideFound' | 'found'>): boolean {
  return filter.hideFound && isTrackableGroup(group) && filter.found.has(pointId)
}

/**
 * The full rule for one point of an enabled category.
 * `power` is the effective power level (the point's own, or its vault's); defaults to point.power.
 */
export function isPointVisible(
  point: MapPoint,
  group: MapGroup | undefined,
  filter: VisibilityFilter,
  power: number | undefined = point.power,
): boolean {
  return (
    isInWorld(point) &&
    matchesPower(power, filter.powers, filter.strictPower) &&
    matchesRegion(point.region, filter.regions) &&
    !hiddenAsFound(point.id, group, filter)
  )
}

/** Every point to draw: drawable points of the enabled categories that pass the filters. */
export function visiblePoints(
  categoryIds: Iterable<string>,
  categoryById: ReadonlyMap<string, MapCategory>,
  drawable: ReadonlyMap<string, readonly MapPoint[]>,
  filter: VisibilityFilter,
  powerOf: (point: MapPoint) => number | undefined = (p) => p.power,
): MapPoint[] {
  const out: MapPoint[] = []
  for (const id of categoryIds) {
    const category = categoryById.get(id)
    if (!category) continue
    for (const p of drawable.get(id) ?? []) {
      if (isPointVisible(p, category.group, filter, powerOf(p))) out.push(p)
    }
  }
  return out
}

/** Distinct power levels, ascending. */
export function collectPowers(powers: Iterable<number | undefined>): number[] {
  const set = new Set<number>()
  for (const p of powers) if (typeof p === 'number' && Number.isFinite(p)) set.add(p)
  return [...set].sort((a, b) => a - b)
}

/**
 * Distinct regions in a sensible order: first as listed in `hints` (the primary quest line and
 * vault order), then the rest alphabetically.
 */
export function orderRegions(regions: Iterable<string | undefined>, hints: readonly string[] = []): string[] {
  const rank = new Map<string, number>()
  for (const hint of hints) if (!rank.has(hint)) rank.set(hint, rank.size)
  const set = new Set<string>()
  for (const r of regions) if (r) set.add(r)
  return [...set].sort((a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER
    return ra - rb || compareLabels(a, b)
  })
}

/* ------------------------------------------------------------------ */
/* Defaults                                                             */
/* ------------------------------------------------------------------ */

/** Two vault markers closer than this (game units) are the same entrance. */
const SAME_SPOT = 500

/**
 * Vault categories to show by default. The wiki has one 'Vaults' page with every entrance plus a
 * page per vault on the same spots; pick the biggest one and add others only when they cover
 * a spot it misses, so the default map has no double markers.
 */
export function defaultVaultCategoryIds(categories: readonly MapCategory[], drawable: ReadonlyMap<string, readonly MapPoint[]>): string[] {
  const vaults = categories
    .filter((c) => c.group === 'vault')
    .map((c) => ({ id: c.id, points: drawable.get(c.id) ?? [] }))
    .filter((c) => c.points.length > 0)
    .sort((a, b) => b.points.length - a.points.length || a.id.localeCompare(b.id))
  const covered: { x: number; y: number }[] = []
  const chosen: string[] = []
  for (const c of vaults) {
    const adds = c.points.some((p) => !covered.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < SAME_SPOT))
    if (!adds) continue
    chosen.push(c.id)
    covered.push(...c.points)
  }
  return chosen.sort()
}

/* ------------------------------------------------------------------ */
/* Counters                                                             */
/* ------------------------------------------------------------------ */

export interface CategoryCount {
  /** Drawable points that pass the power and region filters. */
  total: number
  /** Found points among `total` (lore and unique only, else 0). */
  found: number
}

/**
 * Per category: how many drawable points pass the power and region filters, and how many of
 * those are found. Hide-found is ignored on purpose: the counter shows 'found / total'.
 */
export function countCategories(
  categories: readonly MapCategory[],
  drawable: ReadonlyMap<string, readonly MapPoint[]>,
  filter: Pick<VisibilityFilter, 'powers' | 'strictPower' | 'regions' | 'found'>,
  powerOf: (point: MapPoint) => number | undefined = (p) => p.power,
): Map<string, CategoryCount> {
  const out = new Map<string, CategoryCount>()
  const plain = filter.powers.size === 0 && filter.regions.size === 0
  for (const category of categories) {
    const points = drawable.get(category.id) ?? []
    const trackable = isTrackableGroup(category.group)
    let total = 0
    let found = 0
    for (const p of points) {
      if (!plain && !(matchesPower(powerOf(p), filter.powers, filter.strictPower) && matchesRegion(p.region, filter.regions))) continue
      total++
      if (trackable && filter.found.has(p.id)) found++
    }
    out.set(category.id, { total, found })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Search                                                               */
/* ------------------------------------------------------------------ */

/** Lowercase, no accents, no apostrophes: 'Child’s Storybook' -> 'childs storybook'. */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')
    .toLowerCase()
}

/** Search terms of a query; every term must match (AND). */
export function searchTerms(query: string): string[] {
  return normalizeSearch(query).split(/[^a-z0-9]+/).filter(Boolean)
}

export function matchesTerms(normalizedText: string, terms: readonly string[]): boolean {
  return terms.every((t) => normalizedText.includes(t))
}

/** True when the category label matches every term. */
export function categoryMatches(category: MapCategory, terms: readonly string[]): boolean {
  return terms.length === 0 || matchesTerms(normalizeSearch(category.label), terms)
}

export interface SearchEntry {
  point: MapPoint
  category: MapCategory
  /** What the result list shows: the point name, else the category label. */
  title: string
  /** Normalized text the terms are matched against. */
  text: string
  /** Normalized title, for ranking. */
  key: string
}

/**
 * Categories with at most this many points are searchable per point by their label (a single
 * lore book, a vault, a quest NPC). Bigger ones (Ash Tree, 1847 points) are found as a category.
 */
export const SMALL_CATEGORY = 5

/** Search entries: named points, plus every point of a small category. Only drawable points. */
export function buildSearchIndex(categories: readonly MapCategory[], drawable: ReadonlyMap<string, readonly MapPoint[]>): SearchEntry[] {
  const entries: SearchEntry[] = []
  for (const category of categories) {
    const points = drawable.get(category.id) ?? []
    const small = points.length <= SMALL_CATEGORY
    for (const point of points) {
      if (!point.name && !small) continue
      const title = point.name ?? category.label
      const text = normalizeSearch([title, category.label, point.name ? '' : (point.description ?? '')].join(' '))
      entries.push({ point, category, title, text, key: normalizeSearch(title) })
    }
  }
  return entries
}

export interface SearchResult {
  hits: SearchEntry[]
  /** All matches, including the ones cut off by the limit. */
  total: number
}

/**
 * Matches the query against the index. Ranking: title starts with the query, then a word in the
 * title starts with the first term, then the rest; ties alphabetically.
 */
export function searchIndex(entries: readonly SearchEntry[], query: string, limit = 20): SearchResult {
  const terms = searchTerms(query)
  if (terms.length === 0) return { hits: [], total: 0 }
  const whole = terms.join(' ')
  const first = terms[0]!
  const rank = (e: SearchEntry) => {
    if (e.key.startsWith(whole)) return 0
    if (e.key.split(/[^a-z0-9]+/).some((w) => w.startsWith(first))) return 1
    return 2
  }
  const matches = entries
    .filter((e) => matchesTerms(e.text, terms))
    .map((e) => ({ e, r: rank(e) }))
    .sort((a, b) => a.r - b.r || compareLabels(a.e.title, b.e.title) || a.e.point.id.localeCompare(b.e.point.id))
  return { hits: matches.slice(0, Math.max(0, limit)).map((m) => m.e), total: matches.length }
}
