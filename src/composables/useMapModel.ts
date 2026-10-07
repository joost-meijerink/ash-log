// Everything the map derives from the stores: drawable points, groups, counters, indexes.
// Read-only; the URL state lives in useMapState, Leaflet in useMapLeaflet.

import { computed } from 'vue'
import { groupCategories } from '@/lib/map-groups'
import {
  buildSearchIndex,
  collectPowers,
  defaultVaultCategoryIds,
  orderRegions,
  pointsExtent,
  splitByWorld,
} from '@/lib/map-filter'
import { buildPointLinks, foundPointIds } from '@/lib/map-found'
import { buildVaultIndex, effectivePower, questRegionHints, questStartGroups } from '@/lib/map-links'
import { pointPower as estimatePower, powerEstimates, type PointPower } from '@/lib/map-power'
import { defaultFilters, type MapUrlKnown } from '@/lib/map-url'
import type { MapPoint } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'

export function useMapModel() {
  const data = useDataStore()
  const progress = useProgressStore()

  /** Drawable points per category, and how many per category lie outside the map. */
  const split = computed(() => splitByWorld(data.points))
  const drawable = computed(() => split.value.drawable)
  const skipped = computed(() => split.value.skipped)

  const groups = computed(() => groupCategories(data.categories))
  const vaultIndex = computed(() => buildVaultIndex(data.vaults, data.pointById))

  /** Per region: the vault and chest levels the wiki gives, and the estimate for chests without one. */
  const estimates = computed(() => powerEstimates(data.points, (id) => data.categoryById.get(id)?.group, data.vaults))

  /** The point's own level, else its vault's, else the region estimate for a chest (map-power.ts). */
  function pointPower(point: MapPoint): PointPower | undefined {
    const category = data.categoryById.get(point.categoryId)
    return estimatePower(point, category?.group, effectivePower(point, category, vaultIndex.value), estimates.value)
  }

  /** Power level for the filter, chips and counters: estimated levels count as levels. */
  function powerOf(point: MapPoint): number | undefined {
    return pointPower(point)?.level
  }

  /** Levels on the map (the chips), and how many drawable points carry an estimated one. */
  const powerLevels = computed(() => {
    const levels: (number | undefined)[] = []
    let estimated = 0
    for (const list of drawable.value.values()) {
      for (const p of list) {
        const power = pointPower(p)
        levels.push(power?.level)
        if (power?.estimate) estimated++
      }
    }
    return { powers: collectPowers(levels), estimated }
  })
  /** Only levels of drawable points: 8 and 9 (player gear, Black Dragons off the map) never show. */
  const powers = computed(() => powerLevels.value.powers)
  const estimatedPowers = computed(() => powerLevels.value.estimated)

  const regions = computed(() => {
    const names: (string | undefined)[] = []
    for (const list of drawable.value.values()) for (const p of list) names.push(p.region)
    const hints = [...questRegionHints(data.quests), ...data.vaults.map((v) => v.region ?? '')]
    return orderRegions(names, hints)
  })

  const defaults = computed(() => defaultFilters(defaultVaultCategoryIds(data.categories, drawable.value)))

  /** Aliases of merged twin points, and the rewards picked up at unique points. */
  const links = computed(() => buildPointLinks(data.points, data.rewards))
  /** Point ids ticked on the map (progress.points), as stored: may hold alias ids. */
  const marks = computed<ReadonlySet<string>>(() => new Set(Object.keys(progress.state.points)))
  /** Reward ids you own (progress.rewards). */
  const owned = computed<ReadonlySet<string>>(() => new Set(Object.keys(progress.state.rewards)))
  /**
   * Found point ids, the one rule from map-found.ts: a tick on the point or an alias, or an owned
   * linked reward. Markers, hide-found, counters and the card all read this set.
   */
  const found = computed<ReadonlySet<string>>(() => foundPointIds(links.value, marks.value, owned.value))

  const searchEntries = computed(() => buildSearchIndex(data.categories, drawable.value))
  const startGroups = computed(() => questStartGroups(data.quests))
  const questsWithStart = computed(() => data.quests.filter((q) => q.start).length)

  /** Box around every drawable point: the land, used for the first view. */
  const landExtent = computed(() => {
    const all: MapPoint[] = []
    for (const list of drawable.value.values()) all.push(...list)
    return pointsExtent(all)
  })

  /**
   * Changes when a sync brought new map data, or a category was moved to another group by hand
   * (marker glyphs and found dimming depend on the group); cached markers are rebuilt then.
   */
  const dataVersion = computed(() => {
    const moved = Object.entries(data.overrides.categoryGroup)
      .map(([id, group]) => `${id}=${group}`)
      .sort()
      .join(',')
    return `${data.meta?.syncedAt ?? ''}:${data.points.length}:${data.categories.length}:${moved}`
  })

  const known = computed<MapUrlKnown>(() => {
    const powerSet = new Set(powers.value)
    const regionSet = new Set(regions.value)
    return {
      category: (id) => data.categoryById.has(id),
      power: (level) => powerSet.has(level),
      region: (name) => regionSet.has(name),
      point: (id) => data.pointById.has(id),
      pointAlias: (id) => links.value.aliasOf.get(id),
      quest: (id) => data.questById.has(id),
    }
  })

  return {
    drawable,
    skipped,
    groups,
    vaultIndex,
    estimates,
    pointPower,
    powerOf,
    powers,
    estimatedPowers,
    regions,
    defaults,
    links,
    marks,
    owned,
    found,
    searchEntries,
    startGroups,
    questsWithStart,
    landExtent,
    dataVersion,
    known,
  }
}

export type MapModel = ReturnType<typeof useMapModel>
