// URL state of the quests view and the cross-view links it builds. Pure functions only.
//
//   /quests/<encodeURIComponent(questId)>?q=<search>&status=open|active|done
//   /map?quest=<questId>   shows the quest start on the map
//   /map?pin=<questId>     next click on the map sets the manual start pin

import type { QuestState } from './progress'
import type { StatusFilter } from './quests-list'

export interface QuestListState {
  /** Search text as typed. */
  q: string
  status: StatusFilter
}

/** The values in the URL. Older Dutch addresses are rewritten first, see src/lib/legacy-url.ts. */
const STATUS_PARAM: Record<QuestState, string> = { open: 'open', active: 'active', done: 'done' }
const PARAM_STATUS: Record<string, QuestState> = { open: 'open', active: 'active', done: 'done' }

type QueryValue = string | null | undefined | (string | null)[]

function first(value: QueryValue): string | undefined {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' ? v : undefined
}

/** Reads the list filters from a route query. Unknown values fall back to the defaults. */
export function readListState(query: Record<string, QueryValue>): QuestListState {
  const status = PARAM_STATUS[(first(query.status) ?? '').toLowerCase()]
  return { q: first(query.q) ?? '', status: status ?? 'all' }
}

/**
 * The list filters for a link that comes from another view (a quest on a map card, a reward in
 * the collections). Such a link names a quest and says nothing about the list, so a filter it
 * does not mention stays as it was; one it does mention wins.
 */
export function readArrivalListState(query: Record<string, QueryValue>, kept: QuestListState): QuestListState {
  const named = readListState(query)
  return { q: 'q' in query ? named.q : kept.q, status: 'status' in query ? named.status : kept.status }
}

/** The query for the list filters, without defaults (so a clean list has a clean URL). */
export function listStateQuery(state: QuestListState): Record<string, string> {
  const out: Record<string, string> = {}
  if (state.q.trim()) out.q = state.q
  if (state.status !== 'all') out.status = STATUS_PARAM[state.status]
  return out
}

export function questPath(questId: string): string {
  return `/quests/${encodeURIComponent(questId)}`
}

export function mapQuestLink(questId: string): { path: string; query: Record<string, string> } {
  return { path: '/map', query: { quest: questId } }
}

export function mapPinLink(questId: string): { path: string; query: Record<string, string> } {
  return { path: '/map', query: { pin: questId } }
}

/** The :questId route param as one string (vue-router has already decoded it). */
export function paramValue(raw: string | string[] | undefined): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw
  return v ? v : undefined
}

const loose = (id: string) => id.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Finds the quest id a URL param points at. Exact first, then once more decoded (a link that
 * was encoded twice), then loosely: case-insensitive with underscores as spaces, like wiki URLs
 * ('black_knight's_fortress'). Undefined when nothing matches.
 */
export function resolveQuestId(raw: string | undefined, ids: Iterable<string>): string | undefined {
  if (!raw) return undefined
  const all = [...ids]
  const set = new Set(all)
  if (set.has(raw)) return raw
  let decoded = raw
  if (/%[0-9a-f]{2}/i.test(raw)) {
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      decoded = raw
    }
    if (set.has(decoded)) return decoded
  }
  const wanted = loose(decoded)
  return all.find((id) => loose(id) === wanted)
}
