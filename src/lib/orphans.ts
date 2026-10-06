// Progress that no longer points at anything in the wiki data ("orphaned").
// Used by the sync diff report and live in the app. Pure.

import type { MapData, Orphans, Overrides, Progress, Quest, Reward, Vault } from './types'

export interface OrphanInput {
  map: MapData | null
  quests: Quest[] | null
  vaults: Vault[] | null
  rewards: Reward[] | null
  overrides?: Overrides
}

export function emptyOrphans(): Orphans {
  return { quests: [], steps: [], items: [], points: [], vaults: [], rewards: [] }
}

/** A domain whose data is null (never synced) reports no orphans. */
export function findOrphans(data: OrphanInput, progress: Progress): Orphans {
  const out = emptyOrphans()

  if (data.quests) {
    const questById = new Map(data.quests.map((q) => [q.id, q]))
    for (const [questId, qp] of Object.entries(progress.quests)) {
      const quest = questById.get(questId)
      if (!quest) {
        // An entry left empty by unchecking never held a checkmark, so nothing is lost.
        if (qp.done || qp.steps.length > 0 || qp.items.length > 0) out.quests.push(questId)
        continue
      }
      const stepIds = new Set(quest.steps.map((s) => s.id))
      const itemIds = new Set(quest.items.map((i) => i.id))
      for (const i of data.overrides?.questItems[questId] ?? []) itemIds.add(i.id)
      out.steps.push(...qp.steps.filter((id) => !stepIds.has(id)))
      out.items.push(...qp.items.filter((id) => !itemIds.has(id)))
    }
  }
  if (data.map) {
    // A twin merged into a kept point by the sync lives on as an alias: its progress counts for that point.
    const pointIds = new Set(data.map.points.flatMap((p) => [p.id, ...(p.aliases ?? [])]))
    out.points.push(...Object.keys(progress.points).filter((id) => !pointIds.has(id)))
  }
  if (data.vaults) {
    const vaultIds = new Set(data.vaults.map((v) => v.id))
    out.vaults.push(
      ...Object.entries(progress.vaults)
        .filter(([id, vp]) => !vaultIds.has(id) && !!vp.done)
        .map(([id]) => id),
    )
  }
  if (data.rewards) {
    const rewardIds = new Set(data.rewards.map((r) => r.id))
    out.rewards.push(...Object.keys(progress.rewards).filter((id) => !rewardIds.has(id)))
  }
  return out
}

export function orphanCount(o: Orphans): number {
  return o.quests.length + o.steps.length + o.items.length + o.points.length + o.vaults.length + o.rewards.length
}

/** Returns a copy of progress without the orphaned entries. */
export function withoutOrphans(progress: Progress, o: Orphans): Progress {
  const next: Progress = structuredClone(progress)
  for (const id of o.quests) delete next.quests[id]
  const steps = new Set(o.steps)
  const items = new Set(o.items)
  for (const qp of Object.values(next.quests)) {
    qp.steps = qp.steps.filter((id) => !steps.has(id))
    qp.items = qp.items.filter((id) => !items.has(id))
  }
  for (const id of o.points) delete next.points[id]
  for (const id of o.vaults) delete next.vaults[id]
  for (const id of o.rewards) delete next.rewards[id]
  return next
}
