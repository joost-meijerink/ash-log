// Quest list logic for the quests view: status per quest, search and status filters,
// sections (main story, side quests by region, tertiary) and the default selection.
// Pure functions only, no Vue or store imports.

import { QUEST_STATE_LABEL, questFraction, questState, type QuestState } from './progress'
import type { Quest, QuestKind, QuestProgress } from './types'

/** A quest with its derived progress, as the list and the detail show it. */
export interface QuestEntry<Q extends Quest = Quest> {
  quest: Q
  state: QuestState
  /** 0..1, 1 when marked done by hand. */
  fraction: number
  /** Checked steps that still exist on the wiki. */
  stepsDone: number
  stepsTotal: number
}

export type StatusFilter = 'all' | QuestState

export const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: QUEST_STATE_LABEL.open },
  { value: 'active', label: QUEST_STATE_LABEL.active },
  { value: 'done', label: QUEST_STATE_LABEL.done },
]

export const KIND_TITLE: Record<QuestKind, string> = {
  primary: 'Main story',
  secondary: 'Side quests',
  tertiary: 'Tertiary',
}

/** Label for side quests without a region on the wiki. */
export const NO_REGION_LABEL = 'Other'

const KIND_RANK: Record<QuestKind, number> = { primary: 0, secondary: 1, tertiary: 2 }

export function questEntry<Q extends Quest>(quest: Q, qp: QuestProgress | undefined): QuestEntry<Q> {
  const stepIds = new Set(quest.steps.map((s) => s.id))
  const stepsDone = qp ? new Set(qp.steps.filter((id) => stepIds.has(id))).size : 0
  return {
    quest,
    state: questState(quest, qp),
    fraction: questFraction(quest, qp),
    stepsDone,
    stepsTotal: quest.steps.length,
  }
}

/** Kind first, then the wiki order (quests without one last), then name. */
export function compareQuests(a: Quest, b: Quest): number {
  const kind = KIND_RANK[a.kind] - KIND_RANK[b.kind]
  if (kind !== 0) return kind
  const ao = a.order ?? Number.POSITIVE_INFINITY
  const bo = b.order ?? Number.POSITIVE_INFINITY
  if (ao !== bo) return ao < bo ? -1 : 1
  return a.name.localeCompare(b.name, 'en')
}

export interface QuestGroup<Q extends Quest = Quest> {
  key: string
  /** Region heading for side quests. Undefined for the main story and tertiary quests. */
  label?: string
  entries: QuestEntry<Q>[]
}

export interface QuestSection<Q extends Quest = Quest> {
  kind: QuestKind
  title: string
  groups: QuestGroup<Q>[]
}

/**
 * Splits entries into sections: main story by order, side quests grouped by region
 * (regions in order of first appearance, quests without a region last), tertiary by order.
 * Kinds without entries are left out, so 'Tertiary' only shows up when there is one.
 */
export function buildSections<Q extends Quest>(entries: QuestEntry<Q>[]): QuestSection<Q>[] {
  const sorted = [...entries].sort((a, b) => compareQuests(a.quest, b.quest))
  const sections: QuestSection<Q>[] = []
  for (const kind of ['primary', 'secondary', 'tertiary'] as const) {
    const ofKind = sorted.filter((e) => e.quest.kind === kind)
    if (!ofKind.length) continue
    if (kind !== 'secondary') {
      sections.push({ kind, title: KIND_TITLE[kind], groups: [{ key: kind, entries: ofKind }] })
      continue
    }
    const byRegion = new Map<string, QuestGroup<Q>>()
    let noRegion: QuestGroup<Q> | undefined
    for (const entry of ofKind) {
      const region = entry.quest.region?.trim()
      if (!region) {
        noRegion ??= { key: `${kind}:`, label: NO_REGION_LABEL, entries: [] }
        noRegion.entries.push(entry)
        continue
      }
      let group = byRegion.get(region)
      if (!group) {
        group = { key: `${kind}:${region}`, label: region, entries: [] }
        byRegion.set(region, group)
      }
      group.entries.push(entry)
    }
    const groups = [...byRegion.values()]
    if (noRegion) groups.push(noRegion)
    sections.push({ kind, title: KIND_TITLE[kind], groups })
  }
  return sections
}

/** Entries in the order the list shows them. */
export function orderEntries<Q extends Quest>(entries: QuestEntry<Q>[]): QuestEntry<Q>[] {
  return buildSections(entries).flatMap((s) => s.groups.flatMap((g) => g.entries))
}

/** Lowercase, no diacritics, single spaces. */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every word of the query must occur in the name, region or start location. */
export function matchesSearch(quest: Quest, query: string): boolean {
  const terms = normalizeSearch(query).split(' ').filter(Boolean)
  if (!terms.length) return true
  const haystack = normalizeSearch([quest.name, quest.region ?? '', quest.location].join(' '))
  return terms.every((t) => haystack.includes(t))
}

export function searchEntries<Q extends Quest>(entries: QuestEntry<Q>[], query: string): QuestEntry<Q>[] {
  return entries.filter((e) => matchesSearch(e.quest, query))
}

export function filterEntries<Q extends Quest>(
  entries: QuestEntry<Q>[],
  filter: { q: string; status: StatusFilter },
): QuestEntry<Q>[] {
  return searchEntries(entries, filter.q).filter((e) => filter.status === 'all' || e.state === filter.status)
}

/** Counts per status chip. Pass the search results so the chips match what a click would show. */
export function countByStatus(entries: QuestEntry[]): Record<StatusFilter, number> {
  const out: Record<StatusFilter, number> = { all: entries.length, open: 0, active: 0, done: 0 }
  for (const e of entries) out[e.state]++
  return out
}

export function countDone(entries: QuestEntry[]): { done: number; total: number } {
  return { done: entries.filter((e) => e.state === 'done').length, total: entries.length }
}

/**
 * The quest to open when the URL has none: the first quest in progress, else the first open
 * main story quest, else the first quest in the list.
 */
export function pickDefaultQuestId(entries: QuestEntry[]): string | undefined {
  const ordered = orderEntries(entries)
  const active = ordered.find((e) => e.state === 'active')
  if (active) return active.quest.id
  const openPrimary = ordered.find((e) => e.quest.kind === 'primary' && e.state === 'open')
  if (openPrimary) return openPrimary.quest.id
  return ordered[0]?.quest.id
}
