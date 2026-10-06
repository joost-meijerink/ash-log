/**
 * Seamless sea textures for the water beyond the map, one per native zoom level.
 *
 *   npx tsx scripts/map/make-sea-textures.ts     reads public/wiki-img/tiles, writes src/assets/sea/sea-z<z>.png
 *
 * The painted sea on the wiki tiles has a soft, cloudy structure whose grain depends on the zoom
 * level. For every zoom this finds the largest square of pure sea along the edge of the map
 * (every pixel close to the sea colour), and turns it into a texture that tiles without a seam:
 * the square is B pixels larger than the texture, and that extra strip is cross-faded over the
 * opposite edge, first horizontally, then vertically. Then the large, soft blotches are
 * filtered out (high-pass: minus a wrap-around blur), because a recognisable dark patch makes
 * the repetition visible; only the fine painted grain is kept. The sea layer adds the large-scale
 * cloudiness back with noise that never repeats (see src/components/map/sea-layer.ts). The map's
 * sea changes rarely, so the textures are committed; run this again after a sync that changed
 * the tiles.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { encodeOpaquePng } from '../desktop/make-icons.ts'
import { MAX_NATIVE_ZOOM, MIN_NATIVE_ZOOM, MULT, TILE_SIZE, WORLD_SIZE } from '../../src/lib/projection.ts'
import { isEntryPoint } from '../sync/node-command.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
export const TILES_DIR = join(ROOT, 'public', 'wiki-img', 'tiles')
export const OUT_DIR = join(ROOT, 'src', 'assets', 'sea')

/** Largest-first square sizes to try; each must leave room for the cross-fade strip. */
const SIZES = [512, 448, 384, 320, 256, 192, 160, 128, 96, 80, 64]
/** A pixel counts as sea when its colour is this close (sum of channel differences) to the sea colour. */
const SEA_TOLERANCE = 45

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface Region {
  width: number
  height: number
  /** Straight RGBA (the tiles are opaque). */
  pixels: Uint8Array
}

/** Pixel size of the whole map at a zoom level. */
export const worldSize = (zoom: number) => Math.round(2 ** zoom * MULT * WORLD_SIZE)

const tileData = new Map<string, string | null>()
function tileHref(zoom: number, x: number, y: number): string | null {
  const key = `${zoom}/${x}_${y}`
  if (!tileData.has(key)) {
    const file = join(TILES_DIR, String(zoom), `${x}_${y}.png`)
    tileData.set(key, existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString('base64')}` : null)
  }
  return tileData.get(key)!
}

/** The pixels of a square of the map at a zoom level, composed from the tiles under it. */
export function readRegion(zoom: number, left: number, top: number, size: number): Region {
  const images: string[] = []
  for (let ty = Math.floor(top / TILE_SIZE); ty <= Math.floor((top + size - 1) / TILE_SIZE); ty++) {
    for (let tx = Math.floor(left / TILE_SIZE); tx <= Math.floor((left + size - 1) / TILE_SIZE); tx++) {
      const href = tileHref(zoom, tx, ty)
      if (href) images.push(`<image href="${href}" x="${tx * TILE_SIZE - left}" y="${ty * TILE_SIZE - top}" width="${TILE_SIZE}" height="${TILE_SIZE}"/>`)
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#ff00ff"/>${images.join('')}</svg>`
  const image = new Resvg(svg, { font: { loadSystemFonts: false } }).render()
  return { width: image.width, height: image.height, pixels: image.pixels }
}

export function meanColour(region: Region): Rgb {
  let r = 0
  let g = 0
  let b = 0
  const n = region.width * region.height
  for (let i = 0; i < n * 4; i += 4) {
    r += region.pixels[i]!
    g += region.pixels[i + 1]!
    b += region.pixels[i + 2]!
  }
  return { r: r / n, g: g / n, b: b / n }
}

/** True when every sampled pixel is close to the sea colour (missing tiles are magenta and fail). */
export function isPureSea(region: Region, sea: Rgb, step = 2): boolean {
  for (let y = 0; y < region.height; y += step) {
    for (let x = 0; x < region.width; x += step) {
      const i = (y * region.width + x) * 4
      const d = Math.abs(region.pixels[i]! - sea.r) + Math.abs(region.pixels[i + 1]! - sea.g) + Math.abs(region.pixels[i + 2]! - sea.b)
      if (d > SEA_TOLERANCE) return false
    }
  }
  return true
}

/** Squares of a size along the four edges of a world, `step` apart. */
export function edgeCandidates(world: number, size: number, step: number): [number, number][] {
  const out: [number, number][] = []
  const far = world - size
  for (let p = 0; p <= far; p += step) out.push([p, 0], [p, far], [0, p], [far, p])
  return out
}

/**
 * Cross-fades the extra B-pixel strip of a (S + B) square over its opposite edges, so the
 * S x S result tiles without a seam. At the texture's left edge the pixels come from the far
 * strip (continuing the right edge), fading to the patch's own pixels B pixels in.
 */
export function makeSeamless(patch: Region, border: number): Region {
  const W = patch.width
  const S = W - border
  const get = (src: Uint8Array, width: number, x: number, y: number, c: number) => src[(y * width + x) * 4 + c]!
  // Horizontal pass: W rows, S columns.
  const h = new Uint8Array(S * W * 4)
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < S; x++) {
      const t = x < border ? 1 - (x + 0.5) / border : 0
      for (let c = 0; c < 4; c++) {
        const own = get(patch.pixels, W, x, y, c)
        const far = x < border ? get(patch.pixels, W, S + x, y, c) : own
        h[(y * S + x) * 4 + c] = Math.round(own * (1 - t) + far * t)
      }
    }
  }
  // Vertical pass: S rows, S columns.
  const out = new Uint8Array(S * S * 4)
  for (let y = 0; y < S; y++) {
    const t = y < border ? 1 - (y + 0.5) / border : 0
    for (let x = 0; x < S; x++) {
      for (let c = 0; c < 4; c++) {
        const own = get(h, S, x, y, c)
        const far = y < border ? get(h, S, x, S + y, c) : own
        out[(y * S + x) * 4 + c] = Math.round(own * (1 - t) + far * t)
      }
    }
  }
  return { width: S, height: S, pixels: out }
}

/** One box-blur pass along one axis, wrapping around (the texture tiles). */
function boxBlurAxis(src: Float32Array, size: number, radius: number, horizontal: boolean): Float32Array {
  const out = new Float32Array(src.length)
  const span = 2 * radius + 1
  for (let line = 0; line < size; line++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0
      const at = (i: number) => {
        const k = ((i % size) + size) % size
        return horizontal ? src[(line * size + k) * 3 + c]! : src[(k * size + line) * 3 + c]!
      }
      for (let i = -radius; i <= radius; i++) sum += at(i)
      for (let i = 0; i < size; i++) {
        const o = horizontal ? (line * size + i) * 3 + c : (i * size + line) * 3 + c
        out[o] = sum / span
        sum += at(i + radius + 1) - at(i - radius)
      }
    }
  }
  return out
}

/**
 * Keeps the fine grain of a seamless square texture and flattens its large-scale light and
 * dark areas: result = texture - blur(texture) + mean. The blur wraps around, so the result
 * stays seamless. Returns the texture and the strength (standard deviation) of what was removed.
 */
export function highPass(texture: Region, radius: number): { texture: Region; removed: number } {
  const size = texture.width
  const n = size * size
  let rgb: Float32Array = new Float32Array(n * 3)
  const mean = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      rgb[i * 3 + c] = texture.pixels[i * 4 + c]!
      mean[c]! += texture.pixels[i * 4 + c]! / n
    }
  }
  const original = rgb
  // Three box passes per axis approximate a gaussian blur.
  for (let pass = 0; pass < 3; pass++) {
    rgb = boxBlurAxis(rgb, size, radius, true)
    rgb = boxBlurAxis(rgb, size, radius, false)
  }
  const pixels = new Uint8Array(n * 4)
  let removed = 0
  for (let i = 0; i < n; i++) {
    let luma = 0
    for (let c = 0; c < 3; c++) {
      const low = rgb[i * 3 + c]! - mean[c]!
      luma += low / 3
      pixels[i * 4 + c] = Math.max(0, Math.min(255, Math.round(original[i * 3 + c]! - low)))
    }
    pixels[i * 4 + 3] = 255
    removed += luma * luma
  }
  return { texture: { width: size, height: size, pixels }, removed: Math.sqrt(removed / n) }
}

export interface SeaPatch {
  zoom: number
  left: number
  top: number
  size: number
}

/** The largest pure-sea square along the map's edge at a zoom level, or undefined. */
export function findSeaPatch(zoom: number, sea: Rgb): SeaPatch | undefined {
  const world = worldSize(zoom)
  for (const size of SIZES) {
    if (size > world / 2) continue
    for (const [left, top] of edgeCandidates(world, size, Math.max(16, size / 4))) {
      if (isPureSea(readRegion(zoom, left, top, size), sea)) return { zoom, left, top, size }
    }
  }
  return undefined
}

/** The sea colour: the mean of the corner tile at the highest zoom, which is open water. */
export function seaColour(): Rgb {
  return meanColour(readRegion(MAX_NATIVE_ZOOM, 0, 0, TILE_SIZE))
}

export function writeSeaTextures(outDir = OUT_DIR): string[] {
  mkdirSync(outDir, { recursive: true })
  const sea = seaColour()
  const written: string[] = []
  for (let zoom = MIN_NATIVE_ZOOM; zoom <= MAX_NATIVE_ZOOM; zoom++) {
    const patch = findSeaPatch(zoom, sea)
    if (!patch) throw new Error(`No patch of open sea found at zoom ${zoom}`)
    const border = Math.round(patch.size / 8)
    const seamless = makeSeamless(readRegion(zoom, patch.left, patch.top, patch.size), border)
    const { texture, removed } = highPass(seamless, Math.max(2, Math.round(seamless.width / 24)))
    const file = join(outDir, `sea-z${zoom}.png`)
    writeFileSync(file, encodeOpaquePng(texture.width, texture.height, texture.pixels))
    written.push(`${file} (${texture.width} px, from ${patch.size} px at ${patch.left},${patch.top}; large blotches removed: ${removed.toFixed(1)})`)
  }
  return written
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  for (const line of writeSeaTextures()) console.log(`written: ${line}`)
}
