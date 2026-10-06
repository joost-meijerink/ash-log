import { describe, expect, it } from 'vitest'
import { GROUP_LABEL, GROUP_ORDER, groupCategories, isTrackableGroup, withCategoryGroup } from './map-groups'
import type { MapCategory, MapGroup } from './types'

function cat(id: string, group: MapGroup, label = id): MapCategory {
  return { id, label, group, sources: [], count: 1 }
}

describe('group order', () => {
  it('follows the sidebar order with Dutch headings', () => {
    expect(GROUP_ORDER.map((g) => GROUP_LABEL[g])).toEqual([
      'Grondstoffen',
      'Chests',
      'Unieke unlocks',
      'Lore',
      'Quests',
      'Vaults',
      "NPC's",
      'Monsters',
      'Plaatsen',
      'Overig',
    ])
  })

  it('groups categories in that order, sorted by label, without empty groups', () => {
    const groups = groupCategories([
      cat('zombie', 'monster', 'Zombie'),
      cat('vaults', 'vault', 'Vaults'),
      cat('oak-tree', 'resource', 'Oak Tree'),
      cat('childs-storybook', 'lore', 'Child’s Storybook'),
      cat('ash-tree', 'resource', 'Ash Tree'),
      cat('chefs-journal', 'lore', "Chef's Journal"),
      cat('goat', 'monster', 'Goat'),
    ])
    expect(groups.map((g) => g.group)).toEqual(['resource', 'lore', 'vault', 'monster'])
    expect(groups[0]!.categories.map((c) => c.label)).toEqual(['Ash Tree', 'Oak Tree'])
    expect(groups[1]!.categories.map((c) => c.label)).toEqual(["Chef's Journal", 'Child’s Storybook'])
    expect(groups[3]!.label).toBe('Monsters')
  })

  it('puts an unknown group under Overig instead of dropping it', () => {
    const groups = groupCategories([cat('odd', 'mystery' as MapGroup)])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.group).toBe('other')
  })
})

describe('trackable groups', () => {
  it('only lore and unique can be ticked off; chests and resources reset', () => {
    expect(isTrackableGroup('lore')).toBe(true)
    expect(isTrackableGroup('unique')).toBe(true)
    expect(isTrackableGroup('chest')).toBe(false)
    expect(isTrackableGroup('resource')).toBe(false)
    expect(isTrackableGroup(undefined)).toBe(false)
  })
})

describe('manual category group', () => {
  const overrides = {
    questStart: { Ratcatcher: { x: 1, y: 2 } },
    questItems: {},
    categoryGroup: { death: 'npc' as MapGroup },
  }

  it('moves a category and keeps the other overrides', () => {
    const next = withCategoryGroup(overrides, 'rasthins-riddle-of-faith', 'lore')
    expect(next.categoryGroup).toEqual({ death: 'npc', 'rasthins-riddle-of-faith': 'lore' })
    expect(next.questStart).toBe(overrides.questStart)
    // The input is not changed.
    expect(overrides.categoryGroup).toEqual({ death: 'npc' })
  })

  it('goes back to the automatic group with null', () => {
    expect(withCategoryGroup(overrides, 'death', null).categoryGroup).toEqual({})
    expect(withCategoryGroup(overrides, 'unknown', null).categoryGroup).toEqual({ death: 'npc' })
  })
})
