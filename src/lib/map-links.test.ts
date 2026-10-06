import { describe, expect, it } from 'vitest'
import {
  buildVaultIndex,
  effectivePower,
  questLinksForPoint,
  questRegionHints,
  questStartGroups,
  vaultForPoint,
} from './map-links'
import type { AppQuest, MapCategory, MapGroup, MapPoint, Vault } from './types'

function cat(id: string, group: MapGroup, label: string, wikiPage?: string): MapCategory {
  return { id, label, group, sources: [], count: 1, ...(wikiPage ? { wikiPage } : {}) }
}

function pt(categoryId: string, x: number, y: number, extra: Partial<MapPoint> = {}): MapPoint {
  return { id: `${categoryId}:${Math.round(x)}:${Math.round(y)}`, categoryId, x, y, ...extra }
}

function quest(id: string, extra: Partial<AppQuest> = {}): AppQuest {
  return {
    id,
    name: id,
    kind: 'secondary',
    location: '',
    steps: [],
    stepsSource: 'walkthrough',
    items: [],
    rewards: [],
    requires: [],
    wikiUrl: '',
    itemsOverridden: false,
    ...extra,
  }
}

const vaultPoint = pt('vaults', 37482, 191753)
const vault: Vault = {
  id: 'Crasorak Kara',
  name: 'Crasorak Kara',
  order: 1,
  power: 2,
  area: 'Temple Woods',
  region: 'Brynmoor',
  recipes: [],
  pointId: vaultPoint.id,
}
const index = buildVaultIndex([vault], new Map([[vaultPoint.id, vaultPoint]]))

describe('vaults', () => {
  it('finds the vault by point id, by category name and by spot', () => {
    expect(vaultForPoint(vaultPoint, cat('vaults', 'vault', 'Vaults'), index)).toBe(vault)
    const own = pt('crasorak-kara', 37482, 191753)
    expect(vaultForPoint(own, cat('crasorak-kara', 'vault', 'Crasorak Kara'), index)).toBe(vault)
    const sameSpot = pt('vaults-2', 37482.2, 191752.9)
    expect(vaultForPoint(sameSpot, cat('vaults-2', 'vault', 'Somewhere'), index)).toBe(vault)
  })

  it('never links points outside the vault group', () => {
    const chest = pt('treasure-chest', 37482, 191753)
    expect(vaultForPoint(chest, cat('treasure-chest', 'chest', 'Treasure Chest'), index)).toBeUndefined()
  })

  it('gives vault points the power level of their vault', () => {
    expect(effectivePower(vaultPoint, cat('vaults', 'vault', 'Vaults'), index)).toBe(2)
    expect(effectivePower({ ...vaultPoint, power: 4 }, cat('vaults', 'vault', 'Vaults'), index)).toBe(4)
    expect(effectivePower(pt('ash-tree', 1, 1), cat('ash-tree', 'resource', 'Ash Tree'), index)).toBeUndefined()
  })
})

describe('quests', () => {
  const vannaka = pt('vannaka', 126984, -29735)
  const quests = [
    quest('Things That Go Boom In The Night', { startPointId: vannaka.id, start: { x: vannaka.x, y: vannaka.y, pointId: vannaka.id, source: 'wiki' } }),
    quest('The Wild Hunt', { order: 1, startPointId: vannaka.id, start: { x: vannaka.x, y: vannaka.y, pointId: vannaka.id, source: 'wiki' } }),
    quest('Dragon Slayer', { kind: 'primary', order: 5, region: 'Brynmoor/Ghornfell', start: { x: 10, y: 20, source: 'override' }, startPointId: 'dragon-slayer:48282:177692' }),
    quest('Ratcatcher', { kind: 'primary', order: 3, region: 'Temple Woods' }),
    quest('Mirror, Mirror', { region: 'Fellhollow' }),
  ]

  it('links quests that start at a point, primary first', () => {
    const links = questLinksForPoint(vannaka, cat('vannaka', 'npc', 'Vannaka'), quests)
    expect(links.map((l) => [l.quest.id, l.relation])).toEqual([
      ['The Wild Hunt', 'start'],
      ['Things That Go Boom In The Night', 'start'],
    ])
  })

  it("still links the wiki start point when the start was moved by hand", () => {
    const p = pt('dragon-slayer', 48282, 177692)
    const links = questLinksForPoint(p, cat('dragon-slayer', 'quest', 'Dragon Slayer', 'Dragon Slayer'), quests)
    expect(links).toEqual([{ quest: quests[2], relation: 'start' }])
  })

  it('links quest pins to the quest with the same name', () => {
    const p = pt('mirror-mirror', 1, 1)
    const links = questLinksForPoint(p, cat('mirror-mirror', 'quest', 'Mirror Mirror'), quests)
    expect(links.map((l) => [l.quest.id, l.relation])).toEqual([['Mirror, Mirror', 'objective']])
    // Not for other groups.
    expect(questLinksForPoint(p, cat('mirror-mirror', 'lore', 'Mirror Mirror'), quests)).toEqual([])
  })

  it('groups quest starts that share a spot', () => {
    const groups = questStartGroups(quests)
    expect(groups).toHaveLength(2)
    expect(groups[0]!.quests.map((q) => q.id)).toEqual(['Dragon Slayer'])
    expect(groups[1]!.quests.map((q) => q.id)).toEqual(['The Wild Hunt', 'Things That Go Boom In The Night'])
    expect(groups[1]!.key).toBe('126984:-29735')
  })

  it('reads region hints from the primary quest line', () => {
    expect(questRegionHints(quests)).toEqual(['Temple Woods', 'Brynmoor', 'Ghornfell'])
  })
})
