// When a map point counts as found. One rule for markers, hide-found, counters and the card:
//
//   found = the point or one of its aliases is ticked on the map (progress.points)
//           OR a reward linked to the point (Reward.pointIds) is owned (progress.rewards)
//
// Aliases are twin points the sync merged into this one; ticks on them still count. A point with
// linked rewards is ticked through the reward, so the map and Collections never disagree.
// Pure, no DOM: this file is also type-checked by the Node config.

import type { MapPoint, Reward } from './types'

export interface PointLinks {
  /** Alias id -> id of the point that was kept. */
  aliasOf: ReadonlyMap<string, string>
  /** Point id -> rewards you pick up there, in data order. */
  rewardsByPoint: ReadonlyMap<string, readonly Reward[]>
}

/** Point ids that stand for the same spot: the point itself, then its aliases. */
export function markIds(point: Pick<MapPoint, 'id' | 'aliases'>): string[] {
  return [point.id, ...(point.aliases ?? [])]
}

/** Builds the lookups once per data load. Reward links to an alias land on the kept point. */
export function buildPointLinks(points: readonly MapPoint[], rewards: readonly Reward[]): PointLinks {
  const aliasOf = new Map<string, string>()
  for (const p of points) for (const alias of p.aliases ?? []) if (alias !== p.id) aliasOf.set(alias, p.id)

  const rewardsByPoint = new Map<string, Reward[]>()
  for (const r of rewards) {
    const seen = new Set<string>()
    for (const raw of r.pointIds ?? []) {
      const id = aliasOf.get(raw) ?? raw
      if (seen.has(id)) continue
      seen.add(id)
      const list = rewardsByPoint.get(id)
      if (list) list.push(r)
      else rewardsByPoint.set(id, [r])
    }
  }
  return { aliasOf, rewardsByPoint }
}

/** The kept point id for an alias, else the id itself. */
export function canonicalPointId(id: string, links: PointLinks): string {
  return links.aliasOf.get(id) ?? id
}

/** Rewards picked up at this point (empty when none are linked). */
export function linkedRewards(pointId: string, links: PointLinks): readonly Reward[] {
  return links.rewardsByPoint.get(pointId) ?? []
}

/**
 * Ids of every found point, as kept point ids. `marks` are the ids ticked on the map, `owned`
 * the reward ids you have. Only marks and linked points are visited, so this stays cheap.
 */
export function foundPointIds(
  links: PointLinks,
  marks: Iterable<string>,
  owned: { has(id: string): boolean },
): Set<string> {
  const out = new Set<string>()
  for (const id of marks) out.add(canonicalPointId(id, links))
  for (const [pointId, rewards] of links.rewardsByPoint) {
    if (rewards.some((r) => owned.has(r.id))) out.add(pointId)
  }
  return out
}

export interface PointFoundState {
  /** Found by any route: the same answer as foundPointIds(...).has(point.id). */
  found: boolean
  /** The point or one of its aliases is ticked on the map. */
  marked: boolean
  /** Rewards linked to this point. When there are any, the reward is what you tick. */
  rewards: readonly Reward[]
}

/** Why a single point is found, for the card. Follows the same rule as foundPointIds. */
export function pointFoundState(
  point: Pick<MapPoint, 'id' | 'aliases'>,
  links: PointLinks,
  marks: { has(id: string): boolean },
  owned: { has(id: string): boolean },
): PointFoundState {
  const marked = markIds(point).some((id) => marks.has(id))
  const rewards = linkedRewards(point.id, links)
  return { found: marked || rewards.some((r) => owned.has(r.id)), marked, rewards }
}
