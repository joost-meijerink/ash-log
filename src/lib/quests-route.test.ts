import { describe, expect, it } from 'vitest'
import {
  listStateQuery,
  mapPinLink,
  mapQuestLink,
  paramValue,
  questPath,
  readArrivalListState,
  readListState,
  resolveQuestId,
} from './quests-route'

const IDS = ['Ratcatcher', "Black Knight's Fortress", 'Mirror, Mirror', 'Contact!']

describe('list state in the URL', () => {
  it('reads search and status with Dutch status values', () => {
    expect(readListState({ q: 'vannaka', status: 'bezig' })).toEqual({ q: 'vannaka', status: 'active' })
    expect(readListState({ status: 'Voltooid' })).toEqual({ q: '', status: 'done' })
    expect(readListState({ q: ['a', 'b'], status: null })).toEqual({ q: 'a', status: 'all' })
  })

  it('falls back to all for unknown statuses', () => {
    expect(readListState({ status: 'done' }).status).toBe('all')
    expect(readListState({}).status).toBe('all')
  })

  it('leaves defaults out of the query and round-trips', () => {
    expect(listStateQuery({ q: '', status: 'all' })).toEqual({})
    expect(listStateQuery({ q: '  ', status: 'all' })).toEqual({})
    const state = { q: 'temple woods', status: 'open' as const }
    expect(listStateQuery(state)).toEqual({ q: 'temple woods', status: 'open' })
    expect(readListState(listStateQuery(state))).toEqual(state)
  })
})

describe('list state for a link from another view', () => {
  const kept = { q: 'temple', status: 'open' as const }

  it('keeps the filters a bare quest link does not mention', () => {
    expect(readArrivalListState({}, kept)).toEqual(kept)
    expect(readArrivalListState({ focus: 'x' }, kept)).toEqual(kept)
  })

  it('takes over what the link names, one filter at a time', () => {
    expect(readArrivalListState({ status: 'voltooid' }, kept)).toEqual({ q: 'temple', status: 'done' })
    expect(readArrivalListState({ q: 'rats' }, kept)).toEqual({ q: 'rats', status: 'open' })
    expect(readArrivalListState({ q: 'rats', status: 'bezig' }, kept)).toEqual({ q: 'rats', status: 'active' })
  })

  it('reads a named filter like any other: empty or unknown means the default', () => {
    expect(readArrivalListState({ q: null }, kept)).toEqual({ q: '', status: 'open' })
    expect(readArrivalListState({ q: '' }, kept)).toEqual({ q: '', status: 'open' })
    expect(readArrivalListState({ status: 'nope' }, kept)).toEqual({ q: 'temple', status: 'all' })
  })

  it('does not change the kept state', () => {
    readArrivalListState({ q: 'rats', status: 'bezig' }, kept)
    expect(kept).toEqual({ q: 'temple', status: 'open' })
  })
})

describe('links', () => {
  it('encodes the quest id in the path', () => {
    expect(questPath('Mirror, Mirror')).toBe('/quests/Mirror%2C%20Mirror')
    expect(questPath("Black Knight's Fortress")).toBe("/quests/Black%20Knight's%20Fortress")
  })

  it('builds the map links from the shared contract', () => {
    expect(mapQuestLink('Ratcatcher')).toEqual({ path: '/kaart', query: { quest: 'Ratcatcher' } })
    expect(mapPinLink('Contact!')).toEqual({ path: '/kaart', query: { pin: 'Contact!' } })
  })
})

describe('resolveQuestId', () => {
  it('takes the first value of the param', () => {
    expect(paramValue(['a', 'b'])).toBe('a')
    expect(paramValue('')).toBeUndefined()
    expect(paramValue(undefined)).toBeUndefined()
  })

  it('matches exactly first', () => {
    expect(resolveQuestId('Mirror, Mirror', IDS)).toBe('Mirror, Mirror')
    expect(resolveQuestId(undefined, IDS)).toBeUndefined()
  })

  it('decodes a param that was encoded twice', () => {
    expect(resolveQuestId('Mirror%2C%20Mirror', IDS)).toBe('Mirror, Mirror')
    expect(resolveQuestId('%E0%A4%A', IDS)).toBeUndefined()
  })

  it('matches wiki-style and lowercase ids loosely', () => {
    expect(resolveQuestId("black_knight's_fortress", IDS)).toBe("Black Knight's Fortress")
    expect(resolveQuestId('RATCATCHER', IDS)).toBe('Ratcatcher')
  })

  it('returns undefined for unknown ids', () => {
    expect(resolveQuestId('Dragon Slayer II', IDS)).toBeUndefined()
  })
})
