import { describe, expect, it } from 'vitest'
import { LEGACY_VIEW_PATHS, legacyRedirect, modernQuery } from './legacy-url'

describe('modernQuery', () => {
  it('renames the Dutch collections keys and keeps the rest in order', () => {
    expect(modernQuery('collections', { soort: 'vestige', verberg: '1', x: 'y' })).toEqual({ kind: 'vestige', hide: '1', x: 'y' })
    expect(Object.keys(modernQuery('collections', { x: 'y', soort: 'quest' })!)).toEqual(['x', 'kind'])
    expect(modernQuery('collections', { verberg: 'ja' })).toEqual({ hide: '1' })
    expect(modernQuery('collections', { verberg: ['ja', '0'] })).toEqual({ hide: ['1', '0'] })
    expect(modernQuery('collections', { soort: null })).toEqual({ kind: null })
  })

  it('lets an English key win over its Dutch twin', () => {
    expect(modernQuery('collections', { soort: 'quest', kind: 'effigy' })).toEqual({ kind: 'effigy' })
    expect(modernQuery('collections', { hide: '0', verberg: '1' })).toEqual({ hide: '0' })
  })

  it('translates the Dutch quest status values, whatever their case', () => {
    expect(modernQuery('quests', { q: 'rat', status: 'bezig' })).toEqual({ q: 'rat', status: 'active' })
    expect(modernQuery('quests', { status: 'Voltooid' })).toEqual({ status: 'done' })
    expect(modernQuery('quests', { status: ['bezig', 'open'] })).toEqual({ status: ['active', 'open'] })
  })

  it('returns null when nothing is Dutch, or for a view without Dutch keys', () => {
    expect(modernQuery('collections', { kind: 'quest', hide: '1' })).toBeNull()
    expect(modernQuery('collections', {})).toBeNull()
    expect(modernQuery('quests', { status: 'active' })).toBeNull()
    expect(modernQuery('quests', { status: 'open' })).toBeNull()
    expect(modernQuery('quests', { status: null })).toBeNull()
    expect(modernQuery('quests', { soort: 'quest' })).toBeNull()
    expect(modernQuery('map', { soort: 'quest', status: 'bezig' })).toBeNull()
    expect(modernQuery(undefined, { soort: 'quest' })).toBeNull()
  })
})

describe('legacyRedirect', () => {
  it('keeps the path and the hash', () => {
    const to = { name: 'quests', path: '/quests/Rune%20Mysteries', query: { status: 'voltooid' }, hash: '#step-2' }
    expect(legacyRedirect(to)).toEqual({ path: '/quests/Rune%20Mysteries', query: { status: 'done' }, hash: '#step-2' })
    expect(legacyRedirect({ name: 'collections', path: '/collections', query: { kind: 'all' }, hash: '#unlocks' })).toBeUndefined()
  })

  it('knows the old view paths', () => {
    expect(LEGACY_VIEW_PATHS).toEqual({ '/kaart': '/map', '/verzamelingen': '/collections' })
  })
})
