import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { emptyOverrides, emptyProgress } from '@/lib/normalize'
import type { AppData, AppQuest, MapPoint } from '@/lib/types'
import { useDataStore } from '@/stores/data'
import { useProgressStore } from '@/stores/progress'
import { orphanLabel, summarizeOrphans, useOrphans } from './useOrphans'

// Never talk to the middleware from tests.
vi.mock('@/lib/api', () => ({
  api: {
    data: vi.fn(),
    progress: vi.fn(),
    saveProgress: vi.fn(async (p: unknown) => p),
    saveOverrides: vi.fn(),
    startSync: vi.fn(),
    syncStatus: vi.fn(),
  },
}))

const point: MapPoint = { id: 'lore-scraps:10:20', categoryId: 'lore-scraps', x: 10, y: 20, name: 'Scrap' }
const quest: AppQuest = {
  id: 'Ratcatcher',
  name: 'Ratcatcher',
  kind: 'primary',
  location: 'Fellhollow',
  steps: [{ id: 'Ratcatcher:s:aaaaaaaa', text: 'Talk to Bert.' }],
  stepsSource: 'quick-guide',
  items: [{ id: 'Ratcatcher:i:raw-rat-meat', name: 'Raw rat meat', qty: 4 }],
  rewards: [],
  requires: [],
  wikiUrl: 'https://dragonwilds.runescape.wiki/w/Ratcatcher',
  itemsOverridden: false,
}

function appData(partial: Partial<AppData> = {}): AppData {
  return {
    ready: true,
    map: { categories: [], points: [point] },
    quests: [quest],
    vaults: [{ id: 'Crasorak Kara', name: 'Crasorak Kara', order: 1, power: 2, area: 'Temple Woods', recipes: [] }],
    rewards: [{ id: 'plan:blue-torch', kind: 'plan', name: 'Blue Torch' }],
    overrides: emptyOverrides(),
    ...partial,
  }
}

function setup(data: AppData | null) {
  const dataStore = useDataStore()
  const progress = useProgressStore()
  dataStore.data = data
  progress.state = {
    ...emptyProgress(),
    quests: {
      Ratcatcher: { steps: ['Ratcatcher:s:aaaaaaaa', 'Ratcatcher:s:gone'], items: ['Ratcatcher:i:raw-rat-meat', 'Ratcatcher:i:old'] },
      'Old Quest': { steps: ['Old Quest:s:1'], items: [] },
      // Left empty by unchecking: never counted, never cleaned up.
      'Empty Quest': { steps: [], items: [] },
    },
    points: { 'lore-scraps:10:20': { foundAt: '2026-09-01T00:00:00Z' }, 'lore-scraps:99:99': { foundAt: '2026-09-01T00:00:00Z' } },
    vaults: { 'Crasorak Kara': { done: true }, 'Gone Kara': { done: true }, 'Empty Kara': {} },
    rewards: { 'plan:blue-torch': { at: 'x' }, 'plan:gone': { at: 'x' } },
  }
  progress.loaded = true
  const scope = effectScope()
  const result = scope.run(() => useOrphans())!
  return { result, progress, dataStore }
}

describe('useOrphans', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('finds live orphans in every domain', () => {
    const { result } = setup(appData())
    expect(result.orphans.value).toEqual({
      quests: ['Old Quest'],
      steps: ['Ratcatcher:s:gone'],
      items: ['Ratcatcher:i:old'],
      points: ['lore-scraps:99:99'],
      vaults: ['Gone Kara'],
      rewards: ['plan:gone'],
    })
    expect(result.count.value).toBe(6)
  })

  it('reports nothing before the first sync or while progress is not loaded', () => {
    const { result, progress, dataStore } = setup(appData({ ready: false }))
    expect(result.count.value).toBe(0)
    dataStore.data = null
    expect(result.count.value).toBe(0)
    dataStore.data = appData()
    progress.loaded = false
    expect(result.count.value).toBe(0)
  })

  it('treats an empty domain as not synced instead of flagging all its progress', () => {
    const { result } = setup(appData({ quests: [], vaults: [], rewards: [] }))
    expect(result.orphans.value.quests).toEqual([])
    expect(result.orphans.value.steps).toEqual([])
    expect(result.orphans.value.vaults).toEqual([])
    expect(result.orphans.value.rewards).toEqual([])
    expect(result.orphans.value.points).toEqual(['lore-scraps:99:99'])
  })

  it('counts items from an override as valid', () => {
    const overrides = emptyOverrides()
    overrides.questItems.Ratcatcher = [{ id: 'Ratcatcher:i:old', name: 'Old item' }]
    const { result } = setup(appData({ overrides }))
    expect(result.orphans.value.items).toEqual([])
  })

  it('cleanUp removes exactly the orphans and keeps the rest', () => {
    const { result, progress } = setup(appData())
    expect(result.cleanUp()).toBe(6)
    expect(result.count.value).toBe(0)
    expect(progress.state.quests).toEqual({
      Ratcatcher: { steps: ['Ratcatcher:s:aaaaaaaa'], items: ['Ratcatcher:i:raw-rat-meat'] },
      'Empty Quest': { steps: [], items: [] },
    })
    expect(Object.keys(progress.state.points)).toEqual(['lore-scraps:10:20'])
    expect(Object.keys(progress.state.vaults)).toEqual(['Crasorak Kara', 'Empty Kara'])
    expect(Object.keys(progress.state.rewards)).toEqual(['plan:blue-torch'])
    expect(result.cleanUp()).toBe(0)
  })
})

describe('readable orphans', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('labels every kind with English wiki names', () => {
    const names = {
      questName: (id: string) => (id === 'Dragon Slayer' ? 'Dragon Slayer' : undefined),
      categoryLabel: (id: string) => (id === 'lore-scraps' ? 'Lore Scraps' : undefined),
      stepText: (id: string) => (id === 'Dragon Slayer:s:abc' ? 'Talk to the Guildmaster.' : undefined),
    }
    expect(orphanLabel('steps', 'Dragon Slayer:s:abc', names)).toBe('Dragon Slayer: Talk to the Guildmaster.')
    expect(orphanLabel('steps', 'Dragon Slayer:s:def', names)).toBe('Dragon Slayer (def)')
    expect(orphanLabel('items', 'Gone Quest:i:raw-rat-meat', names)).toBe('Gone Quest: raw rat meat')
    expect(orphanLabel('points', 'lore-scraps:-10:20', names)).toBe('Lore Scraps (-10, 20)')
    expect(orphanLabel('rewards', 'plan:blue-torch', names)).toBe('blue torch (plan)')
    expect(orphanLabel('quests', 'Old Quest', names)).toBe('Old Quest')
  })

  it('summarizes counts per kind with the quests and categories they belong to', () => {
    const summary = summarizeOrphans(
      {
        quests: ['Old Quest'],
        steps: ['Ratcatcher:s:1', 'Ratcatcher:s:2', 'Gone:s:1'],
        items: [],
        points: ['lore-scraps:1:1', 'lore-scraps:2:2'],
        vaults: [],
        rewards: ['plan:gone'],
      },
      { questName: (id) => (id === 'Ratcatcher' ? 'Ratcatcher' : undefined), categoryLabel: () => 'Lore Scraps' },
    )
    expect(summary).toEqual([
      { kind: 'quests', label: 'Quests', count: 1, names: ['Old Quest'] },
      { kind: 'steps', label: 'Quest steps', count: 3, names: ['Ratcatcher', 'Gone'] },
      { kind: 'points', label: 'Map points', count: 2, names: ['Lore Scraps'] },
      { kind: 'rewards', label: 'Rewards', count: 1, names: [] },
    ])
  })

  it('uses the step text of the last report in the live labels', () => {
    const report = {
      syncedAt: '2026-09-01T00:00:00Z',
      ok: true,
      domains: [],
      quests: { quests: { added: [], removed: [], changed: [] }, steps: [{ questId: 'Ratcatcher', added: [], removed: [{ id: 'Ratcatcher:s:gone', text: 'Old step.' }] }] },
      orphans: { quests: [], steps: [], items: [], points: [], vaults: [], rewards: [] },
      warnings: [],
    }
    const { result } = setup(appData({ lastReport: report }))
    expect(result.label('steps', 'Ratcatcher:s:gone')).toBe('Ratcatcher: Old step.')
    expect(result.summary.value.find((g) => g.kind === 'steps')).toEqual({
      kind: 'steps',
      label: 'Quest steps',
      count: 1,
      names: ['Ratcatcher'],
    })
  })
})
