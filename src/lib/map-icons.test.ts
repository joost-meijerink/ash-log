import { describe, expect, it } from 'vitest'
import {
  clusterSize,
  formatClusterCount,
  iconKey,
  iconUrl,
  markerClassName,
  markerHtml,
  markerIconSpec,
  markerTone,
  questStartHtml,
  singleKind,
  stackHtml,
  type MarkerIconSpec,
  type StackChild,
} from './map-icons'
import type { MapCategory, MapGroup, MapPoint } from './types'

function cat(group: MapGroup, icon?: string): MapCategory {
  return { id: 'c', label: 'C', group, sources: [], count: 1, ...(icon ? { icon } : {}) }
}

const point: MapPoint = { id: 'c:1:2', categoryId: 'c', x: 1, y: 2 }

describe('marker icon choice', () => {
  it('uses the point icon before the category icon', () => {
    expect(markerIconSpec({ ...point, icon: 'Raw_Lobster.png' }, cat('resource', 'Coal.png'), false).file).toBe('Raw_Lobster.png')
    expect(markerIconSpec(point, cat('resource', 'Coal.png'), false).file).toBe('Coal.png')
  })

  it('falls back to a glyph disc coloured by group', () => {
    const spec = markerIconSpec(point, cat('chest'), false)
    expect(spec.file).toBeUndefined()
    expect(spec).toMatchObject({ glyph: 'chest', tone: 'ember' })
    expect(markerIconSpec(point, cat('vault'), false).tone).toBe('ember')
    expect(markerIconSpec(point, cat('location'), false).tone).toBe('ember')
    expect(markerIconSpec(point, cat('lore'), false).tone).toBe('muted')
    expect(markerIconSpec(point, cat('monster'), false).tone).toBe('muted')
    expect(markerIconSpec(point, undefined, false)).toMatchObject({ glyph: 'other', tone: 'muted' })
    expect(markerTone('quest-start')).toBe('gold')
  })

  it('dims found points only in lore and unique groups', () => {
    expect(markerIconSpec(point, cat('lore'), true).found).toBe(true)
    expect(markerIconSpec(point, cat('unique'), true).found).toBe(true)
    expect(markerIconSpec(point, cat('chest'), true).found).toBe(false)
  })

  it('shares one icon per spec', () => {
    const a = markerIconSpec(point, cat('resource', 'Coal.png'), false)
    const b = markerIconSpec({ ...point, id: 'c:9:9' }, cat('resource', 'Coal.png'), false)
    const c = markerIconSpec(point, cat('lore'), true)
    expect(iconKey(a)).toBe(iconKey(b))
    expect(iconKey(c)).not.toBe(iconKey(markerIconSpec(point, cat('lore'), false)))
  })
})

describe('marker markup', () => {
  it('renders the wiki image with the glyph disc as fallback', () => {
    const spec = markerIconSpec(point, cat('resource', 'Bittercap Mushroom (Map Icon).png'), false)
    expect(iconUrl(spec.file!)).toBe('/wiki-img/icons/Bittercap_Mushroom_(Map_Icon).png')
    expect(markerHtml(spec)).toContain('<img class="ash-marker__img" src="/wiki-img/icons/Bittercap_Mushroom_(Map_Icon).png"')
    expect(markerHtml(spec)).toContain('ash-marker__disc')
    expect(markerClassName(spec)).toBe('ash-marker ash-marker--muted has-img')
  })

  it('renders only the disc without an icon, dimmed when found', () => {
    const spec = markerIconSpec(point, cat('lore'), true)
    expect(markerHtml(spec)).not.toContain('<img')
    expect(markerClassName(spec)).toBe('ash-marker ash-marker--muted is-disc is-found')
  })

  it('shows a count on shared quest starts only', () => {
    expect(questStartHtml(1)).not.toContain('ash-quest-pin__count')
    expect(questStartHtml(2)).toContain('<span class="ash-quest-pin__count">2</span>')
  })
})

describe('clusters', () => {
  it('formats counts compactly with an English decimal point', () => {
    expect(formatClusterCount(7)).toBe('7')
    expect(formatClusterCount(999)).toBe('999')
    expect(formatClusterCount(1234)).toBe('1.2k')
    expect(formatClusterCount(2000)).toBe('2k')
    expect(formatClusterCount(11350)).toBe('11k')
  })

  it('grows with the count', () => {
    expect(clusterSize(3)).toBeLessThan(clusterSize(30))
    expect(clusterSize(30)).toBeLessThan(clusterSize(300))
    expect(clusterSize(300)).toBeLessThan(clusterSize(3000))
  })
})

describe('stacks', () => {
  const coal = markerIconSpec(point, cat('resource', 'Coal.png'), false)
  const tree = markerIconSpec(point, cat('resource', 'Ash_Tree.png'), false)
  const child = (key: string, spec: MarkerIconSpec, found = false): StackChild => ({ key, spec, label: key, found })

  it('gives the sprite of a cluster of one kind', () => {
    const items = [child('coal', coal), child('coal', coal), child('coal', coal)]
    expect(singleKind(items, (c) => c)).toEqual({ spec: coal, label: 'coal' })
  })

  it('gives nothing for mixed, unknown or empty clusters', () => {
    expect(singleKind([child('coal', coal), child('tree', tree)], (c) => c)).toBeNull()
    expect(singleKind([child('coal', coal), undefined], (c) => c)).toBeNull()
    expect(singleKind([], (c: StackChild) => c)).toBeNull()
  })

  it('stops at the first marker of another kind', () => {
    const seen: string[] = []
    const items = [child('coal', coal), child('tree', tree), child('coal', coal)]
    singleKind(items, (c) => (seen.push(c.key), c))
    expect(seen).toEqual(['coal', 'tree'])
  })

  it('is found only when every marker is found', () => {
    expect(singleKind([child('coal', coal, true), child('coal', coal)], (c) => c)!.spec.found).toBe(false)
    expect(singleKind([child('coal', coal, true), child('coal', coal, true)], (c) => c)!.spec.found).toBe(true)
  })

  it('draws the sprite with the disc fallback, a short count and an escaped label', () => {
    const html = stackHtml(coal, 1234, `Kebbit's <burrow> & co`)
    expect(html).toContain('<img class="ash-marker__img" src="/wiki-img/icons/Coal.png"')
    expect(html).toContain('ash-marker__disc')
    expect(html).toContain('<span class="ash-stack__count" aria-hidden="true">1.2k</span>')
    expect(html).toContain('1234 × Kebbit&#39;s &lt;burrow&gt; &amp; co, zoom in')
    expect(stackHtml({ ...coal, found: true }, 2, 'Coal')).toContain('class="ash-marker ash-marker--muted has-img is-found"')
  })
})
