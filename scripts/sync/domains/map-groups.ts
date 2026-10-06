// Map domain: which MapGroup a map category belongs to.
//
// Priority order (the first step that gives an answer wins):
//  1. Name exceptions where the wiki categories mislead (traps, fast travel stones).
//  2. Strong wiki categories of the base page: Quests (the quest's own map), Monsters/Bosses,
//     Non-player characters, Quest Items, Lore Scraps/Journal, Dragonkin Vaults, Vestiges/Patterns/Capes,
//     categories named after a quest, resource categories, Basic Items.
//  3. Member vote (no categories only): a collection page ('Bramblemead Locations', 'The Secret Scrolls')
//     takes the majority group of the categories its point names refer to.
//  4. The label is a quest name (no categories only): 'Mirror Mirror' for the quest 'Mirror, Mirror'.
//  5. Name rules (mostly pages without a wiki page: 'Recipe: X', 'Air Anima Vent', 'Scorched Tome').
//  6. Head noun family (no categories only): 'Magical Raven' follows 'Corrupted Raven',
//     'Garou Lightning Berserker' follows 'Garou Berserker'.
//  7. Weak categories: Activities, Agility, Scenery, Base building, region categories -> location.
//  8. Anything left: 'other' (the caller reports these in one warning).

import { slug } from '../../../src/lib/ids'
import type { MapGroup } from '../../../src/lib/types'
import { REGIONS, SUB_AREAS } from './map-text'

export interface GroupInput {
  /** Category id (slug of the base name). */
  id: string
  label: string
  /** Non-hidden wiki categories of the existing base pages, without the 'Category:' prefix. */
  categories: string[]
  pointCount: number
  /** One entry per named point (its link target, else its name), used for the member vote. */
  names: string[]
}

export interface GroupResult {
  group: MapGroup
  /** Which rule decided, for tests and debugging. */
  rule: 'exception' | 'category' | 'members' | 'quest-name' | 'name' | 'family' | 'weak-category' | 'none'
}

/** Checked before the wiki categories: 'Exploding Plant Trap' is in Category:Dragonkin Vaults, nodestones in a quest category. */
const NAME_EXCEPTIONS: [MapGroup, RegExp][] = [
  ['monster', /\btraps?\b/i],
  ['location', /\b(nodestone|lodestone)s?\b/i],
]

const QUEST_PAGE = /^Quests$/
const STRONG_BEFORE_QUEST: [MapGroup, RegExp][] = [
  ['monster', /^(Monsters|Bosses)$/],
  ['npc', /^Non-player characters$/],
  ['quest', /^Quest Items$/],
  ['lore', /^(Lore Scraps|Journal)$/],
  ['vault', /^Dragonkin Vaults$/],
  ['unique', /^(Vestiges|Patterns|Capes|Recipe Books)$/],
]
const RESOURCE = /^(Resource nodes|Mining nodes|Mining|Woodcutting|Trees|Resources|Salvage Hotspots|Raw Ingredients|Basic Materials|Potions|Fishing)$/
/** Herbs and plants are Basic Items, but so are single pickups like the Saradomin Symbol. */
const BASIC_ITEMS = /^Basic Items$/

const WEAK_LOCATION = /^(Activities|Agility|Agility Course|Scenery|Base building|Builds|Ashenfall)$/
const REGION_CATEGORIES = new Set<string>([...REGIONS, ...Object.keys(SUB_AREAS)])

/** Categories that never name a quest (maintenance, item types, creature families). */
const NOT_A_QUEST =
  /^(Items|Basic Items|Stubs|Quests|Quest Items|Quest Transcripts|Armour|Artisan|Construction|Interface|Deceased|Discontinued content|Empty drop sources lists|Unarchived Reddit references|Characters that do not appear in-game|Goblins|Kalphites|KotHaar|Zombies|Dragons|Demons|Containers)$|^(Needs|Pages|Weak to) /

const NAME_RULES: [MapGroup, RegExp][] = [
  ['unique', /^Recipe:|^Recipe Books?$/i],
  ['chest', /\b(Treasure Chest|Buried Treasure|Spectral Chest)s?\b|^Chests?$/i],
  ['resource', /\b(Anima Vent|Fishing Spot|Kebbit Burrow|Salvage)s?\b/i],
  ['vault', /^Vaults?$/i],
  ['lore', /^Lore Scraps$/i],
  ['lore', /\b(Journal|Diary|Tomes?|Notes?|Page|Book|Scrolls?|Ledger|Log|Memoirs|Parchment|Storybook|Writings|Primer)\b/i],
  ['location', /\b(Crucible|Gateway|Door|Gate|Entrance|Locations)\b/i],
]

function strongGroup(input: GroupInput, questCats: Set<string>): MapGroup | undefined {
  const cats = input.categories
  if (cats.some((c) => QUEST_PAGE.test(c))) return 'quest'
  for (const [group, re] of STRONG_BEFORE_QUEST) if (cats.some((c) => re.test(c))) return group
  if (cats.some((c) => questCats.has(c))) return 'quest'
  if (cats.some((c) => RESOURCE.test(c))) return 'resource'
  if (cats.some((c) => BASIC_ITEMS.test(c))) return input.pointCount === 1 ? 'unique' : 'resource'
  return undefined
}

function weakGroup(input: GroupInput): MapGroup | undefined {
  return input.categories.some((c) => WEAK_LOCATION.test(c) || REGION_CATEGORIES.has(c)) ? 'location' : undefined
}

/**
 * Categories named after a quest: the categories of quest pages ('Dragon Slayer' is in Category:Dragon Slayer),
 * the names of quest pages, and categories that sit next to 'Quest Items' ('Mirror, Mirror', 'The Great Body Robbery').
 */
export function questCategories(inputs: GroupInput[]): Set<string> {
  const out = new Set<string>()
  const candidate = (c: string) =>
    !NOT_A_QUEST.test(c) &&
    !REGION_CATEGORIES.has(c) &&
    !WEAK_LOCATION.test(c) &&
    !RESOURCE.test(c) &&
    !STRONG_BEFORE_QUEST.some(([, re]) => re.test(c))
  for (const input of inputs) {
    const isQuest = input.categories.some((c) => QUEST_PAGE.test(c))
    if (isQuest) {
      out.add(input.label)
      for (const c of input.categories) if (candidate(c)) out.add(c)
    }
    if (input.categories.includes('Quest Items')) for (const c of input.categories) if (candidate(c)) out.add(c)
  }
  return out
}

function majority(groups: MapGroup[]): MapGroup | undefined {
  const counts = new Map<MapGroup, number>()
  for (const g of groups) counts.set(g, (counts.get(g) ?? 0) + 1)
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  if (!sorted.length) return undefined
  // A tie between the top two groups gives no answer.
  if (sorted[1] && sorted[1][1] === sorted[0]![1]) return undefined
  return sorted[0]![0]
}

/** Last word of a label, without a trailing '(...)' qualifier. */
function headNoun(label: string): string {
  const words = label.replace(/\s*\([^()]*\)\s*$/, '').toLowerCase().match(/[a-z0-9]+/g) ?? []
  return words[words.length - 1] ?? ''
}

/** Group per category id. */
export function classifyGroups(inputs: GroupInput[]): Map<string, GroupResult> {
  const questCats = questCategories(inputs)
  const questSlugs = new Set([...questCats].map(slug))

  // Groups straight from the wiki categories, used by the member vote and the family rule.
  const fromCategories = new Map<string, { strong?: MapGroup; weak?: MapGroup }>()
  for (const input of inputs) fromCategories.set(input.id, { strong: strongGroup(input, questCats), weak: weakGroup(input) })

  const families = new Map<string, MapGroup[]>()
  for (const input of inputs) {
    const strong = fromCategories.get(input.id)!.strong
    if (!strong) continue
    const noun = headNoun(input.label)
    if (noun) families.set(noun, [...(families.get(noun) ?? []), strong])
  }

  const out = new Map<string, GroupResult>()
  for (const input of inputs) {
    const exception = NAME_EXCEPTIONS.find(([, re]) => re.test(input.label))
    if (exception) {
      out.set(input.id, { group: exception[0], rule: 'exception' })
      continue
    }
    const { strong, weak } = fromCategories.get(input.id)!
    if (strong) {
      out.set(input.id, { group: strong, rule: 'category' })
      continue
    }

    // The fallback rules below only apply without any wiki category to go on.
    const pageless = input.categories.length === 0

    const votes: MapGroup[] = []
    for (const name of pageless ? input.names : []) {
      const id = slug(name)
      if (!id || id === input.id) continue
      const other = fromCategories.get(id)
      const group = other?.strong ?? other?.weak
      if (group) votes.push(group)
    }
    const voted = votes.length * 2 >= input.pointCount && votes.length > 0 ? majority(votes) : undefined
    if (voted) {
      out.set(input.id, { group: voted, rule: 'members' })
      continue
    }

    if (pageless && questSlugs.has(input.id)) {
      out.set(input.id, { group: 'quest', rule: 'quest-name' })
      continue
    }

    const byName = NAME_RULES.find(([, re]) => re.test(input.label))
    if (byName) {
      out.set(input.id, { group: byName[0], rule: 'name' })
      continue
    }

    // Self never counts: a category only gets here without a strong group.
    const family = pageless ? majority(families.get(headNoun(input.label)) ?? []) : undefined
    if (family) {
      out.set(input.id, { group: family, rule: 'family' })
      continue
    }

    if (weak) {
      out.set(input.id, { group: weak, rule: 'weak-category' })
      continue
    }
    out.set(input.id, { group: 'other', rule: 'none' })
  }
  return out
}
