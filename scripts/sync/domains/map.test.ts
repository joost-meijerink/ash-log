// Map domain against the stored Module:Map responses. Never hits the network.

import { describe, expect, it } from 'vitest'
import type { MapGroup } from '../../../src/lib/types'
import { fixtureJson, fixturePage, fixturePages, MAP_CATEGORY_FILES, MAP_CONTENT_FILES } from '../__fixtures__/load'
import type { SyncContext } from '../context'
import { BATCH_SIZE, type RawPage } from '../wiki'
import { normalizeTitle } from '../wikitext'
import { classifyGroups } from './map-groups'
import { isCoordinateText, parseDescription, parseTierCode, REGIONS, regionOf, regionsMentioned } from './map-text'
import {
  applyPageTitles,
  collectPageCategories,
  collectPageImages,
  familyOf,
  fetchMapSources,
  firstDropName,
  isNodeLabel,
  junkReason,
  mapBaseName,
  pageTitleCandidates,
  parseMap,
  regionGuessAccuracy,
  titleKey,
  TWIN_DISTANCE,
  TWIN_GROUPS,
  type MapSources,
} from './map'
import { parseQuests } from './quests'
import { parseVaults } from './vaults'

const pages = fixturePages(...MAP_CONTENT_FILES)
const categoryResponses = MAP_CATEGORY_FILES.map((f) => fixtureJson(f))
const bases = [...new Set(pages.map((p) => mapBaseName(p.title)))]
const sources: MapSources = { pages, ...collectPageCategories(bases, categoryResponses) }

function run(src: MapSources = sources) {
  const warnings: { message: string; page?: string }[] = []
  const result = parseMap(src, (message, page) => warnings.push({ message, ...(page ? { page } : {}) }))
  return { ...result, warnings }
}

/** A Module:Map page with hand-made content. */
const page = (base: string, content: unknown): RawPage => ({
  title: `Module:Map/${base}.json`,
  revid: 1,
  content: typeof content === 'string' ? content : JSON.stringify(content),
})

/** The pageimages part of every page query: image name plus a thumbnail at most 64 px wide. */
const PAGE_IMAGE_QUERY = { piprop: 'name|thumbnail', pithumbsize: 64, pilimit: 'max' }

const full = run()
const { categories, points } = full.map
const category = (id: string) => categories.find((c) => c.id === id)!
const pointsOf = (id: string) => points.filter((p) => p.categoryId === id)

describe('collectPageCategories', () => {
  it('maps normalized and redirected titles back to the requested base name', () => {
    const { pageCategories, missingPages } = sources
    expect(pageCategories['Gold Ore Node']).toContain('Category:Mining nodes')
    // 'chests' -> 'Chests' -> redirect 'Chest'
    expect(pageCategories['chests']).toEqual(['Category:Activities', 'Category:Ashenfall', 'Category:Pages with unsourced statements'])
    // 'Vaults' redirects to 'Dragonkin Vault'
    expect(pageCategories['Vaults']).toEqual(['Category:Dragonkin Vaults'])
    expect(pageCategories['zogre']).toEqual(pageCategories['Zogre'])
    expect(missingPages).toContain('Kebbit Burrow (Brynmoor)')
    expect(missingPages).toContain('Recipe: Meat Sandwich')
    expect(missingPages).not.toContain('Gold Ore Node')
  })

  it('merges categories of one page spread over continued responses', () => {
    const first = { query: { pages: [{ title: 'A', categories: [{ title: 'Category:X' }] }] }, continue: { clcontinue: '1|Y' } }
    const second = { query: { pages: [{ title: 'A', categories: [{ title: 'Category:Y' }] }, { title: 'B', missing: true }] } }
    expect(collectPageCategories(['A', 'B'], [first, second])).toEqual({ pageCategories: { A: ['Category:X', 'Category:Y'] }, missingPages: ['B'] })
  })
})

describe('fetchMapSources', () => {
  it('lists Module:Map pages, reads them through the cache and fetches categories per 50 with continue', async () => {
    const allpages = fixtureJson('map/allpages.json')
    // Global view of the stored category responses, to answer any batch the code asks for.
    const alias = new Map<string, { from: string; to: string; kind: 'normalized' | 'redirects' }>()
    const pageByTitle = new Map<string, any>()
    for (const data of categoryResponses) {
      for (const n of data.query.normalized ?? []) alias.set(n.from, { from: n.from, to: n.to, kind: 'normalized' })
      for (const r of data.query.redirects ?? []) alias.set(r.from, { from: r.from, to: r.to, kind: 'redirects' })
      for (const p of data.query.pages) pageByTitle.set(p.title, p)
    }
    const calls: Record<string, any>[] = []
    let queryAllParams: Record<string, any> | undefined
    const ctx = {
      log: () => {},
      full: false,
      revisions: new Map(),
      pages: async (titles: string[]) => {
        const map = new Map<string, RawPage>()
        for (const p of pages) if (titles.includes(p.title)) map.set(p.title, p)
        return { pages: map, missing: titles.filter((t) => !map.has(t)) }
      },
      wiki: {
        queryAll: async (params: Record<string, any>, pick: (d: any) => any[]) => {
          queryAllParams = params
          return pick(allpages)
        },
        api: async (params: Record<string, any>) => {
          calls.push(params)
          const titles = String(params.titles).split('|')
          const normalized: any[] = []
          const redirects: any[] = []
          const out = new Map<string, any>()
          for (const t of titles) {
            let cur = t
            for (let hop = 0; hop < 5 && alias.has(cur); hop++) {
              const a = alias.get(cur)!
              ;(a.kind === 'normalized' ? normalized : redirects).push({ from: a.from, to: a.to })
              cur = a.to
            }
            out.set(cur, pageByTitle.get(cur) ?? { title: cur, missing: true })
          }
          const list = [...out.values()]
          // The first batch answers in two parts: categories of the second half come after 'continue'.
          const split = calls.length === 1 || params.clcontinue
          const half = Math.floor(list.length / 2)
          const part = (p: any, i: number) => {
            if (!split || p.missing) return p
            const withCats = params.clcontinue ? i >= half : i < half
            return withCats ? p : { ...p, categories: undefined }
          }
          return {
            query: { normalized, redirects, pages: list.map(part) },
            ...(calls.length === 1 ? { continue: { clcontinue: 'next', continue: '||' } } : {}),
          }
        },
      },
    } as unknown as SyncContext

    const src = await fetchMapSources(ctx)
    expect(queryAllParams).toMatchObject({ list: 'allpages', apnamespace: 828, apprefix: 'Map/' })
    expect(src.pages.length).toBe(439)
    expect(src.pages.every((p) => p.title.endsWith('.json'))).toBe(true)
    expect(calls.length).toBeGreaterThan(1)
    for (const c of calls) {
      expect(c).toMatchObject({ action: 'query', prop: 'categories|pageimages', clshow: '!hidden', redirects: 1, ...PAGE_IMAGE_QUERY })
      expect(String(c.titles).split('|').length).toBeLessThanOrEqual(BATCH_SIZE)
    }
    expect(calls[1]).toMatchObject({ clcontinue: 'next', titles: calls[0]!.titles })
    // One more round for bases without a page of their own name.
    const extra = calls.flatMap((c) => String(c.titles).split('|')).filter((t) => !bases.includes(t))
    expect(extra).toContain('A Threadbare Grain Sack')
    expect(extra).toContain('Aetheric Fundamentals, a Primordial Primer')
    expect(extra).not.toContain('A Buried Treasure (Brynmoor)')
    // The stored responses do not know those titles: same result as reading them directly.
    expect(src.pageCategories).toEqual(sources.pageCategories)
    expect([...src.missingPages].sort()).toEqual([...sources.missingPages].sort())
    expect(src.pageTitles).toEqual({})
    // The stored responses predate the page images, and the node pages are not in them.
    expect(src.pageImages).toEqual({})
    expect(src.dropImages).toEqual({})
  })
})

describe('pages under another title', () => {
  it('tries link targets with the same slug first, then the base with an article', () => {
    const list = [
      page('Ancient Tomes', [
        { x: 1, y: 1, name: '[[Aetheric Fundamentals, a Primordial Primer]]' },
        { x: 2, y: 2, description: 'Ask [[Razlem, the Deranged|Razlem]]' },
        { x: 3, y: 3, name: '[[A Threadbare Grain Sack]]' },
      ]),
      page('User:Someone/sandbox', [{ x: 4, y: 4, name: '[[Educational Blade, Old]]' }]),
    ]
    const missing = [
      'Aetheric Fundamentals a Primordial Primer',
      'Threadbare Grain Sack',
      'Educational Blade',
      'Razlem the Deranged',
      'Buried Treasure (Brynmoor)',
      'Recipe: Meat Sandwich',
      'The Secret Scrolls',
      'test',
    ]
    expect(pageTitleCandidates(missing, list)).toEqual({
      'Aetheric Fundamentals a Primordial Primer': [
        'Aetheric Fundamentals, a Primordial Primer',
        'An Aetheric Fundamentals a Primordial Primer',
        'The Aetheric Fundamentals a Primordial Primer',
      ],
      'Threadbare Grain Sack': ['A Threadbare Grain Sack', 'The Threadbare Grain Sack'],
      'Educational Blade': ['An Educational Blade', 'The Educational Blade'],
      'Razlem the Deranged': ['Razlem, the Deranged', 'A Razlem the Deranged', 'The Razlem the Deranged'],
    })
  })

  it('finds the real link targets in the stored Module:Map pages', () => {
    const found = pageTitleCandidates(sources.missingPages, pages)
    expect(found['Aetheric Fundamentals a Primordial Primer']?.[0]).toBe('Aetheric Fundamentals, a Primordial Primer')
    expect(found['Threadbare Grain Sack']).toEqual(['A Threadbare Grain Sack', 'The Threadbare Grain Sack'])
    expect(found['Recipe: Meat Sandwich']).toBeUndefined()
    expect(found['Kebbit Burrow (Brynmoor)']).toBeUndefined()
  })

  it('moves a base found under the first candidate that exists out of missingPages', () => {
    const first = { pageCategories: { 'Gold Ore Node': ['Category:Mining nodes'] }, missingPages: ['Threadbare Grain Sack', 'Razlem the Deranged', 'Lonely'] }
    const candidates = { 'Threadbare Grain Sack': ['A Threadbare Grain Sack', 'The Threadbare Grain Sack'], 'Razlem the Deranged': ['Razlem, the Deranged'] }
    const known = { 'Gold Ore Node': ['Category:Mining nodes'], 'The Threadbare Grain Sack': ['Category:Scenery'], 'A Threadbare Grain Sack': ['Category:Vestiges'] }
    expect(applyPageTitles(first, candidates, known)).toEqual({
      pageCategories: { 'Gold Ore Node': ['Category:Mining nodes'], 'Threadbare Grain Sack': ['Category:Vestiges'] },
      missingPages: ['Razlem the Deranged', 'Lonely'],
      pageTitles: { 'Threadbare Grain Sack': 'A Threadbare Grain Sack' },
    })
  })

  it('looks the candidates up in one more batched request and maps them back to the base names', async () => {
    const list = [
      page('Gold Ore Node', [{ x: 1, y: 1 }]),
      page('Threadbare Grain Sack', [{ x: 42722, y: 172338 }]),
      page('Ancient Tomes', [{ x: 10, y: 10, name: '[[Aetheric Fundamentals, a Primordial Primer]]' }]),
      page('Aetheric Fundamentals a Primordial Primer', [{ x: 10, y: 10 }]),
      page('Razlem the Deranged', [{ x: 20, y: 20 }]),
      // Enough pages without a wiki page to need two requests for the candidates.
      ...Array.from({ length: 30 }, (_, i) => page(`Lost Thing ${i + 1}`, [{ x: 100 * i, y: 50 }])),
    ]
    // Hand-made answers, in the shape of prop=categories with redirects=1.
    const answers: Record<string, any> = {
      'Gold Ore Node': { title: 'Gold Ore Node', categories: [{ title: 'Category:Mining nodes' }] },
      'Ancient Tomes': { title: 'Ancient Tomes', categories: [{ title: 'Category:Quest Items' }] },
      'Threadbare grain sack': { title: 'Threadbare grain sack', categories: [{ title: 'Category:Vestiges' }] },
      'Aetheric Fundamentals, a Primordial Primer': {
        title: 'Aetheric Fundamentals, a Primordial Primer',
        categories: [{ title: 'Category:Journal' }, { title: 'Category:Quest Items' }],
      },
    }
    const redirects: Record<string, string> = { 'A Threadbare Grain Sack': 'Threadbare grain sack' }
    const calls: Record<string, any>[] = []
    let running = 0
    let overlap = false
    const ctx = {
      log: () => {},
      full: false,
      revisions: new Map(),
      pages: async (titles: string[]) => ({ pages: new Map(list.filter((p) => titles.includes(p.title)).map((p) => [p.title, p])), missing: [] }),
      wiki: {
        queryAll: async (_params: Record<string, any>, pick: (d: any) => any[]) => pick({ query: { allpages: list.map((p) => ({ title: p.title })) } }),
        api: async (params: Record<string, any>) => {
          calls.push(params)
          overlap ||= running > 0
          running++
          await Promise.resolve()
          running--
          const titles = String(params.titles).split('|')
          return {
            query: {
              redirects: titles.filter((t) => redirects[t]).map((t) => ({ from: t, to: redirects[t] })),
              pages: titles.map((t) => answers[redirects[t] ?? t] ?? { title: t, missing: true }),
            },
          }
        },
      },
    } as unknown as SyncContext

    const src = await fetchMapSources(ctx)
    expect(overlap).toBe(false)
    const batches = calls.map((c) => String(c.titles).split('|'))
    // 35 bases in one request, then 2 candidates for each of the 33 without a page, and 1 more link target.
    expect(batches.map((b) => b.length)).toEqual([35, 50, 17])
    for (const c of calls) expect(c).toMatchObject({ action: 'query', prop: 'categories|pageimages', clshow: '!hidden', cllimit: 'max', redirects: 1, ...PAGE_IMAGE_QUERY })
    expect(batches[1]!.slice(0, 7)).toEqual([
      'A Threadbare Grain Sack',
      'The Threadbare Grain Sack',
      'Aetheric Fundamentals, a Primordial Primer',
      'An Aetheric Fundamentals a Primordial Primer',
      'The Aetheric Fundamentals a Primordial Primer',
      'A Razlem the Deranged',
      'The Razlem the Deranged',
    ])

    expect(src.pageCategories['Threadbare Grain Sack']).toEqual(['Category:Vestiges'])
    expect(src.pageCategories['Aetheric Fundamentals a Primordial Primer']).toEqual(['Category:Journal', 'Category:Quest Items'])
    expect(src.pageTitles).toEqual({
      'Threadbare Grain Sack': 'A Threadbare Grain Sack',
      'Aetheric Fundamentals a Primordial Primer': 'Aetheric Fundamentals, a Primordial Primer',
    })
    expect(src.missingPages).toContain('Razlem the Deranged')
    expect(src.missingPages).not.toContain('Threadbare Grain Sack')
    expect(src.missingPages).toHaveLength(31)

    // The vestige spot becomes a unique thing to find, the tome sits with its sibling quest tomes.
    const { map } = run(src)
    const byId = new Map(map.categories.map((c) => [c.id, c]))
    expect(byId.get('threadbare-grain-sack')).toMatchObject({ group: 'unique', wikiPage: 'A Threadbare Grain Sack' })
    expect(byId.get('aetheric-fundamentals-a-primordial-primer')).toMatchObject({ group: 'quest', wikiPage: 'Aetheric Fundamentals, a Primordial Primer' })
    expect(byId.get('razlem-the-deranged')?.group).toBe('other')
  })
})

describe('parseMap on the full fixtures', () => {
  it('has sane totals', () => {
    // 405 categories on the wiki, 97 of them only repeat Lore Scraps, Recipe Books or Vaults spots.
    expect(categories.length).toBeGreaterThan(280)
    expect(categories.length).toBeLessThan(400)
    expect(points.length).toBeGreaterThan(14000)
    expect(points.length).toBeLessThan(17000)
    expect(full.icons.length).toBeGreaterThan(40)
    expect(full.icons).toContain('Gold_Ore.png')
    // As written in the data, spaces included.
    expect(full.icons).toContain('Agility Course.png')
  })

  it('never produces NaN or broken numbers', () => {
    for (const p of points) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y), p.id).toBe(true)
      if (p.power !== undefined) expect(Number.isInteger(p.power) && p.power > 0, p.id).toBe(true)
      expect(p.id).not.toMatch(/NaN/)
    }
    for (const c of categories) expect(c.count).toBe(pointsOf(c.id).length)
  })

  it('has unique ids and consistent references', () => {
    expect(new Set(categories.map((c) => c.id)).size).toBe(categories.length)
    expect(new Set(points.map((p) => p.id)).size).toBe(points.length)
    const ids = new Set(categories.map((c) => c.id))
    for (const p of points) {
      expect(ids.has(p.categoryId)).toBe(true)
      expect(p.id.startsWith(`${p.categoryId}:`)).toBe(true)
    }
  })

  it('is deterministic and independent of page order', () => {
    const again = run({ ...sources, pages: [...pages].reverse() })
    expect(JSON.stringify(again.map)).toBe(JSON.stringify(full.map))
    expect(again.icons).toEqual(full.icons)
    const labels = categories.map((c) => c.label.toLowerCase())
    expect(labels).toEqual([...labels].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  })

  it('classifies every category into the expected groups', () => {
    const counts: Partial<Record<MapGroup, number>> = {}
    for (const c of categories) counts[c.group] = (counts[c.group] ?? 0) + 1
    expect(counts).toEqual({
      chest: 3,
      location: 34,
      // 94 on the wiki: 82 only repeat Lore Scraps spots (twins).
      lore: 12,
      monster: 95,
      npc: 24,
      other: 8,
      quest: 49,
      resource: 67,
      // 20 on the wiki: the 5 'Recipe: X' pages repeat Recipe Books spots.
      unique: 15,
      // 11 on the wiki: the 10 per-vault pages repeat Vaults spots.
      vault: 1,
    })
    const others = categories.filter((c) => c.group === 'other').map((c) => c.label)
    expect(others).toEqual([
      'Death',
      'Jewellery Box',
      'Kalphite Queen Egg',
      "Rasthin's Riddle of Faith",
      'Razlem the Deranged',
      'Saga of the Adventurer',
      'Scaling Difficulties',
      'Threadbare Grain Sack',
    ])
    const warning = full.warnings.find((w) => w.message.includes("'other'"))
    expect(warning?.message).toContain('8 categories')
  })

  it.each([
    ['gold-ore-node', 'resource'],
    ['air-anima-vent', 'resource'],
    ['lore-scraps', 'lore'],
    ['scorched-tome', 'lore'],
    ['vaults', 'vault'],
    ['ratcatcher', 'quest'],
    ['dragon-slayer', 'quest'],
    ['mirror-mirror', 'quest'],
    ['the-secret-scrolls', 'quest'],
    ['treasure-chest', 'chest'],
    ['buried-treasure', 'chest'],
    ['spectral-chest', 'chest'],
    ['recipe-books', 'unique'],
    ['an-educational-blade', 'unique'],
    ['wise-old-man', 'npc'],
    ['zogre', 'monster'],
    ['magical-raven', 'monster'],
    ['exploding-plant-trap', 'monster'],
    ['nodestone', 'location'],
    ['bramblemead-locations', 'location'],
    ['agility-course', 'location'],
    ['temple-of-saradomin', 'location'],
  ])('%s is %s', (id, group) => {
    expect(category(id)?.group).toBe(group)
  })

  it('gold-ore-node is a resource with its icon on the category', () => {
    const c = category('gold-ore-node')
    expect(c).toMatchObject({ label: 'Gold Ore Node', group: 'resource', icon: 'Gold_Ore.png', wikiPage: 'Gold Ore Node' })
    expect(c.sources).toEqual(['Module:Map/Gold Ore Node.json'])
    expect(pointsOf('gold-ore-node').every((p) => p.icon === undefined)).toBe(true)
  })

  it('never repeats the category icon on a point', () => {
    for (const p of points) if (p.icon) expect(p.icon).not.toBe(category(p.categoryId).icon)
  })

  it('lore-scraps keeps names and links of the scraps', () => {
    const c = category('lore-scraps')
    expect(c.group).toBe('lore')
    expect(c.count).toBe(97)
    const diary = pointsOf('lore-scraps').find((p) => p.name === 'Scrawled Diary Page')
    expect(diary?.link).toBe('Scrawled Diary Page')
  })

  it('vaults has 12 named points with a region', () => {
    const list = pointsOf('vaults')
    expect(list).toHaveLength(12)
    expect(list.every((p) => p.name && p.region)).toBe(true)
    expect(list.find((p) => p.name === 'Crasorak Kara')).toMatchObject({ region: 'Brynmoor', description: 'The location of the Crasorak Kara vault in Temple Woods' })
    expect(list.find((p) => p.name === 'Vault (Kalphite)')?.region).toBe('Umbral Sands')
  })

  it('ratcatcher is a quest with one point', () => {
    expect(category('ratcatcher')).toMatchObject({ group: 'quest', count: 1, wikiPage: 'Ratcatcher' })
  })

  it('treasure-chest merges chests.json with the regional pages', () => {
    const c = category('treasure-chest')
    expect(c.label).toBe('Treasure Chest')
    expect(c.sources).toContain('Module:Map/chests.json')
    expect(c.sources).toContain('Module:Map/Treasure Chest (Brynmoor).json')
    expect(c.sources).toContain('Module:Map/Treasure Chest (Vestige Chance) (Dowdun Reach).json')
    const list = pointsOf('treasure-chest')
    // 282 regional chests; every chests.json point lies on one of them.
    expect(list).toHaveLength(282)
    const both = list.filter((p) => p.power !== undefined && p.region && !p.regionGuessed)
    expect(both).toHaveLength(137)
    expect(list.every((p) => p.region && !p.regionGuessed)).toBe(true)
    expect(list.find((p) => p.id === 'treasure-chest:5179:190727')).toMatchObject({ power: 2, region: 'Brynmoor', description: 'Vestige: Training Sword' })
    const chance = list.filter((p) => p.description === 'Vestige Chance')
    expect(chance).toHaveLength(24)
    expect(chance.every((p) => p.region === 'Dowdun Reach' && p.name === undefined)).toBe(true)
    // Region from 'Treasure Chest (Umbral Sands Cape)'.
    expect(list.find((p) => p.icon === 'Umbral_Sands_Cape.png')?.region).toBe('Umbral Sands')
  })

  it('merges regional kebbit burrows into one category', () => {
    const c = category('kebbit-burrow')
    expect(c.sources).toHaveLength(5)
    expect(c.group).toBe('resource')
    expect(c.wikiPage).toBeUndefined()
    expect(c.icon).toBe('Kebbit_Burrow_icon.png')
    const regions = new Set(pointsOf('kebbit-burrow').map((p) => p.region))
    expect(regions).toEqual(new Set(['Brynmoor', 'Ghornfell', 'Dowdun Reach', 'Umbral Sands', 'Fellhollow']))
    expect(pointsOf('kebbit-burrow').every((p) => !p.regionGuessed && p.name === undefined)).toBe(true)
    expect(categories.some((c) => c.id.startsWith('kebbit-burrow-'))).toBe(false)
  })

  it('keeps parenthesised non-regions as their own category', () => {
    expect(category('cow-cooks-assistant')).toMatchObject({ label: "Cow (Cook's Assistant)", group: 'npc' })
    expect(category('patch-hellrat')).toMatchObject({ label: 'Patch (Hellrat)', group: 'monster' })
    expect(category('cow').group).toBe('monster')
  })

  it('merges case duplicates', () => {
    expect(category('zogre').sources).toEqual(['Module:Map/Zogre.json', 'Module:Map/zogre.json'])
    expect(category('zogre').label).toBe('Zogre')
  })

  it('skips sandbox and test pages with one warning each', () => {
    expect(categories.some((c) => c.sources.some((s) => s.includes('User:')))).toBe(false)
    for (const id of ['test', 'healingpotiontest', 'abyssalwhipstatue', 'user-jsfour-sandbox']) expect(categories.some((c) => c.id === id)).toBe(false)
    const skipped = full.warnings.filter((w) => w.message.startsWith('Skipped'))
    expect(skipped.map((w) => w.page).sort()).toEqual([
      'Module:Map/HealingPotionTest.json',
      'Module:Map/User:Jsfour/sandbox.json',
      'Module:Map/abyssalwhipstatue.json',
      'Module:Map/test.json',
    ])
  })

  it('warns once per page with broken points and once per category with duplicates', () => {
    const broken = full.warnings.filter((w) => w.message.includes('without a valid x/y'))
    expect(broken).toEqual([{ message: '1 of 1 points without a valid x/y skipped', page: 'Module:Map/Rotridden Cow.json' }])
    const dups = full.warnings.filter((w) => w.message.includes('duplicate point'))
    expect(new Set(dups.map((w) => w.page)).size).toBe(dups.length)
    expect(dups.find((w) => w.page === 'Module:Map/Ash Tree.json')?.message).toMatch(/^91 /)
    expect(category('ash-tree').count).toBe(1938 - 91)
  })

  it('never keeps a coordinate-only description or a name equal to its label', () => {
    for (const p of points) {
      if (p.description) {
        expect(isCoordinateText(p.description), p.id).toBe(false)
        expect(p.description).not.toMatch(/^Tier\s*\d/)
      }
      if (p.name) expect(p.name.toLowerCase(), p.id).not.toBe(category(p.categoryId).label.toLowerCase())
    }
    // Onion: 497 points that only carry their own coordinates as description.
    expect(pointsOf('onion').every((p) => p.description === undefined)).toBe(true)
  })

  it('parses power and region from descriptions and names', () => {
    const zombies = pointsOf('zombie')
    expect(zombies.filter((p) => p.power === 5 && p.region === 'Fellhollow' && !p.regionGuessed)).toHaveLength(64)
    expect(zombies.filter((p) => p.power === 6 && p.region === 'Dowdun Reach')).toHaveLength(36)
    expect(zombies.every((p) => p.description === undefined)).toBe(true)
    expect(pointsOf('black-dragon').map((p) => p.power).sort()).toEqual([8, 8, 9])
    // 'Brynmore' and 'Felhollow' are fixed, sub-areas stay as description.
    const vents = pointsOf('anima-vent')
    expect(vents.filter((p) => p.region === 'Brynmoor' && !p.regionGuessed)).toHaveLength(23 + 5 + 2)
    expect(vents.find((p) => p.description === 'Fractured Plains')?.region).toBe('Ghornfell')
    expect(vents.some((p) => p.description === 'Brynmore' || p.description === 'Brynmoor')).toBe(false)
    // A region as name ('Postie Pete' at 'Fellhollow') becomes the region.
    expect(pointsOf('postie-pete').map((p) => [p.name, p.region]).sort()).toEqual([
      [undefined, 'Dowdun Reach'],
      [undefined, 'Fellhollow'],
    ])
    expect(pointsOf('bramblemead-cape')[0]).toMatchObject({ power: 2 })
    expect(pointsOf('bramblemead-cape')[0]!.description).toBeUndefined()
  })

  it('only uses top-level regions and guesses the rest from nearby points', () => {
    const allowed = new Set<string>(REGIONS)
    for (const p of points) if (p.region) expect(allowed.has(p.region), p.id).toBe(true)
    for (const p of points) if (p.regionGuessed) expect(p.region).toBeDefined()
    const guessed = points.filter((p) => p.regionGuessed).length
    const stated = points.filter((p) => p.region && !p.regionGuessed).length
    expect(stated).toBeGreaterThan(900)
    expect(guessed).toBeGreaterThan(12000)
    const accuracy = regionGuessAccuracy(points)
    expect(accuracy.correct / accuracy.total).toBeGreaterThan(0.95)
    // The Windmill sits in Temple Woods, Brynmoor.
    expect(pointsOf('windmill')[0]).toMatchObject({ region: 'Brynmoor' })
  })

  it('links points to their own page when the category has no single page', () => {
    // The Bramblemead Valley diary is a twin of its Lore Scraps entry; the Fellhollow one is not.
    const diaries = pointsOf('weathered-diary')
    expect(category('weathered-diary').wikiPage).toBeUndefined()
    expect(category('weathered-diary').sources).toEqual([
      'Module:Map/Weathered Diary (Bramblemead Valley).json',
      'Module:Map/Weathered Diary (Fellhollow).json',
    ])
    expect(diaries.map((p) => [p.link, p.region])).toEqual([['Weathered Diary (Fellhollow)', 'Fellhollow']])
    expect(points.find((p) => p.aliases?.includes('weathered-diary:85904:162732'))).toMatchObject({
      id: 'lore-scraps:85904:162732',
      link: 'Weathered Diary (Bramblemead Valley)',
      region: 'Brynmoor',
    })
  })
})

describe('parseMap twins', () => {
  const pointById = new Map(points.map((p) => [p.id, p]))
  const aliasOwner = new Map(points.flatMap((p) => (p.aliases ?? []).map((a) => [a, p] as const)))
  const groupOf = (p: { categoryId: string }) => category(p.categoryId).group

  it('keeps one point per one-time spot: 108 lore, 19 unique and 12 vault points', () => {
    const count = (group: MapGroup) => points.filter((p) => groupOf(p) === group).length
    expect([count('lore'), count('unique'), count('vault')]).toEqual([108, 19, 12])
    expect(category('lore-scraps').count).toBe(97)
    expect(category('recipe-books').count).toBe(5)
    expect(category('vaults').count).toBe(12)
  })

  it('never reuses an id: aliases are unique, never a point of their own, and point at a kept point of the same group', () => {
    const aliases = points.flatMap((p) => p.aliases ?? [])
    expect(aliases).toHaveLength(100)
    expect(new Set(aliases).size).toBe(aliases.length)
    for (const alias of aliases) {
      expect(pointById.has(alias), alias).toBe(false)
      const owner = aliasOwner.get(alias)!
      expect(alias.startsWith(`${owner.categoryId}:`), alias).toBe(false)
      expect(['lore', 'unique', 'vault']).toContain(groupOf(owner))
    }
    for (const p of points) if (p.aliases) expect(p.aliases).toEqual([...p.aliases].sort())
  })

  it('folds Gold-plated Tome into its Lore Scraps entry and drops the empty category', () => {
    expect(categories.some((c) => c.id === 'gold-plated-tome')).toBe(false)
    expect(pointById.get('lore-scraps:226980:198282')).toMatchObject({
      name: 'Gold-plated Tome',
      link: 'Gold-plated Tome',
      aliases: ['gold-plated-tome:226980:198282'],
      // The twin states the region, the Lore Scraps entry only had a guess.
      region: 'Umbral Sands',
    })
    expect(pointById.get('lore-scraps:226980:198282')!.regionGuessed).toBeUndefined()
    // Module:Map lookups by page name (quest maps) still find the spot.
    expect(category('lore-scraps').sources).toContain('Module:Map/Gold-plated Tome.json')
    // Weathered Diary keeps one point of its own, so it keeps its sources.
    expect(category('lore-scraps').sources).not.toContain('Module:Map/Weathered Diary (Bramblemead Valley).json')
  })

  it('merges twins a few units apart (Preserved Diary, 56 units)', () => {
    expect(pointById.get('lore-scraps:24322:146327')?.aliases).toEqual(['preserved-diary:24370:146355'])
  })

  it('splits the three-way spot at 132249:30611 by name', () => {
    const here = points.filter((p) => Math.round(p.x) === 132249 && Math.round(p.y) === 30611)
    expect(here.map((p) => [p.id, p.aliases])).toEqual([
      ['lore-scraps:132249:30611', ['ravannas-first-journal:132249:30611']],
      // Linked to 'Weathered Diary (Fellhollow)': another name, so another thing to find.
      ['weathered-diary:132249:30611', undefined],
    ])
  })

  it('folds the recipe pages into Recipe Books', () => {
    for (const id of ['recipe-meat-sandwich', 'recipe-foragers-sandwich']) expect(categories.some((c) => c.id === id)).toBe(false)
    expect(pointById.get('recipe-books:201455:34717')).toMatchObject({
      name: 'Recipe: Meat Sandwich',
      aliases: ['recipe-meat-sandwich:201455:34717'],
    })
    expect(category('recipe-books').sources).toContain('Module:Map/Recipe: Meat Sandwich.json')
  })

  it('folds the per-vault pages into Vaults, which gain a link to the vault page', () => {
    expect(categories.filter((c) => c.group === 'vault').map((c) => c.id)).toEqual(['vaults'])
    expect(pointById.get('vaults:37482:191753')).toMatchObject({
      name: 'Crasorak Kara',
      link: 'Crasorak Kara',
      aliases: ['crasorak-kara:37482:191753'],
    })
    expect(category('vaults').sources).toContain('Module:Map/Crasorak Kara.json')
    // Location collections are not one-time spots: they keep their own points.
    expect(category('bramblemead-locations')).toMatchObject({ group: 'location' })
  })

  it('leaves quest, npc and other groups alone', () => {
    // The Dragon Slayer quest map sits on a Pungent Scribble spot and stays for start matching.
    expect(pointById.get('dragon-slayer:48282:177692')).toBeDefined()
    expect(pointById.get('dragon-slayer:48282:177692')!.aliases).toBeUndefined()
    for (const p of points) if (p.aliases) expect(['lore', 'unique', 'vault']).toContain(groupOf(p))
  })

  it('still gives every vault on the map its Vaults point', () => {
    const vaults = parseVaults({ page: fixturePage('vaults/dragonkin-vault.json'), navbox: fixturePage('vaults/navbox.json') }, full.map, () => {})
    const linked = vaults.filter((v) => v.pointId)
    expect(linked.length).toBeGreaterThanOrEqual(10)
    for (const v of linked) {
      expect(v.pointId!.startsWith('vaults:'), v.name).toBe(true)
      expect(pointById.has(v.pointId!), v.name).toBe(true)
    }
    expect(vaults.find((v) => v.name === 'Crasorak Kara')?.pointId).toBe('vaults:37482:191753')
  })

  it('still starts quests on kept points outside the twin groups', () => {
    const quickGuides: Record<string, RawPage> = {}
    for (const guide of fixturePages('quests/quickguides.json')) quickGuides[guide.title.replace(/\/Quick guide$/, '')] = guide
    const quests = parseQuests({ overview: fixturePage('quests/overview.json'), quests: fixturePages('quests/pages.json'), quickGuides }, full.map, () => {})
    const starts = quests.flatMap((q) => (q.startPointId ? [q.startPointId] : []))
    expect(starts.length).toBeGreaterThan(20)
    for (const id of starts) {
      expect(pointById.has(id), id).toBe(true)
      expect(['lore', 'unique', 'vault']).not.toContain(groupOf(pointById.get(id)!))
    }
  })
})

describe('parseMap edge cases', () => {
  const parse = (list: RawPage[], extra: Partial<MapSources> = {}) =>
    run({ pages: list, pageCategories: {}, missingPages: list.map((p) => mapBaseName(p.title)), ...extra })

  it('reads a single point object and a full Map object', () => {
    const res = parse([
      page('Lone Rock', { x: 10, y: 20, name: 'Lone Rock', description: 'Brynmoor' }),
      page('Mapped', {
        coordinateOrder: 'xy',
        categories: [{ id: 'a', name: 'A' }],
        markers: [
          { position: [100, 200], categoryId: 'a', popup: { title: '[[Gold Ore Node|Gold]]', description: 'Tier 3' } },
          { position: [300, 400], icon: 'Gold ore.png' },
        ],
      }),
      page('Flipped', { coordinateOrder: 'yx', markers: [{ position: [5, 6] }] }),
    ])
    expect(res.map.points).toEqual([
      { id: 'flipped:6:5', categoryId: 'flipped', x: 6, y: 5, region: 'Brynmoor', regionGuessed: true },
      { id: 'lone-rock:10:20', categoryId: 'lone-rock', x: 10, y: 20, region: 'Brynmoor' },
      { id: 'mapped:100:200', categoryId: 'mapped', x: 100, y: 200, name: 'Gold', link: 'Gold Ore Node', power: 3, region: 'Brynmoor', regionGuessed: true },
      { id: 'mapped:300:400', categoryId: 'mapped', x: 300, y: 400, icon: 'Gold_ore.png', region: 'Brynmoor', regionGuessed: true },
    ])
    expect(res.icons).toEqual(['Gold ore.png'])
  })

  it('warns once for invalid JSON, empty objects and broken points', () => {
    const res = parse([
      page('Broken', '[{"x": 1,'),
      page('Empty', {}),
      page('Half', [{ x: 1, y: 2 }, { x: 'a', y: 3 }, { y: 4 }, null, {}]),
    ])
    expect(res.warnings.filter((w) => w.page).map((w) => [w.page, w.message.split(':')[0]])).toEqual([
      ['Module:Map/Broken.json', 'Invalid JSON, page skipped'],
      ['Module:Map/Empty.json', 'No map points recognised (empty object), page skipped'],
      ['Module:Map/Half.json', '4 of 5 points without a valid x/y skipped'],
    ])
    expect(res.map.points.map((p) => p.id)).toEqual(['half:1:2'])
  })

  it('dedupes identical ids with one warning, and merges nearby points of other pages silently', () => {
    const res = parse([
      page('Treasure Chest (Fellhollow)', [
        { x: 1000, y: 1000, name: 'Treasure Chest' },
        { x: 1000.2, y: 999.9, name: 'Treasure Chest' },
        { x: 5000, y: 5000, name: 'Treasure Chest' },
      ]),
      page('chests', [
        { x: 1030, y: 1010, description_: 'Tier4_World_Highlands_Cape' },
        { x: 5200, y: 5000, description: 'Tier 6' },
      ]),
    ])
    expect(res.map.categories).toEqual([
      {
        id: 'treasure-chest',
        label: 'Treasure Chest',
        group: 'chest',
        sources: ['Module:Map/Treasure Chest (Fellhollow).json', 'Module:Map/chests.json'],
        count: 3,
      },
    ])
    expect(res.map.points).toEqual([
      // 32 units apart: the same chest. The page region wins over the 'Highlands' hint of the code.
      { id: 'treasure-chest:1000:1000', categoryId: 'treasure-chest', x: 1000, y: 1000, description: 'Cape vestige', power: 4, region: 'Fellhollow' },
      // 200 units apart: two different chests.
      { id: 'treasure-chest:5000:5000', categoryId: 'treasure-chest', x: 5000, y: 5000, region: 'Fellhollow' },
      { id: 'treasure-chest:5200:5000', categoryId: 'treasure-chest', x: 5200, y: 5000, power: 6, region: 'Fellhollow', regionGuessed: true },
    ])
    expect(res.warnings.filter((w) => w.message.includes('duplicate'))).toEqual([
      { message: '1 duplicate point (same coordinates) merged', page: 'Module:Map/Treasure Chest (Fellhollow).json' },
    ])
  })

  it('uses the region category of a single-point page as a stated region', () => {
    const res = parse([page('Old Note', [{ x: 1, y: 1 }])], {
      pageCategories: { 'Old Note': ['Category:Bramblemead Valley', 'Category:Lore Scraps'] },
      missingPages: [],
    })
    expect(res.map.points[0]).toMatchObject({ region: 'Brynmoor' })
    expect(res.map.points[0]!.regionGuessed).toBeUndefined()
    expect(res.map.categories[0]).toMatchObject({ group: 'lore', wikiPage: 'Old Note' })
  })

  const lore = ['Category:Lore Scraps']

  it('folds twins only within one group, within TWIN_DISTANCE and with the same name', () => {
    const list = [
      page('Lore Scraps', [
        { x: 1000, y: 1000, name: '[[Old Note]]' },
        { x: 5000, y: 5000, name: '[[Far Note]]' },
        { x: 9000, y: 9000, name: '[[Other Note]]' },
      ]),
      // 112 units away, same name: a twin. It states the region and has a description.
      page('Old Note', [{ x: 1100, y: 1050, description: 'Under the bridge' }]),
      // 600 units away: another spot.
      page('Far Note', [{ x: 5600, y: 5000 }]),
      // Same spot, another name: another thing to find.
      page('Some Note', [{ x: 9000, y: 9000 }]),
      // Quest maps are never folded, even on the very same spot.
      page('Quest Thing', [{ x: 1000, y: 1000, name: '[[Old Note]]' }]),
    ]
    const src: Partial<MapSources> = {
      pageCategories: {
        'Lore Scraps': lore,
        'Old Note': [...lore, 'Category:Temple Woods'],
        'Far Note': lore,
        'Some Note': lore,
        'Quest Thing': ['Category:Quests'],
      },
      missingPages: [],
    }
    const res = parse(list, src)
    expect(res.map.categories.map((c) => [c.id, c.group, c.count])).toEqual([
      ['far-note', 'lore', 1],
      ['lore-scraps', 'lore', 3],
      ['quest-thing', 'quest', 1],
      ['some-note', 'lore', 1],
    ])
    expect(res.map.categories.find((c) => c.id === 'lore-scraps')!.sources).toEqual(['Module:Map/Lore Scraps.json', 'Module:Map/Old Note.json'])
    expect(res.map.points.find((p) => p.id === 'lore-scraps:1000:1000')).toEqual({
      id: 'lore-scraps:1000:1000',
      categoryId: 'lore-scraps',
      x: 1000,
      y: 1000,
      name: 'Old Note',
      link: 'Old Note',
      description: 'Under the bridge',
      region: 'Brynmoor',
      aliases: ['old-note:1100:1050'],
    })
    expect(res.map.points.filter((p) => p.aliases).map((p) => p.id)).toEqual(['lore-scraps:1000:1000'])
    // Page order never matters.
    expect(JSON.stringify(parse([...list].reverse(), src).map)).toBe(JSON.stringify(res.map))
  })

  it('keeps the points of the biggest category, then of the first id, and hands sources only from emptied categories', () => {
    const res = parse(
      [
        page('Alpha Page', [{ x: 0, y: 0, name: 'Shared Page' }]),
        page('Beta Page', [{ x: 10, y: 0, name: 'Shared Page' }]),
        // Two points, so it keeps its own; one of them is also listed by Delta Page.
        page('Zeta Pages', [
          { x: 3000, y: 3000, name: 'Lonely Page' },
          { x: 7000, y: 7000, name: 'Weathered Page (Fellhollow)' },
        ]),
        page('Delta Page', [{ x: 3000, y: 3000, name: 'Lonely Page' }]),
        // The qualifier does not count: 'Weathered Page' is the same thing.
        page('Weathered Page', [{ x: 7020, y: 7000 }]),
      ],
      { pageCategories: { 'Alpha Page': lore, 'Beta Page': lore, 'Zeta Pages': lore, 'Delta Page': lore, 'Weathered Page': lore }, missingPages: [] },
    )
    expect(res.map.categories.map((c) => [c.id, c.count, c.sources])).toEqual([
      ['alpha-page', 1, ['Module:Map/Alpha Page.json', 'Module:Map/Beta Page.json']],
      ['zeta-pages', 2, ['Module:Map/Delta Page.json', 'Module:Map/Weathered Page.json', 'Module:Map/Zeta Pages.json']],
    ])
    expect(res.map.points.map((p) => [p.id, p.aliases])).toEqual([
      ['alpha-page:0:0', ['beta-page:10:0']],
      ['zeta-pages:3000:3000', ['delta-page:3000:3000']],
      ['zeta-pages:7000:7000', ['weathered-page:7020:7000']],
    ])
  })

  it('uses the page title found under another name for wikiPage and links', () => {
    const res = parse([page('Threadbare Grain Sack', [{ x: 1, y: 1 }]), page('Ancient Tomes', [{ x: 5, y: 5 }, { x: 900, y: 900, name: 'Other' }])], {
      pageCategories: { 'Threadbare Grain Sack': ['Category:Vestiges'], 'Ancient Tomes': ['Category:Quest Items'] },
      missingPages: [],
      pageTitles: { 'Threadbare Grain Sack': 'A Threadbare Grain Sack', 'Ancient Tomes': 'The Ancient Tomes' },
    })
    expect(res.map.categories.map((c) => [c.id, c.group, c.wikiPage])).toEqual([
      ['ancient-tomes', 'quest', 'The Ancient Tomes'],
      ['threadbare-grain-sack', 'unique', 'A Threadbare Grain Sack'],
    ])
    // Links equal to the category page are left out, as before.
    expect(res.map.points.some((p) => p.link)).toBe(false)
  })
})

describe('page images', () => {
  it('collectPageImages maps normalized and redirected titles back and merges continued responses', () => {
    const first = {
      query: {
        normalized: [
          { from: 'goblin warrior', to: 'Goblin warrior' },
          { from: 'chests', to: 'Chests' },
        ],
        redirects: [
          { from: 'Goblin warrior', to: 'Goblin Warrior' },
          { from: 'Chests', to: 'Chest' },
        ],
        pages: [
          { title: 'Goblin Warrior', pageimage: 'Goblin_Warrior.png', thumbnail: { source: 'https://x/64px-Goblin_Warrior.png', width: 64, height: 89 } },
          // Its image only comes with the continued response.
          { title: 'Chest', categories: [{ title: 'Category:Activities' }] },
          { title: 'Plain Page' },
          { title: 'Gone', missing: true, pageimage: 'Gone.png' },
        ],
      },
      continue: { picontinue: 2, continue: '||categories' },
    }
    const second = {
      query: {
        pages: [
          // Answered again without an image: keeps the first one.
          { title: 'Goblin Warrior' },
          { title: 'Chest', pageimage: 'Chest.png', thumbnail: { source: 'https://x/Chest.png', width: 64, height: 48 } },
          { title: 'No Thumb', pageimage: 'No_Thumb.png' },
        ],
      },
    }
    expect(collectPageImages(['goblin warrior', 'chests', 'Plain Page', 'Gone', 'No Thumb', 'Unanswered'], [first, second])).toEqual({
      'goblin warrior': { file: 'Goblin_Warrior.png', width: 64, height: 89 },
      chests: { file: 'Chest.png', width: 64, height: 48 },
      'No Thumb': { file: 'No_Thumb.png' },
    })
  })

  it('firstDropName takes the item of the first DropsLine', () => {
    const gold = [
      '{{Infobox Resource Node|image = Gold Ore Node.png}}',
      '==Drops==',
      '{{DropsTableHead}}',
      '{{DropsLine|name=Gold ore|quantity=1|rarity=Always}}',
      '{{DropsLine|name=Sapphire|quantity=1|rarity=Rare}}',
      '{{DropsTableBottom}}',
    ].join('\n')
    expect(firstDropName(gold)).toBe('Gold ore')
    expect(firstDropName('{{DropsLine|name=[[iron ore|Iron]]}}')).toBe('Iron ore')
    expect(firstDropName('{{DropsLine|name=}}\n{{dropsline| name = clay <!-- soft --> }}')).toBe('Clay')
    expect(firstDropName('{{Infobox Resource Node|image = Granite Deposit.png}}')).toBeUndefined()
  })

  it.each<[string, string, string | undefined]>([
    ['spaces, extra params before the name', '{{DropsLine | quantity = 1-2 |  name  =  Iron ore  | rarity = Always }}', 'Iron ore'],
    ['Template: prefix, spaced name', '{{Template:Drops line|name=Tin ore}}', 'Tin ore'],
    ['link with a fragment and a trail', '{{DropsLine|name=[[copper ore#Mining|Copper]]s}}', 'Copper ore'],
    // The page the plink points to, not its display text.
    ['plink with txt', '{{DropsLine|name={{plink|Silver ore|txt=Silver}}|quantity=1}}', 'Silver ore'],
    ['entity and underscores', '{{DropsLine|name=Swamp_tar&nbsp;}}', 'Swamp tar'],
    ['plain text with a section', '{{DropsLine|name=Rune essence#Geyser}}', 'Rune essence'],
    // Lines wrapped in another template still count, in source order.
    ['wrapped in a table template', '{{Drops table|\n{{DropsLine|name=Granite|quantity=1}}\n{{DropsLine|name=Flint}}\n}}', 'Granite'],
    ['wrapped in a parser function', '{{#if:{{{x|}}}|{{DropsLine|name=Limestone}}}}\n{{DropsLine|name=Clay}}', 'Limestone'],
    // Commented-out and nowiki lines are not on the page.
    ['commented out first line', '<!-- {{DropsLine|name=Old ore}} -->\n{{DropsLine|name=Luminite}}', 'Luminite'],
    ['nowiki line', '<nowiki>{{DropsLine|name=Example}}</nowiki>', undefined],
    ['only a DropsTableHead', '{{DropsTableHead}}\n{{DropsTableBottom}}', undefined],
    ['a name that is only a file', '{{DropsLine|name=[[File:Ore.png]]}}', undefined],
    // '|' would split the titles of the batch: such a line is skipped.
    ['a name that is no title', '{{DropsLine|name=Ore {{!}} gem}}\n{{DropsLine|name=Gem}}', 'Gem'],
  ])('firstDropName: %s', (_what, text, item) => {
    expect(firstDropName(text)).toBe(item)
  })

  it.each<[string, boolean]>([
    ['Iron Ore Node', true],
    ['Granite Deposit', true],
    ['Limestone Rock', true],
    ['Luminite Deposit', true],
    ['Goblin Warrior', false],
    ['Rocky Outcrop', false],
    ['Nodestone', false],
  ])('isNodeLabel(%s) is %s', (label, node) => {
    expect(isNodeLabel(label)).toBe(node)
  })

  it('fetches page images with the categories and the drop item images of nodes, 50 titles per request', async () => {
    const drops = (...items: string[]) =>
      ['{{Infobox Resource Node}}', '{{DropsTableHead}}', ...items.map((i) => `{{DropsLine|name=${i}|quantity=1}}`), '{{DropsTableBottom}}'].join('\n')
    const img = (file: string, width = 64, height = 64) => ({ pageimage: file, thumbnail: { source: `https://x/${file}`, width, height } })
    const mining = [{ title: 'Category:Mining nodes' }]
    const ores = Array.from({ length: 55 }, (_, i) => i + 1)

    const list = [
      page('Iron Ore Node', [{ x: 1000, y: 1000 }]),
      page('Gold Ore Node', [{ x: 2000, y: 1000 }]),
      page('Clay Node', [{ x: 3000, y: 1000 }]),
      page('Granite Deposit', [{ x: 4000, y: 1000 }]),
      page('goblin warrior', [{ x: 5000, y: 1000 }]),
      page('Threadbare Grain Sack', [{ x: 6000, y: 1000 }]),
      // A node without a wiki page: its wikitext is never asked for.
      page('Lost Rock', [{ x: 7000, y: 1000 }]),
      ...ores.map((i) => page(`Ore ${i} Node`, [{ x: 100 * i, y: 5000 }])),
    ]
    // Hand-made wiki, in the shape of formatversion=2 answers.
    const wikiPages: Record<string, any> = {
      'Iron Ore Node': { title: 'Iron Ore Node', categories: mining, ...img('Iron_Ore_Node.png') },
      'Gold Ore Node': { title: 'Gold Ore Node', categories: mining, ...img('Gold_Ore_Node.png', 64, 89) },
      'Clay Node': { title: 'Clay Node', categories: mining, ...img('Clay_Node.png') },
      'Granite Deposit': { title: 'Granite Deposit', categories: mining },
      'Goblin Warrior': { title: 'Goblin Warrior', categories: [{ title: 'Category:Monsters' }], ...img('Goblin_Warrior.png', 64, 89) },
      'Threadbare grain sack': { title: 'Threadbare grain sack', categories: [{ title: 'Category:Vestiges' }], ...img('Threadbare_Grain_Sack.png') },
      'Iron ore': { title: 'Iron ore', ...img('Iron_ore.png') },
      'Gold Ore (item)': { title: 'Gold Ore (item)', ...img('Gold_Ore.png') },
      Clay: { title: 'Clay' },
      ...Object.fromEntries(ores.map((i) => [`Ore ${i} Node`, { title: `Ore ${i} Node`, categories: mining }])),
      ...Object.fromEntries(ores.map((i) => [`Ore ${i}`, { title: `Ore ${i}`, ...img(`Ore_${i}.png`) }])),
    }
    const redirectTo: Record<string, string> = {
      'Goblin warrior': 'Goblin Warrior',
      'A Threadbare Grain Sack': 'Threadbare grain sack',
      'Gold ore': 'Gold Ore (item)',
    }
    const wikitext: Record<string, string> = {
      'Iron Ore Node': drops('Iron ore', 'Sapphire'),
      'Gold Ore Node': drops('gold ore', 'Sapphire'),
      'Clay Node': drops('Clay'),
      'Granite Deposit': '{{Infobox Resource Node|image = Granite Deposit.png}}',
      ...Object.fromEntries(ores.map((i) => [`Ore ${i} Node`, drops(`Ore ${i}`)])),
    }

    const calls: Record<string, any>[] = []
    const pageRequests: string[][] = []
    let running = 0
    let overlap = false
    const ctx = {
      log: () => {},
      full: false,
      revisions: new Map(),
      pages: async (titles: string[]) => {
        pageRequests.push(titles)
        const map = new Map<string, RawPage>()
        for (const p of list) if (titles.includes(p.title)) map.set(p.title, p)
        for (const t of titles) if (wikitext[t] !== undefined) map.set(t, { title: t, revid: 7, content: wikitext[t]! })
        return { pages: map, missing: titles.filter((t) => !map.has(t)) }
      },
      wiki: {
        queryAll: async (_params: Record<string, any>, pick: (d: any) => any[]) => pick({ query: { allpages: list.map((p) => ({ title: p.title })) } }),
        api: async (params: Record<string, any>) => {
          calls.push(params)
          overlap ||= running > 0
          running++
          await Promise.resolve()
          running--
          const normalized: { from: string; to: string }[] = []
          const redirects: { from: string; to: string }[] = []
          const answered = new Map<string, any>()
          for (const t of String(params.titles).split('|')) {
            let cur = normalizeTitle(t)
            if (cur !== t) normalized.push({ from: t, to: cur })
            if (redirectTo[cur]) {
              redirects.push({ from: cur, to: redirectTo[cur]! })
              cur = redirectTo[cur]!
            }
            answered.set(cur, wikiPages[cur] ?? { title: cur, missing: true })
          }
          let pageList = [...answered.values()]
          // The first request answers in two parts: categories first, the page images after 'continue'.
          if (calls.length === 1) pageList = pageList.map(({ pageimage, thumbnail, ...rest }) => rest)
          if (params.picontinue) pageList = pageList.map(({ categories, ...rest }) => rest)
          return {
            query: { normalized, redirects, pages: pageList },
            ...(calls.length === 1 ? { continue: { picontinue: 20, continue: '||categories' } } : {}),
          }
        },
      },
    } as unknown as SyncContext

    const src = await fetchMapSources(ctx)
    expect(overlap).toBe(false)

    const batches = calls.map((c) => String(c.titles).split('|'))
    // 62 bases (the first 50 in two parts), 4 article titles for the two bases without a page, then 58 drop items.
    expect(batches.map((b) => b.length)).toEqual([50, 50, 12, 4, 50, 8])
    for (const c of calls.slice(0, 4)) {
      expect(c).toMatchObject({ action: 'query', prop: 'categories|pageimages', clshow: '!hidden', cllimit: 'max', redirects: 1, ...PAGE_IMAGE_QUERY })
    }
    expect(calls[1]).toMatchObject({ picontinue: 20, titles: calls[0]!.titles })
    for (const c of calls.slice(4)) {
      expect(c).toMatchObject({ action: 'query', prop: 'pageimages', redirects: 1, ...PAGE_IMAGE_QUERY })
      expect(c.clshow).toBeUndefined()
    }
    expect(batches.slice(4).flat()).toEqual([...new Set(batches.slice(4).flat())])
    expect(batches.slice(4).flat()).toEqual(expect.arrayContaining(['Clay', 'Gold ore', 'Iron ore', 'Ore 1', 'Ore 55']))

    // Node wikitext through the revision cache: only nodes that have a page.
    expect(pageRequests).toHaveLength(2)
    expect(pageRequests[1]).toEqual(
      ['Clay Node', 'Gold Ore Node', 'Granite Deposit', 'Iron Ore Node', ...ores.map((i) => `Ore ${i} Node`)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    )

    expect(src.pageCategories['Threadbare Grain Sack']).toEqual(['Category:Vestiges'])
    expect(src.pageImages).toMatchObject({
      'Iron Ore Node': { file: 'Iron_Ore_Node.png', width: 64, height: 64 },
      'Gold Ore Node': { file: 'Gold_Ore_Node.png', width: 64, height: 89 },
      'Clay Node': { file: 'Clay_Node.png', width: 64, height: 64 },
      // Through 'normalized' and 'redirects', under the requested base name.
      'goblin warrior': { file: 'Goblin_Warrior.png', width: 64, height: 89 },
      // Found under another title in the second round.
      'Threadbare Grain Sack': { file: 'Threadbare_Grain_Sack.png', width: 64, height: 64 },
    })
    expect(Object.keys(src.pageImages!).sort()).toEqual(['Clay Node', 'Gold Ore Node', 'Iron Ore Node', 'Threadbare Grain Sack', 'goblin warrior'])

    expect(src.dropImages!['Iron Ore Node']).toEqual({ item: 'Iron ore', file: 'Iron_ore.png', width: 64, height: 64 })
    // 'gold ore' is normalized, then redirected to the item page.
    expect(src.dropImages!['Gold Ore Node']).toEqual({ item: 'Gold ore', file: 'Gold_Ore.png', width: 64, height: 64 })
    expect(src.dropImages!['Ore 55 Node']).toEqual({ item: 'Ore 55', file: 'Ore_55.png', width: 64, height: 64 })
    // Clay has no page image, Granite Deposit no drops table, Lost Rock no page.
    expect(Object.keys(src.dropImages!)).toHaveLength(2 + ores.length)
    for (const base of ['Clay Node', 'Granite Deposit', 'Lost Rock']) expect(src.dropImages![base]).toBeUndefined()

    const res = run(src)
    const iconOf = (id: string) => res.map.categories.find((c) => c.id === id)?.icon
    expect(iconOf('iron-ore-node')).toBe('Iron_ore.png')
    expect(iconOf('gold-ore-node')).toBe('Gold_Ore.png')
    expect(iconOf('clay-node')).toBe('Clay_Node.png')
    expect(iconOf('granite-deposit')).toBeUndefined()
    expect(iconOf('goblin-warrior')).toBe('Goblin_Warrior.png')
    expect(iconOf('threadbare-grain-sack')).toBe('Threadbare_Grain_Sack.png')
    expect(iconOf('lost-rock')).toBeUndefined()
    expect(res.icons).toContain('Iron_ore.png')
    expect(res.icons).not.toContain('Iron_Ore_Node.png')
  })

  it('finds the drop of a node under another title, reads case duplicates once and merges clcontinue answers', async () => {
    const img = (file: string, width = 64, height = 64) => ({ pageimage: file, thumbnail: { source: `https://x/${file}`, width, height } })
    const cats = ['Category:Mining nodes', 'Category:Resources']
    const catList = cats.map((title) => ({ ns: 14, title }))
    const list = [
      page('Coal Node', [{ x: 1000, y: 1000 }]),
      // Case duplicate of 'Coal Node': the same wiki page.
      page('coal Node', [{ x: 1000, y: 1500 }]),
      // No page of its own name: found as 'The Silver Ore Node' in the second round.
      page('Silver Ore Node', [{ x: 2000, y: 1000 }]),
      page('Tin Ore Node', [{ x: 3000, y: 1000 }]),
    ]
    const wikiPages: Record<string, any> = {
      'Coal Node': { title: 'Coal Node', categories: catList, ...img('Coal_Node.png') },
      'Tin Ore Node': { title: 'Tin Ore Node', categories: catList, ...img('Tin_Ore_Node.png') },
      'The Silver Ore Node': { title: 'The Silver Ore Node', categories: catList, ...img('Silver_Ore_Node.png', 64, 89) },
      Coal: { title: 'Coal', ...img('Coal.png') },
      'Tin ore': { title: 'Tin ore', ...img('Tin_ore.png') },
      'Silver Ore': { title: 'Silver Ore', ...img('Silver_Ore.png') },
    }
    const redirectTo: Record<string, string> = { 'Silver ore': 'Silver Ore' }
    const wikitext: Record<string, string> = {
      'Coal Node': '{{DropsTableHead}}\n{{DropsLine|name=Coal|quantity=1}}\n{{DropsTableBottom}}',
      'Tin Ore Node': '{{Drops table|\n{{DropsLine|name={{plink|Tin ore|txt=Tin}}|quantity=1}}\n}}',
      'The Silver Ore Node': '{{DropsTableHead}}\n{{DropsLine|name=[[silver ore|Silver]]}}\n{{DropsLine|name=Sapphire}}',
    }

    const calls: Record<string, any>[] = []
    const pageRequests: string[][] = []
    const ctx = {
      log: () => {},
      full: false,
      revisions: new Map(),
      pages: async (titles: string[]) => {
        pageRequests.push(titles)
        const map = new Map<string, RawPage>()
        for (const p of list) if (titles.includes(p.title)) map.set(p.title, p)
        for (const t of titles) if (wikitext[t] !== undefined) map.set(t, { title: t, revid: 3, content: wikitext[t]! })
        return { pages: map, missing: titles.filter((t) => !map.has(t)) }
      },
      wiki: {
        queryAll: async (_params: Record<string, any>, pick: (d: any) => any[]) => pick({ query: { allpages: list.map((p) => ({ title: p.title })) } }),
        api: async (params: Record<string, any>) => {
          calls.push(params)
          const normalized: { from: string; to: string }[] = []
          const redirects: { from: string; to: string }[] = []
          const answered = new Map<string, any>()
          for (const t of String(params.titles).split('|')) {
            let cur = normalizeTitle(t)
            if (cur !== t) normalized.push({ from: t, to: cur })
            if (redirectTo[cur]) {
              redirects.push({ from: cur, to: redirectTo[cur]! })
              cur = redirectTo[cur]!
            }
            answered.set(cur, wikiPages[cur] ?? { title: cur, missing: true })
          }
          const query = { normalized, redirects }
          if (params.prop !== 'categories|pageimages') return { query: { ...query, pages: [...answered.values()] } }
          // Like MediaWiki: the page images and the first category first, the other categories after clcontinue,
          // without the page images again (that module is done).
          if (!params.clcontinue) {
            const pages = [...answered.values()].map((p) => (p.missing ? p : { ...p, categories: p.categories.slice(0, 1) }))
            return { query: { ...query, pages }, continue: { clcontinue: 'c1', continue: '||pageimages' } }
          }
          const pages = [...answered.values()].map(({ pageimage, thumbnail, ...p }) => (p.missing ? p : { ...p, categories: p.categories.slice(1) }))
          return { query: { ...query, pages } }
        },
      },
    } as unknown as SyncContext

    const src = await fetchMapSources(ctx)

    expect(calls.map((c) => String(c.titles).split('|').length)).toEqual([4, 4, 2, 2, 3])
    expect(calls[1]).toMatchObject({ clcontinue: 'c1', continue: '||pageimages', titles: calls[0]!.titles })
    expect(calls[3]).toMatchObject({ clcontinue: 'c1', continue: '||pageimages', titles: 'A Silver Ore Node|The Silver Ore Node' })
    expect(calls[4]).toMatchObject({ prop: 'pageimages', titles: 'Coal|Silver ore|Tin ore' })
    // One read per wiki page: 'coal Node' and 'Coal Node' are the same, the renamed node is read under its real title.
    expect(pageRequests[1]).toEqual(['Coal Node', 'The Silver Ore Node', 'Tin Ore Node'])

    expect(src.pageTitles).toEqual({ 'Silver Ore Node': 'The Silver Ore Node' })
    expect(src.pageCategories['Silver Ore Node']).toEqual(cats)
    expect(src.pageCategories['coal Node']).toEqual(cats)
    expect(src.pageImages).toEqual({
      'Coal Node': { file: 'Coal_Node.png', width: 64, height: 64 },
      'coal Node': { file: 'Coal_Node.png', width: 64, height: 64 },
      'Silver Ore Node': { file: 'Silver_Ore_Node.png', width: 64, height: 89 },
      'Tin Ore Node': { file: 'Tin_Ore_Node.png', width: 64, height: 64 },
    })
    expect(src.dropImages).toEqual({
      'Coal Node': { item: 'Coal', file: 'Coal.png', width: 64, height: 64 },
      'coal Node': { item: 'Coal', file: 'Coal.png', width: 64, height: 64 },
      'Silver Ore Node': { item: 'Silver ore', file: 'Silver_Ore.png', width: 64, height: 64 },
      'Tin Ore Node': { item: 'Tin ore', file: 'Tin_ore.png', width: 64, height: 64 },
    })

    const res = run(src)
    expect(res.map.categories.map((c) => [c.id, c.wikiPage, c.icon])).toEqual([
      ['coal-node', 'Coal Node', 'Coal.png'],
      ['silver-ore-node', 'The Silver Ore Node', 'Silver_Ore.png'],
      ['tin-ore-node', 'Tin Ore Node', 'Tin_ore.png'],
    ])
    expect(res.icons).toEqual(['Coal.png', 'Silver_Ore.png', 'Tin_ore.png'])
    expect(res.warnings).toEqual([])
  })
})

describe('parseMap fallback icons', () => {
  const nodes = ['Category:Mining nodes']
  const scenery = ['Category:Scenery']
  const list = [
    page('Iron Ore Node', [{ x: 1000, y: 1000 }, { x: 1600, y: 1000 }]),
    page('Gold Ore Node', [
      { x: 2000, y: 1000, icon: 'Gold_Ore.png' },
      { x: 2600, y: 1000, icon: 'Gold_Ore.png' },
    ]),
    page('Clay Node', [{ x: 3000, y: 1000 }]),
    page('Goblin Warrior', [
      { x: 4000, y: 1000 },
      { x: 4600, y: 1000, icon: 'Goblin_Warrior.png' },
      { x: 5200, y: 1000, icon: 'Goblin_Chief.png' },
    ]),
    page('Temple of Saradomin', [{ x: 6000, y: 1000 }]),
    page('Tall Banner', [{ x: 7000, y: 1000 }]),
    page('Old Map', [{ x: 8000, y: 1000 }]),
    page('Mystery Box', [{ x: 9000, y: 1000 }]),
    page('Ratcatcher', [{ x: 10000, y: 1000 }]),
    page('Lost Journal', [{ x: 11000, y: 1000 }]),
  ]
  const src: MapSources = {
    pages: list,
    pageCategories: {
      'Iron Ore Node': nodes,
      'Gold Ore Node': nodes,
      'Clay Node': nodes,
      'Goblin Warrior': ['Category:Monsters'],
      'Temple of Saradomin': scenery,
      'Tall Banner': scenery,
      'Old Map': scenery,
      'Mystery Box': scenery,
      Ratcatcher: ['Category:Quests'],
    },
    missingPages: ['Lost Journal'],
    pageImages: {
      'Iron Ore Node': { file: 'Iron_Ore_Node.png', width: 64, height: 64 },
      'Gold Ore Node': { file: 'Gold_Ore_Node.png', width: 64, height: 89 },
      'Clay Node': { file: 'Clay_Node.png', width: 64, height: 64 },
      'Goblin Warrior': { file: 'Goblin_Warrior.png', width: 64, height: 89 },
      // A wide screenshot of the place.
      'Temple of Saradomin': { file: 'Temple_of_Saradomin.png', width: 64, height: 36 },
      'Tall Banner': { file: 'Tall_Banner.png', width: 64, height: 200 },
      'Old Map': { file: 'Old_Map.jpg', width: 64, height: 64 },
      'Mystery Box': { file: 'Mystery_Box.png' },
      Ratcatcher: { file: 'Ratcatcher.png', width: 64, height: 64 },
      'Lost Journal': { file: 'Lost_Journal.png', width: 64, height: 64 },
    },
    dropImages: {
      'Iron Ore Node': { item: 'Iron ore', file: 'Iron_ore.png', width: 64, height: 64 },
      'Gold Ore Node': { item: 'Gold ore', file: 'Gold_ore_item.png', width: 64, height: 64 },
      // Only nodes use their drop.
      'Goblin Warrior': { item: 'Bones', file: 'Bones.png', width: 64, height: 64 },
    },
  }
  const res = run(src)
  const iconOf = (id: string) => res.map.categories.find((c) => c.id === id)!.icon

  it.each<[string, string | undefined]>([
    // Module:Map icon wins over the drop and the page image.
    ['gold-ore-node', 'Gold_Ore.png'],
    // Node: the page image of its main drop, not the look-alike node render.
    ['iron-ore-node', 'Iron_ore.png'],
    // Node without a drop image: its own page image.
    ['clay-node', 'Clay_Node.png'],
    // Not a node: its own page image, never the drop.
    ['goblin-warrior', 'Goblin_Warrior.png'],
    // Too wide, too tall, not a PNG, shape unknown, a quest page, no wiki page.
    ['temple-of-saradomin', undefined],
    ['tall-banner', undefined],
    ['old-map', undefined],
    ['mystery-box', undefined],
    ['ratcatcher', undefined],
    ['lost-journal', undefined],
  ])('%s gets %s', (id, icon) => {
    expect(iconOf(id)).toBe(icon)
  })

  it('lists the fallback files for download, and nothing it did not use', () => {
    expect(res.icons).toEqual(['Clay_Node.png', 'Goblin_Chief.png', 'Goblin_Warrior.png', 'Gold_Ore.png', 'Iron_ore.png'])
  })

  it('keeps other point icons and never repeats the category icon on a point', () => {
    expect(res.map.points.filter((p) => p.categoryId === 'goblin-warrior').map((p) => p.icon)).toEqual([undefined, undefined, 'Goblin_Chief.png'])
    for (const p of res.map.points) if (p.icon) expect(p.icon).not.toBe(iconOf(p.categoryId))
  })

  it('never warns about a missing icon, and does not depend on page order', () => {
    expect(res.warnings).toEqual([])
    expect(JSON.stringify(run({ ...src, pages: [...list].reverse() }).map)).toBe(JSON.stringify(res.map))
  })

  it('changes nothing else in the output', () => {
    const plain = run({ ...src, pageImages: undefined, dropImages: undefined })
    const strip = (cats: typeof res.map.categories) => cats.map(({ icon, ...rest }) => rest)
    expect(strip(res.map.categories)).toEqual(strip(plain.map.categories))
    expect(res.map.points.map((p) => p.id)).toEqual(plain.map.points.map((p) => p.id))
    expect(plain.map.categories.filter((c) => c.icon).map((c) => c.id)).toEqual(['gold-ore-node'])
  })

  it('finds the image of a page under another title or with a normalized name', () => {
    const other = run({
      pages: [page('Threadbare Grain Sack', [{ x: 1, y: 1 }]), page('zogre', [{ x: 900, y: 900 }])],
      pageCategories: { 'Threadbare Grain Sack': ['Category:Vestiges'], Zogre: ['Category:Monsters'] },
      missingPages: [],
      pageTitles: { 'Threadbare Grain Sack': 'A Threadbare Grain Sack' },
      pageImages: {
        'Threadbare Grain Sack': { file: 'Threadbare_Grain_Sack.png', width: 64, height: 64 },
        Zogre: { file: 'Zogre.png', width: 64, height: 80 },
      },
    })
    expect(other.map.categories.map((c) => [c.id, c.wikiPage, c.icon])).toEqual([
      ['threadbare-grain-sack', 'A Threadbare Grain Sack', 'Threadbare_Grain_Sack.png'],
      ['zogre', 'Zogre', 'Zogre.png'],
    ])
  })
})

describe('titleKey', () => {
  it.each([
    ['Weathered Diary (Fellhollow)', 'weathered-diary'],
    ['Recipe: Meat Sandwich', 'recipe-meat-sandwich'],
    ["Ravanna's First Journal", 'ravannas-first-journal'],
    ['Entomologist’s Journal [Umbral Sands]', 'entomologists-journal'],
    ['Vault (Kalphite)', 'vault'],
    ['(Unknown)', ''],
  ])('%s -> %s', (title, key) => {
    expect(titleKey(title)).toBe(key)
  })

  it('reaches twins of at most TWIN_DISTANCE in the lore, unique and vault groups', () => {
    expect(TWIN_DISTANCE).toBe(500)
    expect([...TWIN_GROUPS].sort()).toEqual(['lore', 'unique', 'vault'])
  })
})

describe('text helpers', () => {
  it.each([
    ['Tier 3', { power: 3 }],
    ['Tier 6', { power: 6 }],
    ['Tier3_World', { power: 3 }],
    ['Tier3+_World', { power: 3 }],
    ['Tier3_World_Highlands', { power: 3, region: 'Ghornfell' }],
    ['Tier4_World_Highlands_Cape', { power: 4, region: 'Ghornfell', text: 'Cape vestige', hint: true }],
    ['Tier2_World_Vestige_TrainingSword', { power: 2, text: 'Vestige: Training Sword', hint: true }],
    ['Tier4_World_ToxicSwamp_Cape', { power: 4, text: 'Toxic Swamp, Cape vestige', hint: true }],
  ])('tier code %s', (input, expected) => {
    expect(parseTierCode(input)).toEqual(expected)
    expect(parseDescription(input)).toEqual(expected)
  })

  it.each([
    ['Zombie (Fellhollow) - Power Level 4', ['Zombie'], { power: 4, region: 'Fellhollow' }],
    ['Skeletal Archer (Dowdun) - Power Level 6', ['Skeletal Archer'], { power: 6, region: 'Dowdun Reach' }],
    ['Black Dragon (Power Level 9)', ['Black Dragon'], { power: 9 }],
    ['Bramblemead Cape Tier 2', ['Bramblemead Cape'], { power: 2 }],
    ['Brynmore', [], { region: 'Brynmoor' }],
    ['Felhollow', [], { region: 'Fellhollow' }],
    ['Dowdun Reach', [], { region: 'Dowdun Reach' }],
    ['Fractured Plains', [], { region: 'Ghornfell', text: 'Fractured Plains' }],
    ['Whispering Swamp (Inside Cave)', [], { region: 'Brynmoor', text: 'Whispering Swamp (Inside Cave)' }],
    ['The location of a Sanguine Urn in Dowdun Reach.', [], { region: 'Dowdun Reach', text: 'The location of a Sanguine Urn in Dowdun Reach.' }],
    ['The location of the Vault, north of Dunes of Uzzer at the pyramid.', [], { region: 'Umbral Sands', text: 'The location of the Vault, north of Dunes of Uzzer at the pyramid.' }],
    ['Gateway between Fellhollow and Dowdun Reach', [], { text: 'Gateway between Fellhollow and Dowdun Reach' }],
    ['182777.476, 58573.508', [], {}],
    ['jewellery_box', ['Jewellery Box'], {}],
    ['Small Egg', ['Kalphite Queen Egg'], { text: 'Small Egg' }],
  ])('description %s', (input, labels, expected) => {
    expect(parseDescription(input, labels)).toEqual(expected)
  })

  it('knows regions, sub-areas and misspellings', () => {
    expect(regionOf('Brynmoor')).toEqual({ region: 'Brynmoor' })
    expect(regionOf('the Scorned Wilderness')).toEqual({ region: 'Scorned Wilderness' })
    expect(regionOf('Lake of Lost Souls')).toEqual({ region: 'Fellhollow', area: 'Lake of Lost Souls' })
    expect(regionOf('Temple Woods')?.region).toBe('Brynmoor')
    expect(regionOf('Bloodblight Swamp')?.region).toBe('Ghornfell')
    expect(regionOf('Emberwood')?.region).toBe('Fellhollow')
    expect(regionOf("Cook's Assistant")).toBeUndefined()
    expect(regionsMentioned('Chest that contains the vestige Fell Cape, that unlocks the Fellhollow Cape.')).toEqual(['Fellhollow'])
    expect(regionsMentioned('Chest contains the vestige that unlocks the Bloodblight Cape.')).toEqual([])
  })

  it.each([
    ['Treasure Chest (Brynmoor)', { label: 'Treasure Chest', region: 'Brynmoor' }],
    ['Treasure Chest (Vestige Chance) (Dowdun Reach)', { label: 'Treasure Chest', region: 'Dowdun Reach', qualifier: 'Vestige Chance' }],
    ['Treasure Chest (Umbral Sands Cape)', { label: 'Treasure Chest', region: 'Umbral Sands', suffix: 'Umbral Sands Cape' }],
    ['Weathered Diary (Bramblemead Valley)', { label: 'Weathered Diary', region: 'Brynmoor', area: 'Bramblemead Valley' }],
    ['Treasure Chest (Scorned Wilderness)', { label: 'Treasure Chest', region: 'Scorned Wilderness' }],
    ["Cow (Cook's Assistant)", { label: "Cow (Cook's Assistant)" }],
    ['Fractured Ruins (Agility Course)', { label: 'Fractured Ruins (Agility Course)' }],
    ['chests', { label: 'Treasure Chest' }],
  ])('family of %s', (base, expected) => {
    expect(familyOf(base)).toEqual(expected)
  })

  it('recognises junk pages', () => {
    expect(junkReason('User:Jsfour/sandbox')).toBeDefined()
    expect(junkReason('test')).toBeDefined()
    expect(junkReason('HealingPotionTest')).toBeDefined()
    expect(junkReason('abyssalwhipstatue')).toBeDefined()
    expect(junkReason('Contest')).toBeUndefined()
    expect(junkReason('zogre')).toBeUndefined()
    expect(junkReason('chests')).toBeUndefined()
  })
})

describe('classifyGroups', () => {
  const input = (label: string, cats: string[], extra: { names?: string[]; pointCount?: number } = {}) => ({
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    label,
    categories: cats,
    pointCount: extra.pointCount ?? 1,
    names: extra.names ?? [],
  })

  it('follows the priority order', () => {
    const groups = classifyGroups([
      input('Some Quest', ['Quests', 'Some Quest']),
      input('Quest Well', ['Scenery', 'Some Quest']),
      input('Big Boss', ['Bosses', 'Non-player characters']),
      input('Herb', ['Basic Items', 'Items'], { pointCount: 40 }),
      input('Holy Symbol', ['Basic Items', 'Items']),
      input('Spike Trap', ['Dragonkin Vaults']),
      input('Some Quest Map', [], { names: ['Quest Well', 'Some Quest'], pointCount: 2 }),
      input('Tall Tower', ['Scenery']),
      input('Recipe: Pie', []),
      input('Mystery', []),
    ])
    expect(Object.fromEntries([...groups].map(([id, r]) => [id, r.group]))).toEqual({
      'some-quest': 'quest',
      'quest-well': 'quest',
      'big-boss': 'monster',
      herb: 'resource',
      'holy-symbol': 'unique',
      'spike-trap': 'monster',
      'some-quest-map': 'quest',
      'tall-tower': 'location',
      'recipe-pie': 'unique',
      mystery: 'other',
    })
  })
})
