// The sea beyond the map tiles: a grid layer under the tiles that paints the open water in two
// parts. The fine painted grain comes from a seamless texture cut from the map's own sea at the
// same zoom level (scripts/map/make-sea-textures.ts), with its large blotches filtered out so the
// repetition cannot be seen. The large, soft cloudiness comes from value noise anchored to world
// coordinates: it never repeats, neighbouring tiles match exactly, and the same patches stay in
// place while zooming. Both move and scale with the map.

import L from 'leaflet'
import sea0 from '@/assets/sea/sea-z0.png'
import sea1 from '@/assets/sea/sea-z1.png'
import sea2 from '@/assets/sea/sea-z2.png'
import sea3 from '@/assets/sea/sea-z3.png'
import sea4 from '@/assets/sea/sea-z4.png'
import { MAX_NATIVE_ZOOM, MIN_NATIVE_ZOOM, MULT, TILE_SIZE, WORLD_SIZE } from '@/lib/projection'

/** Texture per native zoom level, index = zoom. */
export const SEA_TEXTURES = [sea0, sea1, sea2, sea3, sea4]

/** Open-water colour, used until a texture has loaded (same as the map background). */
export const SEA_COLOUR = '#657573'

/** Cloudiness: strength in colour levels, and the size of the largest blotches in zoom-3 pixels. */
export const NOISE_STRENGTH = 7
export const NOISE_CELL = 128
/** Zoom level whose pixels the noise cell is measured in. */
const NOISE_ZOOM = 3
/** The noise is computed every this many pixels and blended in between. */
const NOISE_STEP = 8

/** Deterministic pseudo-random value in [-1, 1] for a lattice point. */
function lattice(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h & 0xffff) / 32767.5 - 1
}

const smooth = (t: number) => t * t * (3 - 2 * t)

/** Smooth value noise in [-1, 1] at a point, lattice spacing 1. */
function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = smooth(x - ix)
  const fy = smooth(y - iy)
  const top = lattice(ix, iy, seed) + (lattice(ix + 1, iy, seed) - lattice(ix, iy, seed)) * fx
  const bottom = lattice(ix, iy + 1, seed) + (lattice(ix + 1, iy + 1, seed) - lattice(ix, iy + 1, seed)) * fx
  return top + (bottom - top) * fy
}

/**
 * The sea's large-scale light and dark, in colour levels, at a point in zoom-3 pixels: two
 * octaves of value noise. Deterministic, continuous and without a period.
 */
export function seaNoise(x: number, y: number): number {
  const u = x / NOISE_CELL
  const v = y / NOISE_CELL
  return ((valueNoise(u, v, 1) + 0.5 * valueNoise(u * 2.03, v * 2.03, 2)) / 1.5) * NOISE_STRENGTH
}

/** Adds the cloudiness to a painted tile (its pixels at tile zoom `zoom`, grid position x, y). */
export function applySeaNoise(image: ImageData, coords: { x: number; y: number; z: number }) {
  const { width, height, data } = image
  const scale = 2 ** (NOISE_ZOOM - coords.z)
  const left = coords.x * TILE_SIZE
  const top = coords.y * TILE_SIZE
  const cols = Math.ceil(width / NOISE_STEP) + 1
  const rows = Math.ceil(height / NOISE_STEP) + 1
  // Noise at the corners of an 8 px grid, in global pixel positions, so neighbours share values.
  const grid = new Float32Array(cols * rows)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) grid[j * cols + i] = seaNoise((left + i * NOISE_STEP) * scale, (top + j * NOISE_STEP) * scale)
  }
  for (let y = 0; y < height; y++) {
    const gy = y / NOISE_STEP
    const j = Math.floor(gy)
    const ty = gy - j
    for (let x = 0; x < width; x++) {
      const gx = x / NOISE_STEP
      const i = Math.floor(gx)
      const tx = gx - i
      const a = grid[j * cols + i]!
      const b = grid[j * cols + i + 1]!
      const c = grid[(j + 1) * cols + i]!
      const d = grid[(j + 1) * cols + i + 1]!
      const delta = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
      const o = (y * width + x) * 4
      data[o] = data[o]! + delta
      data[o + 1] = data[o + 1]! + delta
      data[o + 2] = data[o + 2]! + delta
    }
  }
}

/** Offset into a repeating texture of `size` px for a tile at grid position `index` (may be negative). */
export function patternOffset(index: number, tileSize: number, size: number): number {
  return (((index * tileSize) % size) + size) % size
}

/** Texture index for a tile zoom (overzoomed tiles reuse the highest level). */
export function textureZoom(zoom: number): number {
  return Math.min(MAX_NATIVE_ZOOM, Math.max(MIN_NATIVE_ZOOM, Math.round(zoom)))
}

/** Paints one tile: the texture of its zoom level, continuing the pattern of its neighbours. */
export function paintSea(canvas: HTMLCanvasElement, coords: { x: number; y: number; z: number }, textures: readonly HTMLImageElement[]) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const texture = textures[textureZoom(coords.z)]
  const size = texture?.naturalWidth ?? 0
  const pattern = size > 0 ? ctx.createPattern(texture!, 'repeat') : null
  if (!pattern) {
    ctx.fillStyle = SEA_COLOUR
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    return
  }
  const ox = patternOffset(coords.x, TILE_SIZE, size)
  const oy = patternOffset(coords.y, TILE_SIZE, size)
  ctx.save()
  ctx.translate(-ox, -oy)
  ctx.fillStyle = pattern
  ctx.fillRect(ox, oy, canvas.width, canvas.height)
  ctx.restore()
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  applySeaNoise(pixels, coords)
  ctx.putImageData(pixels, 0, 0)
}

/** Resolves when an image has loaded or failed (decode() where available, else the load events). */
function whenLoaded(image: HTMLImageElement): Promise<void> {
  if (typeof image.decode === 'function') return image.decode().catch(() => undefined)
  if (image.complete) return Promise.resolve()
  return new Promise((resolve) => {
    image.addEventListener('load', () => resolve(), { once: true })
    image.addEventListener('error', () => resolve(), { once: true })
  })
}

/** A grid layer with the sea, meant to sit under the map tiles (zIndex 0). */
export function createSeaLayer(options: L.GridLayerOptions = {}): L.GridLayer {
  const textures = SEA_TEXTURES.map((src) => {
    const image = new Image()
    image.decoding = 'async'
    image.src = src
    return image
  })
  const loaded = Promise.all(textures.map(whenLoaded))

  // extend() is typed without constructor arguments; the options go to GridLayer's initialize.
  const SeaLayer = L.GridLayer.extend({
    createTile(this: L.GridLayer, coords: L.Coords, done: L.DoneCallback) {
      const canvas = L.DomUtil.create('canvas', 'ash-sea-tile') as HTMLCanvasElement
      const size = this.getTileSize()
      canvas.width = size.x
      canvas.height = size.y
      void loaded.then(() => {
        paintSea(canvas, coords, textures)
        done(undefined, canvas)
      })
      return canvas
    },
  })
  const Layer = SeaLayer as unknown as new (options: L.GridLayerOptions) => L.GridLayer
  return new Layer({
    tileSize: TILE_SIZE,
    minNativeZoom: MIN_NATIVE_ZOOM,
    maxNativeZoom: MAX_NATIVE_ZOOM,
    zIndex: 0,
    keepBuffer: 4,
    ...options,
  })
}

/** Pixel size of the whole map at a zoom level (same maths as the tiles). */
export function worldPixels(zoom: number): number {
  return Math.round(2 ** zoom * MULT * WORLD_SIZE)
}

/** Width of the band where the map tiles fade into the sea layer, in tile pixels. */
export function featherWidth(zoom: number): number {
  return Math.min(48, worldPixels(zoom) * 0.03)
}

/** The open-water colour as RGB (SEA_COLOUR). */
const SEA_RGB = [101, 117, 115] as const

/**
 * How much a pixel looks like open water: 1 for the sea colour, 0 for land, coastlines and
 * anything else, with a soft step in between (sum of channel differences 12 to 36).
 */
export function seaness(r: number, g: number, b: number): number {
  const d = Math.abs(r - SEA_RGB[0]) + Math.abs(g - SEA_RGB[1]) + Math.abs(b - SEA_RGB[2])
  return Math.max(0, Math.min(1, 1 - (d - 12) / 24))
}

/**
 * Distance in tile pixels from a pixel of a tile to the nearest world edge that runs through
 * or close to that tile: negative outside the world, Infinity when no edge is near.
 */
export function edgeDistance(coords: { x: number; y: number; z: number }, px: number, py: number): number {
  const world = worldPixels(coords.z)
  const gx = coords.x * TILE_SIZE + px + 0.5
  const gy = coords.y * TILE_SIZE + py + 0.5
  return Math.min(gx, gy, world - gx, world - gy)
}

/** True when a tile touches the band along the world edge where the sea fades out. */
export function isEdgeTile(coords: { x: number; y: number; z: number }): boolean {
  const world = worldPixels(coords.z)
  const fade = featherWidth(coords.z)
  const x0 = coords.x * TILE_SIZE
  const y0 = coords.y * TILE_SIZE
  const near = (start: number) => start < fade || start + TILE_SIZE > world - fade
  return near(x0) || near(y0)
}

/**
 * Alpha for one pixel of an edge tile: land and coastlines stay fully opaque; open water
 * fades out towards the world edge, so the sea layer underneath takes over without a line.
 */
export function featherAlpha(r: number, g: number, b: number, distance: number, fade: number): number {
  if (distance <= 0) return 0
  const ramp = Math.min(1, distance / fade)
  return 1 - (1 - ramp) * seaness(r, g, b)
}

/**
 * Gives a loaded map tile on the world edge a mask made from its own pixels (see featherAlpha).
 * Tiles away from the edge are left alone. The tiles are same-origin, so their pixels can be read.
 */
export function featherTile(tile: HTMLImageElement, coords: { x: number; y: number; z: number }) {
  if (!isEdgeTile(coords) || !tile.naturalWidth) return
  const size = tile.naturalWidth
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = tile.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  ctx.drawImage(tile, 0, 0)
  let image: ImageData
  try {
    image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  } catch {
    return // a tainted canvas: leave the tile as it is
  }
  const fade = featherWidth(coords.z)
  const scale = TILE_SIZE / size
  const d = image.data
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4
      const alpha = featherAlpha(d[o]!, d[o + 1]!, d[o + 2]!, edgeDistance(coords, x * scale, y * scale), fade)
      d[o] = 0
      d[o + 1] = 0
      d[o + 2] = 0
      d[o + 3] = Math.round(d[o + 3]! * alpha)
    }
  }
  ctx.putImageData(image, 0, 0)
  const mask = `url(${canvas.toDataURL('image/png')})`
  const style = tile.style as CSSStyleDeclaration & { webkitMaskImage: string; webkitMaskSize: string }
  style.webkitMaskImage = mask
  style.maskImage = mask
  style.webkitMaskSize = '100% 100%'
  style.maskSize = '100% 100%'
}
