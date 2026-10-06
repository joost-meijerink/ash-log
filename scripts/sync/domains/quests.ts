// Quests domain: Category:Quests + the 'Quests' overview page + Quick guides -> Quest[].
//
// A page is a quest when it has {{Quest details}} with |qtype primary, secondary or tertiary.
// Pages marked as removed from the game ({{Gone}} at the top) are skipped with a warning.
// Order and region come from the tables on the 'Quests' page, steps from the Quick guide
// subpage when it exists and otherwise from the Walkthrough section.

import { wikiUrl } from '../../../src/lib/ids'
import type { MapData, Quest, QuestKind } from '../../../src/lib/types'
import type { SyncContext, Warn } from '../context'
import type { RawPage } from '../wiki'
import { expandGrid, findTemplates, lead, links, normalizeTitle, parseTables, type Template } from '../wikitext'
import {
  parseItems,
  parseRewards,
  plain,
  quickGuideSteps,
  walkthroughNeeds,
  walkthroughSteps,
  withStepIds,
  type RawStep,
} from './quests-content'
import { findStartPoint, MapIndex } from './quests-start'

export interface QuestSources {
  /** The 'Quests' overview page (primary/secondary tables with order, region, where to start). */
  overview: RawPage
  /** Quest pages from Category:Quests (subpages like 'Ratcatcher/Quick guide' excluded). */
  quests: RawPage[]
  /** Existing '<quest>/Quick guide' subpages, keyed by quest title. */
  quickGuides: Record<string, RawPage>
}

export const QUESTS_CATEGORY = 'Category:Quests'
export const OVERVIEW_TITLE = 'Quests'
const QUICK_GUIDE = '/Quick guide'
/** Banners for content that is no longer in the game. */
const REMOVED = /^(?:gone|removed|discontinued)$/i

/** Category members that can be quests: namespace 0 pages, not the overview itself, no subpages. */
export function questTitles(members: string[]): string[] {
  return [...new Set(members)].filter((t) => t !== OVERVIEW_TITLE && !t.includes('/'))
}

export async function fetchQuestSources(ctx: SyncContext): Promise<QuestSources> {
  const members = await ctx.wiki.queryAll<{ title: string; ns?: number }>(
    { list: 'categorymembers', cmtitle: QUESTS_CATEGORY, cmnamespace: 0, cmlimit: 'max' },
    (d) => d.query?.categorymembers ?? [],
  )
  const titles = questTitles(members.filter((m) => (m.ns ?? 0) === 0).map((m) => m.title))
  ctx.log(`  ${titles.length} pages in ${QUESTS_CATEGORY}`)

  const { pages, missing } = await ctx.pages([...titles, OVERVIEW_TITLE])
  const overview = pages.get(OVERVIEW_TITLE)
  if (!overview) throw new Error(`Page '${OVERVIEW_TITLE}' not found on the wiki`)
  if (missing.length) ctx.log(`  Not found: ${missing.join(', ')}`)
  const quests = titles.flatMap((t) => pages.get(t) ?? [])

  // Most quests have no Quick guide; missing subpages are normal.
  const guides = await ctx.pages(quests.map((q) => q.title + QUICK_GUIDE))
  const quickGuides: Record<string, RawPage> = {}
  for (const quest of quests) {
    const guide = guides.pages.get(quest.title + QUICK_GUIDE)
    // A redirect to the quest page itself is not a Quick guide.
    if (guide && guide.title.endsWith(QUICK_GUIDE)) quickGuides[quest.title] = guide
  }
  return { overview, quests, quickGuides }
}

/** `map` is used to find each quest's start point. */
export function parseQuests(src: QuestSources, map: MapData, warn: Warn): Quest[] {
  const recognised: { page: RawPage; details: Template; kind: QuestKind }[] = []
  for (const page of src.quests) {
    const removed = findTemplates(lead(page.content), REMOVED)[0]
    if (removed) {
      warn(`Removed from the game ({{${removed.name}}}), skipped`, page.title)
      continue
    }
    const details = findTemplates(page.content, 'Quest details')[0]
    const qtype = details ? plain(details.params.qtype ?? '').toLowerCase() : ''
    if (!details || !qtype) {
      warn('No Quest details/qtype, skipped', page.title)
      continue
    }
    if (!isKind(qtype)) {
      warn(`Unknown qtype '${qtype}', skipped`, page.title)
      continue
    }
    recognised.push({ page, details, kind: qtype })
  }

  const resolve = questResolver(recognised.map((r) => r.page.title))
  const overview = parseOverview(src.overview, resolve, warn)
  const index = new MapIndex(map)

  const quests = recognised.map(({ page, details, kind }) => {
    const id = page.title
    const p = details.params
    const row = overview.get(id)
    if (!row && kind !== 'tertiary') warn(`Not on the page '${OVERVIEW_TITLE}', so no order or region`, id)

    const location = plain(p.start ?? '') || row?.start || ''
    const description = plain(p.desc ?? '')

    let raw: RawStep[] | undefined
    let stepsSource: Quest['stepsSource'] = 'walkthrough'
    let dropped = new Set<string>()
    const guide = src.quickGuides[id]
    if (guide) {
      raw = quickGuideSteps(guide.content, dropped)
      if (raw.length) stepsSource = 'quick-guide'
      else warn('Quick guide without steps, using the Walkthrough', guide.title)
    }
    if (!raw?.length) {
      dropped = new Set()
      raw = walkthroughSteps(page.content, dropped)
      if (!raw) warn('No Walkthrough section found', id)
    }
    const steps = withStepIds(id, raw ?? [], warn)
    if (!steps.length) warn('No steps found', id)
    if (dropped.size) {
      const names = [...dropped].map((n) => `{{${n}}}`).join(', ')
      warn(`${dropped.size === 1 ? 'Template' : 'Templates'} ${names} left out of the steps`, stepsSource === 'quick-guide' ? guide!.title : id)
    }
    const needs = walkthroughNeeds(page.content)

    const requires: string[] = []
    for (const link of links(p.req ?? '')) {
      const req = resolve(link.target)
      if (req && req !== id && !requires.includes(req)) requires.push(req)
    }

    const start = findStartPoint({ content: page.content, start: p.start ?? '', location, region: row?.region }, index)

    const quest: Quest = {
      id,
      name: id,
      kind,
      ...(row ? { order: row.order } : {}),
      ...(row?.region ? { region: row.region } : {}),
      ...(description ? { description } : {}),
      location,
      ...(start ? { startPointId: start.pointId, startMatch: start.match } : {}),
      steps,
      stepsSource,
      items: parseItems(id, p.item_req),
      rewards: parseRewards(page.content),
      requires,
      ...(needs.length ? { needs } : {}),
      wikiUrl: wikiUrl(id),
    }
    return quest
  })

  return quests.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.order ?? Infinity) - (b.order ?? Infinity) ||
      a.name.localeCompare(b.name, 'en'),
  )
}

const KIND_ORDER: Record<QuestKind, number> = { primary: 0, secondary: 1, tertiary: 2 }

function isKind(value: string): value is QuestKind {
  return value in KIND_ORDER
}

/**
 * Link target to quest id: exact or case-insensitive title, and "Black Knight's Fortress (Quest)"
 * resolves to the page "Black Knight's Fortress".
 */
export function questResolver(titles: string[]): (target: string) => string | undefined {
  const byLower = new Map(titles.map((t) => [t.toLowerCase(), t]))
  return (target) => {
    const key = normalizeTitle(target).toLowerCase()
    return byLower.get(key) ?? byLower.get(key.replace(/\s*\(quest\)$/, ''))
  }
}

export interface OverviewRow {
  /** 1-based position within its table. */
  order: number
  region?: string
  start?: string
}

/**
 * The tables on the 'Quests' page (Primary, Secondary): quest id -> order, region and where to start.
 * Rowspans are expanded, so every row has its region. Rows without a quest link are skipped.
 */
export function parseOverview(page: RawPage, resolve: (target: string) => string | undefined, warn: Warn): Map<string, OverviewRow> {
  const out = new Map<string, OverviewRow>()
  const tables = parseTables(page.content)
  let recognised = 0
  for (const rows of tables) {
    const header = rows.find((r) => r.every((c) => c.header))
    const names = header?.map((c) => plain(c.text).toLowerCase()) ?? []
    const questCol = names.findIndex((n) => n === 'quests' || n === 'quest')
    if (questCol < 0) {
      warn('Table without a Quests column on the Quests page, skipped', page.title)
      continue
    }
    recognised++
    const regionCol = names.findIndex((n) => n === 'region')
    const startCol = names.findIndex((n) => /start/.test(n))

    const grid = expandGrid(rows)
    let order = 0
    rows.forEach((row, i) => {
      if (row.every((c) => c.header)) return
      const link = links(grid[i][questCol] ?? '')[0]
      if (!link) return
      order++
      const id = resolve(link.target)
      if (!id) {
        warn(`'${link.target}' is in the quest table but isn't a known quest`, page.title)
        return
      }
      if (out.has(id)) return
      const region = regionCol >= 0 ? plain(grid[i][regionCol]) : ''
      const start = startCol >= 0 ? plain(grid[i][startCol]) : ''
      out.set(id, { order, ...(region ? { region } : {}), ...(start ? { start } : {}) })
    })
  }
  if (!recognised) warn('No quest tables recognised, quests get no order or region', page.title)
  return out
}
