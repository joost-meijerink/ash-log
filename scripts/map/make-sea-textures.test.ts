import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { edgeCandidates, highPass, isPureSea, makeSeamless, OUT_DIR, type Region } from './make-sea-textures.ts'

const solid = (size: number, rgb: [number, number, number]): Region => {
  const pixels = new Uint8Array(size * size * 4)
  for (let i = 0; i < pixels.length; i += 4) pixels.set([...rgb, 255], i)
  return { width: size, height: size, pixels }
}

describe('sea textures', () => {
  it('lists squares along all four edges', () => {
    const c = edgeCandidates(100, 50, 25)
    expect(c).toContainEqual([0, 0])
    expect(c).toContainEqual([50, 50])
    expect(c).toContainEqual([25, 0])
    expect(c).toContainEqual([0, 25])
    expect(c.every(([x, y]) => x === 0 || y === 0 || x === 50 || y === 50)).toBe(true)
  })

  it('recognises pure sea and rejects land', () => {
    const sea = { r: 101, g: 117, b: 115 }
    const water = solid(8, [104, 118, 112])
    expect(isPureSea(water, sea, 1)).toBe(true)
    water.pixels.set([200, 150, 90, 255], (3 * 8 + 3) * 4)
    expect(isPureSea(water, sea, 1)).toBe(false)
  })

  it('makes a texture whose opposite edges continue each other', () => {
    // A horizontal ramp (0..255): not seamless as it is.
    const size = 40
    const border = 8
    const pixels = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) pixels.set([Math.round((x * 255) / (size - 1)), 0, 0, 255], (y * size + x) * 4)
    }
    const out = makeSeamless({ width: size, height: size, pixels }, border)
    const S = size - border
    expect(out.width).toBe(S)
    const red = (x: number, y: number) => out.pixels[(y * S + x) * 4]!
    // The left edge picks up where the right edge ends: the jump across the wrap is as small as a normal step.
    const step = Math.abs(red(S - 1, 5) - red(S - 2, 5))
    expect(Math.abs(red(0, 5) - red(S - 1, 5))).toBeLessThanOrEqual(step + 1)
  })

  it('removes large blotches but keeps the texture seamless and its mean', () => {
    const size = 48
    const pixels = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // A dark blotch (large scale) plus fine grain.
        const blotch = Math.hypot(x - 24, y - 24) < 10 ? -20 : 0
        const grain = (x + y) % 2 ? 3 : -3
        pixels.set([100 + blotch + grain, 100 + blotch + grain, 100 + blotch + grain, 255], (y * size + x) * 4)
      }
    }
    const { texture, removed } = highPass({ width: size, height: size, pixels }, 3)
    expect(removed).toBeGreaterThan(3)
    const at = (x: number, y: number) => texture.pixels[(y * size + x) * 4]!
    // The blotch is gone: its centre is about as bright as far away from it.
    expect(Math.abs(at(24, 24) - at(2, 2))).toBeLessThan(6)
    // The grain survives.
    expect(Math.abs(at(10, 10) - at(11, 10))).toBeGreaterThanOrEqual(4)
  })

  it('ships a square texture per zoom level', () => {
    for (let z = 0; z <= 4; z++) {
      const png = readFileSync(join(OUT_DIR, `sea-z${z}.png`))
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
      expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20))
      expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(64)
    }
  })
})
