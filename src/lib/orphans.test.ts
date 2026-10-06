import { describe, expect, it } from 'vitest'
import { emptyProgress, normalizeProgress } from './normalize'
import { findOrphans, orphanCount } from './orphans'
import type { MapData, Progress } from './types'

const map: MapData = {
  categories: [],
  points: [
    { id: 'lore-scraps:10:20', categoryId: 'lore-scraps', x: 10, y: 20, aliases: ['journals:10:21'] },
    { id: 'lore-scraps:30:40', categoryId: 'lore-scraps', x: 30, y: 40 },
  ],
}

describe('findOrphans', () => {
  it('ignores entries that unchecking left empty', () => {
    const progress = normalizeProgress({
      quests: { Gone: { steps: [], items: [] } },
      vaults: { 'Old Kara': { cores: [] } },
    })
    const o = findOrphans({ map: null, quests: [], vaults: [], rewards: null }, progress)
    expect(orphanCount(o)).toBe(0)
  })

  it('still reports missing quests and vaults that hold something', () => {
    const progress: Progress = {
      ...emptyProgress(),
      quests: { Done: { done: true, steps: [], items: [] }, Items: { steps: [], items: ['Items:i:rope'] } },
      vaults: { 'Done Kara': { done: true }, 'Empty Kara': {} },
    }
    const o = findOrphans({ map: null, quests: [], vaults: [], rewards: null }, progress)
    expect(o.quests).toEqual(['Done', 'Items'])
    expect(o.vaults).toEqual(['Done Kara'])
  })

  it('treats the alias of a merged twin point as a known point', () => {
    const progress: Progress = {
      ...emptyProgress(),
      points: {
        'journals:10:21': { foundAt: 'x' },
        'lore-scraps:30:40': { foundAt: 'x' },
        'journals:99:99': { foundAt: 'x' },
      },
    }
    const o = findOrphans({ map, quests: null, vaults: null, rewards: null }, progress)
    expect(o.points).toEqual(['journals:99:99'])
  })
})
