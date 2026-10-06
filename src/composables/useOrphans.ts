// Live orphaned progress: checkmarks that no longer point at anything in the current wiki data.
// Unlike DiffReport.orphans (a snapshot taken at sync time), this follows the stores.

import { computed, toRaw, type ComputedRef } from 'vue'
import { emptyOrphans, findOrphans, orphanCount, withoutOrphans } from '@/lib/orphans'
import type { Orphans } from '@/lib/types'
import { useConnectionStore } from '@/stores/connection'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'

export type OrphanKind = keyof Orphans

/** Dutch labels per orphan kind, in display order. */
export const ORPHAN_KIND_LABEL: Record<OrphanKind, string> = {
  quests: 'Quests',
  steps: 'Queststappen',
  items: 'Questitems',
  points: 'Kaartpunten',
  vaults: 'Vaults',
  rewards: 'Beloningen',
}

/** Looks up English wiki names for orphan ids. Anything it cannot resolve falls back to the id. */
export interface OrphanNames {
  questName?: (questId: string) => string | undefined
  categoryLabel?: (categoryId: string) => string | undefined
  /** Text of a step that the wiki changed or removed, e.g. from the last sync report. */
  stepText?: (stepId: string) => string | undefined
}

/** Quest id of a step id ('<quest>:s:<hash>') or item id ('<quest>:i:<slug>'). */
export function questIdOf(id: string, kind: 'steps' | 'items'): string {
  const at = id.lastIndexOf(kind === 'steps' ? ':s:' : ':i:')
  return at > 0 ? id.slice(0, at) : id
}

/** Category id of a point id ('<category>:<x>:<y>'). */
export function categoryIdOf(pointId: string): string {
  return pointId.split(':')[0] ?? pointId
}

const humanize = (slugText: string) => slugText.replace(/-/g, ' ')

/** Readable English label for one orphan id: quest, step or item with its quest, point with its category. */
export function orphanLabel(kind: OrphanKind, id: string, names: OrphanNames = {}): string {
  switch (kind) {
    case 'steps':
    case 'items': {
      const questId = questIdOf(id, kind)
      const quest = names.questName?.(questId) ?? questId
      const rest = id.slice(questId.length + 3)
      if (kind === 'items') return `${quest}: ${humanize(rest)}`
      const text = names.stepText?.(id)
      return text ? `${quest}: ${text}` : `${quest} (${rest})`
    }
    case 'points': {
      const categoryId = categoryIdOf(id)
      const [, x, y] = id.split(':')
      const category = names.categoryLabel?.(categoryId) ?? categoryId
      return x !== undefined && y !== undefined ? `${category} (${x}, ${y})` : category
    }
    case 'rewards': {
      const at = id.indexOf(':')
      return at > 0 ? `${humanize(id.slice(at + 1))} (${id.slice(0, at)})` : id
    }
    default:
      return id
  }
}

export interface OrphanGroup {
  kind: OrphanKind
  /** Dutch label of the kind. */
  label: string
  count: number
  /** English wiki names it concerns (quests for steps and items, categories for points), deduped. */
  names: string[]
}

/** Orphans per kind with readable names, in display order. Kinds without orphans are left out. */
export function summarizeOrphans(orphans: Orphans, names: OrphanNames = {}): OrphanGroup[] {
  const nameOf = (kind: OrphanKind, id: string): string | undefined => {
    switch (kind) {
      case 'quests':
      case 'vaults':
        return id
      case 'steps':
      case 'items': {
        const questId = questIdOf(id, kind)
        return names.questName?.(questId) ?? questId
      }
      case 'points': {
        const categoryId = categoryIdOf(id)
        return names.categoryLabel?.(categoryId) ?? categoryId
      }
      default:
        return undefined
    }
  }
  return (Object.keys(ORPHAN_KIND_LABEL) as OrphanKind[])
    .filter((kind) => orphans[kind].length > 0)
    .map((kind) => ({
      kind,
      label: ORPHAN_KIND_LABEL[kind],
      count: orphans[kind].length,
      names: [...new Set(orphans[kind].map((id) => nameOf(kind, id)).filter((n): n is string => !!n))],
    }))
}

export function useOrphans(): {
  /** Orphaned ids per kind. Empty until both data and progress are loaded. */
  orphans: ComputedRef<Orphans>
  /** Total number of orphaned entries. */
  count: ComputedRef<number>
  /** Orphans per kind with readable names, for a confirm dialog. */
  summary: ComputedRef<OrphanGroup[]>
  /** Readable English label for one orphan id. */
  label: (kind: OrphanKind, id: string) => string
  /** Removes exactly the current orphans from progress (saved by the progress store). Returns how many. */
  cleanUp: () => number
} {
  const data = useDataStore()
  const progress = useProgressStore()
  const connection = useConnectionStore()

  const removedSteps = computed(() => {
    const out = new Map<string, string>()
    for (const q of data.lastReport?.quests?.steps ?? []) for (const s of q.removed) out.set(s.id, s.text)
    return out
  })
  const names: OrphanNames = {
    questName: (id) => data.questById.get(id)?.name,
    categoryLabel: (id) => data.categoryById.get(id)?.label,
    stepText: (id) => removedSteps.value.get(id),
  }

  const orphans = computed<Orphans>(() => {
    const d = data.data
    if (!d?.ready || !progress.loaded) return emptyOrphans()
    // An empty list means the domain was never synced (the middleware serves [] for a missing file),
    // not that the wiki removed everything. Treat it as unknown so nothing gets flagged.
    return findOrphans(
      {
        map: d.map.points.length ? d.map : null,
        quests: d.quests.length ? d.quests : null,
        vaults: d.vaults.length ? d.vaults : null,
        rewards: d.rewards.length ? d.rewards : null,
        overrides: d.overrides,
      },
      progress.state,
    )
  })

  const count = computed(() => orphanCount(orphans.value))
  const summary = computed(() => summarizeOrphans(orphans.value, names))
  const label = (kind: OrphanKind, id: string) => orphanLabel(kind, id, names)

  function cleanUp(): number {
    const n = count.value
    // Not progress.removeOrphans(): it hands the reactive proxy to structuredClone, which throws
    // DataCloneError. Cloning the raw state gives the same result.
    // Offline on a phone: nothing changes until the Mac can be reached again.
    if (connection.readOnly) return 0
    if (n > 0) progress.state = withoutOrphans(toRaw(progress.state), orphans.value)
    return n
  }

  return { orphans, count, summary, label, cleanUp }
}
