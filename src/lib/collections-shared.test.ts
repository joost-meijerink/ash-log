import { describe, expect, it } from 'vitest'
import {
  compareNames,
  compareRegions,
  knownRegion,
  matchesQuery,
  regionInText,
  searchKey,
  tallyFraction,
  tallyText,
} from './collections-shared'

describe('tallies', () => {
  it('formats and divides safely', () => {
    expect(tallyText({ done: 3, total: 8 })).toBe('3 / 8')
    expect(tallyFraction({ done: 3, total: 12 })).toBe(0.25)
    expect(tallyFraction({ done: 0, total: 0 })).toBe(0)
  })
})

describe('compareRegions', () => {
  it('orders known regions by play order, others alphabetically, missing last', () => {
    const list = [null, 'Scorned Wilderness', 'Zeta', 'Brynmoor', 'Alpha', 'Dowdun Reach', 'ghornfell']
    expect([...list].sort(compareRegions)).toEqual([
      'Brynmoor',
      'ghornfell',
      'Dowdun Reach',
      'Scorned Wilderness',
      'Alpha',
      'Zeta',
      null,
    ])
  })
})

describe('compareNames', () => {
  it('sorts numbers naturally and ignores case', () => {
    expect(['flag 10', 'Flag 2', 'flag 1'].sort(compareNames)).toEqual(['flag 1', 'Flag 2', 'flag 10'])
  })
})

describe('search', () => {
  it('normalises case, accents, quotes and spaces', () => {
    expect(searchKey('  Trophées  ‘Hope’s’   Fall ')).toBe("trophees 'hope's' fall")
  })

  it('needs every word', () => {
    const hay = searchKey("Paladin's Helm Paladin armour set Takla Kara")
    expect(matchesQuery(hay, 'paladin takla')).toBe(true)
    expect(matchesQuery(hay, 'paladin chaktan')).toBe(false)
    expect(matchesQuery(hay, '   ')).toBe(true)
  })
})

describe('knownRegion', () => {
  it('gives the first top-level region of a region field, in the usual spelling', () => {
    expect(knownRegion('Brynmoor')).toBe('Brynmoor')
    expect(knownRegion('dowdun reach')).toBe('Dowdun Reach')
    expect(knownRegion('Brynmoor/Ghornfell')).toBe('Brynmoor')
    expect(knownRegion('Temple Woods / Ghornfell')).toBe('Ghornfell')
    expect(knownRegion('Fellhollow, Dowdun Reach')).toBe('Fellhollow')
    expect(knownRegion('Umbral Sands & Brynmoor')).toBe('Umbral Sands')
    expect(knownRegion('Scorned Wilderness and Fellhollow')).toBe('Scorned Wilderness')
  })

  it('gives undefined for areas that are not a top-level region, and for nothing', () => {
    expect(knownRegion('Temple Woods')).toBeUndefined()
    expect(knownRegion('Ghornfell Highlands')).toBeUndefined()
    expect(knownRegion('')).toBeUndefined()
    expect(knownRegion(undefined)).toBeUndefined()
  })
})

describe('regionInText', () => {
  it('finds the region a text mentions first, in any case', () => {
    expect(regionInText('Rod fishing spots in Ghornfell.')).toBe('Ghornfell')
    expect(regionInText('Near the Dunes of Uzzer in umbral  sands')).toBe('Umbral Sands')
    expect(regionInText('From Fellhollow, or later in Brynmoor')).toBe('Fellhollow')
    expect(regionInText('In Brynmoor, not in Fellhollow')).toBe('Brynmoor')
  })

  it('only matches whole words', () => {
    expect(regionInText('A Brynmoorish lantern')).toBeUndefined()
    expect(regionInText('Ghornfells and Fellhollows')).toBeUndefined()
    expect(regionInText('Located inside a chest')).toBeUndefined()
    expect(regionInText(undefined)).toBeUndefined()
  })
})
