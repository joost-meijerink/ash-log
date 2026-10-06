// Vault parser against the stored 'Dragonkin Vault' page and 'Template:Dragonkin Vaults' navbox.

import { describe, expect, it } from 'vitest'
import { mapPointId, wikiUrl } from '../../../src/lib/ids'
import type { MapData, SyncWarning } from '../../../src/lib/types'
import { fixturePage, fixturePages, MAP_CONTENT_FILES } from '../__fixtures__/load'
import { warnCollector, type SyncContext } from '../context'
import type { RawPage } from '../wiki'
import { fetchVaultSources, parseRecipeList, parseVaults, VAULT_NAVBOX, VAULT_PAGE, type VaultSources } from './vaults'

const src: VaultSources = {
  page: fixturePage('vaults/dragonkin-vault.json'),
  navbox: fixturePage('vaults/navbox.json'),
}

/** Map with the real points of Module:Map/Vaults.json, as the map domain would name them. */
function vaultMap(): MapData {
  const page = fixturePages(...MAP_CONTENT_FILES).find((p) => p.title === 'Module:Map/Vaults.json')
  if (!page) throw new Error('fixture misses Module:Map/Vaults.json')
  const raw = JSON.parse(page.content) as { x: number; y: number; name: string; description?: string }[]
  return {
    categories: [{ id: 'vaults', label: 'Vaults', group: 'vault', sources: [page.title], count: raw.length }],
    points: raw.map((p) => ({
      id: mapPointId('vaults', p.x, p.y),
      categoryId: 'vaults',
      x: p.x,
      y: p.y,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
    })),
  }
}

function parse(source: VaultSources = src, map: MapData = vaultMap()) {
  const warnings: SyncWarning[] = []
  const vaults = parseVaults(source, map, warnCollector(warnings, 'vaults'))
  return { vaults, warnings, byName: (name: string) => vaults.find((v) => v.name === name) }
}

describe('parseVaults on the fixtures', () => {
  it('reads all 12 vaults in progression order without warnings', () => {
    const { vaults, warnings } = parse()
    expect(warnings).toEqual([])
    expect(vaults).toHaveLength(12)
    expect(vaults.map((v) => v.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11])
    expect(vaults.map((v) => v.name)).toEqual([
      'Crasorak Kara',
      'Thishepen Kara',
      'Vertentis Kara',
      'Takla Kara',
      'Skeklac Kara',
      'Kletterbuja Kara',
      'Chaktan Kara',
      'Kalistrakthen Kara',
      'Skekven Kara',
      'Vekchenven Kara',
      'Manafem Kara',
      'Uzzer Kara',
    ])
    for (const v of vaults) expect(v.id).toBe(v.name)
  })

  it('reads power, area and region per vault', () => {
    const { byName } = parse()
    expect(byName('Crasorak Kara')).toMatchObject({
      power: 2,
      area: 'Temple Woods',
      region: 'Brynmoor',
      recipes: [],
      wikiUrl: wikiUrl('Crasorak Kara'),
    })
    expect(byName('Takla Kara')).toMatchObject({ power: 3, area: 'Fractured Plains', region: 'Ghornfell' })
    expect(byName('Kalistrakthen Kara')).toMatchObject({ power: 5, area: 'Emberwood', region: 'Fellhollow' })
    expect(byName('Skekven Kara')?.area).toBe('Lake of Lost Souls (east)')
    expect(byName('Vekchenven Kara')?.area).toBe('Lake of Lost Souls (west)')
  })

  it('names the TBA vaults from the navbox, without a wiki page', () => {
    const { byName } = parse()
    for (const name of ['Uzzer Kara', 'Manafem Kara']) {
      const vault = byName(name)
      expect(vault).toMatchObject({ order: 11, power: 7, area: 'Umbral Sands', region: 'Umbral Sands', recipes: [] })
      expect(vault?.wikiUrl).toBeUndefined()
    }
  })

  it('reads recipes with armour set labels', () => {
    const { byName } = parse()
    expect(byName('Takla Kara')?.recipes).toEqual([
      { name: "Paladin's helm", set: 'Paladin armour set' },
      { name: "Paladin's platebody", set: 'Paladin armour set' },
      { name: 'Paladin platelegs', set: 'Paladin armour set' },
      { name: "Wild scout's shortbow" },
    ])
    expect(byName('Chaktan Kara')?.recipes).toEqual([
      { name: 'Dragonbone dagger' },
      { name: 'Dragonkin mage hood', set: 'Dragonkin mage armour set' },
      { name: 'Dragonkin mage robes', set: 'Dragonkin mage armour set' },
      { name: 'Dragonkin mage robe legs', set: 'Dragonkin mage armour set' },
    ])
    expect(byName('Vertentis Kara')?.recipes).toEqual([{ name: 'Anti-dragon shield' }])
    // A blank line between list items does not end the list.
    expect(byName('Vekchenven Kara')?.recipes).toEqual([{ name: "Necromancer's staff" }, { name: "Fallen hoplite's helm" }])
    expect(byName('Crasorak Kara')?.recipes).toEqual([])
    expect(byName('Thishepen Kara')?.recipes).toEqual([])
  })

  it('keeps the Misc Information column as plain text', () => {
    const { byName } = parse()
    expect(byName('Skeklac Kara')?.note).toBe(
      'This recipe is not fully unlocked until completion of the quest Granite Mauled.',
    )
    expect(byName('Kletterbuja Kara')?.note).toMatch(/abyssal spine/)
    expect(byName('Takla Kara')?.note).toBeUndefined()
  })

  it('links every vault to its map point', () => {
    const { byName, vaults } = parse()
    expect(byName('Crasorak Kara')?.pointId).toBe('vaults:37482:191753')
    expect(byName('Skekven Kara')?.pointId).toBe(mapPointId('vaults', 197933.86, -42374.29))
    for (const v of vaults) expect(v.pointId, v.name).toBeDefined()
    expect(new Set(vaults.map((v) => v.pointId)).size).toBe(vaults.length)
  })

  it('links the Umbral Sands vaults through the area word in the point description', () => {
    // 'Vault (Kalphite)': 'south of Manafem Plains at the pyramid'; 'Vault (Mirrors)': 'north of Dunes of Uzzer'.
    const { byName } = parse()
    expect(byName('Manafem Kara')?.pointId).toBe('vaults:233978:223195')
    expect(byName('Uzzer Kara')?.pointId).toBe('vaults:342891:74271')
  })
})

describe('parseVaults map matching', () => {
  it('matches case-insensitively and warns once per vault without a point', () => {
    const map: MapData = {
      categories: [{ id: 'vaults', label: 'Vaults', group: 'vault', sources: [], count: 2 }],
      points: [
        { id: 'vaults:1:2', categoryId: 'vaults', x: 1, y: 2, name: 'crasorak kara' },
        { id: 'vaults:3:4', categoryId: 'vaults', x: 3, y: 4, name: 'Takla Kara' },
        { id: 'lore:5:6', categoryId: 'lore', x: 5, y: 6, name: 'Thishepen Kara' },
      ],
    }
    const { byName, warnings } = parse(src, map)
    expect(byName('Crasorak Kara')?.pointId).toBe('vaults:1:2')
    expect(byName('Takla Kara')?.pointId).toBe('vaults:3:4')
    // A point in another category does not count.
    expect(byName('Thishepen Kara')?.pointId).toBeUndefined()
    // 8 vaults with a page and the two TBA vaults lack a point.
    expect(warnings).toHaveLength(10)
    expect(warnings.every((w) => w.source === 'vaults' && w.message.includes(w.page!))).toBe(true)
    expect(warnings.map((w) => w.page)).toContain('Uzzer Kara')
  })

  it('takes a description match only when it is the single unused candidate', () => {
    const map: MapData = {
      categories: [{ id: 'vaults', label: 'Vaults', group: 'vault', sources: [], count: 4 }],
      points: [
        { id: 'vaults:1:1', categoryId: 'vaults', x: 1, y: 1, name: 'Vault', description: 'North of Manafem Plains.' },
        { id: 'vaults:2:2', categoryId: 'vaults', x: 2, y: 2, name: 'Vault', description: 'South of Manafem Plains.' },
        { id: 'vaults:3:3', categoryId: 'vaults', x: 3, y: 3, name: 'Takla Kara', description: 'Near Uzzer.' },
        { id: 'vaults:4:4', categoryId: 'vaults', x: 4, y: 4, name: 'Vault', description: 'The Uzzering dunes.' },
      ],
    }
    const { byName, warnings } = parse(src, map)
    // Two Manafem candidates: no guess, one warning.
    expect(byName('Manafem Kara')?.pointId).toBeUndefined()
    expect(warnings.filter((w) => w.page === 'Manafem Kara').map((w) => w.message)).toEqual([
      'More than one possible map point for vault Manafem Kara, none picked',
    ])
    // 'Near Uzzer' belongs to Takla Kara already, and 'Uzzering' is not the whole word.
    expect(byName('Takla Kara')?.pointId).toBe('vaults:3:3')
    expect(byName('Uzzer Kara')?.pointId).toBeUndefined()
    expect(warnings.filter((w) => w.page === 'Uzzer Kara').map((w) => w.message)).toEqual([
      'No map point found for vault Uzzer Kara',
    ])
  })

  it('gives one warning when the map has no vault category', () => {
    const { vaults, warnings } = parse(src, { categories: [], points: [] })
    expect(vaults).toHaveLength(12)
    expect(vaults.every((v) => v.pointId === undefined)).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toMatch(/map/)
  })
})

describe('parseVaults on changed pages', () => {
  const noMap: MapData = { categories: [], points: [] }
  const withNavbox = (content: string): VaultSources => ({ ...src, navbox: { ...src.navbox, content } })

  it('skips TBA rows with a warning when the navbox has no names for them', () => {
    const navbox = src.navbox.content.replace('  * Uzzer Kara\n  * Manafem Kara\n', '')
    const warnings: SyncWarning[] = []
    const vaults = parseVaults(withNavbox(navbox), noMap, warnCollector(warnings, 'vaults'))
    expect(vaults).toHaveLength(10)
    const tba = warnings.filter((w) => /TBA/.test(w.message))
    expect(tba).toHaveLength(2)
    expect(tba[0].page).toBe(VAULT_NAVBOX)
  })

  it('warns about navbox vaults that are missing from the table', () => {
    const navbox = src.navbox.content.replace('  * Manafem Kara\n', '  * Manafem Kara\n  * Sekhmet Kara\n')
    const warnings: SyncWarning[] = []
    const vaults = parseVaults(withNavbox(navbox), noMap, warnCollector(warnings, 'vaults'))
    expect(vaults).toHaveLength(12)
    expect(warnings.some((w) => w.message.includes('Sekhmet Kara'))).toBe(true)
  })

  it('warns once when the navbox is not recognised, and keeps the linked vaults', () => {
    const warnings: SyncWarning[] = []
    const vaults = parseVaults(withNavbox('Nothing here'), noMap, warnCollector(warnings, 'vaults'))
    expect(vaults).toHaveLength(10)
    expect(vaults.every((v) => v.region === undefined)).toBe(true)
    expect(warnings.some((w) => /Navbox not recognised/.test(w.message))).toBe(true)
  })

  it('throws when the progression table is gone, instead of writing an empty list', () => {
    const page: RawPage = { ...src.page, content: 'The vaults moved.' }
    expect(() => parseVaults({ ...src, page }, noMap, () => {})).toThrow(/Standard Progression Order/)
  })

  it('warns when the recipes table is gone and keeps the vaults', () => {
    const content = src.page.content.replace('! Recipe\n', '! Loot\n')
    const warnings: SyncWarning[] = []
    const vaults = parseVaults({ ...src, page: { ...src.page, content } }, noMap, warnCollector(warnings, 'vaults'))
    expect(vaults).toHaveLength(12)
    expect(vaults.every((v) => v.recipes.length === 0)).toBe(true)
    expect(warnings.some((w) => /Recipes/.test(w.message) && w.page === VAULT_PAGE)).toBe(true)
  })
})

describe('parseRecipeList', () => {
  it('ends a set at the next item on the same level', () => {
    const cell = "* '''Set A:'''\n** [[a one]]\n** [[a two]]\n* [[loose]]\n*'''Set B''':\n**[[b one]]"
    expect(parseRecipeList(cell)).toEqual([
      { name: 'A one', set: 'Set A' },
      { name: 'A two', set: 'Set A' },
      { name: 'Loose' },
      { name: 'B one', set: 'Set B' },
    ])
  })

  it('keeps text next to the link as a note', () => {
    expect(parseRecipeList('* [[Granite maul]] (after [[Granite Mauled]])')).toEqual([
      { name: 'Granite maul', note: 'after Granite Mauled' },
    ])
  })

  it('reads links without a list, and gives undefined for plain text', () => {
    expect(parseRecipeList('[[Abyssal whip]]')).toEqual([{ name: 'Abyssal whip' }])
    expect(parseRecipeList('')).toEqual([])
    expect(parseRecipeList('Coming soon')).toBeUndefined()
  })
})

describe('fetchVaultSources', () => {
  function fakeContext(available: RawPage[]): SyncContext & { asked: string[][] } {
    const asked: string[][] = []
    return {
      asked,
      async pages(titles: string[]) {
        asked.push(titles)
        const pages = new Map(available.filter((p) => titles.includes(p.title)).map((p) => [p.title, p]))
        return { pages, missing: titles.filter((t) => !pages.has(t)) }
      },
    } as unknown as SyncContext & { asked: string[][] }
  }

  it('asks for the page and the navbox in one call', async () => {
    const ctx = fakeContext([src.page, src.navbox])
    const sources = await fetchVaultSources(ctx)
    expect(ctx.asked).toEqual([[VAULT_PAGE, VAULT_NAVBOX]])
    expect(sources.page.title).toBe(VAULT_PAGE)
    expect(sources.navbox.title).toBe(VAULT_NAVBOX)
  })

  it('throws a clear error when a page is missing', async () => {
    await expect(fetchVaultSources(fakeContext([src.page]))).rejects.toThrow(VAULT_NAVBOX)
  })
})
