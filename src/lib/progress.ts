// Pure progress rules shared by views and stores.

import type { Progress, Quest, QuestProgress, VaultProgress } from './types'

export type QuestState = 'open' | 'active' | 'done'

/** Dutch labels for QuestState. */
export const QUEST_STATE_LABEL: Record<QuestState, string> = {
  open: 'Open',
  active: 'Bezig',
  done: 'Voltooid',
}

/** Number of distinct checked steps that still exist in the quest (a hand-edited file may list one twice). */
function checkedSteps(quest: Quest, qp: QuestProgress): number {
  const stepIds = new Set(quest.steps.map((s) => s.id))
  return new Set(qp.steps.filter((id) => stepIds.has(id))).size
}

/** A quest is done when marked by hand, or when every step is checked. */
export function questState(quest: Quest, qp: QuestProgress | undefined): QuestState {
  if (!qp) return 'open'
  if (qp.done) return 'done'
  const checked = checkedSteps(quest, qp)
  if (quest.steps.length > 0 && checked === quest.steps.length) return 'done'
  const itemIds = new Set(quest.items.map((i) => i.id))
  if (checked > 0 || qp.items.some((id) => itemIds.has(id))) return 'active'
  return 'open'
}

/** Fraction of steps checked, 0..1 (1 when done by hand). */
export function questFraction(quest: Quest, qp: QuestProgress | undefined): number {
  if (!qp) return 0
  if (qp.done || quest.steps.length === 0) return qp.done ? 1 : 0
  return checkedSteps(quest, qp) / quest.steps.length
}

/** True when a quest entry holds nothing: no steps, no items, not marked done. */
export function isEmptyQuestProgress(qp: QuestProgress): boolean {
  return !qp.done && qp.steps.length === 0 && qp.items.length === 0
}

/** True when a vault entry holds nothing: not marked done. */
export function isEmptyVaultProgress(vp: VaultProgress): boolean {
  return !vp.done
}

/* ------------------------------------------------------------------ */
/* Three-way merge                                                      */
/* ------------------------------------------------------------------ */

const has = (record: object, id: string) => Object.prototype.hasOwnProperty.call(record, id)

/** The server list, plus what local added since base, minus what local removed since base. */
export function mergeIds<T extends string | number>(base: readonly T[], local: readonly T[], server: readonly T[]): T[] {
  const inBase = new Set(base)
  const inLocal = new Set(local)
  const removed = new Set(base.filter((id) => !inLocal.has(id)))
  const out = [...new Set(server)].filter((id) => !removed.has(id))
  const seen = new Set(out)
  for (const id of local) {
    if (inBase.has(id) || seen.has(id)) continue
    out.push(id)
    seen.add(id)
  }
  return out
}

/** Local wins when it changed the flag since base, otherwise the server does. */
function mergeFlag(base: boolean, local: boolean, server: boolean): boolean {
  return local !== base ? local : server
}

/** Per key: local wins when it added or removed the key since base, otherwise the server does. */
function mergeEntries<V>(base: Record<string, V>, local: Record<string, V>, server: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {}
  for (const id of new Set([...Object.keys(server), ...Object.keys(local)])) {
    const localChanged = has(local, id) !== has(base, id)
    if (localChanged ? has(local, id) : has(server, id)) out[id] = { ...(has(server, id) ? server[id] : local[id]) } as V
  }
  return out
}

/**
 * Three-way merge of progress, used when another tab (or a hand edit) changed progress.json
 * since this tab last read it. `base` is the last copy this tab got from the server, `local`
 * is this tab's state and `server` is what is on disk now. Every id list (quest steps, items,
 * points, rewards) and flag (quest done, vault done) keeps the local additions
 * and removals and takes everything else from the server. Entries that end up empty are dropped.
 */
export function mergeProgress(base: Progress, local: Progress, server: Progress): Progress {
  const out: Progress = {
    version: 1,
    quests: {},
    points: mergeEntries(base.points, local.points, server.points),
    vaults: {},
    rewards: mergeEntries(base.rewards, local.rewards, server.rewards),
  }

  for (const id of new Set([...Object.keys(server.quests), ...Object.keys(local.quests), ...Object.keys(base.quests)])) {
    const b = base.quests[id]
    const l = local.quests[id]
    const s = server.quests[id]
    const qp: QuestProgress = {
      ...(mergeFlag(!!b?.done, !!l?.done, !!s?.done) ? { done: true } : {}),
      steps: mergeIds(b?.steps ?? [], l?.steps ?? [], s?.steps ?? []),
      items: mergeIds(b?.items ?? [], l?.items ?? [], s?.items ?? []),
    }
    if (!isEmptyQuestProgress(qp)) out.quests[id] = qp
  }

  for (const id of new Set([...Object.keys(server.vaults), ...Object.keys(local.vaults), ...Object.keys(base.vaults)])) {
    const b = base.vaults[id]
    const l = local.vaults[id]
    const s = server.vaults[id]
    const vp: VaultProgress = mergeFlag(!!b?.done, !!l?.done, !!s?.done) ? { done: true } : {}
    if (!isEmptyVaultProgress(vp)) out.vaults[id] = vp
  }

  return out
}
