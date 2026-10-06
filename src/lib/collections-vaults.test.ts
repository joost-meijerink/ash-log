import { describe, expect, it } from 'vitest'
import {
  collectionSummary,
  indexRewardsByName,
  matchRecipeReward,
  sortVaults,
  uncheckedVaultRewards,
  vaultAnchor,
  vaultRecipeGroups,
  vaultRewards,
  vaultRewardTally,
} from './collections-vaults'
import type { Progress, Reward, Vault } from './types'

// Shapes as synced from the wiki (data/wiki/vaults.json and rewards.json).
const vault = (v: Partial<Vault> & Pick<Vault, 'id' | 'order'>): Vault => ({
  name: v.id,
  power: 2,
  area: 'Somewhere',
  recipes: [],
  ...v,
})

const takla = vault({
  id: 'Takla Kara',
  order: 4,
  power: 3,
  area: 'Fractured Plains',
  region: 'Ghornfell',
  recipes: [
    { name: "Paladin's helm", set: 'Paladin armour set' },
    { name: "Paladin's platebody", set: 'Paladin armour set' },
    { name: 'Paladin platelegs', set: 'Paladin armour set' },
    { name: "Wild scout's shortbow" },
  ],
})

const chaktan = vault({
  id: 'Chaktan Kara',
  order: 7,
  recipes: [
    { name: 'Dragonbone dagger' },
    { name: 'Dragonkin mage hood', set: 'Dragonkin mage armour set' },
    { name: 'Dragonkin mage robes', set: 'Dragonkin mage armour set' },
  ],
})

const vertentis = vault({ id: 'Vertentis Kara', order: 3, recipes: [{ name: 'Anti-dragon shield' }] })
const kletterbuja = vault({ id: 'Kletterbuja Kara', order: 6, recipes: [{ name: 'Abyssal whip' }] })
const uzzer = vault({ id: 'Uzzer Kara', order: 11, power: 7 })
const manafem = vault({ id: 'Manafem Kara', order: 11, power: 7 })
const crasorak = vault({ id: 'Crasorak Kara', order: 1, recipes: [{ name: 'Mystery recipe' }] })

const effigy = (name: string, vaultId: string, set?: string): Reward => ({
  id: `effigy:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  kind: 'effigy',
  name,
  group: 'Ghornfell',
  source: `Dragonkin effigy in ${vaultId}`,
  vaultId,
  ...(set ? { set } : {}),
})

const rewards: Reward[] = [
  effigy("Paladin's Helm", 'Takla Kara', 'Paladin armour set'),
  effigy("Paladin's Platebody", 'Takla Kara', 'Paladin armour set'),
  effigy('Paladin Platelegs', 'Takla Kara', 'Paladin armour set'),
  effigy("Wild Scout's Shortbow", 'Takla Kara'),
  effigy('Dragonbone Dagger', 'Chaktan Kara'),
  effigy('Dragonkin Mage Hood', 'Chaktan Kara', 'Dragonkin mage armour set'),
  effigy('Dragonkin Mage Robes', 'Chaktan Kara', 'Dragonkin mage armour set'),
  effigy('Dragonkin Mage Robe Legs', 'Chaktan Kara', 'Dragonkin mage armour set'),
  effigy('Abyssal Whip', 'Kletterbuja Kara'),
  effigy('Wild Archer Cowl', 'Kletterbuja Kara'),
  effigy('Wild Archer Body', 'Kletterbuja Kara'),
  {
    id: 'quest:anti-dragon-shield',
    kind: 'quest',
    name: 'Anti-Dragon Shield',
    requirement: 'Vertentis Kara',
    questId: 'Dragon Slayer',
  },
  { id: 'plan:abyssal-whip-decoy', kind: 'plan', name: 'Dragonbone Dagger', group: 'General' },
]
const index = indexRewardsByName(rewards)

describe('vaultAnchor', () => {
  it('builds the deep-link id from the slug of the vault id', () => {
    expect(vaultAnchor('Crasorak Kara')).toBe('vault-crasorak-kara')
    expect(vaultAnchor('Lake of Lost Souls (east)')).toBe('vault-lake-of-lost-souls-east')
  })
})

describe('sortVaults', () => {
  it('sorts by standard order, then by name', () => {
    expect(sortVaults([uzzer, takla, manafem, crasorak]).map((v) => v.id)).toEqual([
      'Crasorak Kara',
      'Takla Kara',
      'Manafem Kara',
      'Uzzer Kara',
    ])
  })
})

describe('matchRecipeReward', () => {
  it('matches case- and punctuation-insensitively', () => {
    expect(matchRecipeReward("Paladin's helm", 'Takla Kara', index)?.id).toBe('effigy:paladin-s-helm')
    expect(matchRecipeReward('Paladin platelegs', 'Takla Kara', index)?.name).toBe('Paladin Platelegs')
  })

  it('prefers the effigy of this vault over another reward with the same name', () => {
    expect(matchRecipeReward('Dragonbone dagger', 'Chaktan Kara', index)?.kind).toBe('effigy')
  })

  it('falls back to any reward with that name', () => {
    expect(matchRecipeReward('Anti-dragon shield', 'Vertentis Kara', index)?.id).toBe('quest:anti-dragon-shield')
  })

  it('returns undefined when nothing matches', () => {
    expect(matchRecipeReward('Mystery recipe', 'Crasorak Kara', index)).toBeUndefined()
  })
})

describe('vaultRecipeGroups', () => {
  it('groups set items together and keeps loose recipes separate', () => {
    const groups = vaultRecipeGroups(takla, index, rewards)
    expect(groups.map((g) => [g.set ?? null, g.extra, g.rows.map((r) => r.name)])).toEqual([
      ['Paladin armour set', false, ["Paladin's helm", "Paladin's platebody", 'Paladin platelegs']],
      [null, false, ["Wild scout's shortbow"]],
    ])
    expect(groups.every((g) => g.rows.every((r) => r.reward?.kind === 'effigy'))).toBe(true)
  })

  it('keeps the wiki order of groups and adds unlisted set effigies to their set', () => {
    const groups = vaultRecipeGroups(chaktan, index, rewards)
    expect(groups.map((g) => g.set ?? null)).toEqual([null, 'Dragonkin mage armour set'])
    const set = groups[1]!
    expect(set.rows.map((r) => [r.name, r.origin])).toEqual([
      ['Dragonkin mage hood', 'recipe'],
      ['Dragonkin mage robes', 'recipe'],
      ['Dragonkin Mage Robe Legs', 'effigy'],
    ])
  })

  it('puts effigies of the vault without a recipe row in an extra group', () => {
    const groups = vaultRecipeGroups(kletterbuja, index, rewards)
    expect(groups.map((g) => [g.key, g.extra, g.rows.map((r) => r.name)])).toEqual([
      ['loose', false, ['Abyssal whip']],
      ['extra', true, ['Wild Archer Body', 'Wild Archer Cowl']],
    ])
  })

  it('keeps unmatched recipes as plain rows and returns nothing for empty vaults', () => {
    const [group] = vaultRecipeGroups(crasorak, index, rewards)
    expect(group!.rows[0]).toMatchObject({ name: 'Mystery recipe', reward: undefined, origin: 'recipe' })
    expect(vaultRecipeGroups(uzzer, index, rewards)).toEqual([])
  })

  it('gives every row a unique key', () => {
    for (const v of [takla, chaktan, kletterbuja]) {
      const keys = vaultRecipeGroups(v, index, rewards).flatMap((g) => g.rows.map((r) => r.key))
      expect(new Set(keys).size).toBe(keys.length)
    }
  })
})

describe('vault rewards and the tick-all offer', () => {
  const groups = vaultRecipeGroups(takla, index, rewards)

  it('lists each matched reward once', () => {
    expect(vaultRewards(groups).map((r) => r.name)).toEqual([
      "Paladin's Helm",
      "Paladin's Platebody",
      'Paladin Platelegs',
      "Wild Scout's Shortbow",
    ])
  })

  it('finds what is still unchecked and counts the rest', () => {
    const owned = new Set(['effigy:paladin-s-helm', 'effigy:wild-scout-s-shortbow'])
    expect(uncheckedVaultRewards(groups, owned).map((r) => r.name)).toEqual(["Paladin's Platebody", 'Paladin Platelegs'])
    expect(vaultRewardTally(groups, owned)).toEqual({ done: 2, total: 4 })
  })
})


describe('collectionSummary', () => {
  it('counts unlocks and finished vaults, ignoring orphaned progress', () => {
    const progress: Pick<Progress, 'vaults' | 'rewards'> = {
      vaults: {
        'Takla Kara': { done: true },
        'Chaktan Kara': {},
        'Gone Kara': { done: true },
      },
      rewards: {
        'effigy:paladin-s-helm': { at: '2026-09-28T10:00:00Z' },
        'quest:anti-dragon-shield': { at: '2026-09-28T10:00:00Z' },
        'plan:removed-from-wiki': { at: '2026-09-28T10:00:00Z' },
      },
    }
    const summary = collectionSummary([takla, chaktan, vertentis, uzzer], rewards, progress)
    expect(summary).toEqual({
      rewards: { done: 2, total: rewards.length },
      vaults: { done: 1, total: 4 },
    })
  })
})
