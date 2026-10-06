// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  applySeaNoise,
  edgeDistance,
  featherAlpha,
  featherWidth,
  isEdgeTile,
  NOISE_STRENGTH,
  patternOffset,
  seaNoise,
  seaness,
  textureZoom,
  worldPixels,
} from './sea-layer'

describe('sea texture placement', () => {
  it('continues the texture across tiles, also left of and above the world', () => {
    expect(patternOffset(0, 256, 448)).toBe(0)
    expect(patternOffset(1, 256, 448)).toBe(256)
    expect(patternOffset(2, 256, 448)).toBe(64)
    expect(patternOffset(-1, 256, 448)).toBe(192)
    for (const i of [-3, -1, 0, 4]) expect((patternOffset(i, 256, 84) + 256) % 84).toBe(patternOffset(i + 1, 256, 84))
  })

  it('uses the texture of the tile zoom, the highest one when overzoomed', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(textureZoom)).toEqual([0, 1, 2, 3, 4, 4, 4])
  })
})

describe('sea cloudiness', () => {
  it('is deterministic, bounded and smooth', () => {
    expect(seaNoise(123.4, 567.8)).toBe(seaNoise(123.4, 567.8))
    let max = 0
    for (let i = 0; i < 2000; i++) {
      const v = seaNoise(i * 37.1, i * 11.3)
      max = Math.max(max, Math.abs(v))
      // A step of one pixel changes the value only a little.
      expect(Math.abs(seaNoise(i * 37.1 + 1, i * 11.3) - v)).toBeLessThan(0.3)
    }
    expect(max).toBeLessThanOrEqual(NOISE_STRENGTH)
    expect(max).toBeGreaterThan(NOISE_STRENGTH * 0.4)
  })

  it('does not repeat', () => {
    const row = Array.from({ length: 64 }, (_, i) => Math.round(seaNoise(i * 128, 0) * 100))
    const shifted = Array.from({ length: 64 }, (_, i) => Math.round(seaNoise(i * 128 + 4096, 0) * 100))
    expect(row).not.toEqual(shifted)
  })

  it('matches exactly where two tiles meet', () => {
    const tile = (x: number) => {
      const image = { width: 256, height: 256, data: new Uint8ClampedArray(256 * 256 * 4).fill(100) } as unknown as ImageData
      applySeaNoise(image, { x, y: 5, z: 2 })
      return image
    }
    const left = tile(3)
    const right = tile(4)
    for (const y of [0, 77, 255]) {
      const lastOfLeft = left.data[(y * 256 + 255) * 4]!
      const firstOfRight = right.data[(y * 256) * 4]!
      expect(Math.abs(lastOfLeft - firstOfRight)).toBeLessThanOrEqual(1)
    }
  })
})

describe('edge feathering', () => {
  it('knows which tiles touch the fade band', () => {
    expect(worldPixels(0)).toBe(384)
    expect(isEdgeTile({ x: 0, y: 3, z: 3 })).toBe(true)
    expect(isEdgeTile({ x: 11, y: 3, z: 3 })).toBe(true)
    expect(isEdgeTile({ x: 5, y: 5, z: 3 })).toBe(false)
  })

  it('measures the distance to the nearest world edge, negative outside', () => {
    expect(edgeDistance({ x: 0, y: 2, z: 3 }, 9.5, 100)).toBe(10)
    expect(edgeDistance({ x: 1, y: 0, z: 0 }, 200, 50)).toBeLessThan(0) // tile 1 at zoom 0 sticks out past 384 px
  })

  it('fades open water towards the edge but keeps land and coasts opaque', () => {
    const fade = featherWidth(3)
    expect(seaness(101, 117, 115)).toBe(1)
    expect(seaness(180, 150, 90)).toBe(0)
    // Water: transparent at the edge, opaque once a full band inside.
    expect(featherAlpha(101, 117, 115, 1, fade)).toBeLessThan(0.1)
    expect(featherAlpha(101, 117, 115, fade, fade)).toBe(1)
    // Land right at the edge stays.
    expect(featherAlpha(180, 150, 90, 1, fade)).toBe(1)
    expect(featherAlpha(40, 30, 25, 1, fade)).toBe(1)
    // Outside the world nothing shows.
    expect(featherAlpha(180, 150, 90, -2, fade)).toBe(0)
  })
})
