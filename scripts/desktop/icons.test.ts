import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_DIR,
  downscale,
  encodeOpaquePng,
  hasMasters,
  masterSvg,
  renderMaster,
  ICONSET,
  type IconSource,
  PUBLIC_ICONS_DIR,
  readSource,
  render,
  renderTarget,
  SPRITE_FILE,
  WEB_ICONS,
} from './make-icons.ts'

const SOURCES: IconSource[] = ['icon', 'icon-maskable', 'icon-small', 'icon-macos', 'icon-macos-small']

/** Width, height and colour type from a PNG's IHDR chunk. */
function pngHeader(png: Buffer) {
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colourType: png[25] }
}

const alphaAt = (image: { width: number; pixels: Uint8Array }, x: number, y: number) =>
  image.pixels[(y * image.width + x) * 4 + 3]

describe('icon sources', () => {
  const sprite = readFileSync(join(DESKTOP_DIR, SPRITE_FILE))

  it('ships the Ash Logs sprite from the wiki as a 256 px PNG', () => {
    expect(sprite.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect(sprite.readUInt32BE(16)).toBe(256)
    expect(sprite.readUInt32BE(20)).toBe(256)
  })

  it.each(SOURCES)('%s shows the Ash Logs sprite, inlined for resvg', (source) => {
    expect(readFileSync(join(DESKTOP_DIR, `${source}.svg`), 'utf8')).toContain(`href="${SPRITE_FILE}"`)
    const svg = readSource(source)
    expect(svg).toContain(`href="data:image/png;base64,${sprite.toString('base64')}"`)
    expect(svg).not.toContain(`href="${SPRITE_FILE}"`)
  })

  it.each(SOURCES)('%s is a 1024 px square without text', (source) => {
    const svg = readSource(source)
    expect(svg).toContain('viewBox="0 0 1024 1024"')
    expect(svg).not.toMatch(/<text|font-family/)
  })
})

describe('rendered icons', () => {
  it('fills every pixel of the full-bleed icons', () => {
    for (const source of ['icon', 'icon-maskable'] as const) {
      const image = render(readSource(source), 64)
      for (let i = 3; i < image.pixels.length; i += 4) expect(image.pixels[i]).toBe(255)
    }
  })

  it('keeps the maskable sprite inside the 80% safe zone', () => {
    const size = 256
    const image = render(readSource('icon-maskable'), size)
    const centre = size / 2
    // The logs are light wood on dark leather; the tooling behind them stays dark.
    let wood = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        if (Math.max(image.pixels[i]!, image.pixels[i + 1]!, image.pixels[i + 2]!) > 120) {
          wood++
          expect(Math.hypot(x + 0.5 - centre, y + 0.5 - centre)).toBeLessThanOrEqual(size * 0.4)
        }
      }
    }
    expect(wood).toBeGreaterThan(500)
  })

  it('draws the macOS icon on the grid: transparent margin, solid body', () => {
    for (const source of ['icon-macos', 'icon-macos-small'] as const) {
      const image = render(readSource(source), 1024)
      expect(alphaAt(image, 4, 4)).toBe(0)
      expect(alphaAt(image, 512, 40)).toBe(0) // above the body (which starts at 100)
      expect(alphaAt(image, 110, 110)).toBe(0) // outside the rounded corner
      expect(alphaAt(image, 512, 110)).toBe(255)
      expect(alphaAt(image, 512, 512)).toBe(255)
    }
  })

  it('writes opaque targets as RGB PNGs', () => {
    const png = renderTarget({ file: 'x.png', source: 'icon', size: 48, opaque: true })
    expect(pngHeader(png)).toEqual({ width: 48, height: 48, colourType: 2 })
  })

  it('encodes RGB PNGs that decode back to the same pixels', () => {
    const rgba = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 1, 2, 3, 255])
    const png = encodeOpaquePng(2, 2, rgba)
    expect(pngHeader(png)).toEqual({ width: 2, height: 2, colourType: 2 })
    const idatLength = png.readUInt32BE(33)
    expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT')
    const raw = inflateSync(png.subarray(41, 41 + idatLength))
    expect([...raw]).toEqual([0, 10, 20, 30, 40, 50, 60, 0, 70, 80, 90, 1, 2, 3])
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND')
  })

  it('refuses transparent pixels for an opaque PNG', () => {
    expect(() => encodeOpaquePng(1, 1, new Uint8Array([0, 0, 0, 128]))).toThrow(/Transparent/)
  })
})

describe('icon sets', () => {
  it('lists every size iconutil expects, with the bold variant up to 64 px', () => {
    expect(ICONSET.map((t) => `${t.file}:${t.size}:${t.source}`)).toEqual([
      'icon_16x16.png:16:icon-macos-small',
      'icon_16x16@2x.png:32:icon-macos-small',
      'icon_32x32.png:32:icon-macos-small',
      'icon_32x32@2x.png:64:icon-macos-small',
      'icon_128x128.png:128:icon-macos',
      'icon_128x128@2x.png:256:icon-macos',
      'icon_256x256.png:256:icon-macos',
      'icon_256x256@2x.png:512:icon-macos',
      'icon_512x512.png:512:icon-macos',
      'icon_512x512@2x.png:1024:icon-macos',
    ])
  })

  it.each(WEB_ICONS)('public/icons/$file is committed and matches its source', (target) => {
    const file = join(PUBLIC_ICONS_DIR, target.file)
    expect(existsSync(file), `${target.file} missing: run npx tsx scripts/desktop/make-icons.ts --web`).toBe(true)
    const committed = readFileSync(file)
    expect(pngHeader(committed)).toEqual({ width: target.size, height: target.size, colourType: target.opaque ? 2 : 6 })
    expect(committed.equals(renderTarget(target)), `${target.file} is stale: run npx tsx scripts/desktop/make-icons.ts --web`).toBe(true)
  })

  it('keeps the icon sources next to the script', () => {
    for (const source of SOURCES) expect(existsSync(join(DESKTOP_DIR, `${source}.svg`))).toBe(true)
  })
})

describe('downscale', () => {
  it('averages the covered area and un-premultiplies', () => {
    // 2x2 premultiplied source: opaque red, opaque blue, half-transparent red, fully transparent.
    const src = { width: 2, height: 2, pixels: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255, 128, 0, 0, 128, 0, 0, 0, 0]) }
    // Mean alpha 159.5; red (255 + 128) / 4 and blue 255 / 4, both scaled back by 255 / 159.5.
    expect([...downscale(src, 1)]).toEqual([153, 0, 102, 160])
    expect([...downscale(src, 2)]).toEqual([255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 128, 0, 0, 0, 0])
  })

  it('handles non-integer factors by coverage', () => {
    const src = { width: 3, height: 3, pixels: new Uint8Array(3 * 3 * 4).fill(255) }
    expect([...downscale(src, 2)]).toEqual(new Array(16).fill(255))
  })
})

describe.runIf(hasMasters())('icons from the Figma masters', () => {
  it('uses the masters for every target', () => {
    for (const source of ['icon', 'icon-small', 'icon-maskable', 'icon-macos', 'icon-macos-small'] as const) {
      expect(masterSvg(source)).toContain('data:image/png;base64,')
    }
  })

  it('keeps the gold of the maskable icon inside the 80% safe zone', () => {
    const image = renderMaster('icon-maskable', true)
    const size = image.width
    const centre = size / 2
    let gold = 0
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const i = (y * size + x) * 4
        const [r, g, b] = [image.pixels[i]!, image.pixels[i + 1]!, image.pixels[i + 2]!]
        if (r > 150 && g > 110 && b < 110 && r - b > 80) {
          gold++
          expect(Math.hypot(x + 0.5 - centre, y + 0.5 - centre)).toBeLessThanOrEqual(size * 0.4)
        }
      }
    }
    expect(gold).toBeGreaterThan(200)
  })

  it('gives the favicon transparent corners and the macOS icon its transparent margin', () => {
    const favicon = downscale(renderMaster('icon-small', false), 32)
    expect(favicon[3]).toBe(0)
    expect(favicon[(16 * 32 + 16) * 4 + 3]).toBe(255)
    const mac = renderMaster('icon-macos', false)
    const alpha = (x: number, y: number) => mac.pixels[(y * mac.width + x) * 4 + 3]
    expect(alpha(40, 40)).toBe(0)
    expect(alpha(512, 512)).toBe(255)
  })
})
