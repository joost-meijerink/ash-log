import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { continuousRect, FIGMA_DIR, figmaSvg, readBands, SHAPES } from './make-figma.ts'
import { DESKTOP_DIR, readSource } from './make-icons.ts'

const shapePath = (source: string, id: string) =>
  new RegExp(`<path id="${id}" d="([^"]+)"/>`).exec(readFileSync(join(DESKTOP_DIR, `${source}.svg`), 'utf8'))?.[1]

describe('continuousRect', () => {
  it.each(Object.entries(SHAPES))('reproduces the %s shape of the render source exactly', (_, shape) => {
    expect(continuousRect(shape.x, shape.y, shape.size, shape.size, shape.radius)).toBe(shapePath(shape.source, shape.id))
  })
})

describe('readBands', () => {
  it('reads inset, width, colour and opacity of every border', () => {
    expect(readBands(readSource('icon'))).toEqual([
      { name: 'outer', inset: 66, width: 14, color: '#0c0a07' },
      { name: 'inner', inset: 74, width: 4, color: '#3a2f22' },
      { name: 'gold', inset: 104, width: 12, color: '#c9a24a', opacity: 0.85 },
    ])
    expect(readBands(readSource('icon-macos')).map((b) => [b.name, b.inset, b.width])).toEqual([
      ['outer', 26, 11],
      ['inner', 32, 3],
      ['gold', 56, 11],
    ])
  })
})

describe('figmaSvg', () => {
  it.each(['ios', 'macos'] as const)('%s has no masks, filters, references or external files', (variant) => {
    const svg = figmaSvg(variant)
    expect(svg).not.toMatch(/<mask|mask=|<filter|filter=|<use |href="ash-logs.png"|<!--[^>]*(band|grain)/)
    expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"')
    expect(svg).toMatch(/<image id="Ash_Logs" xlink:href="data:image\/png;base64,/)
  })

  it.each(['ios', 'macos'] as const)('%s names its layers', (variant) => {
    const ids = [...figmaSvg(variant).matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
    expect(ids).toEqual(expect.arrayContaining(['Leather', 'Compass_rose', 'Borders', 'Border_outer', 'Border_inner', 'Border_gold', 'Diamonds', 'Ash_Logs']))
  })

  it('draws the gold border as a stroked continuous rect inset from the iOS mask', () => {
    const gold = /<path id="Border_gold" d="([^"]+)" fill="none" stroke="#c9a24a" stroke-width="12" opacity="0.85"\/>/.exec(figmaSvg('ios'))
    expect(gold?.[1]).toBe(continuousRect(104, 104, 816, 816, 230.4 - 104))
  })

  it('keeps the iOS mask as a guide layer only on the iOS copy', () => {
    expect(figmaSvg('ios')).toContain('id="iOS_mask_guide_hide_on_export"')
    expect(figmaSvg('macos')).not.toContain('hulplijn')
  })

  it.each(['ios', 'macos'] as const)('the committed figma/ash-log-%s.svg is up to date', (variant) => {
    const committed = readFileSync(join(FIGMA_DIR, `ash-log-${variant}.svg`), 'utf8')
    expect(committed === figmaSvg(variant), 'stale: run npx tsx scripts/desktop/make-figma.ts').toBe(true)
  })
})
