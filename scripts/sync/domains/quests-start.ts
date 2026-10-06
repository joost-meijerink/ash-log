// Finds the map point where a quest starts.
//
// 1. quest-map: the quest page shows {{Map|<name>}} (a Module:Map page, often named after the quest).
//    Outside walkthrough sub-sections those maps are about the start, not about later objectives.
//    a. a map category named after a link in |start ([[Slopfinger]]) with one point
//    b. a point whose name appears in the start text ('Speak to [[Vannaka]]' and a point 'Vannaka');
//       failing that, the last word of a longer name ('the mirror' and 'Magic Mirror') when exactly
//       one quest-map point has it
//    c. a point marked as the start ('Doric (starting point)', 'Quest start. Found in The Nexus.')
//    d. a map category with exactly one point
// 2. npc-name: a link in |start whose map category has exactly one point ([[Manktongue]]).
// Several candidates are narrowed down by the quest's region (a sub-area like 'Temple Woods' counts
// as its top-level region, which is what points carry); still ambiguous means no pin
// (the user can set one, no warning needed).

import { mapCategoryId } from '../../../src/lib/ids'
import type { MapCategory, MapData, MapPoint, Quest } from '../../../src/lib/types'
import { findTemplates, links, normalizeTitle, sections } from '../wikitext'
import { regionOf } from './map-text'

export interface StartMatch {
  pointId: string
  match: NonNullable<Quest['startMatch']>
}

interface Entry {
  id: string
  category?: MapCategory
  points: MapPoint[]
}

/** Map categories by id and by the Module:Map page names they were built from. */
export class MapIndex {
  private readonly byId = new Map<string, Entry>()
  private readonly bySource = new Map<string, string>()

  constructor(map: MapData) {
    for (const category of map.categories) {
      this.byId.set(category.id, { id: category.id, category, points: [] })
      for (const source of category.sources) this.bySource.set(sourceKey(source), category.id)
    }
    for (const point of map.points) {
      let entry = this.byId.get(point.categoryId)
      if (!entry) this.byId.set(point.categoryId, (entry = { id: point.categoryId, points: [] }))
      entry.points.push(point)
    }
  }

  /** The category for a Module:Map page name ('Ratcatcher', 'Cow (Cook's Assistant)'). */
  find(name: string): Entry | undefined {
    return this.byId.get(mapCategoryId(name)) ?? this.byId.get(this.bySource.get(sourceKey(name)) ?? '')
  }
}

/** 'Module:Map/Cow_(Cook's_Assistant).json' and 'Cow (Cook's Assistant)' give the same key. */
function sourceKey(source: string): string {
  return normalizeTitle(source.replace(/^Module:Map\//i, '').replace(/\.json$/i, '')).toLowerCase()
}

/**
 * Module:Map names used by {{Map}} on the page, in order, leaving out maps inside walkthrough
 * sub-sections (level 3 and deeper), which show objectives rather than the start.
 */
export function questMapNames(content: string): string[] {
  const secs = sections(content)
  const names: string[] = []
  for (const t of findTemplates(content, 'Map', { nested: true })) {
    const level = secs.reduce((max, s) => (s.start <= t.start && t.start < s.end ? Math.max(max, s.level) : max), 0)
    if (level >= 3) continue
    for (const part of (t.positional[0] ?? '').split(',')) {
      const name = part.trim()
      if (name && !/^-?[\d.]+$/.test(name) && !names.includes(name)) names.push(name)
    }
  }
  return names
}

export interface StartInput {
  /** Wiki page content (for {{Map}} templates). */
  content: string
  /** Quest details |start as wikitext (for its links). */
  start: string
  /** Plain-text location. */
  location: string
  /** Region from the Quests page, e.g. 'Brynmoor/Ghornfell'. */
  region?: string
}

export function findStartPoint(input: StartInput, index: MapIndex): StartMatch | undefined {
  // Points carry top-level regions: 'Temple Woods' narrows down to Brynmoor.
  const regions = [
    ...new Set(
      (input.region ?? '')
        .split('/')
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => (regionOf(r)?.region ?? r).toLowerCase()),
    ),
  ]
  const pick = (points: MapPoint[]) => pickOne(points, regions)
  const startLinks = links(input.start).filter((l) => l.target)
  const linkIds = startLinks.flatMap((l) => linkCategoryIds(l.target, l.label))

  const entries: Entry[] = []
  for (const name of questMapNames(input.content)) {
    const entry = index.find(name)
    if (entry && entry.points.length && !entries.some((e) => e.id === entry.id)) entries.push(entry)
  }

  // 1a. A quest map named after someone in |start.
  for (const id of linkIds) {
    const entry = entries.find((e) => e.id === id)
    const point = entry && pick(entry.points)
    if (point) return { pointId: point.id, match: 'quest-map' }
  }

  // 1b. A quest-map point named in the start text; the earliest mention wins.
  const text = input.location.toLowerCase()
  const hits: { point: MapPoint; label: string; pos: number }[] = []
  for (const entry of entries) {
    for (const point of entry.points) {
      for (const label of pointLabels(point, entry)) {
        const pos = wordIndex(text, label)
        if (pos >= 0) hits.push({ point, label, pos })
      }
    }
  }
  if (hits.length) {
    hits.sort((a, b) => a.pos - b.pos || b.label.length - a.label.length)
    const first = hits[0]
    const point = pick(hits.filter((h) => h.pos === first.pos && h.label === first.label).map((h) => h.point))
    if (point) return { pointId: point.id, match: 'quest-map' }
  } else {
    // 'Speak to the mirror' and a point 'Magic Mirror': only when exactly one quest-map point matches this way.
    const byWord = entries.flatMap((e) => e.points).filter((p) => {
      const word = lastWord(p.name)
      return !!word && wordIndex(text, word) >= 0
    })
    const unique = [...new Map(byWord.map((p) => [p.id, p])).values()]
    if (unique.length === 1) return { pointId: unique[0].id, match: 'quest-map' }
  }

  // 1c. A point marked as the start.
  const marked = entries.flatMap((e) => e.points.filter((p) => /\bstart(?:ing)?\b/i.test(`${p.name ?? ''} ${p.description ?? ''}`)))
  const markedPoint = pick(marked)
  if (markedPoint) return { pointId: markedPoint.id, match: 'quest-map' }

  // 1d. A quest map with a single point.
  const single = entries.find((e) => e.points.length === 1)
  if (single) return { pointId: single.points[0].id, match: 'quest-map' }

  // 2. Someone in |start with their own map category.
  for (const id of linkIds) {
    const entry = index.find(id)
    const point = entry && pick(entry.points)
    if (point) return { pointId: point.id, match: 'npc-name' }
  }
  return undefined
}

/** Category ids a start link can point at: the target, without '(disambiguation)', and the label. */
function linkCategoryIds(target: string, label: string): string[] {
  const ids = [target, target.replace(/\s*\([^()]*\)\s*$/, ''), label].map((t) => mapCategoryId(t)).filter(Boolean)
  return [...new Set(ids)]
}

/** One point, or the only one in the quest's region. */
function pickOne(points: MapPoint[], regions: string[]): MapPoint | undefined {
  const unique = [...new Map(points.map((p) => [p.id, p])).values()]
  if (unique.length === 1) return unique[0]
  if (unique.length === 0 || !regions.length) return undefined
  const inRegion = unique.filter((p) => p.region && regions.includes(p.region.toLowerCase()))
  return inRegion.length === 1 ? inRegion[0] : undefined
}

/**
 * Lower-case names to look for in the start text: 'Doric (starting point)' gives 'doric (starting point)'
 * and 'doric'; 'Moon Sprite Shaman - Anamcara' also gives 'anamcara'. A nameless point of a
 * single-point category uses the category label.
 */
function pointLabels(point: MapPoint, entry: Entry): string[] {
  const name = point.name ?? (entry.points.length === 1 ? entry.category?.label : undefined)
  if (!name) return []
  const full = name.toLowerCase().trim()
  const base = full.replace(/\s*\([^()]*\)\s*$/, '')
  const labels = [full, base, ...base.split(/\s+-\s+/)]
  return [...new Set(labels.map((l) => l.trim()).filter((l) => l.length >= 3))]
}

/** Shorter last words ('man' of 'Wise Old Man') are too common to point at one spot. */
const LAST_WORD_MIN = 5

/** Lower-case last word of a name of two or more words ('Magic Mirror' gives 'mirror'). */
function lastWord(name: string | undefined): string | undefined {
  const words = (name ?? '').toLowerCase().replace(/\s*\([^()]*\)\s*$/, '').trim().split(/\s+/)
  const last = words[words.length - 1]
  return words.length >= 2 && last.length >= LAST_WORD_MIN ? last : undefined
}

/** Index of `needle` in `text` as a whole word (or phrase), or -1. */
function wordIndex(text: string, needle: string): number {
  let from = 0
  for (;;) {
    const i = text.indexOf(needle, from)
    if (i < 0) return -1
    const before = text[i - 1]
    const after = text[i + needle.length]
    if ((!before || !/[a-z0-9]/.test(before)) && (!after || !/[a-z0-9]/.test(after))) return i
    from = i + 1
  }
}
