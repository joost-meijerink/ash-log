import { describe, expect, it } from 'vitest'
import {
  defaultFilters,
  emptyFilters,
  hasActiveFilters,
  isStrictPower,
  parseMapQuery,
  queryKey,
  sameFilters,
  serializeFilters,
  serializeMapQuery,
  type MapUrlKnown,
  type MapUrlState,
} from './map-url'

const known: MapUrlKnown = {
  category: (id) => ['vaults', 'gold-ore-node', 'lore-scraps', 'treasure-chest'].includes(id),
  power: (n) => [2, 3, 5, 6].includes(n),
  region: (r) => ['Brynmoor', 'Dowdun Reach', 'Fellhollow'].includes(r),
  point: (id) => id === 'lore-scraps:10:20',
  pointAlias: (id) => (id === 'ravannas-first-journal:10:20' ? 'lore-scraps:10:20' : undefined),
  quest: (id) => id === 'Ratcatcher' || id === "Black Knight's Fortress",
}

const defaults = defaultFilters(['vaults'])

describe('parseMapQuery', () => {
  it('uses the defaults (vaults and quest starts) without any filter param', () => {
    expect(parseMapQuery({}, known, defaults)).toEqual({ ...defaults })
    expect(defaults).toMatchObject({ categories: ['vaults'], questStarts: true, hideFound: false })
  })

  it('keeps the defaults for focus, quest and pin, which are not filters', () => {
    const s = parseMapQuery({ quest: 'Ratcatcher' }, known, defaults)
    expect(s.categories).toEqual(['vaults'])
    expect(s.questStarts).toBe(true)
    expect(s.quest).toBe('Ratcatcher')
  })

  it('takes exactly what is there once any filter param is present', () => {
    const s = parseMapQuery({ c: 'treasure-chest', r: 'Brynmoor' }, known, defaults)
    expect(s).toEqual({ ...emptyFilters(), categories: ['treasure-chest'], regions: ['Brynmoor'] })
  })

  it('reads an empty c= as all categories off', () => {
    expect(parseMapQuery({ c: '' }, known, defaults).categories).toEqual([])
    expect(parseMapQuery({ c: null }, known, defaults).categories).toEqual([])
  })

  it('ignores unknown ids and bad levels, and sorts and dedupes the rest', () => {
    const s = parseMapQuery(
      { c: 'gold-ore-node,nope,vaults,gold-ore-node', p: '6,x,2,99,2', r: 'Atlantis,Fellhollow,Brynmoor' },
      known,
      defaults,
    )
    expect(s.categories).toEqual(['gold-ore-node', 'vaults'])
    expect(s.powers).toEqual([2, 6])
    expect(s.regions).toEqual(['Brynmoor', 'Fellhollow'])
  })

  it('drops unknown focus, quest and pin ids', () => {
    const s = parseMapQuery({ focus: 'gone:1:2', quest: 'Nope', pin: 'Nope' }, known, defaults)
    expect(s.focus).toBeUndefined()
    expect(s.quest).toBeUndefined()
    expect(s.pin).toBeUndefined()
  })

  it('opens the kept point for a focus on a merged twin', () => {
    expect(parseMapQuery({ focus: 'ravannas-first-journal:10:20' }, known, defaults).focus).toBe('lore-scraps:10:20')
    expect(parseMapQuery({ focus: 'lore-scraps:10:20' }, known, defaults).focus).toBe('lore-scraps:10:20')
    const { pointAlias: _unused, ...withoutAliases } = known
    expect(parseMapQuery({ focus: 'ravannas-first-journal:10:20' }, withoutAliases, defaults).focus).toBeUndefined()
  })

  it('reads strict power only together with a known level', () => {
    expect(parseMapQuery({ c: 'treasure-chest', p: '3', ps: '1' }, known, defaults)).toMatchObject({ powers: [3], strictPower: true })
    expect(parseMapQuery({ c: 'treasure-chest', p: '3' }, known, defaults).strictPower).toBe(false)
    expect(parseMapQuery({ c: 'treasure-chest', ps: '1' }, known, defaults).strictPower).toBe(false)
    expect(parseMapQuery({ c: 'treasure-chest', p: '42', ps: '1' }, known, defaults).strictPower).toBe(false)
    // ps alone is a filter param: no defaults.
    expect(parseMapQuery({ ps: '1' }, known, defaults).categories).toEqual([])
  })

  it('reads flags, search and array values', () => {
    const s = parseMapQuery({ c: ['lore-scraps', 'vaults'], h: '1', qs: '0', q: '  gold ' }, known, defaults)
    expect(s.categories).toEqual(['lore-scraps'])
    expect(s.hideFound).toBe(true)
    expect(s.questStarts).toBe(false)
    expect(s.search).toBe('gold')
  })
})

describe('serializeMapQuery', () => {
  it('writes nothing for the default state, so /map stays clean', () => {
    expect(serializeMapQuery({ ...defaults }, defaults)).toEqual({})
    expect(serializeMapQuery({ ...defaults, quest: 'Ratcatcher' }, defaults)).toEqual({ quest: 'Ratcatcher' })
  })

  it('always writes c once the state differs from the defaults', () => {
    expect(serializeMapQuery(emptyFilters(), defaults)).toEqual({ c: '' })
    expect(serializeMapQuery({ ...defaults, questStarts: false }, defaults)).toEqual({ c: 'vaults' })
  })

  it('keeps the filters in links that stay on the map', () => {
    const f = { ...emptyFilters(), categories: ['treasure-chest'], powers: [5] }
    expect(serializeFilters(f, defaults)).toEqual({ c: 'treasure-chest', p: '5' })
  })

  it('writes ps=1 only while a level is picked', () => {
    const f = { ...emptyFilters(), categories: ['treasure-chest'], powers: [3], strictPower: true }
    expect(serializeFilters(f, defaults)).toEqual({ c: 'treasure-chest', p: '3', ps: '1' })
    expect(serializeFilters({ ...f, powers: [] }, defaults)).toEqual({ c: 'treasure-chest' })
  })
})

describe('URL round trip', () => {
  const states: MapUrlState[] = [
    { ...defaults },
    { ...emptyFilters() },
    { ...defaults, questStarts: false },
    { ...emptyFilters(), questStarts: true },
    {
      categories: ['gold-ore-node', 'lore-scraps', 'vaults'],
      powers: [2, 5],
      strictPower: false,
      regions: ['Brynmoor', 'Dowdun Reach'],
      search: 'scrawled diary',
      hideFound: true,
      questStarts: true,
      focus: 'lore-scraps:10:20',
    },
    { ...defaults, search: 'gold', pin: "Black Knight's Fortress" },
    { ...emptyFilters(), categories: ['treasure-chest'], quest: 'Ratcatcher' },
    { ...emptyFilters(), categories: ['treasure-chest'], powers: [3], strictPower: true, regions: ['Fellhollow'] },
  ]

  it.each(states.map((s, i) => [i, s] as const))('state %i survives serialize and parse', (_i, state) => {
    const query = serializeMapQuery(state, defaults)
    const back = parseMapQuery(query, known, defaults)
    expect(sameFilters(back, state)).toBe(true)
    expect(back.focus).toBe(state.focus)
    expect(back.quest).toBe(state.quest)
    expect(back.pin).toBe(state.pin)
    // And the query itself is stable.
    expect(queryKey(serializeMapQuery(back, defaults))).toBe(queryKey(query))
  })
})

describe('helpers', () => {
  it('queryKey ignores key order and undefined values', () => {
    expect(queryKey({ c: 'a', p: '2' })).toBe(queryKey({ p: '2', c: 'a', q: undefined }))
    expect(queryKey({ c: 'a' })).not.toBe(queryKey({ c: 'b' }))
  })

  it('hasActiveFilters is false only for the empty state', () => {
    expect(hasActiveFilters(emptyFilters())).toBe(false)
    expect(hasActiveFilters({ ...emptyFilters(), search: '  ' })).toBe(false)
    expect(hasActiveFilters(defaults)).toBe(true)
    expect(hasActiveFilters({ ...emptyFilters(), powers: [2] })).toBe(true)
  })

  it('treats strict power without a level as off', () => {
    expect(isStrictPower({ powers: [], strictPower: true })).toBe(false)
    expect(isStrictPower({ powers: [3], strictPower: true })).toBe(true)
    expect(sameFilters({ ...emptyFilters(), strictPower: true }, emptyFilters())).toBe(true)
    expect(sameFilters({ ...emptyFilters(), powers: [3], strictPower: true }, { ...emptyFilters(), powers: [3] })).toBe(false)
  })
})
