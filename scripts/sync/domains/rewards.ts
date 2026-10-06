// Rewards domain: the 'Consumable Recipes' page -> unique unlocks to tick off.
//
// One level-2 section per kind (Plans, Patterns, Vestiges, Quests, Dragonkin Effigies,
// Recipe Books, Fishing Trophies); level-3 headings become the group. Table cells can
// hold several {{plink}}s, one per line, that pair up by position across columns.
// Patterns, vestiges and recipe books are linked to the one-time map spots where you
// pick them up (Reward.pointIds), see linkPoints.

import { rewardId, slug } from '../../../src/lib/ids'
import type { MapData, MapPoint, Quest, Reward, RewardKind, RewardVia, Vault } from '../../../src/lib/types'
import type { SyncContext, Warn } from '../context'
import type { RawPage } from '../wiki'
import { findTemplates, links, listItems, parseTables, sections, splitTopLevel, stripMarkup } from '../wikitext'
import { compact, nameKey, readColumns, sameName, upperFirst } from './table-columns'

export const REWARD_PAGE = 'Consumable Recipes'

export interface RewardSources {
  /** The 'Consumable Recipes' page. */
  page: RawPage
}

export async function fetchRewardSources(ctx: SyncContext): Promise<RewardSources> {
  const { pages } = await ctx.pages([REWARD_PAGE])
  const page = pages.get(REWARD_PAGE)
  if (!page) throw new Error(`Rewards: page '${REWARD_PAGE}' is missing from the wiki. Without it there's nothing to read.`)
  return { page }
}

/** Level-2 sections in the order rewards are sorted in. */
const KINDS: { kind: RewardKind; title: RegExp }[] = [
  { kind: 'plan', title: /^plans?$/i },
  { kind: 'pattern', title: /^patterns?$/i },
  { kind: 'vestige', title: /^vestiges?$/i },
  { kind: 'quest', title: /^quests?$/i },
  { kind: 'effigy', title: /^dragonkin effig(y|ies)$/i },
  { kind: 'recipe-book', title: /^recipe books?$/i },
  { kind: 'fishing-trophy', title: /^fishing troph(y|ies)$/i },
]
const KIND_ORDER = KINDS.map((k) => k.kind)

/** Standard wiki sections without rewards: skipped without a warning. */
const IGNORED_SECTIONS = /^(references|update history|gallery|trivia|see also|changes)$/i

/** Tables where a Recipe cell and an Item cell pair up line by line. */
const PAIRED_COLUMNS: Partial<Record<RewardKind, { recipe: RegExp; item: RegExp; source: RegExp }>> = {
  plan: { recipe: /^recipes?$/i, item: /^items?$/i, source: /^sources?$/i },
  pattern: { recipe: /^recipes?$/i, item: /^items?$/i, source: /^sources?$/i },
  vestige: { recipe: /^recipes?$/i, item: /^items?$/i, source: /^sources?$/i },
  'fishing-trophy': { recipe: /^fish$/i, item: /^troph(y|ies)$/i, source: /^sources?$/i },
}
const QUEST_COLUMNS = { reward: /^rewards?$/i, requirement: /^requirements?$/i, quest: /^quests?$/i }
const EFFIGY_COLUMNS = { item: /^items?(\s*\(s\))?$/i, vault: /^vaults?$/i }

/**
 * Source templates the wiki expands into a table of monsters or shops. We only keep what
 * they mean (Reward.via); the app shows its own label for it.
 */
const SOURCE_TEMPLATES: Record<string, RewardVia> = {
  'Drop sources list': 'drops',
  'Store locations list': 'shops',
}

interface Block {
  /** Level-2 section title, for warnings. */
  section: string
  group?: string
  text: string
}

interface Parser {
  add: (reward: Omit<Reward, 'id'>) => void
  warn: (message: string) => void
  quests: Quest[]
  vaults: Vault[]
  unresolvedQuests: Set<string>
  unresolvedVaults: Set<string>
}

/**
 * Quests and vaults are used to link rewards (questId, vaultId) and to pick up armour set labels;
 * the map to link pickups to their spot (pointIds). Without a map, rewards get no pointIds.
 */
export function parseRewards(
  src: RewardSources,
  refs: { quests: Quest[]; vaults: Vault[]; map?: MapData | null },
  warn: Warn,
): Reward[] {
  const pageTitle = src.page.title
  const found: Reward[] = []
  const p: Parser = {
    add: (reward) => found.push(compact<Reward>({ id: rewardId(reward.kind, reward.name), ...reward })),
    warn: (message) => warn(message, pageTitle),
    quests: refs.quests,
    vaults: refs.vaults,
    unresolvedQuests: new Set(),
    unresolvedVaults: new Set(),
  }

  const seen = new Set<RewardKind>()
  for (const s of sections(src.page.content)) {
    if (s.level !== 2) continue
    const spec = KINDS.find((k) => k.title.test(s.title))
    if (!spec) {
      if (!IGNORED_SECTIONS.test(s.title)) p.warn(`Unknown section '${s.title}' skipped`)
      continue
    }
    seen.add(spec.kind)
    const before = found.length
    for (const block of groupBlocks(s.title, s.body)) {
      const n = found.length
      parseBlock(spec.kind, block, p)
      // Only groups: a section intro is often prose without rewards (Dragonkin Effigies).
      if (block.group && found.length === n) p.warn(`${where(block)}: no rewards recognised, group skipped`)
    }
    if (found.length === before) p.warn(`Section '${s.title}' gave no rewards, did the page layout change?`)
  }
  for (const { kind } of KINDS) {
    if (!seen.has(kind)) p.warn(`Section for '${kind}' not found, these rewards are missing`)
  }
  if (p.unresolvedQuests.size) p.warn(`Quests not found, rewards without a quest link: ${[...p.unresolvedQuests].join(', ')}`)
  if (p.unresolvedVaults.size) p.warn(`Vaults not found, effigies without a vault link: ${[...p.unresolvedVaults].join(', ')}`)

  const rewards = dedupe(found, p.warn)
  if (refs.map) linkPoints(rewards, refs.map, p.warn)
  return rewards.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (a.group ?? '').localeCompare(b.group ?? '', 'en') ||
      a.name.localeCompare(b.name, 'en'),
  )
}

/** The section intro (no group) followed by one block per level-3 heading. */
function groupBlocks(section: string, body: string): Block[] {
  const subs = sections(body).filter((s) => s.level === 3)
  const blocks: Block[] = [{ section, text: body.slice(0, subs[0]?.start ?? body.length) }]
  for (const sub of subs) blocks.push({ section, group: sub.title, text: sub.body })
  return blocks
}

function where(block: Block): string {
  return block.group ? `${block.section} > ${block.group}` : block.section
}

function parseBlock(kind: RewardKind, block: Block, p: Parser): void {
  const paired = PAIRED_COLUMNS[kind]
  if (paired) parsePaired(kind, paired, block, p)
  else if (kind === 'quest') parseQuests(block, p)
  else if (kind === 'effigy') parseEffigies(block, p)
  else if (kind === 'recipe-book') parseRecipeBooks(block, p)
}

/** Plans, patterns, vestiges and fishing trophies: recipe[i] teaches item[i]. */
function parsePaired(kind: RewardKind, columns: { recipe: RegExp; item: RegExp; source: RegExp }, block: Block, p: Parser) {
  for (const rows of parseTables(block.text)) {
    const table = readColumns(rows, { recipe: columns.recipe, item: columns.item }, { source: columns.source })
    if (!table) {
      p.warn(`${where(block)}: table without recognisable columns skipped`)
      continue
    }
    for (const row of table) {
      const recipes = entries(row.recipe)
      const items = entries(row.item)
      if (!items.length && !recipes.length) {
        if (stripMarkup(row.recipe + row.item)) p.warn(`${where(block)}: row without {{plink}} skipped: ${stripMarkup(row.item || row.recipe)}`)
        continue
      }
      if (recipes.length !== items.length) {
        p.warn(
          `${where(block)}: ${recipes.length} recipes and ${items.length} items in one row, row skipped (${items[0] ?? recipes[0]})`,
        )
        continue
      }
      const { via, text } = sourceText(row.source)
      items.forEach((name, i) =>
        p.add({ kind, name, recipe: recipes[i], group: block.group, source: text, via: via && [...via] }),
      )
    }
  }
}

/** Quests table: every reward in the Reward cell comes from the linked quest. */
function parseQuests(block: Block, p: Parser) {
  for (const rows of parseTables(block.text)) {
    const table = readColumns(rows, QUEST_COLUMNS)
    if (!table) {
      p.warn(`${where(block)}: table without the columns Reward, Requirement and Quest skipped`)
      continue
    }
    for (const row of table) {
      const names = entries(row.reward)
      if (!names.length) {
        if (stripMarkup(row.reward)) p.warn(`${where(block)}: reward not recognised, row skipped: ${stripMarkup(row.reward)}`)
        continue
      }
      const questName = stripMarkup(row.quest)
      const quest = resolveQuest(links(row.quest)[0]?.target ?? questName, p)
      if (!quest && questName) p.unresolvedQuests.add(questName)
      const requirement = lineText(row.requirement)
      for (const name of names) {
        p.add({
          kind: 'quest',
          name,
          group: block.group,
          // Without a quest link the quest name is kept as plain text.
          source: quest ? undefined : questName || undefined,
          requirement,
          questId: quest?.id,
        })
      }
    }
  }
}

/** Dragonkin effigies: armour and weapon recipes inside a vault. */
function parseEffigies(block: Block, p: Parser) {
  for (const rows of parseTables(block.text)) {
    const table = readColumns(rows, EFFIGY_COLUMNS)
    if (!table) {
      p.warn(`${where(block)}: table without the columns Item and Vault skipped`)
      continue
    }
    for (const row of table) {
      const names = entries(row.item)
      if (!names.length) {
        if (stripMarkup(row.item)) p.warn(`${where(block)}: item not recognised, row skipped: ${stripMarkup(row.item)}`)
        continue
      }
      const ref = links(row.vault)[0]?.target ?? stripMarkup(row.vault)
      const vault = p.vaults.find((v) => sameName(v.id, ref) || sameName(v.name, ref))
      if (!vault) p.unresolvedVaults.add(ref || '(empty)')
      for (const name of names) {
        const recipe = vault?.recipes.find((r) => slug(r.name) === slug(name))
        p.add({
          kind: 'effigy',
          name,
          group: block.group,
          set: recipe?.set,
          // vaultId links a known vault; an unknown one keeps the wiki's vault name as plain text.
          source: vault ? undefined : ref || undefined,
          vaultId: vault?.id,
        })
      }
    }
  }
}

/** Recipe books: a list of {{plink}}s, a trailing '(...)' says where the book comes from. */
function parseRecipeBooks(block: Block, p: Parser) {
  for (const item of listItems(block.text)) {
    const plink = findTemplates(item.text, 'Plink')[0]
    const link = plink ? undefined : links(item.text)[0]
    const name = plink ? stripMarkup(plink.raw) : link ? upperFirst(link.label) : ''
    if (!name) {
      p.warn(`${where(block)}: line without {{plink}} skipped: ${stripMarkup(item.text)}`)
      continue
    }
    const paren = trailingParenthetical(plink ? item.text.slice(plink.end) : item.text)
    const quest = paren ? links(paren).map((l) => resolveQuest(l.target, p)).find((q) => q) : undefined
    p.add({
      kind: 'recipe-book',
      name,
      group: block.group,
      source: paren ? stripMarkup(paren) || undefined : undefined,
      questId: quest?.id,
    })
  }
}

/**
 * Names in a cell, in order: every {{plink}} (its txt= or first argument), or on a
 * line without plinks every [[link]]. One entry per plink, so a cell with several
 * plinks on separate lines (blank lines in between) gives several entries.
 */
export function entries(cell: string): string[] {
  const out: string[] = []
  for (const line of splitTopLevel(cell, '\n')) {
    const plinks = findTemplates(line, 'Plink')
    const names = plinks.length ? plinks.map((t) => stripMarkup(t.raw)) : links(line).map((l) => upperFirst(l.label))
    out.push(...names.filter(Boolean))
  }
  return out
}

/**
 * A Source cell as `via` and `text`. {{Drop sources list}} and {{Store locations list}} only
 * expand on the wiki, so they become via 'drops' and 'shops' (in order, once each); `text` is
 * the rest of the cell as plain text, only the wiki's own words ('Also found in chests in Dowdun Reach.').
 */
export function sourceText(cell: string): { via?: RewardVia[]; text?: string } {
  const via: RewardVia[] = []
  for (const t of findTemplates(cell)) {
    const kind = SOURCE_TEMPLATES[t.name]
    if (kind && !via.includes(kind)) via.push(kind)
  }
  const text = stripMarkup(cell)
  return { ...(via.length ? { via } : {}), ...(text ? { text } : {}) }
}

/** Plain text per line, joined with commas (a cell listing several plinks). */
function lineText(cell: string): string | undefined {
  const parts = splitTopLevel(cell, '\n')
    .map((line) => stripMarkup(line))
    .filter(Boolean)
  return parts.length ? parts.join(', ') : undefined
}

/** '(Awarded as part of the [[Black Knight's Fortress (quest)]])' at the end gives its inner wikitext. */
function trailingParenthetical(text: string): string | undefined {
  const m = /\(((?:[^()]|\([^()]*\))*)\)\s*$/.exec(text)
  return m ? m[1].trim() : undefined
}

/** A quest link target ('Black Knight's Fortress (quest)') to the quest it points at. */
function resolveQuest(ref: string, p: Parser): Quest | undefined {
  const key = nameKey(ref.replace(/\s*\(quest\)\s*$/i, ''))
  if (!key) return undefined
  return p.quests.find((q) => nameKey(q.id) === key || nameKey(q.name) === key)
}

/** Same kind and name twice: keep the first, fill its gaps from the later ones, warn once per kind. */
function dedupe(rewards: Reward[], warn: (message: string) => void): Reward[] {
  const byId = new Map<string, Reward>()
  const dupes = new Map<RewardKind, string[]>()
  for (const reward of rewards) {
    const first = byId.get(reward.id)
    if (!first) {
      byId.set(reward.id, reward)
      continue
    }
    const target = first as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(reward)) if (target[key] === undefined) target[key] = value
    dupes.set(reward.kind, [...(dupes.get(reward.kind) ?? []), reward.name])
  }
  for (const [kind, names] of dupes) warn(`Duplicate rewards (${kind}) merged: ${[...new Set(names)].join(', ')}`)
  return [...byId.values()]
}

// ---------------------------------------------------------------------------
// Map spots

/** Kinds that are picked up at a one-time spot on the map. Plans only with an explicit 'PLAN:' label. */
const PICKUP_KINDS: RewardKind[] = ['pattern', 'vestige', 'recipe-book']
/** 'Recipe: Meat Sandwich', 'PATTERN: Fell Cape', 'Vestige: Training Sword': the prefix names the kind. */
const KIND_PREFIX = /^(recipe|pattern|plan|vestige)\s*:\s*/i
const PREFIX_KIND: Record<string, RewardKind> = { recipe: 'recipe-book', pattern: 'pattern', plan: 'plan', vestige: 'vestige' }

/** Loose key: kind prefix and a leading article dropped ('A Threadbare Grain Sack' and 'Threadbare Grain Sack' match). */
function pickupKey(text: string): string {
  return slug(text.replace(KIND_PREFIX, '')).replace(/^(?:a|an|the)-/, '')
}

/**
 * Sets Reward.pointIds: the points of 'unique' map categories where a pattern, vestige or recipe
 * book is picked up. A point is matched on its category label and its name ('Recipe: Meat
 * Sandwich' to the recipe book, 'An Educational Blade' to the vestige with that recipe, 'Fell
 * Cape' to the pattern 'PATTERN: Fell Cape'), and on a 'Vestige: X' description ('Vestige:
 * Training Sword' to 'Wooden Training Sword' when only one vestige contains those words).
 * A point that fits several rewards is left unlinked, with a warning. Chests respawn and are
 * never linked. Names, not ids, drive the match, so merged twin points link the same way.
 */
export function linkPoints(rewards: Reward[], map: MapData, warn: (message: string) => void): void {
  const byKey = new Map<string, Reward[]>()
  const addKey = (key: string, reward: Reward) => {
    if (!key) return
    const list = byKey.get(key) ?? []
    if (!list.includes(reward)) list.push(reward)
    byKey.set(key, list)
  }
  const pickups = rewards.filter((r) => PICKUP_KINDS.includes(r.kind) || r.kind === 'plan')
  for (const reward of pickups) {
    addKey(pickupKey(reward.name), reward)
    if (reward.recipe) addKey(pickupKey(reward.recipe), reward)
  }
  const vestiges = rewards.filter((r) => r.kind === 'vestige')

  const matchText = (text: string, kinds: RewardKind[]): Reward[] => {
    const prefixed = KIND_PREFIX.exec(text)
    const allowed = prefixed ? [PREFIX_KIND[prefixed[1].toLowerCase()]] : kinds
    return (byKey.get(pickupKey(text)) ?? []).filter((r) => allowed.includes(r.kind))
  }

  const categories = new Map(map.categories.map((c) => [c.id, c]))
  const spots = new Map<Reward, MapPoint[]>()
  for (const point of map.points) {
    const category = categories.get(point.categoryId)
    if (category?.group !== 'unique') continue
    const found = new Set<Reward>()
    for (const text of [category.label, point.name]) {
      if (text) for (const r of matchText(text, PICKUP_KINDS)) found.add(r)
    }
    const vestige = /^vestige\s*:\s*(.+)$/i.exec(point.description ?? '')
    if (vestige) {
      const exact = matchText(vestige[1], ['vestige'])
      const key = pickupKey(vestige[1])
      const loose = vestiges.filter((r) => `-${pickupKey(r.name)}-`.includes(`-${key}-`))
      for (const r of exact.length ? exact : loose.length === 1 ? loose : []) found.add(r)
    }
    if (found.size > 1) {
      warn(`Map point ${point.id} matches more than one reward (${[...found].map((r) => r.id).join(', ')}), not linked`)
      continue
    }
    const [reward] = found
    if (reward) spots.set(reward, [...(spots.get(reward) ?? []), point])
  }
  for (const [reward, points] of spots) reward.pointIds = points.map((p) => p.id).sort()
}
