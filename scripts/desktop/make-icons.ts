/**
 * Renders the app icons from the SVG sources in this folder.
 *
 *   public/icons/*.png                    web app manifest, iPhone home screen, favicon (committed)
 *   scripts/windows/ash-log.ico           icon of the Windows shortcuts (committed)
 *   scripts/desktop/build/AppIcon.icns    icon of the macOS app (built, not committed)
 *
 *   npx tsx scripts/desktop/make-icons.ts           all three (the .icns only on macOS)
 *   npx tsx scripts/desktop/make-icons.ts --web     only public/icons
 *   npx tsx scripts/desktop/make-icons.ts --ico     only the .ico
 *   npx tsx scripts/desktop/make-icons.ts --icns    only the .icns (macOS, needs /usr/bin/iconutil)
 *
 * The flags combine: --web --ico writes both.
 *
 * Masters: when scripts/desktop/figma/ash-log-ios.png and ash-log-macos.png exist (1024 px exports
 * from Figma), every icon comes from them: the iOS master for the web, iPhone and favicon icons
 * (and, scaled into the safe zone over a blurred copy of itself, the maskable one) and the .ico,
 * the macOS master for the .icns. They are downscaled by area averaging, which stays sharp without aliasing.
 * Without masters the SVG sources below are rendered directly.
 *
 * Sources: icon.svg (full-bleed square), icon-maskable.svg (sprite inside the 80% safe zone),
 * icon-macos.svg (body on the macOS icon grid) and small variants of the first and last one
 * with a bigger sprite for 16 to 64 px. All of them show ash-logs.png, the Ash Logs sprite
 * from the wiki (File:Ash_Logs.png, CC BY-NC-SA 3.0).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { Resvg } from '@resvg/resvg-js'
import { continuousRect, IOS_MASK_RADIUS } from './shapes.ts'

export const DESKTOP_DIR = dirname(fileURLToPath(import.meta.url))
export const PROJECT_DIR = resolve(DESKTOP_DIR, '..', '..')
export const PUBLIC_ICONS_DIR = join(PROJECT_DIR, 'public', 'icons')
export const BUILD_DIR = join(DESKTOP_DIR, 'build')

/** Background of the app (token `ink`), painted under icons that must be opaque. */
export const INK = '#15120e'

export type IconSource = 'icon' | 'icon-maskable' | 'icon-small' | 'icon-macos' | 'icon-macos-small'

export interface IconTarget {
  file: string
  source: IconSource
  /** Width and height in pixels. */
  size: number
  /** Written as an RGB PNG without alpha channel, on `ink` (iOS turns transparency black). */
  opaque?: boolean
}

/** Icons in public/icons, served at /icons/* (manifest, apple-touch-icon, favicon). */
export const WEB_ICONS: IconTarget[] = [
  { file: 'icon-192.png', source: 'icon', size: 192, opaque: true },
  { file: 'icon-512.png', source: 'icon', size: 512, opaque: true },
  { file: 'icon-maskable-512.png', source: 'icon-maskable', size: 512, opaque: true },
  { file: 'apple-touch-icon.png', source: 'icon', size: 180, opaque: true },
  { file: 'favicon-32.png', source: 'icon-small', size: 32 },
]

/** Largest pixel size that still uses the small macOS variant. */
const MACOS_SMALL_MAX = 64

/** The files iconutil expects in an .iconset: 16 to 512 points at 1x and 2x. */
export const ICONSET: IconTarget[] = [16, 32, 128, 256, 512].flatMap((points) =>
  [1, 2].map((scale) => {
    const size = points * scale
    const suffix = scale === 2 ? '@2x' : ''
    return {
      file: `icon_${points}x${points}${suffix}.png`,
      source: (size <= MACOS_SMALL_MAX ? 'icon-macos-small' : 'icon-macos') as IconSource,
      size,
    }
  }),
)

/** The Ash Logs sprite (File:Ash_Logs.png on the wiki), referenced by every icon source. */
export const SPRITE_FILE = 'ash-logs.png'

/** An icon source with the sprite inlined as a data URI, so resvg needs no file access. */
export function readSource(source: IconSource): string {
  const svg = readFileSync(join(DESKTOP_DIR, `${source}.svg`), 'utf8')
  const sprite = readFileSync(join(DESKTOP_DIR, SPRITE_FILE)).toString('base64')
  return svg.replaceAll(`href="${SPRITE_FILE}"`, `href="data:image/png;base64,${sprite}"`)
}

/** Renders an SVG to raw RGBA pixels (for checks) and PNG bytes. */
export function render(svg: string, size: number, background?: string) {
  const image = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background,
    font: { loadSystemFonts: false },
  }).render()
  return { width: image.width, height: image.height, pixels: image.pixels, png: image.asPng() }
}

/* ------------------------------------------------------------------ */
/* Masters: the icon as exported from Figma                            */
/* ------------------------------------------------------------------ */

export const MASTERS_DIR = join(DESKTOP_DIR, 'figma')
export const MASTERS = {
  ios: join(MASTERS_DIR, 'ash-log-ios.png'),
  macos: join(MASTERS_DIR, 'ash-log-macos.png'),
} as const
/** Pixel size of the masters. */
export const MASTER_SIZE = 1024
/** The maskable icon shows the iOS master at this scale, so its border stays inside the 80% safe zone. */
export const MASKABLE_SCALE = 0.76

export function hasMasters(): boolean {
  return existsSync(MASTERS.ios) && existsSync(MASTERS.macos)
}

/** An SVG that draws one icon source from the masters, at master size. */
export function masterSvg(source: IconSource): string {
  const image = (file: string, attrs = '') =>
    `<image href="data:image/png;base64,${readFileSync(file).toString('base64')}" width="${MASTER_SIZE}" height="${MASTER_SIZE}"${attrs}/>`
  const svg = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MASTER_SIZE}" height="${MASTER_SIZE}" viewBox="0 0 ${MASTER_SIZE} ${MASTER_SIZE}">${body}</svg>`
  switch (source) {
    case 'icon':
      return svg(image(MASTERS.ios))
    case 'icon-small':
      // Favicon: the iOS master as a rounded tile with transparent corners.
      return svg(
        `<defs><clipPath id="tile"><path d="${continuousRect(0, 0, MASTER_SIZE, MASTER_SIZE, IOS_MASK_RADIUS)}"/></clipPath></defs>` +
          `<g clip-path="url(#tile)">${image(MASTERS.ios)}</g>`,
      )
    case 'icon-maskable': {
      // A blurred, darkened copy fills the edge, the master sits scaled inside the safe zone.
      const size = MASTER_SIZE * MASKABLE_SCALE
      const offset = (MASTER_SIZE - size) / 2
      const bleed = MASTER_SIZE * 0.15
      return svg(
        `<defs><filter id="soft"><feGaussianBlur stdDeviation="40"/></filter></defs>` +
          `<g transform="translate(${-bleed} ${-bleed}) scale(${(MASTER_SIZE + 2 * bleed) / MASTER_SIZE})">${image(MASTERS.ios, ' filter="url(#soft)"')}</g>` +
          `<rect width="${MASTER_SIZE}" height="${MASTER_SIZE}" fill="#000" opacity="0.3"/>` +
          `<g transform="translate(${offset} ${offset}) scale(${MASKABLE_SCALE})">${image(MASTERS.ios)}</g>`,
      )
    }
    case 'icon-macos':
    case 'icon-macos-small':
      return svg(image(MASTERS.macos))
  }
}

export interface Pixels {
  width: number
  height: number
  /** Premultiplied RGBA, as resvg returns it. */
  pixels: Uint8Array
}

/**
 * Downscales square premultiplied RGBA pixels to size x size by area averaging: every target
 * pixel is the coverage-weighted mean of the source pixels under it. Returns straight RGBA.
 */
export function downscale(src: Pixels, size: number): Uint8Array {
  const scale = src.width / size
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    const y0 = y * scale
    const y1 = y0 + scale
    for (let x = 0; x < size; x++) {
      const x0 = x * scale
      const x1 = x0 + scale
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let weight = 0
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0)
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const w = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0))
          const i = (sy * src.width + sx) * 4
          r += src.pixels[i]! * w
          g += src.pixels[i + 1]! * w
          b += src.pixels[i + 2]! * w
          a += src.pixels[i + 3]! * w
          weight += w
        }
      }
      const o = (y * size + x) * 4
      const alpha = a / weight
      out[o + 3] = Math.round(alpha)
      if (alpha > 0) {
        // Un-premultiply: PNG stores straight alpha.
        out[o] = Math.min(255, Math.round((r / weight) * (255 / alpha)))
        out[o + 1] = Math.min(255, Math.round((g / weight) * (255 / alpha)))
        out[o + 2] = Math.min(255, Math.round((b / weight) * (255 / alpha)))
      }
    }
  }
  return out
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const chunk = Buffer.alloc(body.length + 8)
  chunk.writeUInt32BE(data.length, 0)
  body.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(body), body.length + 4)
  return chunk
}

/** Encodes fully opaque RGBA pixels as an RGB PNG (8 bit, no alpha channel). */
export function encodeOpaquePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4
      if (rgba[from + 3] !== 255) throw new Error(`Transparent pixel at ${x},${y}`)
      const to = y * stride + 1 + x * 3
      raw[to] = rgba[from]
      raw[to + 1] = rgba[from + 1]
      raw[to + 2] = rgba[from + 2]
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Encodes straight RGBA pixels as an RGBA PNG (8 bit). */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * stride + 1)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** A master-based source rendered at master size (opaque targets over ink). */
export function renderMaster(source: IconSource, opaque: boolean): Pixels {
  return render(masterSvg(source), MASTER_SIZE, opaque ? INK : undefined)
}

/** PNG bytes for one target, from a master rendering (see renderMaster). */
export function masterTarget(target: IconTarget, master: Pixels): Buffer {
  const pixels = downscale(master, target.size)
  return target.opaque ? encodeOpaquePng(target.size, target.size, pixels) : encodeRgbaPng(target.size, target.size, pixels)
}

/** PNG bytes for one target. */
export function renderTarget(target: IconTarget, svg?: string): Buffer {
  if (svg === undefined && hasMasters()) return masterTarget(target, renderMaster(target.source, !!target.opaque))
  svg ??= readSource(target.source)
  if (!target.opaque) return render(svg, target.size).png
  const image = render(svg, target.size, INK)
  return encodeOpaquePng(image.width, image.height, image.pixels)
}

function renderTargets(targets: IconTarget[], outDir: string): string[] {
  mkdirSync(outDir, { recursive: true })
  if (hasMasters()) {
    const masters = new Map<string, Pixels>()
    return targets.map((target) => {
      const key = `${target.source}:${target.opaque ? 'opaque' : 'alpha'}`
      let master = masters.get(key)
      if (!master) {
        master = renderMaster(target.source, !!target.opaque)
        masters.set(key, master)
      }
      const file = join(outDir, target.file)
      writeFileSync(file, masterTarget(target, master))
      return file
    })
  }
  const sources = new Map<IconSource, string>()
  return targets.map((target) => {
    let svg = sources.get(target.source)
    if (svg === undefined) {
      svg = readSource(target.source)
      sources.set(target.source, svg)
    }
    const file = join(outDir, target.file)
    writeFileSync(file, renderTarget(target, svg))
    return file
  })
}

/** Writes the web icons (public/icons by default). Returns the written paths. */
export function writeWebIcons(outDir = PUBLIC_ICONS_DIR): string[] {
  return renderTargets(WEB_ICONS, outDir)
}

/** Renders the .iconset and turns it into AppIcon.icns with iconutil. Returns the .icns path. */
export function writeIcns(buildDir = BUILD_DIR): string {
  const iconset = join(buildDir, 'AppIcon.iconset')
  const icns = join(buildDir, 'AppIcon.icns')
  rmSync(iconset, { recursive: true, force: true })
  renderTargets(ICONSET, iconset)
  execFileSync('/usr/bin/iconutil', ['--convert', 'icns', '--output', icns, iconset], { stdio: 'pipe' })
  return icns
}

/* ------------------------------------------------------------------ */
/* Windows: the icon of the Start menu and desktop shortcuts           */
/* ------------------------------------------------------------------ */

/** The Windows launcher and installer (scripts/windows). */
export const WINDOWS_DIR = join(PROJECT_DIR, 'scripts', 'windows')
export const ICO_FILE = join(WINDOWS_DIR, 'ash-log.ico')

/**
 * Sizes in the .ico: Explorer, the Start menu, the taskbar and the desktop at 100% to 200%
 * display scaling, and 256 for the large views. Windows scales the nearest one for the rest.
 */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const

/**
 * The .ico shows the favicon: the iOS master as a rounded tile with transparent corners. It fills
 * the square, so the logs stay readable at 16 to 32 px on the taskbar, and it matches the favicon
 * Edge puts on the app window. The macOS master spends a fifth of its width on the margin of
 * Apple's icon grid and on a drop shadow, which turns to mud this small.
 */
export const ICO_SOURCE: IconSource = 'icon-small'

export const ICO_TARGETS: IconTarget[] = ICO_SIZES.map((size) => ({ file: `ash-log-${size}.png`, source: ICO_SOURCE, size }))

export interface IcoImage {
  /** Width and height in pixels, 1 to 256. */
  size: number
  png: Buffer
}

/** Width and height from a PNG's IHDR chunk. Throws for anything that is not a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('Not a PNG')
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/**
 * An .ico with one PNG entry per size (ICONDIR, then a 16-byte ICONDIRENTRY per image, then the
 * images). Windows reads PNG entries at every size since Vista.
 */
export function encodeIco(images: IcoImage[]): Buffer {
  if (images.length === 0 || images.length > 0xffff) throw new Error(`An .ico holds 1 to 65535 images, not ${images.length}`)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon (2 is a cursor)
  header.writeUInt16LE(images.length, 4)
  const entries = Buffer.alloc(16 * images.length)
  let offset = header.length + entries.length
  images.forEach((image, i) => {
    const { width, height } = pngSize(image.png)
    if (!Number.isInteger(image.size) || image.size < 1 || image.size > 256 || width !== image.size || height !== image.size) {
      throw new Error(`Icon image ${i} is ${width}x${height}, expected a square of ${image.size} (1 to 256)`)
    }
    const at = i * 16
    entries[at] = image.size % 256 // width; 0 means 256
    entries[at + 1] = image.size % 256 // height
    entries[at + 2] = 0 // colours in the palette: none
    entries[at + 3] = 0 // reserved
    entries.writeUInt16LE(1, at + 4) // colour planes
    entries.writeUInt16LE(32, at + 6) // bits per pixel
    entries.writeUInt32LE(image.png.length, at + 8)
    entries.writeUInt32LE(offset, at + 12)
    offset += image.png.length
  })
  return Buffer.concat([header, entries, ...images.map((image) => image.png)])
}

/** The PNG entries of the .ico, from the masters when they exist, else from the SVG source. */
export function renderIcoImages(): IcoImage[] {
  if (hasMasters()) {
    const master = renderMaster(ICO_SOURCE, false)
    return ICO_TARGETS.map((target) => ({ size: target.size, png: masterTarget(target, master) }))
  }
  const svg = readSource(ICO_SOURCE)
  return ICO_TARGETS.map((target) => ({ size: target.size, png: renderTarget(target, svg) }))
}

/** Writes scripts/windows/ash-log.ico (or `file`). Returns its path. */
export function writeIco(file = ICO_FILE): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodeIco(renderIcoImages()))
  return file
}

function main(args: string[], platform: NodeJS.Platform = process.platform) {
  const all = !['--web', '--ico', '--icns'].some((flag) => args.includes(flag))
  if (all || args.includes('--web')) {
    for (const file of writeWebIcons()) console.log(`geschreven: ${file}`)
  }
  if (all || args.includes('--ico')) console.log(`geschreven: ${writeIco()}`)
  // iconutil only exists on macOS.
  if (args.includes('--icns') || (all && platform === 'darwin')) console.log(`geschreven: ${writeIcns()}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
}
