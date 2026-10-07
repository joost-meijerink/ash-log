// Estimated power levels for treasure chests the wiki gives no level. Pure, computed on the client
// from the synced wiki data, so it needs no resync.
//
// The wiki states a level for about half of the treasure chests (chests.json covers Brynmoor,
// Ghornfell and Dowdun Reach). The rule, per top-level region:
//  1. Evidence: the vault levels in the region (the Dragonkin Vault table, vaults.json) and the
//     wiki levels of chest points whose region the wiki states.
//  2. All evidence names one and the same level: that is the region's estimate.
//  3. No evidence (Scorned Wilderness) or more than one level (Ghornfell: 3 and 4): no estimate.
// A point gets the estimate only when it has no level of its own, its region is stated by the wiki
// (a guessed region would make it a guess on a guess), and its category is a chest category the
// wiki gives levels elsewhere (Treasure Chest). Kinds the wiki never levels (Buried Treasure,
// Spectral Chest) may not scale with power at all, so they stay without one.
// Levels 8 and 9 are player gear levels; no region or chest reaches them, and nothing here adds them.

import type { MapGroup, MapPoint, Vault } from './types'

export type PowerBasis = 'vaults' | 'chests' | 'both'

export interface RegionPower {
  region: string
  /** Distinct vault levels in the region, ascending. */
  vaults: number[]
  /** Distinct wiki levels of chests in the region (stated region only), ascending. */
  chests: number[]
  /** The estimate; only set when the evidence names exactly one level. */
  level?: number
  /** Where the estimate comes from. */
  basis?: PowerBasis
}

export interface PowerEstimates {
  /** Evidence and estimate per region, for every region with chests or vaults. */
  regions: Map<string, RegionPower>
  /** Chest categories with at least one wiki level: only their points get an estimate. */
  categories: Set<string>
}

/** A point's power level and, when the wiki gives none, the region estimate it came from. */
export interface PointPower {
  level: number
  estimate?: RegionPower
}

const isLevel = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b)

export function powerEstimates(
  points: readonly MapPoint[],
  groupOf: (categoryId: string) => MapGroup | undefined,
  vaults: readonly Pick<Vault, 'region' | 'power'>[],
): PowerEstimates {
  const evidence = new Map<string, { vaults: Set<number>; chests: Set<number> }>()
  const of = (region: string) => {
    let e = evidence.get(region)
    if (!e) evidence.set(region, (e = { vaults: new Set(), chests: new Set() }))
    return e
  }
  const categories = new Set<string>()
  for (const v of vaults) if (v.region && isLevel(v.power)) of(v.region).vaults.add(v.power)
  for (const p of points) {
    if (groupOf(p.categoryId) !== 'chest') continue
    if (isLevel(p.power)) categories.add(p.categoryId)
    if (!p.region || p.regionGuessed) continue
    const e = of(p.region)
    if (isLevel(p.power)) e.chests.add(p.power)
  }

  const regions = new Map<string, RegionPower>()
  for (const [region, e] of evidence) {
    const entry: RegionPower = { region, vaults: sorted(e.vaults), chests: sorted(e.chests) }
    const all = new Set([...e.vaults, ...e.chests])
    if (all.size === 1) {
      entry.level = [...all][0]!
      entry.basis = e.vaults.size && e.chests.size ? 'both' : e.vaults.size ? 'vaults' : 'chests'
    }
    regions.set(region, entry)
  }
  return { regions, categories }
}

/** The region estimate for a chest without a level of its own; undefined for anything else. */
export function estimatedPower(point: MapPoint, group: MapGroup | undefined, estimates: PowerEstimates): RegionPower | undefined {
  if (group !== 'chest' || !estimates.categories.has(point.categoryId)) return undefined
  if (isLevel(point.power) || !point.region || point.regionGuessed) return undefined
  const estimate = estimates.regions.get(point.region)
  return estimate?.level === undefined ? undefined : estimate
}

/** A known level (the point's own, or its vault's) wins; else the region estimate. */
export function pointPower(
  point: MapPoint,
  group: MapGroup | undefined,
  known: number | undefined,
  estimates: PowerEstimates,
): PointPower | undefined {
  if (isLevel(known)) return { level: known }
  const estimate = estimatedPower(point, group, estimates)
  return estimate ? { level: estimate.level!, estimate } : undefined
}

const BASIS_TEXT: Record<PowerBasis, string> = {
  vaults: 'the vaults',
  chests: 'the other chests',
  both: 'the vaults and other chests',
}

/** Short explanation for the point card: 'No level on the wiki. Estimated from the vaults in Fellhollow.' */
export function estimateNote(estimate: RegionPower): string {
  return `No level on the wiki. Estimated from ${BASIS_TEXT[estimate.basis ?? 'vaults']} in ${estimate.region}.`
}
