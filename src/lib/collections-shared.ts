// Small shared pieces for the collections view: tallies, region order, search normalisation.
// Pure functions only, no Vue.

/** Done out of total, e.g. 3 of 8 recipes. */
export interface Tally {
  done: number
  total: number
}

export const emptyTally = (): Tally => ({ done: 0, total: 0 })

/** 0..1, and 0 for an empty tally. */
export function tallyFraction(t: Tally): number {
  return t.total > 0 ? t.done / t.total : 0
}

/** '3 / 8' */
export function tallyText(t: Tally): string {
  return `${t.done} / ${t.total}`
}

/**
 * Top-level regions in the order you play them (same list as the sync's map-text.ts).
 * Anything else sorts after these, alphabetically.
 */
export const REGION_ORDER = ['Brynmoor', 'Ghornfell', 'Fellhollow', 'Dowdun Reach', 'Umbral Sands', 'Scorned Wilderness'] as const

const REGION_RANK = new Map<string, number>(REGION_ORDER.map((r, i) => [r.toLowerCase(), i]))

export function isRegion(name: string | undefined | null): boolean {
  return !!name && REGION_RANK.has(name.toLowerCase())
}

/**
 * The top-level region a region field names, in REGION_ORDER spelling. A field that names
 * several ('Brynmoor/Ghornfell', 'Fellhollow and Dowdun Reach') gives the first top-level
 * one; an area that is not a top-level region ('Temple Woods') gives undefined.
 */
export function knownRegion(text: string | undefined | null): string | undefined {
  if (!text) return undefined
  for (const part of text.split(/\s*(?:[/,&]|\band\b)\s*/i)) {
    const rank = REGION_RANK.get(part.trim().toLowerCase())
    if (rank !== undefined) return REGION_ORDER[rank]
  }
  return undefined
}

const REGION_IN_TEXT = REGION_ORDER.map((name) => ({
  name,
  re: new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu'),
}))

/** The top-level region a free text mentions first, as a whole word in any case ('Rod fishing spots in Ghornfell.'). */
export function regionInText(text: string | undefined | null): string | undefined {
  if (!text) return undefined
  let best: { name: string; at: number } | undefined
  for (const { name, re } of REGION_IN_TEXT) {
    const at = text.search(re)
    if (at >= 0 && (!best || at < best.at)) best = { name, at }
  }
  return best?.name
}

/** Known regions in play order, then other names alphabetically, then missing names last. */
export function compareRegions(a: string | undefined | null, b: string | undefined | null): number {
  if (a === b) return 0
  if (!a) return 1
  if (!b) return -1
  const ra = REGION_RANK.get(a.toLowerCase())
  const rb = REGION_RANK.get(b.toLowerCase())
  if (ra !== undefined && rb !== undefined) return ra - rb
  if (ra !== undefined) return -1
  if (rb !== undefined) return 1
  return compareNames(a, b)
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** Natural, case-insensitive order: 'Flag 2' before 'Flag 10'. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b)
}

/** Lowercase, no diacritics, straight quotes, single spaces. For search only. */
export function searchKey(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every word of the query must occur somewhere in the haystack (already a searchKey). */
export function matchesQuery(haystack: string, query: string): boolean {
  const words = searchKey(query).split(' ').filter(Boolean)
  return words.every((w) => haystack.includes(w))
}
