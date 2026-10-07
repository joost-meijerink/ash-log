import { describe, expect, it } from 'vitest'
import { estimatedPower, estimateNote, pointPower, powerEstimates } from './map-power'
import type { MapGroup, MapPoint } from './types'

const GROUPS: Record<string, MapGroup> = { chest: 'chest', buried: 'chest', zombie: 'monster', tree: 'resource' }
const groupOf = (id: string) => GROUPS[id]

let n = 0
function pt(categoryId: string, extra: Partial<MapPoint> = {}): MapPoint {
  n++
  return { id: `${categoryId}:${n}:0`, categoryId, x: n, y: 0, ...extra }
}

const points: MapPoint[] = [
  // Vaults and chests agree.
  pt('chest', { region: 'Brynmoor', power: 2 }),
  pt('chest', { region: 'Brynmoor' }),
  // Two vault levels: mixed.
  pt('chest', { region: 'Ghornfell', power: 3 }),
  pt('buried', { region: 'Ghornfell' }),
  // Only vaults.
  pt('chest', { region: 'Fellhollow' }),
  // Only chests; a monster level and a guessed-region chest are no evidence.
  pt('chest', { region: 'Dowdun Reach', power: 6 }),
  pt('zombie', { region: 'Dowdun Reach', power: 9 }),
  pt('chest', { region: 'Dowdun Reach', power: 4, regionGuessed: true }),
  // Nothing at all.
  pt('chest', { region: 'Scorned Wilderness' }),
]
const vaults = [
  { region: 'Brynmoor', power: 2 },
  { region: 'Brynmoor', power: 2 },
  { region: 'Ghornfell', power: 3 },
  { region: 'Ghornfell', power: 4 },
  { region: 'Fellhollow', power: 5 },
  { power: 9 },
]
const estimates = powerEstimates(points, groupOf, vaults)

describe('powerEstimates', () => {
  it('estimates a region only when vaults and wiki chests name one level', () => {
    expect(Object.fromEntries(estimates.regions)).toEqual({
      Brynmoor: { region: 'Brynmoor', vaults: [2], chests: [2], level: 2, basis: 'both' },
      Ghornfell: { region: 'Ghornfell', vaults: [3, 4], chests: [3] },
      Fellhollow: { region: 'Fellhollow', vaults: [5], chests: [], level: 5, basis: 'vaults' },
      'Dowdun Reach': { region: 'Dowdun Reach', vaults: [], chests: [6], level: 6, basis: 'chests' },
      'Scorned Wilderness': { region: 'Scorned Wilderness', vaults: [], chests: [] },
    })
  })

  it('only estimates chest kinds the wiki levels somewhere', () => {
    expect([...estimates.categories]).toEqual(['chest'])
  })

  it('calls a region mixed when vaults and chests disagree', () => {
    const mixed = powerEstimates([pt('chest', { region: 'Brynmoor', power: 3 })], groupOf, [{ region: 'Brynmoor', power: 2 }])
    expect(mixed.regions.get('Brynmoor')?.level).toBeUndefined()
  })
})

describe('estimatedPower and pointPower', () => {
  it('only estimates levelled chest kinds without a level, in a region the wiki states', () => {
    const at = (categoryId: string, extra: Partial<MapPoint>) => estimatedPower(pt(categoryId, extra), groupOf(categoryId), estimates)?.level
    expect(at('chest', { region: 'Fellhollow' })).toBe(5)
    expect(at('chest', { region: 'Dowdun Reach' })).toBe(6)
    expect(at('chest', { region: 'Fellhollow', power: 4 })).toBeUndefined()
    expect(at('chest', { region: 'Fellhollow', regionGuessed: true })).toBeUndefined()
    expect(at('chest', {})).toBeUndefined()
    expect(at('chest', { region: 'Ghornfell' })).toBeUndefined()
    expect(at('chest', { region: 'Scorned Wilderness' })).toBeUndefined()
    // Buried treasure never has a level on the wiki.
    expect(at('buried', { region: 'Fellhollow' })).toBeUndefined()
    expect(at('tree', { region: 'Fellhollow' })).toBeUndefined()
    expect(at('zombie', { region: 'Fellhollow' })).toBeUndefined()
  })

  it('prefers a known level (own or vault) over the estimate', () => {
    const chest = pt('chest', { region: 'Fellhollow' })
    expect(pointPower(chest, 'chest', 4, estimates)).toEqual({ level: 4 })
    expect(pointPower(chest, 'chest', undefined, estimates)).toEqual({ level: 5, estimate: estimates.regions.get('Fellhollow') })
    expect(pointPower(pt('tree', { region: 'Fellhollow' }), 'resource', undefined, estimates)).toBeUndefined()
  })

  it('explains where an estimate comes from', () => {
    const note = (region: string) => estimateNote(estimates.regions.get(region)!)
    expect(note('Fellhollow')).toBe('No level on the wiki. Estimated from the vaults in Fellhollow.')
    expect(note('Dowdun Reach')).toBe('No level on the wiki. Estimated from the other chests in Dowdun Reach.')
    expect(note('Brynmoor')).toBe('No level on the wiki. Estimated from the vaults and other chests in Brynmoor.')
  })
})
