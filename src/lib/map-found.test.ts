import { describe, expect, it } from 'vitest'
import { buildPointLinks, canonicalPointId, foundPointIds, linkedRewards, markIds, pointFoundState } from './map-found'
import type { MapPoint, Reward } from './types'

// The 3-way lore spot from the real data: lore-scraps kept, Ravanna's journal merged into it.
const scrap: MapPoint = {
  id: 'lore-scraps:132249:30611',
  categoryId: 'lore-scraps',
  x: 132249,
  y: 30611,
  name: "Ravanna's First Journal",
  aliases: ['ravannas-first-journal:132249:30611'],
}
const diary: MapPoint = { id: 'weathered-diary:132249:30611', categoryId: 'weathered-diary', x: 132249, y: 30611 }
const book: MapPoint = {
  id: 'recipe-books:201455:34717',
  categoryId: 'recipe-books',
  x: 201455,
  y: 34717,
  aliases: ['recipe-meat-sandwich:201455:34717'],
}
const tapestry: MapPoint = { id: 'torn-tapestry:1:2', categoryId: 'torn-tapestry', x: 1, y: 2 }

const sandwich: Reward = { id: 'recipe-book:meat-sandwich', kind: 'recipe-book', name: 'Meat Sandwich', pointIds: [book.id] }
const cape: Reward = { id: 'pattern:dowdun-reach-cape', kind: 'pattern', name: 'Dowdun Reach Cape', pointIds: [tapestry.id] }
// Linked through an alias id: lands on the kept point.
const pie: Reward = { id: 'recipe-book:pie', kind: 'recipe-book', name: 'Pie', pointIds: ['recipe-meat-sandwich:201455:34717', book.id] }
const unlinked: Reward = { id: 'plan:torch', kind: 'plan', name: 'Torch' }

const points = [scrap, diary, book, tapestry]
const links = buildPointLinks(points, [sandwich, cape, pie, unlinked])
const none = new Set<string>()

describe('point links', () => {
  it('maps alias ids to the kept point', () => {
    expect(canonicalPointId('ravannas-first-journal:132249:30611', links)).toBe(scrap.id)
    expect(canonicalPointId(diary.id, links)).toBe(diary.id)
    expect(canonicalPointId('gone:1:1', links)).toBe('gone:1:1')
    expect(markIds(scrap)).toEqual([scrap.id, 'ravannas-first-journal:132249:30611'])
    expect(markIds(diary)).toEqual([diary.id])
  })

  it('indexes rewards per point, once each, through aliases', () => {
    expect(linkedRewards(book.id, links).map((r) => r.id)).toEqual([sandwich.id, pie.id])
    expect(linkedRewards(tapestry.id, links).map((r) => r.id)).toEqual([cape.id])
    expect(linkedRewards(scrap.id, links)).toEqual([])
    expect(links.rewardsByPoint.has('recipe-meat-sandwich:201455:34717')).toBe(false)
  })
})

describe('found rule', () => {
  it('counts a tick on the point itself', () => {
    const found = foundPointIds(links, [scrap.id], none)
    expect(found.has(scrap.id)).toBe(true)
    expect(found.has(diary.id)).toBe(false)
  })

  it('counts a tick on an alias as the kept point, and leaves the other twin alone', () => {
    const found = foundPointIds(links, ['ravannas-first-journal:132249:30611'], none)
    expect([...found]).toEqual([scrap.id])
    expect(pointFoundState(scrap, links, new Set(['ravannas-first-journal:132249:30611']), none)).toMatchObject({
      found: true,
      marked: true,
    })
  })

  it('counts an owned linked reward as found, without any map tick', () => {
    const owned = new Set([cape.id])
    expect(foundPointIds(links, [], owned).has(tapestry.id)).toBe(true)
    const state = pointFoundState(tapestry, links, none, owned)
    expect(state).toMatchObject({ found: true, marked: false })
    expect(state.rewards.map((r) => r.id)).toEqual([cape.id])
  })

  it('needs only one of several linked rewards', () => {
    expect(foundPointIds(links, [], new Set([pie.id])).has(book.id)).toBe(true)
    expect(foundPointIds(links, [], new Set([unlinked.id])).size).toBe(0)
  })

  it('agrees between the set and the single-point check for every combination', () => {
    const markSets = [[], [scrap.id], ['ravannas-first-journal:132249:30611'], ['recipe-meat-sandwich:201455:34717'], [tapestry.id]]
    const ownedSets = [[], [cape.id], [sandwich.id], [pie.id, unlinked.id]]
    for (const m of markSets) {
      for (const o of ownedSets) {
        const marks = new Set(m)
        const owned = new Set(o)
        const found = foundPointIds(links, marks, owned)
        for (const p of points) expect(pointFoundState(p, links, marks, owned).found).toBe(found.has(p.id))
      }
    }
  })
})
