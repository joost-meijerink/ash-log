// Links between map points and the rest of the logbook: quests and vaults.
// Pure, no DOM: this file is also type-checked by the Node config.

import { slug } from './ids'
import type { AppQuest, MapCategory, MapPoint, QuestKind, Vault } from './types'

/** Rounded game position, used to spot markers on the same spot. */
export function positionKey(x: number, y: number): string {
  return `${Math.round(x)}:${Math.round(y)}`
}

/* ------------------------------------------------------------------ */
/* Vaults                                                               */
/* ------------------------------------------------------------------ */

export interface VaultIndex {
  byPointId: Map<string, Vault>
  bySlug: Map<string, Vault>
  byPosition: Map<string, Vault>
}

/**
 * Index to find the vault behind a map point. The 'Vaults' category points are linked by
 * Vault.pointId; the per-vault pages ('Crasorak Kara') by name, or by sharing the spot.
 */
export function buildVaultIndex(vaults: readonly Vault[], pointById: ReadonlyMap<string, MapPoint>): VaultIndex {
  const index: VaultIndex = { byPointId: new Map(), bySlug: new Map(), byPosition: new Map() }
  for (const vault of vaults) {
    index.bySlug.set(slug(vault.name), vault)
    if (!vault.pointId) continue
    index.byPointId.set(vault.pointId, vault)
    const point = pointById.get(vault.pointId)
    if (point) index.byPosition.set(positionKey(point.x, point.y), vault)
  }
  return index
}

/** The vault a point belongs to. Only points in the 'vault' group are linked. */
export function vaultForPoint(point: MapPoint, category: MapCategory | undefined, index: VaultIndex): Vault | undefined {
  if (category?.group !== 'vault') return undefined
  return (
    index.byPointId.get(point.id) ??
    index.bySlug.get(slug(category.label)) ??
    (point.name ? index.bySlug.get(slug(point.name)) : undefined) ??
    index.byPosition.get(positionKey(point.x, point.y))
  )
}

/** Power level used by the filter: the point's own, else the power of its vault. */
export function effectivePower(point: MapPoint, category: MapCategory | undefined, index: VaultIndex): number | undefined {
  return point.power ?? vaultForPoint(point, category, index)?.power
}

/* ------------------------------------------------------------------ */
/* Quests                                                               */
/* ------------------------------------------------------------------ */

const KIND_RANK: Record<QuestKind, number> = { primary: 0, secondary: 1, tertiary: 2 }

/** Primary before secondary, then the order from the Quests page, then name. */
export function compareQuests(a: AppQuest, b: AppQuest): number {
  return (
    (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) ||
    (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
    a.name.localeCompare(b.name)
  )
}

export interface QuestLink {
  quest: AppQuest
  /** 'start': the point is where the quest starts. 'objective': the point is one of the quest's own map pins. */
  relation: 'start' | 'objective'
}

/**
 * Quests a point belongs to: quests that start there (current start or the wiki's start point),
 * and for quest-group categories the quest with the same name ('Dragon Slayer' pins).
 */
export function questLinksForPoint(point: MapPoint, category: MapCategory | undefined, quests: readonly AppQuest[]): QuestLink[] {
  const links: QuestLink[] = []
  const seen = new Set<string>()
  for (const quest of [...quests].sort(compareQuests)) {
    if (quest.start?.pointId === point.id || quest.startPointId === point.id) {
      links.push({ quest, relation: 'start' })
      seen.add(quest.id)
    }
  }
  if (category?.group === 'quest') {
    const keys = new Set([slug(category.label), category.wikiPage ? slug(category.wikiPage) : ''].filter(Boolean))
    for (const quest of quests) {
      if (seen.has(quest.id)) continue
      if (keys.has(slug(quest.name)) || keys.has(slug(quest.id))) {
        links.push({ quest, relation: 'objective' })
        seen.add(quest.id)
      }
    }
  }
  return links
}

export interface QuestStartGroup {
  /** positionKey of the start. */
  key: string
  x: number
  y: number
  /** Quests starting here, primary first. */
  quests: AppQuest[]
}

/** One pin per start spot: several quests can start at the same NPC. */
export function questStartGroups(quests: readonly AppQuest[]): QuestStartGroup[] {
  const groups = new Map<string, QuestStartGroup>()
  for (const quest of quests) {
    if (!quest.start) continue
    const key = positionKey(quest.start.x, quest.start.y)
    const group = groups.get(key)
    if (group) group.quests.push(quest)
    else groups.set(key, { key, x: quest.start.x, y: quest.start.y, quests: [quest] })
  }
  const out = [...groups.values()]
  for (const g of out) g.quests.sort(compareQuests)
  return out.sort((a, b) => compareQuests(a.quests[0]!, b.quests[0]!))
}

/** Regions of the primary quest line in play order ('Brynmoor/Ghornfell' counts as both). */
export function questRegionHints(quests: readonly AppQuest[]): string[] {
  return [...quests]
    .filter((q) => q.kind === 'primary')
    .sort(compareQuests)
    .flatMap((q) => (q.region ?? '').split('/'))
    .map((r) => r.trim())
    .filter(Boolean)
}
