// Map state in the URL, so every filter combination can be bookmarked.
//
//   c   category ids, comma separated (c= with nothing means: all categories off)
//   p   power levels, comma separated
//   ps  1 = strict power: with p set, points without a power level are hidden too
//   r   top-level regions, comma separated
//   q   search text
//   h   1 = hide found lore and unique points
//   qs  1 = show quest starts
//   focus  point id: fly there, turn its category on, open its card
//   quest  quest id: show its start and open the quest card
//   pin    quest id: pin mode, the next click sets the quest start
//
// Without any filter param (c, p, ps, r, q, h, qs) the map shows the defaults: vaults and quest
// starts. focus, quest and pin are not filters, so /kaart?quest=X also gets the defaults.
// (useMapState fills in the last filters of this session first, see src/stores/mapMemory.ts.)
// A state equal to the defaults is written without filter params, so a plain /kaart stays clean.
// Pure, no DOM: this file is also type-checked by the Node config.

export interface MapFilters {
  /** Enabled category ids, sorted, unique. */
  categories: string[]
  /** Selected power levels, ascending, unique. */
  powers: number[]
  /** Hide points without a power level too. Only means something while `powers` is not empty. */
  strictPower: boolean
  /** Selected regions, sorted, unique. */
  regions: string[]
  search: string
  hideFound: boolean
  questStarts: boolean
}

export interface MapUrlState extends MapFilters {
  focus?: string
  quest?: string
  pin?: string
}

/** What the current data knows about; anything else in the URL is ignored. */
export interface MapUrlKnown {
  category(id: string): boolean
  power(level: number): boolean
  region(name: string): boolean
  point(id: string): boolean
  /** The kept point for an alias id (a twin the sync merged away), if any. */
  pointAlias?(id: string): string | undefined
  quest(id: string): boolean
}

/** vue-router's LocationQuery, without depending on vue-router here. */
export type RawQuery = Record<string, string | null | undefined | (string | null)[]>

export const FILTER_PARAMS = ['c', 'p', 'ps', 'r', 'q', 'h', 'qs'] as const

export function emptyFilters(): MapFilters {
  return { categories: [], powers: [], strictPower: false, regions: [], search: '', hideFound: false, questStarts: false }
}

export function defaultFilters(defaultCategories: readonly string[]): MapFilters {
  return { ...emptyFilters(), categories: canonicalStrings(defaultCategories), questStarts: true }
}

export function cloneFilters(f: MapFilters): MapFilters {
  return { ...f, categories: [...f.categories], powers: [...f.powers], regions: [...f.regions] }
}

export function canonicalStrings(list: Iterable<string>): string[] {
  return [...new Set(list)].sort()
}

export function canonicalNumbers(list: Iterable<number>): number[] {
  return [...new Set(list)].sort((a, b) => a - b)
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Strict power in effect: switched on and at least one level picked. */
export function isStrictPower(f: Pick<MapFilters, 'powers' | 'strictPower'>): boolean {
  return f.strictPower && f.powers.length > 0
}

/** Compares two canonical filter states (search compared trimmed). */
export function sameFilters(a: MapFilters, b: MapFilters): boolean {
  return (
    sameList(a.categories, b.categories) &&
    sameList(a.powers, b.powers) &&
    isStrictPower(a) === isStrictPower(b) &&
    sameList(a.regions, b.regions) &&
    a.search.trim() === b.search.trim() &&
    a.hideFound === b.hideFound &&
    a.questStarts === b.questStarts
  )
}

/** True when any filter narrows or widens the map beyond 'nothing on'. */
export function hasActiveFilters(f: MapFilters): boolean {
  return !sameFilters(f, emptyFilters())
}

/** First string value of a query param; null (a bare `?c`) counts as ''. */
export function firstParam(value: RawQuery[string]): string | undefined {
  if (value === undefined) return undefined
  const v = Array.isArray(value) ? value[0] : value
  return v ?? ''
}

function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseLevels(value: string | undefined): number[] {
  return splitList(value)
    .filter((s) => /^\d{1,3}$/.test(s))
    .map(Number)
}

export function hasFilterParams(query: RawQuery): boolean {
  return FILTER_PARAMS.some((k) => query[k] !== undefined)
}

function parseFilters(query: RawQuery, known: MapUrlKnown): MapFilters {
  const powers = canonicalNumbers(parseLevels(firstParam(query.p)).filter((n) => known.power(n)))
  return {
    categories: canonicalStrings(splitList(firstParam(query.c)).filter((id) => known.category(id))),
    powers,
    strictPower: firstParam(query.ps) === '1' && powers.length > 0,
    regions: canonicalStrings(splitList(firstParam(query.r)).filter((r) => known.region(r))),
    search: (firstParam(query.q) ?? '').trim(),
    hideFound: firstParam(query.h) === '1',
    questStarts: firstParam(query.qs) === '1',
  }
}

export function parseMapQuery(query: RawQuery, known: MapUrlKnown, defaults: MapFilters): MapUrlState {
  const filters: MapFilters = hasFilterParams(query) ? parseFilters(query, known) : cloneFilters(defaults)

  const state: MapUrlState = filters
  const focus = firstParam(query.focus)
  // An old link to a merged twin opens the point it was merged into.
  const focusId = focus ? (known.point(focus) ? focus : known.pointAlias?.(focus)) : undefined
  if (focusId) state.focus = focusId
  const quest = firstParam(query.quest)
  if (quest && known.quest(quest)) state.quest = quest
  const pin = firstParam(query.pin)
  if (pin && known.quest(pin)) state.pin = pin
  return state
}

/** Only the filter part of the query (for links that keep the current filters). */
export function serializeFilters(filters: MapFilters, defaults: MapFilters): Record<string, string> {
  if (sameFilters(filters, defaults)) return {}
  const q: Record<string, string> = { c: filters.categories.join(',') }
  if (filters.powers.length) q.p = filters.powers.join(',')
  if (isStrictPower(filters)) q.ps = '1'
  if (filters.regions.length) q.r = filters.regions.join(',')
  const search = filters.search.trim()
  if (search) q.q = search
  if (filters.hideFound) q.h = '1'
  if (filters.questStarts) q.qs = '1'
  return q
}

export function serializeMapQuery(state: MapUrlState, defaults: MapFilters): Record<string, string> {
  const q = serializeFilters(state, defaults)
  if (state.focus) q.focus = state.focus
  if (state.quest) q.quest = state.quest
  if (state.pin) q.pin = state.pin
  return q
}

/** Order-independent key of a query, to tell our own URL writes apart from navigation. */
export function queryKey(query: RawQuery): string {
  return Object.keys(query)
    .filter((k) => query[k] !== undefined)
    .sort()
    .map((k) => `${k}=${firstParam(query[k])}`)
    .join('&')
}
