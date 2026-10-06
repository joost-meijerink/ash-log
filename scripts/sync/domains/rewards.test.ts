// Rewards parser against the stored 'Consumable Recipes' page.

import { describe, expect, it } from 'vitest'
import { mapPointId, rewardId } from '../../../src/lib/ids'
import type { MapCategory, MapData, MapGroup, MapPoint, Quest, Reward, RewardKind, SyncWarning, Vault } from '../../../src/lib/types'
import { fixturePage, fixturePages } from '../__fixtures__/load'
import { warnCollector, type SyncContext } from '../context'
import type { RawPage } from '../wiki'
import { entries, fetchRewardSources, parseRewards, REWARD_PAGE, sourceText, type RewardSources } from './rewards'
import { parseVaults } from './vaults'

const page = fixturePage('rewards/consumable-recipes.json')

const vaults: Vault[] = parseVaults(
  { page: fixturePage('vaults/dragonkin-vault.json'), navbox: fixturePage('vaults/navbox.json') },
  { categories: [], points: [] },
  () => {},
)

/** Minimal quests named after the stored quest pages (the two non-quests left out). */
const quests: Quest[] = fixturePages('quests/pages.json')
  .filter((p) => !['Consumable Recipes', 'Statues of Saradomin'].includes(p.title))
  .map((p) => ({
    id: p.title,
    name: p.title,
    kind: 'primary',
    location: '',
    steps: [],
    stepsSource: 'walkthrough',
    items: [],
    rewards: [],
    requires: [],
    wikiUrl: '',
  }))

function parse(content = page.content, refs: { quests: Quest[]; vaults: Vault[]; map?: MapData | null } = { quests, vaults }) {
  const warnings: SyncWarning[] = []
  const src: RewardSources = { page: { ...page, content } }
  const rewards = parseRewards(src, refs, warnCollector(warnings, 'rewards'))
  const find = (kind: RewardKind, name: string) => rewards.find((r) => r.kind === kind && r.name === name)
  return { rewards, warnings, find }
}

const fixture = parse()

describe('parseRewards on the fixture', () => {
  it('parses every section without warnings', () => {
    expect(fixture.warnings).toEqual([])
  })

  it('finds the expected number of rewards per kind', () => {
    const counts: Record<string, number> = {}
    for (const r of fixture.rewards) counts[r.kind] = (counts[r.kind] ?? 0) + 1
    // Plans: Lighting 8, General 9+1, Ancient Dragonkin 8, Garou 8+4+3, Food and Drink 6+1,
    // Fellhollow 6+1, Dowdun Reach 5 gods x (5 flags + 3 banners). Vestiges: 5 + 7 + 31 + 24.
    expect(counts).toEqual({
      plan: 95,
      pattern: 8,
      vestige: 67,
      quest: 26,
      effigy: 18,
      'recipe-book': 6,
      'fishing-trophy': 9,
    })
  })

  it('gives stable, unique ids and plain-text names', () => {
    const ids = fixture.rewards.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of fixture.rewards) {
      expect(r.id).toBe(rewardId(r.kind, r.name))
      for (const text of [r.name, r.recipe, r.source, r.requirement, r.group, r.set]) {
        if (text !== undefined) expect(text, r.id).not.toMatch(/\{\{|\}\}|\[\[|\]\]|'''/)
      }
    }
  })

  it('sorts by kind, then group, then name', () => {
    const order: RewardKind[] = ['plan', 'pattern', 'vestige', 'quest', 'effigy', 'recipe-book', 'fishing-trophy']
    const sorted = [...fixture.rewards].sort(
      (a, b) =>
        order.indexOf(a.kind) - order.indexOf(b.kind) ||
        (a.group ?? '').localeCompare(b.group ?? '', 'en') ||
        a.name.localeCompare(b.name, 'en'),
    )
    expect(fixture.rewards.map((r) => r.id)).toEqual(sorted.map((r) => r.id))
  })

  it('pairs plan recipes with items in order', () => {
    expect(fixture.find('plan', 'Blue Standing Torch')).toEqual({
      id: 'plan:blue-standing-torch',
      kind: 'plan',
      name: 'Blue Standing Torch',
      recipe: 'PLAN: Blue Standing Torch',
      group: 'Lighting',
      via: ['drops'],
    })
    expect(fixture.find('plan', 'Garou Wall Pelt')?.recipe).toBe('PLAN: Garou Hanging Pelt')
    expect(fixture.find('plan', 'Grave 01')).toMatchObject({ recipe: 'PLAN: Grave 1', group: 'Fellhollow' })
    expect(fixture.find('plan', 'Textile Kit')?.group).toBe('General')
    expect(fixture.find('plan', 'Bowl of Peaches')?.group).toBe('Food and Drink, Plants, and Shelves and Cabinets')
  })

  it('keeps source templates as via and only the wiki text as source', () => {
    expect(fixture.find('plan', 'Spectral Book')).toMatchObject({ via: ['drops'], source: 'Reward from the activity X Marks the Spot.' })
    expect(fixture.find('plan', 'Zamorak Banner 02')).toMatchObject({ via: ['drops'], source: 'Found in chests in Dowdun Reach.' })
    expect(fixture.find('plan', 'Headstone 01')?.source).toMatch(
      /^PLAN: headstone 01 and PLAN: grave 1 are available from 3 spectral platforming chests\./,
    )
    expect(fixture.find('vestige', 'Shadow Crossbow')).toMatchObject({
      via: ['shops', 'drops'],
      source: 'Also found in chests in Dowdun Reach.',
    })
    expect(fixture.find('vestige', 'White Full Helm')).toMatchObject({ via: ['shops'] })
    expect(fixture.find('vestige', 'White Full Helm')?.source).toBeUndefined()
    // No app-written English is left in any source.
    for (const r of fixture.rewards) expect(r.source ?? '', r.id).not.toMatch(/Dropped by monsters|Sold in shops|Dragonkin effigy in/)
    expect(fixture.rewards.filter((r) => r.via?.includes('drops'))).toHaveLength(112)
    expect(fixture.rewards.filter((r) => r.via?.includes('shops'))).toHaveLength(47)
    expect(fixture.find('vestige', 'Wooden Training Sword')).toMatchObject({
      recipe: 'An Educational Blade',
      group: 'Brynmoor',
      source: 'Located inside a chest on top of the Temple of Saradomin ledge',
    })
    expect(fixture.find('vestige', 'Wooden Training Sword')?.via).toBeUndefined()
    expect(fixture.find('vestige', 'Goblin "Swingslash"')).toMatchObject({ via: ['drops'] })
    expect(fixture.find('vestige', 'Goblin "Swingslash"')?.source).toBeUndefined()
  })

  it('reads patterns, including a plink with txt=', () => {
    expect(fixture.find('pattern', 'Umbral Sands Cape')).toMatchObject({
      recipe: 'Shred of Sunbleached Weave',
      source: 'Located near the top of a stone obelisk in the Dunes of Uzzer in Umbral Sands.',
    })
    expect(fixture.find('pattern', 'Umbral Sands Cape')?.group).toBeUndefined()
    expect(fixture.find('pattern', 'Dowdun Reach Cape')?.recipe).toBe('Torn Tapestry')
  })

  it('links quest rewards to their quest', () => {
    const garou = fixture.rewards.filter((r) => r.kind === 'quest' && r.questId === 'A Room With A Garou')
    expect(garou.map((r) => r.name).sort()).toEqual(['Hanging Tools', 'Pots on a Bench', 'Sawhorse'])
    expect(garou.every((r) => r.requirement === 'Ash Logs')).toBe(true)

    expect(fixture.find('quest', "Titan's Wrath")).toEqual({
      id: 'quest:titans-wrath',
      kind: 'quest',
      name: "Titan's Wrath",
      requirement: "Broken Titan's Wrath",
      questId: "Black Knight's Fortress",
    })
    expect(fixture.find('quest', 'Mount')).toMatchObject({ questId: 'The Wild Hunt', requirement: 'Primordial Heart' })
    expect(fixture.find('quest', "Ava's Accumulator")?.requirement).toBe('Undead Chicken, Bundle of Undead Twigs, Magnet')
    expect(fixture.find('quest', 'Ghostspeak Amulet')?.requirement).toBe('Required for Even More Restless Ghosts')
    expect(fixture.rewards.filter((r) => r.kind === 'quest').every((r) => r.questId)).toBe(true)
  })

  it('links effigies to their vault and armour set', () => {
    expect(fixture.find('effigy', "Paladin's Helm")).toEqual({
      id: 'effigy:paladins-helm',
      kind: 'effigy',
      name: "Paladin's Helm",
      group: 'Ghornfell',
      set: 'Paladin armour set',
      vaultId: 'Takla Kara',
    })
    expect(fixture.find('effigy', 'Dragonkin Mage Robe Legs')).toMatchObject({
      vaultId: 'Chaktan Kara',
      set: 'Dragonkin mage armour set',
    })
    expect(fixture.find('effigy', "Wild Scout's Shortbow")).toMatchObject({ vaultId: 'Takla Kara' })
    expect(fixture.find('effigy', "Wild Scout's Shortbow")?.set).toBeUndefined()
    expect(fixture.find('effigy', 'Wolfbane Dagger')).toMatchObject({ vaultId: 'Vekchenven Kara', group: 'Fellhollow' })
  })

  it('reads recipe books with a trailing note as source', () => {
    const books = fixture.rewards.filter((r) => r.kind === 'recipe-book')
    expect(books.map((r) => r.name)).toContain("Forager's Sandwich")
    expect(fixture.find('recipe-book', 'Maple Toastie')).toMatchObject({
      source: "Awarded as part of the Black Knight's Fortress (quest)",
      questId: "Black Knight's Fortress",
    })
    expect(fixture.find('recipe-book', 'Meat Sandwich')?.source).toBeUndefined()
  })

  it('pairs fish with trophies', () => {
    expect(fixture.find('fishing-trophy', 'Pristine Trout Trophy')).toEqual({
      id: 'fishing-trophy:pristine-trout-trophy',
      kind: 'fishing-trophy',
      name: 'Pristine Trout Trophy',
      recipe: 'Pristine Trout',
      source: 'Rod fishing spots in Brynmoor.',
    })
    expect(fixture.find('fishing-trophy', 'Pristine Lobster Trophy')?.source).toBe('Net fishing spots in Fellhollow.')
    expect(fixture.find('fishing-trophy', 'Pristine Armoured Catfish Trophy')?.recipe).toBe('Pristine Armoured Catfish')
  })
})

describe('parseRewards on changed pages', () => {
  const table = (rows: string) => `{| class="wikitable"\n!Recipe\n!Item\n!Source\n|-\n${rows}\n|}`

  it('skips a row whose recipe and item counts differ, with one warning', () => {
    const content = `==Plans==\n===Lighting===\n${table(
      '|{{plink|PLAN: A}}\n{{plink|PLAN: B}}\n|{{plink|A}}\n|x\n|-\n|{{plink|PLAN: C}}\n|{{plink|C}}\n|y',
    )}`
    const { rewards, warnings } = parse(content)
    expect(rewards.map((r) => r.name)).toEqual(['C'])
    const mismatch = warnings.filter((w) => /2 recipes and 1 items/.test(w.message))
    expect(mismatch).toHaveLength(1)
    expect(mismatch[0]).toMatchObject({ source: 'rewards', page: REWARD_PAGE })
  })

  it('warns once for an unknown section and skips it', () => {
    const content = `==Plans==\n${table('|{{plink|PLAN: A}}\n|{{plink|A}}\n|x')}\n==Mystery Loot==\n${table(
      '|{{plink|PLAN: Z}}\n|{{plink|Z}}\n|x\n|-\n|{{plink|PLAN: Y}}\n|{{plink|Y}}\n|x',
    )}\n==References==\n<references/>`
    const { rewards, warnings } = parse(content)
    expect(rewards.map((r) => r.name)).toEqual(['A'])
    expect(warnings.filter((w) => w.message.includes('Mystery Loot'))).toHaveLength(1)
    expect(warnings.some((w) => w.message.includes('References'))).toBe(false)
  })

  it('warns about missing sections and unrecognised tables', () => {
    const content = `==Plans==\n{| class="wikitable"\n!Name\n!Where\n|-\n|a\n|b\n|}`
    const { rewards, warnings } = parse(content)
    expect(rewards).toEqual([])
    expect(warnings.some((w) => /table without recognisable columns/.test(w.message))).toBe(true)
    expect(warnings.some((w) => /Plans' gave no rewards/.test(w.message))).toBe(true)
    // Six other kinds are missing: one warning each.
    expect(warnings.filter((w) => /not found, these rewards are missing/.test(w.message))).toHaveLength(6)
  })

  it('warns about a group that gives no rewards, but not about a section intro', () => {
    const content = `==Plans==\n===Lighting===\n${table('|{{plink|PLAN: Lamp}}\n|{{plink|Lamp}}\n|x')}\n===Garou===\n* {{plink|PLAN: Pelt}}\n* {{plink|Pelt}}\n==Dragonkin Effigies==\nEffigies also teach armour.\n===Fellhollow===\n{|\n!Item\n!Vault\n|-\n|{{plink|X}}\n|[[Takla Kara]]\n|}`
    const { rewards, warnings } = parse(content)
    expect(rewards.map((r) => r.id)).toEqual(['plan:lamp', 'effigy:x'])
    expect(warnings.filter((w) => /no rewards recognised/.test(w.message)).map((w) => w.message)).toEqual([
      'Plans > Garou: no rewards recognised, group skipped',
    ])
  })

  it('merges duplicates within a kind with one warning', () => {
    const content = `==Plans==\n===One===\n${table('|{{plink|PLAN: A}}\n|{{plink|A}}\n|')}\n===Two===\n${table(
      '|{{plink|PLAN: A}}\n|{{plink|A}}\n|Found in [[chest]]s\n|-\n|{{plink|PLAN: A2}}\n|{{plink|a}}\n|z',
    )}`
    const { rewards, warnings } = parse(content)
    expect(rewards).toEqual([
      { id: 'plan:a', kind: 'plan', name: 'A', recipe: 'PLAN: A', group: 'One', source: 'Found in chests' },
    ])
    expect(warnings.filter((w) => /Duplicate rewards \(plan\)/.test(w.message))).toHaveLength(1)
  })

  it('keeps effigies of an unknown vault, with one warning for all of them', () => {
    const content = `==Dragonkin Effigies==\n{|\n!Item\n!Vault\n|-\n|{{plink|X}}\n{{plink|Y}}\n|[[Nowhere Kara]]\n|}`
    const { rewards, warnings } = parse(content, { quests, vaults })
    expect(rewards.map((r) => [r.name, r.vaultId, r.source])).toEqual([
      ['X', undefined, 'Nowhere Kara'],
      ['Y', undefined, 'Nowhere Kara'],
    ])
    expect(warnings.filter((w) => w.message.includes('Nowhere Kara'))).toHaveLength(1)
  })

  it('keeps quest rewards of an unknown quest as plain text, with one warning', () => {
    const content = `==Quests==\n{|\n!Reward\n!Requirement\n!Quest\n|-\n|{{plink|X}}\n|\n|[[Future Quest]]\n|-\n|{{plink|Y}}\n|\n|[[Future Quest]]\n|}`
    const { rewards, warnings } = parse(content, { quests: [], vaults: [] })
    expect(rewards.map((r: Reward) => [r.name, r.questId, r.source])).toEqual([
      ['X', undefined, 'Future Quest'],
      ['Y', undefined, 'Future Quest'],
    ])
    expect(warnings.filter((w) => w.message.includes('Future Quest'))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Map spots (Reward.pointIds)

/** Unique-group categories and points as the map domain names them (see data/wiki/map.json), plus chests. */
function spotMap(extra: { category: string; label: string; group?: MapGroup; x: number; y: number; point?: Partial<MapPoint> }[] = []): MapData {
  const spots = [
    { category: 'an-educational-blade', label: 'An Educational Blade', x: 5179, y: 190727, point: { description: 'Vestige: Training Sword' } },
    { category: 'a-corroded-serrated-blade', label: 'A Corroded Serrated Blade', x: 78372, y: 114684, point: { description: 'Vestige: Chieftan Blade' } },
    { category: 'suspiciously-light-tattered-boots', label: 'Suspiciously Light Tattered Boots', x: 16257, y: 172060, point: { description: 'Vestige: Leggings Lightness' } },
    { category: 'torn-tapestry', label: 'Torn Tapestry', x: 241275, y: 44716 },
    { category: 'bramblemead-cape', label: 'Bramblemead Cape', x: 21416, y: 147505 },
    { category: 'fell-cape', label: 'Fell Cape', x: 132216, y: -50829, point: { name: 'Treasure Chest', description: 'Chest that contains the vestige Fell Cape.' } },
    { category: 'recipe-books', label: 'Recipe Books', x: 201455, y: 34717, point: { name: 'Recipe: Meat Sandwich' } },
    { category: 'recipe-books', label: 'Recipe Books', x: 214569, y: 50748, point: { name: 'Recipe: Steak Sandwich' } },
    { category: 'recipe-meat-sandwich', label: 'Recipe: Meat Sandwich', x: 201455, y: 34717 },
    { category: 'saradomin-symbol', label: 'Saradomin Symbol', x: 70215, y: -54256 },
    { category: 'threadbare-grain-sack', label: 'Threadbare Grain Sack', x: 42722, y: 172338 },
    // Chests respawn: never linked, whatever the description says.
    { category: 'treasure-chest', label: 'Treasure Chest', group: 'chest' as MapGroup, x: 5179, y: 190727, point: { description: 'Vestige: Training Sword' } },
    { category: 'treasure-chest', label: 'Treasure Chest', group: 'chest' as MapGroup, x: 21416, y: 147505, point: { description: 'Bramblemead Cape' } },
    ...extra,
  ]
  const categories = new Map<string, MapCategory>()
  const points: MapPoint[] = []
  for (const s of spots) {
    if (!categories.has(s.category)) categories.set(s.category, { id: s.category, label: s.label, group: s.group ?? 'unique', sources: [], count: 0 })
    categories.get(s.category)!.count++
    points.push({ id: mapPointId(s.category, s.x, s.y), categoryId: s.category, x: s.x, y: s.y, ...s.point })
  }
  return { categories: [...categories.values()], points }
}

function linked(rewards: Reward[]): Record<string, string[]> {
  return Object.fromEntries(rewards.filter((r) => r.pointIds).map((r) => [r.id, r.pointIds!]))
}

describe('parseRewards: map spots', () => {
  it('links patterns, vestiges and recipe books to their unique spot by name', () => {
    const { rewards, warnings } = parse(page.content, { quests, vaults, map: spotMap() })
    expect(warnings).toEqual([])
    expect(linked(rewards)).toEqual({
      'pattern:bramblemead-cape': ['bramblemead-cape:21416:147505'],
      'pattern:dowdun-reach-cape': ['torn-tapestry:241275:44716'],
      // 'PATTERN: Fell Cape' teaches the Fellhollow Cape.
      'pattern:fellhollow-cape': ['fell-cape:132216:-50829'],
      // Category label = recipe; the typo in 'Vestige: Chieftan Blade' does not matter.
      'vestige:chieftains-blade': ['a-corroded-serrated-blade:78372:114684'],
      'vestige:leggings-of-lightness': ['suspiciously-light-tattered-boots:16257:172060'],
      'vestige:wooden-training-sword': ['an-educational-blade:5179:190727'],
      // 'Threadbare Grain Sack' and the recipe 'A Threadbare Grain Sack'.
      'vestige:bag-of-noggin': ['threadbare-grain-sack:42722:172338'],
      // Twin points of one book, before the map merges them.
      'recipe-book:meat-sandwich': ['recipe-books:201455:34717', 'recipe-meat-sandwich:201455:34717'],
      'recipe-book:steak-sandwich': ['recipe-books:214569:50748'],
    })
    const all = Object.values(linked(rewards)).flat()
    expect(all.some((id) => id.startsWith('treasure-chest:') || id.startsWith('saradomin-symbol:'))).toBe(false)
  })

  it('links the kept point after the map merged twins, whichever twin was kept', () => {
    const merged = (drop: string, keep: string): MapData => {
      const map = spotMap()
      return {
        categories: map.categories,
        points: map.points.filter((p) => p.id !== drop).map((p) => (p.id === keep ? { ...p, aliases: [drop] } : p)),
      }
    }
    const a = parse(page.content, { quests, vaults, map: merged('recipe-meat-sandwich:201455:34717', 'recipe-books:201455:34717') })
    expect(linked(a.rewards)['recipe-book:meat-sandwich']).toEqual(['recipe-books:201455:34717'])
    const b = parse(page.content, { quests, vaults, map: merged('recipe-books:201455:34717', 'recipe-meat-sandwich:201455:34717') })
    expect(linked(b.rewards)['recipe-book:meat-sandwich']).toEqual(['recipe-meat-sandwich:201455:34717'])
  })

  it('matches a Vestige: description loosely only when one vestige fits', () => {
    const map = spotMap([
      { category: 'odd-spot', label: 'Odd Spot', x: 1, y: 1, point: { description: 'Vestige: Adventurers Longbow' } },
      { category: 'dyad-spot', label: 'Dyad Spot', x: 2, y: 2, point: { description: 'Vestige: Dyad Cape' } },
    ])
    const { rewards } = parse(page.content, { quests, vaults, map })
    expect(linked(rewards)['vestige:adventurers-longbow']).toEqual(['odd-spot:1:1'])
    // Five dyad capes contain 'dyad-cape': no guess.
    expect(Object.values(linked(rewards)).flat()).not.toContain('dyad-spot:2:2')
  })

  it('leaves a point that fits two rewards unlinked, with a warning', () => {
    const map = spotMap([{ category: 'bramblemead-cape', label: 'Bramblemead Cape', x: 3, y: 3, point: { description: 'Vestige: Training Sword' } }])
    const { rewards, warnings } = parse(page.content, { quests, vaults, map })
    expect(linked(rewards)['pattern:bramblemead-cape']).toEqual(['bramblemead-cape:21416:147505'])
    expect(warnings.map((w) => w.message)).toEqual([
      'Map point bramblemead-cape:3:3 matches more than one reward (pattern:bramblemead-cape, vestige:wooden-training-sword), not linked',
    ])
  })

  it('gives no pointIds without a map', () => {
    expect(fixture.rewards.some((r) => r.pointIds)).toBe(false)
    expect(parse(page.content, { quests, vaults, map: null }).rewards.some((r) => r.pointIds)).toBe(false)
  })
})

describe('cell helpers', () => {
  it('entries reads plinks per line and plain links on lines without plinks', () => {
    expect(entries('{{plink|A}}\n{{plink|B|txt=Bee}}\n\n{{plink|C}} {{plink|D}}\n[[mount]]')).toEqual([
      'A',
      'Bee',
      'C',
      'D',
      'Mount',
    ])
  })

  it('sourceText turns list templates into via, in order and once, and keeps the rest as text', () => {
    expect(sourceText('{{Drop sources list|A}}\n{{Drop sources list|B}}')).toEqual({ via: ['drops'] })
    expect(sourceText('{{Store locations list|A}}')).toEqual({ via: ['shops'] })
    expect(sourceText('{{Store locations list|A}} {{Drop sources list|B}}\nAlso in [[chest]]s.')).toEqual({
      via: ['shops', 'drops'],
      text: 'Also in chests.',
    })
    expect(sourceText('[[Rod fishing spot]]s in [[Brynmoor]].')).toEqual({ text: 'Rod fishing spots in Brynmoor.' })
    expect(sourceText('')).toEqual({})
  })
})

describe('fetchRewardSources', () => {
  const ctxWith = (available: RawPage[]) =>
    ({
      async pages(titles: string[]) {
        const pages = new Map(available.filter((p) => titles.includes(p.title)).map((p) => [p.title, p]))
        return { pages, missing: titles.filter((t) => !pages.has(t)) }
      },
    }) as unknown as SyncContext

  it('returns the Consumable Recipes page', async () => {
    const sources = await fetchRewardSources(ctxWith([page]))
    expect(sources.page.title).toBe(REWARD_PAGE)
  })

  it('throws when the page is missing', async () => {
    await expect(fetchRewardSources(ctxWith([]))).rejects.toThrow(REWARD_PAGE)
  })
})
