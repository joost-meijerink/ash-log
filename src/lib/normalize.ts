// Fills in missing fields so older or hand-edited files never crash the app.
// Pure: used by the middleware, the sync (orphan check) and the app.

import type { Overrides, Progress } from './types.ts'

export function emptyProgress(): Progress {
  return { version: 1, quests: {}, points: {}, vaults: {}, rewards: {} }
}

export function emptyOverrides(): Overrides {
  return { questStart: {}, questItems: {}, categoryGroup: {} }
}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function normalizeProgress(input: unknown): Progress {
  const out = emptyProgress()
  if (!isRecord(input)) return out
  if (isRecord(input.quests)) {
    for (const [id, q] of Object.entries(input.quests)) {
      if (!isRecord(q)) continue
      out.quests[id] = {
        ...(q.done ? { done: true } : {}),
        // Deduped: a hand-merged file with a step twice would count it twice and need two clicks to uncheck.
        steps: Array.isArray(q.steps) ? [...new Set<string>(q.steps.filter((s: unknown) => typeof s === 'string'))] : [],
        items: Array.isArray(q.items) ? [...new Set<string>(q.items.filter((s: unknown) => typeof s === 'string'))] : [],
      }
    }
  }
  if (isRecord(input.points)) {
    for (const [id, p] of Object.entries(input.points)) {
      if (isRecord(p) && typeof p.foundAt === 'string') out.points[id] = { foundAt: p.foundAt }
    }
  }
  if (isRecord(input.vaults)) {
    for (const [id, v] of Object.entries(input.vaults)) {
      if (!isRecord(v)) continue
      // Older files may still carry 'cores'; vault cores respawn, so they are no longer kept.
      if (v.done) out.vaults[id] = { done: true }
    }
  }
  if (isRecord(input.rewards)) {
    for (const [id, r] of Object.entries(input.rewards)) {
      if (isRecord(r) && typeof r.at === 'string') out.rewards[id] = { at: r.at }
    }
  }
  return out
}

export function normalizeOverrides(input: unknown): Overrides {
  const out = emptyOverrides()
  if (!isRecord(input)) return out
  if (isRecord(input.questStart)) {
    for (const [id, p] of Object.entries(input.questStart)) {
      if (isRecord(p) && Number.isFinite(p.x) && Number.isFinite(p.y)) out.questStart[id] = { x: p.x, y: p.y }
    }
  }
  if (isRecord(input.questItems)) {
    for (const [id, items] of Object.entries(input.questItems)) {
      if (!Array.isArray(items)) continue
      out.questItems[id] = items
        .filter((i: unknown) => isRecord(i) && typeof i.id === 'string' && typeof i.name === 'string')
        .map((i: any) => ({
          id: i.id,
          name: i.name,
          ...(Number.isFinite(i.qty) ? { qty: i.qty } : {}),
          ...(typeof i.note === 'string' && i.note ? { note: i.note } : {}),
        }))
    }
  }
  if (isRecord(input.categoryGroup)) {
    for (const [id, g] of Object.entries(input.categoryGroup)) {
      if (typeof g === 'string') out.categoryGroup[id] = g as Overrides['categoryGroup'][string]
    }
  }
  return out
}
