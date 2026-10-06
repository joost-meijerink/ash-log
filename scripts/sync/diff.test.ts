import { describe, expect, it } from 'vitest'
import { mapCategoryId, mapPointId, questItemId, questStepId, rewardId, wikiUrl } from '../../src/lib/ids'
import { emptyOverrides, emptyProgress } from '../../src/lib/normalize'
import type {
  DiffReport,
  MapCategory,
  MapData,
  MapPoint,
  Progress,
  Quest,
  Reward,
  RewardKind,
  SyncDomain,
  SyncWarning,
  Vault,
} from '../../src/lib/types'
import { buildReport, findDanglingRefs, formatReport, type ReportInput, type WikiSnapshot } from './diff'
import { PARTIAL_WRITE_PREFIX } from './files'

const ALL: SyncDomain[] = ['map', 'quests', 'vaults', 'rewards']
const SYNCED_AT = '2026-09-28T10:00:00.000Z'
const EMPTY: WikiSnapshot = { map: null, quests: null, vaults: null, rewards: null }

function category(label: string, extra: Partial<MapCategory> = {}): MapCategory {
  const id = mapCategoryId(label)
  return { id, label, group: 'resource', sources: [`Module:Map/${label}.json`], count: 0, ...extra }
}

function point(categoryId: string, x: number, y: number, extra: Partial<MapPoint> = {}): MapPoint {
  return { id: mapPointId(categoryId, x, y), categoryId, x, y, ...extra }
}

function mapData(categories: MapCategory[], points: MapPoint[]): MapData {
  return {
    categories: categories.map((c) => ({ ...c, count: points.filter((p) => p.categoryId === c.id).length })),
    points,
  }
}

function quest(id: string, steps: string[], extra: Partial<Quest> = {}): Quest {
  return {
    id,
    name: id,
    kind: 'primary',
    location: 'Somewhere',
    steps: steps.map((text) => ({ id: questStepId(id, text), text })),
    stepsSource: 'walkthrough',
    items: [],
    rewards: [],
    requires: [],
    wikiUrl: wikiUrl(id),
    ...extra,
  }
}

function vault(name: string, order: number, extra: Partial<Vault> = {}): Vault {
  return { id: name, name, order, power: order, area: 'Temple Woods', recipes: [], ...extra }
}

function reward(kind: RewardKind, name: string, extra: Partial<Reward> = {}): Reward {
  return { id: rewardId(kind, name), kind, name, ...extra }
}

function input(partial: Partial<ReportInput>): ReportInput {
  return {
    syncedAt: SYNCED_AT,
    domains: ALL,
    prev: EMPTY,
    next: EMPTY,
    progress: emptyProgress(),
    warnings: [],
    ...partial,
  }
}

const gold = category('Gold Ore Node')
const silver = category('Silver Ore Node')
const chest = category('Treasure Chest', { group: 'chest' })

const baseMap = mapData(
  [gold, silver, chest],
  [
    point(gold.id, 100.4, 200.2),
    point(gold.id, 300, 400),
    point(silver.id, 10, 20),
    point(chest.id, 5000, -6000, { power: 3, region: 'Brynmoor' }),
  ],
)

const ratcatcher = quest('Ratcatcher', ['Talk to Hild in Fellhollow.', 'Kill 4 rats.', 'Return to Hild.'], {
  items: [{ id: questItemId('Ratcatcher', 'Raw rat meat'), name: 'Raw rat meat', qty: 4 }],
})
const dragonSlayer = quest('Dragon Slayer', ['Speak to the Guildmaster.', 'Slay the dragon.'])
const baseVaults = [vault('Crasorak Kara', 1), vault('Uzzer Kara', 2)]
const baseRewards = [reward('plan', 'Blue Standing Torch'), reward('pattern', 'Red Cape')]

const baseSnapshot: WikiSnapshot = {
  map: baseMap,
  quests: [ratcatcher, dragonSlayer],
  vaults: baseVaults,
  rewards: baseRewards,
}

describe('buildReport', () => {
  it('counts everything as added on a first sync', () => {
    const report = buildReport(input({ prev: EMPTY, next: baseSnapshot }))

    expect(report.ok).toBe(true)
    expect(report.syncedAt).toBe(SYNCED_AT)
    expect(report.domains).toEqual(ALL)
    expect(report.map?.categories).toEqual({
      added: ['gold-ore-node', 'silver-ore-node', 'treasure-chest'],
      removed: [],
      changed: [],
    })
    expect(Object.keys(report.map!.points)).toEqual(['gold-ore-node', 'silver-ore-node', 'treasure-chest'])
    expect(report.map!.points['gold-ore-node']).toEqual({
      added: ['gold-ore-node:100:200', 'gold-ore-node:300:400'],
      removed: [],
      changed: [],
    })
    expect(report.quests?.quests.added).toEqual(['Dragon Slayer', 'Ratcatcher'])
    // New quests are listed once, not with every step.
    expect(report.quests?.steps).toEqual([])
    expect(report.vaults?.vaults.added).toEqual(['Crasorak Kara', 'Uzzer Kara'])
    expect(report.rewards?.rewards.added).toEqual(['pattern:red-cape', 'plan:blue-standing-torch'])
    expect(report.orphans).toEqual({ quests: [], steps: [], items: [], points: [], vaults: [], rewards: [] })
    expect(report.warnings).toEqual([])
  })

  it('reports nothing when nothing changed', () => {
    const report = buildReport(input({ prev: baseSnapshot, next: structuredClone(baseSnapshot) }))
    expect(report.map).toEqual({ categories: { added: [], removed: [], changed: [] }, points: {} })
    expect(report.quests).toEqual({ quests: { added: [], removed: [], changed: [] }, steps: [] })
    expect(report.vaults?.vaults).toEqual({ added: [], removed: [], changed: [] })
    expect(report.rewards?.rewards).toEqual({ added: [], removed: [], changed: [] })
  })

  it('finds added, removed and changed points per category', () => {
    const next = mapData(
      [gold, silver, chest],
      [
        point(gold.id, 100.4, 200.2, { name: 'Gold Ore Node' }), // changed
        point(gold.id, 700, 800), // added (300:400 removed, count stays 2)
        point(silver.id, 10, 20), // unchanged
        point(chest.id, 5000, -6000, { power: 4, region: 'Brynmoor' }), // changed power
      ],
    )
    const report = buildReport(input({ domains: ['map'], prev: { ...EMPTY, map: baseMap }, next: { ...EMPTY, map: next } }))

    expect(report.map!.categories).toEqual({ added: [], removed: [], changed: [] })
    expect(report.map!.points).toEqual({
      'gold-ore-node': { added: ['gold-ore-node:700:800'], removed: ['gold-ore-node:300:400'], changed: ['gold-ore-node:100:200'] },
      'treasure-chest': { added: [], removed: [], changed: ['treasure-chest:5000:-6000'] },
    })
  })

  it('reports added and removed categories with their points', () => {
    const lore = category('Lore Scraps', { group: 'lore' })
    const next = mapData([gold, chest, lore], [...baseMap.points.filter((p) => p.categoryId !== silver.id), point(lore.id, 1, 2)])
    const report = buildReport(input({ domains: ['map'], prev: { ...EMPTY, map: baseMap }, next: { ...EMPTY, map: next } }))

    expect(report.map!.categories).toEqual({ added: ['lore-scraps'], removed: ['silver-ore-node'], changed: [] })
    expect(report.map!.points['lore-scraps']).toEqual({ added: ['lore-scraps:1:2'], removed: [], changed: [] })
    expect(report.map!.points['silver-ore-node']).toEqual({ added: [], removed: ['silver-ore-node:10:20'], changed: [] })
    expect(report.map!.points['gold-ore-node']).toBeUndefined()
  })

  it('ignores key order and undefined fields when comparing', () => {
    const p = point(gold.id, 1, 2, { name: 'A', description: 'B' })
    const reordered = { description: 'B', name: 'A', region: undefined, y: 2, x: 1, categoryId: gold.id, id: p.id } as MapPoint
    const report = buildReport(
      input({
        domains: ['map'],
        prev: { ...EMPTY, map: mapData([gold], [p]) },
        next: { ...EMPTY, map: mapData([gold], [reordered]) },
      }),
    )
    expect(report.map!.points).toEqual({})
  })

  it('lists added and removed steps of changed quests', () => {
    const nextRat = quest('Ratcatcher', ['Talk to Hild in Fellhollow.', 'Kill 5 rats.', 'Return to Hild.', 'Collect your reward.'], {
      items: ratcatcher.items,
    })
    const reordered = quest('Dragon Slayer', ['Slay the dragon.', 'Speak to the Guildmaster.'])
    const newQuest = quest('Rune Mysteries', ['Find the talisman.'])
    const report = buildReport(
      input({
        domains: ['quests'],
        prev: { ...EMPTY, quests: [ratcatcher, dragonSlayer] },
        next: { ...EMPTY, quests: [nextRat, reordered, newQuest] },
      }),
    )

    expect(report.quests!.quests).toEqual({ added: ['Rune Mysteries'], removed: [], changed: ['Dragon Slayer', 'Ratcatcher'] })
    // Reordering keeps every step id, so only Ratcatcher shows up here.
    expect(report.quests!.steps).toEqual([
      {
        questId: 'Ratcatcher',
        added: [
          { id: questStepId('Ratcatcher', 'Kill 5 rats.'), text: 'Kill 5 rats.' },
          { id: questStepId('Ratcatcher', 'Collect your reward.'), text: 'Collect your reward.' },
        ],
        removed: [{ id: questStepId('Ratcatcher', 'Kill 4 rats.'), text: 'Kill 4 rats.' }],
      },
    ])
  })

  it('marks a quest as changed without step changes when only other fields differ', () => {
    const report = buildReport(
      input({
        domains: ['quests'],
        prev: { ...EMPTY, quests: [ratcatcher] },
        next: { ...EMPTY, quests: [{ ...ratcatcher, rewards: ['Ratcatcher cape'] }] },
      }),
    )
    expect(report.quests!.quests.changed).toEqual(['Ratcatcher'])
    expect(report.quests!.steps).toEqual([])
  })

  it('diffs vaults and rewards by id', () => {
    const report = buildReport(
      input({
        domains: ['vaults', 'rewards'],
        prev: { ...EMPTY, vaults: baseVaults, rewards: baseRewards },
        next: {
          ...EMPTY,
          vaults: [vault('Crasorak Kara', 1, { recipes: [{ name: "Paladin's helm", set: 'Paladin armour set' }] }), vault('Manafem Kara', 3)],
          rewards: [reward('plan', 'Blue Standing Torch'), reward('pattern', 'Red Cape', { source: 'Shop' }), reward('fishing-trophy', 'Trout')],
        },
      }),
    )
    expect(report.vaults!.vaults).toEqual({ added: ['Manafem Kara'], removed: ['Uzzer Kara'], changed: ['Crasorak Kara'] })
    expect(report.rewards!.rewards).toEqual({ added: ['fishing-trophy:trout'], removed: [], changed: ['pattern:red-cape'] })
  })

  it('only includes sections for refreshed domains', () => {
    const next: WikiSnapshot = { ...baseSnapshot, quests: [quest('Ratcatcher', ['Only step.'])] }
    const report = buildReport(input({ domains: ['quests'], prev: baseSnapshot, next }))
    expect(report.domains).toEqual(['quests'])
    expect(report.map).toBeUndefined()
    expect(report.vaults).toBeUndefined()
    expect(report.rewards).toBeUndefined()
    expect(report.quests!.quests.removed).toEqual(['Dragon Slayer'])
  })

  it('finds orphans over the complete snapshot, including domains that were not refreshed', () => {
    const progress: Progress = {
      ...emptyProgress(),
      quests: {
        'Gone Quest': { steps: ['Gone Quest:s:00000000'], items: [] },
        Ratcatcher: {
          steps: [ratcatcher.steps[0]!.id, 'Ratcatcher:s:deadbeef', 'Ratcatcher:s:0badf00d'],
          items: [ratcatcher.items[0]!.id, 'Ratcatcher:i:ash-logs', 'Ratcatcher:i:bronze-bar'],
        },
      },
      points: {
        [baseMap.points[0]!.id]: { foundAt: SYNCED_AT },
        'lore-scraps:9:9': { foundAt: SYNCED_AT },
      },
      vaults: { 'Crasorak Kara': { done: true }, 'Old Kara': { done: true } },
      rewards: { 'plan:blue-standing-torch': { at: SYNCED_AT }, 'plan:removed-plan': { at: SYNCED_AT } },
    }
    const overrides = emptyOverrides()
    overrides.questItems.Ratcatcher = [{ id: 'Ratcatcher:i:ash-logs', name: 'Ash logs', qty: 4 }]

    const report = buildReport(input({ domains: ['quests'], prev: baseSnapshot, next: baseSnapshot, progress, overrides }))

    expect(report.orphans).toEqual({
      quests: ['Gone Quest'],
      steps: ['Ratcatcher:s:0badf00d', 'Ratcatcher:s:deadbeef'],
      // The override item keeps its checkmark, the unknown one is orphaned.
      items: ['Ratcatcher:i:bronze-bar'],
      points: ['lore-scraps:9:9'],
      vaults: ['Old Kara'],
      rewards: ['plan:removed-plan'],
    })
  })

  it('reports an override item as orphaned when no overrides are passed', () => {
    const progress: Progress = { ...emptyProgress(), quests: { Ratcatcher: { steps: [], items: ['Ratcatcher:i:ash-logs'] } } }
    const report = buildReport(input({ prev: baseSnapshot, next: baseSnapshot, progress }))
    expect(report.orphans.items).toEqual(['Ratcatcher:i:ash-logs'])
  })

  it('reports no orphans for a domain that was never synced', () => {
    const progress: Progress = { ...emptyProgress(), vaults: { 'Crasorak Kara': { done: true } } }
    const report = buildReport(input({ domains: ['map'], next: { ...EMPTY, map: baseMap }, progress }))
    expect(report.orphans.vaults).toEqual([])
  })

  it('passes warnings through untouched', () => {
    const warnings: SyncWarning[] = [
      { source: 'map', page: 'Module:Map/test.json', message: 'unknown format' },
      { source: 'assets', message: 'no image' },
    ]
    const report = buildReport(input({ warnings }))
    expect(report.warnings).toEqual(warnings)
    expect(report.warnings).not.toBe(warnings)
  })
})

describe('findDanglingRefs', () => {
  const goldPoint = baseMap.points[0]!
  const linked: WikiSnapshot = {
    map: baseMap,
    quests: [quest('Ratcatcher', [], { startPointId: goldPoint.id })],
    vaults: [vault('Crasorak Kara', 1, { pointId: goldPoint.id })],
    rewards: [reward('quest', 'Rat Hat', { questId: 'Ratcatcher', vaultId: 'Crasorak Kara', pointIds: [goldPoint.id] })],
  }

  it('finds nothing when every link resolves', () => {
    expect(findDanglingRefs(linked)).toEqual([])
  })

  it('names every link that points at nothing', () => {
    const next: WikiSnapshot = {
      map: baseMap,
      quests: [quest('Ratcatcher', [], { startPointId: 'ratcatcher:100:200' })],
      vaults: [vault('Crasorak Kara', 1, { pointId: 'vaults:1:2' })],
      rewards: [reward('quest', 'Rat Hat', { questId: 'Gone Quest', vaultId: 'Gone Kara', pointIds: [goldPoint.id, 'recipe-book:5:5'] })],
    }
    const warnings = findDanglingRefs(next)
    expect(warnings.every((w) => w.source === 'sync')).toBe(true)
    expect(warnings.map((w) => (w.page ? `${w.page}: ${w.message}` : w.message))).toEqual([
      'Ratcatcher: start point ratcatcher:100:200 is no longer on the map. Run a full sync.',
      'Crasorak Kara: map point vaults:1:2 is no longer on the map. Run a full sync.',
      'Reward quest:rat-hat points to quest Gone Quest, which no longer exists. Run a full sync.',
      'Reward quest:rat-hat points to vault Gone Kara, which no longer exists. Run a full sync.',
      'Reward quest:rat-hat points to map point recipe-book:5:5, which is no longer on the map. Run a full sync.',
    ])
  })

  it('skips domains that were never synced', () => {
    const next: WikiSnapshot = { ...EMPTY, rewards: linked.rewards, quests: [quest('Ratcatcher', [], { startPointId: 'x:1:1' })] }
    expect(findDanglingRefs(next)).toEqual([])
  })
})

describe('formatReport', () => {
  const EM_DASH = String.fromCodePoint(0x2014)

  function changedReport(): DiffReport {
    const nextRat = quest('Ratcatcher', ['Talk to Hild in Fellhollow.', 'Kill 5 rats.', 'Return to Hild.'])
    const progress: Progress = {
      ...emptyProgress(),
      quests: { Ratcatcher: { steps: [questStepId('Ratcatcher', 'Kill 4 rats.')], items: [] } },
      points: { 'lore-scraps:9:9': { foundAt: SYNCED_AT } },
    }
    return buildReport(
      input({
        prev: baseSnapshot,
        next: {
          ...baseSnapshot,
          map: mapData([gold, silver, chest], [...baseMap.points, point(gold.id, 1, 1), point(gold.id, 2, 2)]),
          quests: [nextRat, dragonSlayer],
          rewards: [...baseRewards, reward('recipe-book', 'Cooking Basics')],
        },
        progress,
        warnings: [
          { source: 'map', page: 'Module:Map/test.json', message: 'unknown format, skipped' },
          { source: 'quests', page: 'Statues of Saradomin', message: 'no qtype, not a quest' },
        ],
      }),
    )
  }

  it('summarises changes per domain', () => {
    const text = formatReport(changedReport())
    expect(text).toMatch(/^Sync done \(\d{1,2} [A-Z][a-z]{2} 2026, \d{2}:\d{2}\), updated: map, quests, vaults, rewards/)
    // The gold category changed because its point count went up.
    expect(text).toContain('Categories: 0 new, 0 removed, 1 changed')
    expect(text).toContain('Points: 2 new, 0 removed, 0 changed')
    expect(text).toContain('gold-ore-node: 2 new')
    expect(text).toContain('Quests: 0 new, 0 removed, 1 changed')
    expect(text).toContain('Ratcatcher: 1 new, 1 removed')
    expect(text).toContain('- Kill 4 rats.')
    expect(text).toContain('+ Kill 5 rats.')
    expect(text).toContain('Vaults: no changes')
    expect(text).toContain('Rewards: 1 new, 0 removed, 0 changed')
    expect(text).not.toContain(EM_DASH)
  })

  it('mentions orphans with a hint that sync never deletes them', () => {
    const text = formatReport(changedReport())
    expect(text).toContain('Orphaned progress: 2 (1 step, 1 map point)')
    expect(text).toContain('Sync never deletes anything')
    expect(formatReport(buildReport(input({ next: baseSnapshot })))).toContain('No orphaned progress.')
  })

  it('groups warnings by source and caps the list', () => {
    const warnings: SyncWarning[] = [
      ...Array.from({ length: 30 }, (_, i): SyncWarning => ({ source: 'map', page: `Module:Map/p${i}.json`, message: 'broken' })),
      ...Array.from({ length: 25 }, (_, i): SyncWarning => ({ source: 'assets', message: `icon ${i} missing` })),
      { source: 'sync', message: 'heads up' },
    ]
    const text = formatReport(buildReport(input({ domains: [], warnings })))
    expect(text).toContain('Warnings: 56')
    const lines = text.split('\n')
    const syncHeader = lines.indexOf('  Sync (1)')
    const mapHeader = lines.indexOf('  Map (30)')
    const assetsHeader = lines.indexOf('  Images (25)')
    expect(syncHeader).toBeGreaterThan(-1)
    expect(mapHeader).toBeGreaterThan(syncHeader)
    expect(assetsHeader).toBeGreaterThan(mapHeader)
    expect(text).toContain('    Module:Map/p0.json: broken')
    // 40 shown: 1 sync, 30 map, 9 assets.
    expect(text).toContain('icon 8 missing')
    expect(text).not.toContain('icon 9 missing')
    expect(text).toContain('and 16 more')
  })

  it('shows the error of a failed sync', () => {
    const report: DiffReport = {
      syncedAt: SYNCED_AT,
      ok: false,
      error: 'HTTP 500 for https://dragonwilds.runescape.wiki/api.php',
      domains: ['map'],
      orphans: { quests: [], steps: [], items: [], points: [], vaults: [], rewards: [] },
      warnings: [],
    }
    const text = formatReport(report)
    expect(text).toMatch(/^Sync failed \(.+\): HTTP 500/)
    expect(text).toContain('Nothing was written')
    expect(text).not.toContain(EM_DASH)
  })

  it('does not claim nothing was written after a partial write', () => {
    const report: DiffReport = {
      syncedAt: SYNCED_AT,
      ok: false,
      error: `${PARTIAL_WRITE_PREFIX} (map.json), then failed: EIO`,
      domains: ['map'],
      orphans: { quests: [], steps: [], items: [], points: [], vaults: [], rewards: [] },
      warnings: [],
    }
    const text = formatReport(report)
    expect(text).not.toContain('Nothing was written')
    expect(text).toContain('only partly updated')
  })

  it('caps the per-category list', () => {
    const cats = Array.from({ length: 20 }, (_, i) => category(`Cat ${String(i).padStart(2, '0')}`))
    const next = mapData(cats, cats.map((c, i) => point(c.id, i, i)))
    const text = formatReport(buildReport(input({ domains: ['map'], next: { ...EMPTY, map: next } })))
    expect(text).toContain('Categories: 20 new, 0 removed, 0 changed')
    expect(text).toContain('and 5 more categories')
  })
})
