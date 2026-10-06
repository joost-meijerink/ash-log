// Map domain: Module:Map/*.json pages -> map categories and points.
// Contract used by scripts/sync/index.ts. See docs/spikes.md for the data formats.
//
// Steps in parseMap:
//  1. Skip sandbox and test pages (one warning each), parse the JSON (array, single point or Map object).
//  2. Family per page: '<Base> (<Region>)' pages merge into one category with a region per point.
//  3. Points: name, link, description, power and region from the free-text fields.
//  4. Merge the pages of a category: identical ids dedupe, points of different pages that lie
//     within MERGE_DISTANCE of each other are the same thing (chests.json vs Treasure Chest (<region>)).
//  5. Group per category (map-groups.ts), region guess for the rest.
//  6. Twins: one-time spots (lore, unique, vault) listed in two categories of a group become one point
//     that carries the dropped ids as aliases. Then icons (Module:Map first, page images of the wiki as
//     a fallback, see fallbackIcon) and deterministic output.

import { iconFileName, mapCategoryId, mapPointId, slug } from '../../../src/lib/ids'
import type { MapCategory, MapData, MapGroup, MapPoint } from '../../../src/lib/types'
import type { SyncContext, Warn } from '../context'
import { BATCH_SIZE, type RawPage } from '../wiki'
import { findTemplates, links, normalizeTitle, stripMarkup } from '../wikitext'
import { classifyGroups, type GroupInput } from './map-groups'
import { parseDescription, regionOf, regionPrefix, sameText } from './map-text'

export interface MapSources {
  /** Module:Map/<name>.json pages (JSON content), keyed by full title. */
  pages: RawPage[]
  /** Non-hidden wiki categories of the main-namespace page per base name ('Gold Ore Node' -> ['Category:Mining nodes', ...]). */
  pageCategories: Record<string, string[]>
  /** Base names that have no main-namespace page. */
  missingPages: string[]
  /**
   * Main-namespace title per base name when the page lives under another title
   * ('Threadbare Grain Sack' -> 'A Threadbare Grain Sack'). Other bases use their own name.
   */
  pageTitles?: Record<string, string>
  /**
   * Page image of the main-namespace page per base name (prop=pageimages): the picture the wiki itself picks
   * for the page ('Goblin Warrior' -> { file: 'Goblin_Warrior.png', width: 64, height: 89 }). Width and height
   * are those of a thumbnail at most 64 px wide, so only their ratio means something. Bases without one are left out.
   */
  pageImages?: Record<string, PageImage>
  /**
   * Resource node pages only: the main drop (first {{DropsLine}} on the page) and the page image of that item,
   * per base name ('Iron Ore Node' -> { item: 'Iron ore', file: 'Iron_ore.png', ... }). Left out when the item has none.
   */
  dropImages?: Record<string, DropImage>
}

export interface PageImage {
  /** Wiki file name as the API gives it, e.g. 'Goblin_Warrior.png'. */
  file: string
  width?: number
  height?: number
}

export interface DropImage extends PageImage {
  /** Title of the dropped item's page, e.g. 'Iron ore'. */
  item: string
}

export interface MapResult {
  map: MapData
  /**
   * Wiki file names of every icon used: as written in the Module:Map data (e.g. 'Gold_Ore.png'), plus the
   * page images that became a category icon (see fallbackIcon).
   */
  icons: string[]
}

const MODULE_PREFIX = 'Module:Map/'
const JSON_SUFFIX = '.json'

/** Plain code-unit order: the same in every runtime and locale. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** 'Module:Map/Gold Ore Node.json' -> 'Gold Ore Node'. */
export function mapBaseName(title: string): string {
  let base = title.startsWith(MODULE_PREFIX) ? title.slice(MODULE_PREFIX.length) : title
  if (base.endsWith(JSON_SUFFIX)) base = base.slice(0, -JSON_SUFFIX.length)
  return base
}

/* ------------------------------------------------------------------ */
/* Fetch                                                                */
/* ------------------------------------------------------------------ */

export async function fetchMapSources(ctx: SyncContext): Promise<MapSources> {
  const all = await ctx.wiki.queryAll<{ title: string }>(
    { list: 'allpages', apnamespace: 828, apprefix: 'Map/', aplimit: 'max' },
    (d) => d.query?.allpages ?? [],
  )
  const titles = all.map((p) => p.title).filter((t) => t.endsWith(JSON_SUFFIX))
  ctx.log(`  Found ${titles.length} Module:Map pages`)

  const { pages } = await ctx.pages(titles)
  const found = titles.map((t) => pages.get(t)).filter((p): p is RawPage => !!p)
  const bases = [...new Set(found.map((p) => mapBaseName(p.title)))]

  ctx.log(`  Fetching wiki categories and images of ${bases.length} pages`)
  const firstResponses = await fetchPageInfoResponses(ctx, bases)
  const first = collectPageCategories(bases, firstResponses)
  const images = collectPageImages(bases, firstResponses)

  // Bases without a page of their own name may have one under a slightly different title.
  const candidates = pageTitleCandidates(first.missingPages, found)
  const requested = new Set(bases)
  const extra = [...new Set(Object.values(candidates).flat())].filter((t) => !requested.has(t))
  let known = first.pageCategories
  let knownImages = images
  if (extra.length) {
    ctx.log(`  Trying ${extra.length} other titles for ${Object.keys(candidates).length} pages without a page of their own`)
    const responses = await fetchPageInfoResponses(ctx, extra)
    known = { ...collectPageCategories(extra, responses).pageCategories, ...known }
    knownImages = { ...collectPageImages(extra, responses), ...images }
  }
  const titled = applyPageTitles(first, candidates, known)
  const pageTitles = titled.pageTitles ?? {}
  // Bases found under another title take the image of that page.
  const pageImages = { ...images }
  for (const [base, title] of Object.entries(pageTitles)) {
    const image = Object.hasOwn(knownImages, title) ? knownImages[title] : undefined
    if (image) pageImages[base] = image
  }

  const missing = new Set(titled.missingPages)
  const nodes = Object.keys(titled.pageCategories)
    .filter((b) => !missing.has(b) && !junkReason(b) && isNodeLabel(familyOf(b).label))
    .sort(byText)
  // Normalised, so case duplicates ('zogre', 'Zogre') read one page.
  const dropImages = await fetchDropImages(ctx, nodes, (b) => normalizeTitle(Object.hasOwn(pageTitles, b) ? pageTitles[b]! : b))
  return { pages: found, ...titled, pageImages, dropImages }
}

/** prop=pageimages: the name of the page image plus a thumbnail at most 64 px wide (for its shape). */
const PAGE_IMAGE_PARAMS = { piprop: 'name|thumbnail', pithumbsize: 64, pilimit: 'max' }

/** Wiki categories and page image of every title in one `prop=categories|pageimages` query per 50 titles. */
function fetchPageInfoResponses(ctx: SyncContext, titles: string[]): Promise<unknown[]> {
  return queryBatches(ctx, titles, { prop: 'categories|pageimages', clshow: '!hidden', cllimit: 'max', ...PAGE_IMAGE_PARAMS })
}

/** A prop query for every title: 50 per request, one request at a time, following `continue`. Every response is returned. */
async function queryBatches(ctx: SyncContext, titles: string[], params: Record<string, string | number>): Promise<unknown[]> {
  const responses: unknown[] = []
  for (let i = 0; i < titles.length; i += BATCH_SIZE) {
    const batch = titles.slice(i, i + BATCH_SIZE)
    let cont: Record<string, string> | undefined = {}
    while (cont) {
      const data: any = await ctx.wiki.api({ action: 'query', ...params, redirects: 1, titles: batch.join('|'), ...cont })
      responses.push(data)
      cont = data.continue
    }
  }
  return responses
}

/** Labels of resource nodes: 'Iron Ore Node', 'Granite Deposit', 'Limestone Rock'. */
const NODE_LABEL = /\b(?:Node|Deposit|Rock)$/

export function isNodeLabel(label: string): boolean {
  return NODE_LABEL.test(normalizeTitle(label))
}

/**
 * Main drop of a resource node page: the item in the first {{DropsLine}} of its drops table
 * ('Gold Ore Node' lists gold ore first, then sapphire). Lines wrapped in another template count too.
 * Undefined when the page has none.
 */
export function firstDropName(wikitext: string): string | undefined {
  for (const t of findTemplates(wikitext, /^Drops ?line$/i, { nested: true })) {
    const name = dropTarget(t.params.name ?? '')
    if (name) return name
  }
  return undefined
}

/**
 * Page a DropsLine name points to: the target of a link or {{plink}} (never its display text), else the plain text.
 * A name with characters no title can have ('|' from {{!}}, brackets) is no title: it would also split the batch.
 */
function dropTarget(raw: string): string | undefined {
  const link = raw.includes('[[') ? links(raw)[0]?.target : undefined
  const plink = findTemplates(raw, 'Plink', { nested: true })[0]?.positional[0]
  const name = (link || (plink ? stripMarkup(plink) : '') || stripMarkup(raw)).replace(/#.*$/, '').trim()
  return name && !/[<>[\]{}|]/.test(name) ? normalizeTitle(name) : undefined
}

/**
 * Page image of the main drop of every node base (the wiki's own map shows Gold_Ore.png for the Gold Ore Node).
 * Node pages come through the revision cache, the item images from one prop=pageimages query per 50 items.
 * A node without a drop, or whose item has no page image, is left out; parseMap then falls back to the page itself.
 */
async function fetchDropImages(ctx: SyncContext, bases: string[], titleOf: (base: string) => string): Promise<Record<string, DropImage>> {
  if (!bases.length) return {}
  ctx.log(`  Looking up the drops of ${bases.length} resource nodes`)
  const { pages } = await ctx.pages([...new Set(bases.map(titleOf))])
  const itemOf = new Map<string, string>()
  for (const base of bases) {
    const page = pages.get(titleOf(base))
    const item = page ? firstDropName(page.content) : undefined
    if (item) itemOf.set(base, item)
  }
  const items = [...new Set(itemOf.values())].sort(byText)
  if (!items.length) return {}
  const images = collectPageImages(items, await queryBatches(ctx, items, { prop: 'pageimages', ...PAGE_IMAGE_PARAMS }))
  const out: Record<string, DropImage> = {}
  for (const [base, item] of itemOf) {
    const image = Object.hasOwn(images, item) ? images[item] : undefined
    if (image) out[base] = { item, ...image }
  }
  return out
}

/** 'A Threadbare Grain Sack' and 'Threadbare Grain Sack' give the same key: slug without a leading article. */
const bareSlug = (title: string) => slug(title).replace(/^(?:a|an|the)-/, '')

/**
 * Other titles a base without a main-namespace page may have on the wiki, best first:
 * 1. link targets in the map data with the same slug, leading article ignored
 *    ('Aetheric Fundamentals, a Primordial Primer' for 'Aetheric Fundamentals a Primordial Primer');
 * 2. the base with 'A ' (or 'An ' before a vowel) or 'The ' in front ('A Threadbare Grain Sack').
 * Qualified names ('Buried Treasure (Brynmoor)', 'Recipe: Meat Sandwich') and names that already
 * start with an article get no article variants. Junk pages get nothing.
 */
export function pageTitleCandidates(missing: string[], pages: RawPage[]): Record<string, string[]> {
  const targets = new Map<string, Set<string>>()
  for (const page of pages) {
    if (junkReason(mapBaseName(page.title))) continue
    let json: unknown
    try {
      json = JSON.parse(page.content)
    } catch {
      continue // parseMap reports it
    }
    const raws = extractPoints(json)
    if (typeof raws === 'string') continue
    for (const raw of raws) {
      for (const value of [raw.name, ...raw.descriptions]) {
        const text = asText(value)
        if (!text?.includes('[[')) continue
        for (const { target } of links(text)) {
          if (!target) continue
          const key = bareSlug(target)
          targets.set(key, (targets.get(key) ?? new Set()).add(target))
        }
      }
    }
  }

  const out: Record<string, string[]> = {}
  for (const base of missing) {
    if (junkReason(base)) continue
    const title = normalizeTitle(base)
    const list = [...(targets.get(bareSlug(base)) ?? [])].sort(byText)
    if (!/^(?:a|an|the)\s/i.test(title) && !/[:()]/.test(title)) {
      list.push(`${/^[aeiou]/i.test(title) ? 'An' : 'A'} ${title}`, `The ${title}`)
    }
    const unique = [...new Set(list)].filter((t) => t !== title)
    if (unique.length) out[base] = unique
  }
  return out
}

/**
 * Missing bases found under a candidate title move to pageCategories (under the base name, so parseMap
 * finds them as before) and get that title in pageTitles. `known` holds categories per looked-up title.
 */
export function applyPageTitles(
  first: Pick<MapSources, 'pageCategories' | 'missingPages'>,
  candidates: Record<string, string[]>,
  known: Record<string, string[]>,
): Pick<MapSources, 'pageCategories' | 'missingPages' | 'pageTitles'> {
  const pageCategories = { ...first.pageCategories }
  const missingPages: string[] = []
  const pageTitles: Record<string, string> = {}
  for (const base of first.missingPages) {
    const list = Object.hasOwn(candidates, base) ? candidates[base]! : []
    const title = list.find((t) => Object.hasOwn(known, t))
    if (title) {
      pageCategories[base] = known[title]!
      pageTitles[base] = title
    } else {
      missingPages.push(base)
    }
  }
  return { pageCategories, missingPages, pageTitles }
}

/**
 * Maps `prop=categories` responses back to the requested titles, through the
 * `normalized` and `redirects` lists ('chests' -> 'Chests' -> 'Chest'). Categories of one page
 * spread over several responses (clcontinue) are merged.
 */
export function collectPageCategories(requested: string[], responses: unknown[]): Pick<MapSources, 'pageCategories' | 'missingPages'> {
  const byTitle = new Map<string, Set<string>>()
  for (const p of existingPages(responses)) {
    const set = byTitle.get(p.title) ?? new Set<string>()
    for (const c of p.categories ?? []) if (typeof c?.title === 'string') set.add(c.title)
    byTitle.set(p.title, set)
  }
  const resolve = aliasResolver(responses)
  const pageCategories: Record<string, string[]> = {}
  const missingPages: string[] = []
  for (const title of requested) {
    const cats = byTitle.get(resolve(title))
    if (cats) pageCategories[title] = [...cats].sort()
    else missingPages.push(title)
  }
  return { pageCategories, missingPages }
}

/**
 * Maps `prop=pageimages` responses back to the requested titles, like collectPageCategories. A page answered
 * in several responses (continue) keeps the image it got first. Titles without a page image are left out.
 */
export function collectPageImages(requested: string[], responses: unknown[]): Record<string, PageImage> {
  const byTitle = new Map<string, PageImage>()
  for (const p of existingPages(responses)) {
    const file = typeof p.pageimage === 'string' ? p.pageimage.trim() : ''
    const thumb = isRecord(p.thumbnail) ? p.thumbnail : {}
    const size = isSize(thumb.width) && isSize(thumb.height) ? { width: thumb.width as number, height: thumb.height as number } : undefined
    const seen = byTitle.get(p.title)
    if (seen) {
      if (size && seen.width === undefined && (!file || file === seen.file)) Object.assign(seen, size)
    } else if (file) {
      byTitle.set(p.title, { file, ...size })
    }
  }
  const resolve = aliasResolver(responses)
  const out: Record<string, PageImage> = {}
  for (const title of requested) {
    const image = byTitle.get(resolve(title))
    if (image) out[title] = { ...image }
  }
  return out
}

const isSize = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0

/** Pages that exist, from every response. */
function existingPages(responses: unknown[]): any[] {
  return (responses as any[]).flatMap((data) => (data?.query?.pages ?? []) as any[]).filter((p) => !p.missing && !p.invalid && typeof p.title === 'string')
}

/** Requested title -> canonical title, through the `normalized` and `redirects` lists of every response. */
function aliasResolver(responses: unknown[]): (title: string) => string {
  const alias = new Map<string, string>()
  for (const data of responses as any[]) {
    const q = data?.query ?? {}
    for (const n of q.normalized ?? []) alias.set(n.from, n.to)
    for (const r of q.redirects ?? []) alias.set(r.from, r.to)
  }
  return (title) => {
    let cur = title
    for (let hops = 0; hops < 5 && alias.has(cur); hops++) cur = alias.get(cur)!
    return cur
  }
}

/* ------------------------------------------------------------------ */
/* Parse                                                                */
/* ------------------------------------------------------------------ */

/**
 * Pages that are not game data (one warning each, then skipped):
 * - anything with 'User:' or 'sandbox' in the name ('User:Jsfour/sandbox.json', a Map-object experiment)
 * - test pages: 'test.json' (239 points in a regular grid), 'HealingPotionTest.json' (5 points, no page)
 * - 'abyssalwhipstatue.json': one point at placeholder coordinates (319000, 227000) and no wiki page
 * 'zogre.json' is not junk: it is a case-duplicate of 'Zogre.json' and merges into the same category.
 */
const JUNK_PAGES = new Set(['abyssalwhipstatue'])

export function junkReason(base: string): string | undefined {
  if (/user( talk)?:/i.test(base)) return "a user's sandbox"
  if (/sandbox/i.test(base)) return 'sandbox'
  if (/^test\b/i.test(base) || /(^|[\s_-])test$/i.test(base) || /[a-z]Test$/.test(base)) return 'test page'
  if (JUNK_PAGES.has(base.toLowerCase())) return 'test point at placeholder coordinates'
  return undefined
}

/** Pages whose name does not say what they are. */
const CATEGORY_ALIASES: Record<string, string> = { chests: 'Treasure Chest' }

/**
 * Two points of different pages in one category closer than this are the same thing.
 * All 137 points of chests.json lie exactly (distance 0) on a 'Treasure Chest (<region>)' point,
 * while two distinct chests are never closer than 125 units (the Vestige Chance chests in Dowdun Reach)
 * and distinct points of the whole map sit hundreds of units apart. 50 absorbs small coordinate edits
 * on one of the two pages without ever joining two real chests.
 */
export const MERGE_DISTANCE = 50

/**
 * Region guess for points without a stated region: majority of the REGION_K nearest points
 * with a stated region within REGION_MAX_DISTANCE (game units; the world is 420000 wide).
 * Leave-one-out on the stated points of the fixtures: 975 of 987 right, 3 without a guess. Points farther
 * than this from any stated point (vault interiors far outside the map) keep no region.
 */
export const REGION_K = 5
export const REGION_MAX_DISTANCE = 25000

interface Family {
  /** Category label: the base name without region suffix. */
  label: string
  region?: string
  /** Sub-area from the suffix ('Weathered Diary (Bramblemead Valley)'). */
  area?: string
  /** Non-region qualifier of a regional page ('Treasure Chest (Vestige Chance) (Dowdun Reach)'). */
  qualifier?: string
  /** Suffix that starts with a region but says more ('Umbral Sands Cape'). */
  suffix?: string
}

const PAREN = /^(.*\S)\s*\(([^()]+)\)$/

export function familyOf(base: string): Family {
  const alias = CATEGORY_ALIASES[base.toLowerCase()]
  if (alias) return { label: alias }
  const m = base.match(PAREN)
  const r = m ? regionPrefix(m[2]!) : undefined
  if (!m || !r) return { label: base }
  const out: Family = { label: m[1]!, region: r.region }
  if (r.area) out.area = r.area
  if (r.rest) out.suffix = m[2]!.trim()
  const q = out.label.match(PAREN)
  if (q && !regionOf(q[2]!)) {
    out.label = q[1]!
    out.qualifier = q[2]!.trim()
  }
  return out
}

interface Draft {
  x: number
  y: number
  /** Module:Map title the point came from. */
  source: string
  name?: string
  link?: string
  /** Human-written description parts. */
  texts: string[]
  /** Readable versions of internal codes; shown only when there is no human text. */
  hints: string[]
  /** Wiki file name as written in the data. */
  icon?: string
  power?: number
  region?: string
  regionGuessed?: boolean
  /** Ids of twins in other categories that were folded into this point. */
  aliases?: string[]
}

interface RawPoint {
  x: unknown
  y: unknown
  name?: unknown
  descriptions: unknown[]
  icon?: unknown
}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Array of points, a single point, or a full Map object ({ coordinateOrder, markers: [{ position }] }). */
function extractPoints(json: unknown): RawPoint[] | string {
  const fromPoint = (p: any): RawPoint =>
    isRecord(p)
      ? { x: p.x, y: p.y, name: p.name, icon: p.icon, descriptions: [p.description, p.desc, p.description_] }
      : { x: undefined, y: undefined, descriptions: [] }
  if (Array.isArray(json)) return json.map(fromPoint)
  if (!isRecord(json)) return 'not a JSON object or array'
  if (Array.isArray(json.markers)) {
    const xy = (json.coordinateOrder ?? 'xy') === 'xy'
    return json.markers.map((m: any): RawPoint => {
      const pos = isRecord(m) && Array.isArray(m.position) ? m.position : []
      const popup = isRecord(m?.popup) ? m.popup : {}
      return {
        x: xy ? pos[0] : pos[1],
        y: xy ? pos[1] : pos[0],
        name: popup.title ?? m?.name,
        icon: m?.icon,
        descriptions: [popup.description ?? m?.description],
      }
    })
  }
  if ('x' in json || 'y' in json) return [fromPoint(json)]
  return Object.keys(json).length ? 'unknown format' : 'empty object'
}

const asText = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined

function parsePoint(raw: RawPoint, source: string, family: Family, pageBase: string): Draft | undefined {
  if (typeof raw.x !== 'number' || typeof raw.y !== 'number' || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return undefined
  const draft: Draft = { x: raw.x, y: raw.y, source, texts: [], hints: [] }
  // Text equal to one of these says nothing new ('Treasure Chest (Vestige chance)' on that very page).
  const labels = [family.label, pageBase]
  if (family.qualifier) labels.push(`${family.label} (${family.qualifier})`)

  const rawName = asText(raw.name)
  if (rawName) {
    if (rawName.includes('[[')) {
      const target = links(rawName)[0]?.target
      if (target) draft.link = target
    }
    let name = stripMarkup(rawName)
    const level = name.match(/^(.*?)[\s,;:\u2013-]*\(\s*Power Level\s*(\d+)\s*\)$/i)
    if (level) {
      draft.power = Number(level[2])
      name = level[1]!.trim()
    }
    const r = regionOf(name)
    if (r) {
      draft.region = r.region
      // A top-level region as name ('Postie Pete' at 'Fellhollow') says nothing beyond the region.
      if (!r.area) name = ''
    }
    if (name && !labels.some((l) => sameText(l, name))) draft.name = name
  }

  for (const value of raw.descriptions) {
    const text = asText(value)
    if (!text) continue
    const parsed = parseDescription(stripMarkup(text), draft.name ? [...labels, draft.name] : labels)
    if (parsed.power !== undefined) draft.power ??= parsed.power
    if (parsed.region) draft.region ??= parsed.region
    if (parsed.text) (parsed.hint ? draft.hints : draft.texts).push(parsed.text)
  }

  // The page suffix is the most reliable region.
  if (family.region) draft.region = family.region
  if (family.qualifier) draft.texts.unshift(family.qualifier)
  if (family.area) draft.hints.push(family.area)
  if (family.suffix) draft.hints.push(family.suffix)

  const icon = asText(raw.icon)?.trim()
  if (icon) draft.icon = icon
  return draft
}

function mergeInto(target: Draft, other: Draft) {
  target.name ??= other.name
  target.link ??= other.link
  target.icon ??= other.icon
  target.power ??= other.power
  target.region ??= other.region
  for (const t of other.texts) if (!target.texts.some((x) => sameText(x, t))) target.texts.push(t)
  for (const t of other.hints) if (!target.hints.some((x) => sameText(x, t))) target.hints.push(t)
}

interface CategoryDraft {
  id: string
  labels: string[]
  sources: string[]
  bases: string[]
  points: Draft[]
  duplicates: number
  duplicateSource?: string
}

/** Points bucketed in square cells of `size`, for "what lies within `size` of here" lookups. */
class Grid<T extends { x: number; y: number }> {
  private readonly cells = new Map<string, T[]>()
  private readonly size: number

  constructor(size: number) {
    this.size = size
  }

  add(item: T) {
    const key = `${Math.floor(item.x / this.size)}:${Math.floor(item.y / this.size)}`
    const list = this.cells.get(key)
    if (list) list.push(item)
    else this.cells.set(key, [item])
  }

  /** Every item within `size` of (x, y), in insertion order. */
  near(x: number, y: number): { item: T; dist: number }[] {
    const cx = Math.floor(x / this.size)
    const cy = Math.floor(y / this.size)
    const out: { item: T; dist: number }[] = []
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const item of this.cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
          const dist = Math.hypot(item.x - x, item.y - y)
          if (dist <= this.size) out.push({ item, dist })
        }
      }
    }
    return out
  }
}

/** Merges the pages of one category: identical ids first, then nearby points of other pages. */
function mergePoints(cat: CategoryDraft, perSource: Map<string, Draft[]>) {
  const byId = new Map<string, Draft>()
  const grid = new Grid<Draft>(MERGE_DISTANCE)
  const multi = perSource.size > 1

  for (const source of [...perSource.keys()].sort(byText)) {
    for (const draft of perSource.get(source)!) {
      const id = mapPointId(cat.id, draft.x, draft.y)
      const same = byId.get(id)
      if (same) {
        if (same.source === source) {
          cat.duplicates++
          cat.duplicateSource ??= source
        }
        mergeInto(same, draft)
        continue
      }
      const nearest = multi
        ? grid
            .near(draft.x, draft.y)
            .filter((n) => n.item.source !== source)
            .sort((a, b) => a.dist - b.dist)[0]?.item
        : undefined
      if (nearest) {
        mergeInto(nearest, draft)
        byId.set(id, nearest)
        continue
      }
      byId.set(id, draft)
      grid.add(draft)
      cat.points.push(draft)
    }
  }
}

type Located = { x: number; y: number; region?: string }

/** Majority region of the REGION_K nearest candidates; ties go to the nearest of the tied regions. */
function guessRegion(near: { item: Located; dist: number }[]): string | undefined {
  const top = near
    .filter((n) => n.item.region)
    .sort((a, b) => a.dist - b.dist || byText(a.item.region!, b.item.region!))
    .slice(0, REGION_K)
  if (!top.length) return undefined
  const counts = new Map<string, number>()
  for (const n of top) counts.set(n.item.region!, (counts.get(n.item.region!) ?? 0) + 1)
  const max = Math.max(...counts.values())
  return top.find((n) => counts.get(n.item.region!) === max)!.item.region
}

/** Points without a stated region get the majority region of the nearest points that have one. */
function inferRegions(points: Draft[]) {
  const grid = new Grid<Draft>(REGION_MAX_DISTANCE)
  for (const p of points) if (p.region) grid.add(p)
  for (const p of points) {
    if (p.region) continue
    const region = guessRegion(grid.near(p.x, p.y))
    if (region) {
      p.region = region
      p.regionGuessed = true
    }
  }
}

/** Leave-one-out check of the region guess on the stated points (used by tests to tune the constants). */
export function regionGuessAccuracy(points: Pick<MapPoint, 'x' | 'y' | 'region' | 'regionGuessed'>[]): { total: number; correct: number; unknown: number } {
  const anchors = points.filter((p) => p.region && !p.regionGuessed)
  const grid = new Grid<Located>(REGION_MAX_DISTANCE)
  for (const a of anchors) grid.add(a)
  let correct = 0
  let unknown = 0
  for (const a of anchors) {
    const guess = guessRegion(grid.near(a.x, a.y).filter((n) => n.item !== a))
    if (!guess) unknown++
    else if (guess === a.region) correct++
  }
  return { total: anchors.length, correct, unknown }
}

function pickLabel(labels: string[]): string {
  const sorted = [...new Set(labels)].sort()
  const label = sorted.find((l) => /^[A-Z0-9]/.test(l)) ?? sorted[0]!
  return normalizeTitle(label)
}

/* ------------------------------------------------------------------ */
/* Twins                                                                */
/* ------------------------------------------------------------------ */

/** Groups of one-time spots. The wiki lists some of those spots in two categories of one group. */
export const TWIN_GROUPS: ReadonlySet<MapGroup> = new Set<MapGroup>(['lore', 'unique', 'vault'])

/**
 * The same spot listed in two categories lies at most this far apart. In the fixtures twins are 0 to 56 units
 * apart (Preserved Diary and its Lore Scraps entry), while distinct lore spots are at least 1678 apart.
 */
export const TWIN_DISTANCE = 500

/** Name of a spot for twin matching, without a trailing qualifier: 'Weathered Diary (Fellhollow)' -> 'weathered-diary'. */
export function titleKey(title: string): string {
  return slug(title.replace(/\s*(?:\([^()]*\)|\[[^[\]]*\])\s*$/, ''))
}

interface Keeper {
  x: number
  y: number
  id: string
  key: string
  draft: Draft
  cat: CategoryDraft
}

/** The kept point takes over what it lacks from its twin. A stated region beats a guessed one. */
function foldTwin(keeper: Draft, twin: Draft, twinLink: string | undefined) {
  if (twin.region && (!keeper.region || (keeper.regionGuessed && !twin.regionGuessed))) {
    keeper.region = twin.region
    keeper.regionGuessed = twin.regionGuessed
  }
  keeper.link ??= twinLink
  mergeInto(keeper, twin)
}

/**
 * Folds twins of one group into one point per spot. Categories are visited by point count (most first, then id),
 * so 'Lore Scraps', 'Vaults' and 'Recipe Books' keep their points. A point is a twin of a point kept earlier in
 * another category when it lies within TWIN_DISTANCE and has the same titleKey (link, else name, else category
 * label). The twin is dropped and its id becomes an alias of the kept point. A category that loses every point
 * hands its sources to the categories that took them, so lookups by Module:Map page name (MapIndex) still work.
 */
function mergeTwins(cats: { cat: CategoryDraft; label: string }[], linkOf: (d: Draft) => string | undefined): void {
  const grid = new Grid<Keeper>(TWIN_DISTANCE)
  const order = [...cats].sort((a, b) => b.cat.points.length - a.cat.points.length || byText(a.cat.id, b.cat.id))
  for (const { cat, label } of order) {
    const kept: Draft[] = []
    const keepers: Keeper[] = []
    const takers = new Set<CategoryDraft>()
    for (const d of cat.points) {
      const id = mapPointId(cat.id, d.x, d.y)
      const key = titleKey(d.link ?? d.name ?? label)
      const twin = key
        ? grid
            .near(d.x, d.y)
            .filter((n) => n.item.key === key)
            .sort((a, b) => a.dist - b.dist || byText(a.item.id, b.item.id))[0]?.item
        : undefined
      if (twin) {
        foldTwin(twin.draft, d, linkOf(d))
        ;(twin.draft.aliases ??= []).push(id)
        takers.add(twin.cat)
      } else {
        kept.push(d)
        keepers.push({ x: d.x, y: d.y, id, key, draft: d, cat })
      }
    }
    // Only after the whole category: a twin always sits in another category.
    for (const k of keepers) grid.add(k)
    cat.points = kept
    if (!kept.length) for (const taker of takers) taker.sources.push(...cat.sources)
  }
}

/* ------------------------------------------------------------------ */
/* Fallback icons                                                       */
/* ------------------------------------------------------------------ */

/**
 * Height/width range of a page image that can stand in as an icon. Item, creature and NPC renders are
 * 0.75 (Chest) to 1.4 (Goblin Warrior, Vannaka); wide screenshots of places and quest scenes fall outside.
 */
export const PAGE_IMAGE_ASPECT = { min: 0.6, max: 1.8 } as const

/** A PNG (transparent render) of roughly icon shape. Without a known size the shape is unknown: not usable. */
function iconShaped(image: PageImage): boolean {
  if (!/\.png$/i.test(image.file) || !image.width || !image.height) return false
  const ratio = image.height / image.width
  return ratio >= PAGE_IMAGE_ASPECT.min && ratio <= PAGE_IMAGE_ASPECT.max
}

/** Value for a base name, also when the record is keyed by the normalised title. */
function byBase<T>(record: Record<string, T> | undefined, base: string): T | undefined {
  if (!record) return undefined
  if (Object.hasOwn(record, base)) return record[base]
  const title = normalizeTitle(base)
  return Object.hasOwn(record, title) ? record[title] : undefined
}

/**
 * Icon for a category without a Module:Map icon, from the wiki page of the category (`base` is its Module:Map base):
 * 1. a resource node ('Iron Ore Node'): the page image of its main drop ('Iron ore'), like the wiki's own map,
 *    since the node renders all look alike at marker size;
 * 2. else the page image of the page itself, when it is a PNG of icon shape and the page is not a quest
 *    (a quest page shows a scene, not the thing on the map);
 * 3. else none: the app shows the group glyph. Having no icon is normal and never a warning.
 */
function fallbackIcon(src: MapSources, label: string, base: string, categories: string[]): string | undefined {
  if (isNodeLabel(label)) {
    const drop = byBase(src.dropImages, base)
    if (drop?.file) return drop.file
  }
  const image = byBase(src.pageImages, base)
  if (!image || !iconShaped(image)) return undefined
  if (categories.includes('Category:Quests')) return undefined
  return image.file
}

/* ------------------------------------------------------------------ */
/* parseMap                                                             */
/* ------------------------------------------------------------------ */

export function parseMap(src: MapSources, warn: Warn): MapResult {
  const pageCats = (base: string): string[] | undefined => src.pageCategories[base] ?? src.pageCategories[normalizeTitle(base)]
  const missing = new Set(src.missingPages.flatMap((b) => [b, normalizeTitle(b)]))
  const hasPage = (base: string) => !!pageCats(base) && !missing.has(base)
  const renamed = new Map(Object.entries(src.pageTitles ?? {}))
  /** Main-namespace title of a base that has a page. */
  const pageTitle = (base: string) => renamed.get(base) ?? renamed.get(normalizeTitle(base)) ?? normalizeTitle(base)
  /** Wiki page a point links to: its own link, else the page of the Module:Map page it came from. */
  const pageLink = (d: Draft) => {
    const base = mapBaseName(d.source)
    return d.link ?? (hasPage(base) ? pageTitle(base) : undefined)
  }

  const categories = new Map<string, CategoryDraft>()
  const perCategorySource = new Map<string, Map<string, Draft[]>>()

  for (const page of [...src.pages].sort((a, b) => byText(a.title, b.title))) {
    const base = mapBaseName(page.title)
    const junk = junkReason(base)
    if (junk) {
      warn(`Skipped: ${junk}`, page.title)
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(page.content)
    } catch (err) {
      warn(`Invalid JSON, page skipped: ${(err as Error).message}`, page.title)
      continue
    }
    const raws = extractPoints(json)
    if (typeof raws === 'string') {
      warn(`No map points recognised (${raws}), page skipped`, page.title)
      continue
    }

    const family = familyOf(base)
    const drafts: Draft[] = []
    let broken = 0
    for (const raw of raws) {
      const draft = parsePoint(raw, page.title, family, base)
      if (draft) drafts.push(draft)
      else broken++
    }
    if (broken) warn(`${broken} of ${raws.length} points without a valid x/y skipped`, page.title)
    if (!drafts.length) {
      if (!broken) warn('Page has no map points', page.title)
      continue
    }

    // A single point on a page in exactly one region category: the wiki states where it is.
    if (drafts.length === 1 && !drafts[0]!.region) {
      const regions = new Set((pageCats(base) ?? []).map((c) => regionOf(c.replace(/^Category:/, ''))?.region).filter(Boolean))
      if (regions.size === 1) drafts[0]!.region = [...regions][0]
    }

    const id = mapCategoryId(family.label)
    if (!id) {
      warn('No usable category name, page skipped', page.title)
      continue
    }
    const cat = categories.get(id) ?? { id, labels: [], sources: [], bases: [], points: [], duplicates: 0 }
    cat.labels.push(family.label)
    cat.sources.push(page.title)
    cat.bases.push(base)
    categories.set(id, cat)
    const perSource = perCategorySource.get(id) ?? new Map<string, Draft[]>()
    perSource.set(page.title, [...(perSource.get(page.title) ?? []), ...drafts])
    perCategorySource.set(id, perSource)
  }

  for (const cat of categories.values()) {
    mergePoints(cat, perCategorySource.get(cat.id)!)
    if (cat.duplicates) {
      warn(`${cat.duplicates} duplicate ${cat.duplicates === 1 ? 'point' : 'points'} (same coordinates) merged`, cat.duplicateSource)
    }
  }

  // Groups
  const inputs: GroupInput[] = [...categories.values()].map((cat) => ({
    id: cat.id,
    label: pickLabel(cat.labels),
    categories: [...new Set(cat.bases.flatMap((b) => (hasPage(b) ? pageCats(b)! : [])))].map((c) => c.replace(/^Category:/, '')).sort(),
    pointCount: cat.points.length,
    names: cat.points.flatMap((p) => {
      const name = p.link ?? p.name
      return name ? [name] : []
    }),
  }))
  const groups = classifyGroups(inputs)

  // Regions
  const allDrafts = [...categories.values()].flatMap((c) => c.points)
  inferRegions(allDrafts)

  // Twins, per group
  const twinGroups = new Map<MapGroup, { cat: CategoryDraft; label: string }[]>()
  for (const input of inputs) {
    const group = groups.get(input.id)?.group ?? 'other'
    if (!TWIN_GROUPS.has(group)) continue
    twinGroups.set(group, [...(twinGroups.get(group) ?? []), { cat: categories.get(input.id)!, label: input.label }])
  }
  for (const list of twinGroups.values()) mergeTwins(list, pageLink)

  // Output
  const outCategories: MapCategory[] = []
  const outPoints: MapPoint[] = []
  const icons = new Set<string>()
  const others: string[] = []

  for (const input of inputs) {
    const cat = categories.get(input.id)!
    // Every point was a twin of a point in another category.
    if (!cat.points.length) continue
    const group: MapGroup = groups.get(input.id)?.group ?? 'other'
    if (group === 'other') others.push(input.label)

    const pages = [...new Set(cat.bases.filter(hasPage).map(pageTitle))]
    const own = pages.find((p) => sameText(p, input.label))
    const wikiPage = own ?? (pages.length === 1 ? pages[0] : undefined)

    const iconCounts = new Map<string, number>()
    for (const p of cat.points) {
      if (!p.icon) continue
      icons.add(p.icon)
      const local = iconFileName(p.icon)
      iconCounts.set(local, (iconCounts.get(local) ?? 0) + 1)
    }
    const [topIcon, topCount] = [...iconCounts].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0] ?? []
    const mapIcon = topIcon && topCount! * 2 > cat.points.length ? topIcon : undefined
    // Module:Map icons always win; only a category without one looks at its wiki page.
    const pageBase = mapIcon || !wikiPage ? undefined : [...cat.bases].filter(hasPage).sort(byText).find((b) => pageTitle(b) === wikiPage)
    const fallback = pageBase ? fallbackIcon(src, input.label, pageBase, pageCats(pageBase) ?? []) : undefined
    if (fallback) icons.add(fallback)
    const catIcon = mapIcon ?? (fallback ? iconFileName(fallback) : undefined)

    outCategories.push({
      id: cat.id,
      label: input.label,
      group,
      ...(catIcon ? { icon: catIcon } : {}),
      ...(wikiPage ? { wikiPage } : {}),
      sources: [...new Set(cat.sources)].sort(byText),
      count: cat.points.length,
    })

    for (const d of cat.points) {
      const point: MapPoint = { id: mapPointId(cat.id, d.x, d.y), categoryId: cat.id, x: d.x, y: d.y }
      if (d.name) point.name = d.name
      const link = pageLink(d)
      if (link && (!wikiPage || !sameText(link, wikiPage))) point.link = link
      const parts = d.texts.length ? d.texts : d.hints
      const description = parts.filter((t) => !point.name || !sameText(t, point.name)).join('; ')
      if (description) point.description = description
      if (d.icon) {
        const local = iconFileName(d.icon)
        if (local !== catIcon) point.icon = local
      }
      if (d.power !== undefined) point.power = d.power
      if (d.region) point.region = d.region
      if (d.regionGuessed) point.regionGuessed = true
      if (d.aliases?.length) point.aliases = [...d.aliases].sort(byText)
      outPoints.push(point)
    }
  }

  if (others.length) {
    warn(`No group found for ${others.length} categories, they go under 'other': ${others.sort(byText).join(', ')}`)
  }

  outCategories.sort((a, b) => byText(a.label.toLowerCase(), b.label.toLowerCase()) || byText(a.id, b.id))
  outPoints.sort((a, b) => byText(a.categoryId, b.categoryId) || byText(a.id, b.id))
  return { map: { categories: outCategories, points: outPoints }, icons: [...icons].sort(byText) }
}
