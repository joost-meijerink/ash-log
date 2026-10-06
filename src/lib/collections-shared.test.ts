import { describe, expect, it } from 'vitest'
import { compareNames, compareRegions, matchesQuery, searchKey, tallyFraction, tallyText } from './collections-shared'

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
    expect(searchKey('  Vistrofeeën  ‘Hope’s’   Fall ')).toBe("vistrofeeen 'hope's' fall")
  })

  it('needs every word', () => {
    const hay = searchKey("Paladin's Helm Paladin armour set Takla Kara")
    expect(matchesQuery(hay, 'paladin takla')).toBe(true)
    expect(matchesQuery(hay, 'paladin chaktan')).toBe(false)
    expect(matchesQuery(hay, '   ')).toBe(true)
  })
})
