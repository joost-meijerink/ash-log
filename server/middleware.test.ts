import { describe, expect, it } from 'vitest'
import { emptyOverrides } from '../src/lib/normalize.ts'
import type { MapData, Quest } from '../src/lib/types.ts'
import { mergeAppData, syncCommand } from './middleware.ts'

const map: MapData = {
  categories: [
    { id: 'ratcatcher', label: 'Ratcatcher', group: 'quest', sources: [], count: 1 },
    { id: 'death', label: 'Death', group: 'other', sources: [], count: 1 },
  ],
  points: [
    { id: 'ratcatcher:15183:178853', categoryId: 'ratcatcher', x: 15182.6, y: 178853.4 },
    { id: 'death:1:2', categoryId: 'death', x: 1, y: 2 },
  ],
}

const quest = (id: string, extra: Partial<Quest> = {}): Quest => ({
  id,
  name: id,
  kind: 'primary',
  location: '',
  steps: [],
  stepsSource: 'walkthrough',
  items: [{ id: `${id}:i:stone`, name: 'Stone', qty: 4 }],
  rewards: [],
  requires: [],
  wikiUrl: '',
  ...extra,
})

const base = { map, vaults: [], rewards: [], meta: null, report: null }

describe('mergeAppData', () => {
  it('uses the wiki start point when there is no override', () => {
    const data = mergeAppData({
      ...base,
      quests: [quest('Ratcatcher', { startPointId: 'ratcatcher:15183:178853' })],
      overrides: emptyOverrides(),
    })
    expect(data.quests[0].start).toEqual({ x: 15182.6, y: 178853.4, pointId: 'ratcatcher:15183:178853', source: 'wiki' })
    expect(data.quests[0].itemsOverridden).toBe(false)
  })

  it('lets a manual pin win over the wiki point', () => {
    const overrides = { ...emptyOverrides(), questStart: { Ratcatcher: { x: 10, y: 20 } } }
    const data = mergeAppData({
      ...base,
      quests: [quest('Ratcatcher', { startPointId: 'ratcatcher:15183:178853' })],
      overrides,
    })
    expect(data.quests[0].start).toEqual({ x: 10, y: 20, source: 'override' })
  })

  it('replaces the item list with the override and flags it', () => {
    const items = [{ id: 'Ratcatcher:i:ash-log', name: 'Ash log', qty: 6 }]
    const overrides = { ...emptyOverrides(), questItems: { Ratcatcher: items } }
    const data = mergeAppData({ ...base, quests: [quest('Ratcatcher')], overrides })
    expect(data.quests[0].items).toEqual(items)
    expect(data.quests[0].itemsOverridden).toBe(true)
  })

  it('applies category group overrides without touching the wiki data', () => {
    const overrides = { ...emptyOverrides(), categoryGroup: { death: 'npc' as const } }
    const data = mergeAppData({ ...base, quests: [], overrides })
    expect(data.map.categories.find((c) => c.id === 'death')?.group).toBe('npc')
    expect(map.categories.find((c) => c.id === 'death')?.group).toBe('other')
  })

  it('is not ready before the first sync', () => {
    const data = mergeAppData({ map: null, quests: null, vaults: null, rewards: null, meta: null, report: null, overrides: emptyOverrides() })
    expect(data.ready).toBe(false)
    expect(data.quests).toEqual([])
    expect(data.map.points).toEqual([])
  })
})

describe('syncCommand', () => {
  it('runs the sync script with Node and the tsx loader, never a .bin shim or a shell', () => {
    const cmd = syncCommand(['map', 'quests'], true, {
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      loaderUrl: 'file:///C:/Users/Joost%20M/Ash%20Log/node_modules/tsx/dist/loader.mjs',
      root: 'C:\\Users\\Joost M\\Ash Log',
    })
    expect(cmd.command).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(cmd.args[0]).toBe('--import')
    expect(cmd.args[1]).toBe('file:///C:/Users/Joost%20M/Ash%20Log/node_modules/tsx/dist/loader.mjs')
    // The script path stays one argument, spaces and all.
    expect(cmd.args[2]).toMatch(/Ash Log[\\/]scripts[\\/]sync[\\/]index\.ts$/)
    expect(cmd.args.slice(3)).toEqual(['--only=map,quests', '--full'])
  })

  it('defaults to this Node and the tsx in node_modules', () => {
    const cmd = syncCommand([], false)
    expect(cmd.command).toBe(process.execPath)
    expect(cmd.args[1]).toMatch(/^file:\/\/\/.*\/node_modules\/tsx\/dist\/loader\.mjs$/)
    expect(cmd.args).toHaveLength(3)
  })
})
