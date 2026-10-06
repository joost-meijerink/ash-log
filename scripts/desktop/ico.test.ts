// The Windows icon (scripts/windows/ash-log.ico): the ICO container and the committed file.
import { existsSync, readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { encodeIco, encodeRgbaPng, ICO_FILE, ICO_SIZES, ICO_SOURCE, pngSize, renderIcoImages } from './make-icons.ts'

interface IcoEntry {
  width: number
  height: number
  colours: number
  reserved: number
  planes: number
  bitCount: number
  bytes: number
  offset: number
  png: Buffer
}

/** Reads an .ico the way Windows does: ICONDIR, then one 16-byte ICONDIRENTRY per image. */
function parseIco(ico: Buffer) {
  const count = ico.readUInt16LE(4)
  const entries: IcoEntry[] = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    const bytes = ico.readUInt32LE(at + 8)
    const offset = ico.readUInt32LE(at + 12)
    entries.push({
      width: ico[at]! || 256,
      height: ico[at + 1]! || 256,
      colours: ico[at + 2]!,
      reserved: ico[at + 3]!,
      planes: ico.readUInt16LE(at + 4),
      bitCount: ico.readUInt16LE(at + 6),
      bytes,
      offset,
      png: ico.subarray(offset, offset + bytes),
    })
  }
  return { reserved: ico.readUInt16LE(0), type: ico.readUInt16LE(2), entries }
}

/** Straight RGBA pixels of an 8-bit RGBA PNG written by encodeRgbaPng (filter 0 on every row). */
function decodeRgba(png: Buffer): { size: number; pixels: Uint8Array } {
  const { width, height } = pngSize(png)
  expect(png[24], 'bit depth').toBe(8)
  expect(png[25], 'colour type RGBA').toBe(6)
  const idat: Buffer[] = []
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at)
    if (png.subarray(at + 4, at + 8).toString('ascii') === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length))
    at += length + 12
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4 + 1
  expect(raw.length).toBe(stride * height)
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride], `filter of row ${y}`).toBe(0)
    pixels.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * width * 4)
  }
  expect(width).toBe(height)
  return { size: width, pixels }
}

const blank = (size: number) => encodeRgbaPng(size, size, new Uint8Array(size * size * 4))

describe('encodeIco', () => {
  it('writes the header, one entry per image and the PNGs back to back', () => {
    const small = blank(2)
    const large = blank(256)
    const ico = encodeIco([
      { size: 2, png: small },
      { size: 256, png: large },
    ])
    const parsed = parseIco(ico)
    expect(parsed.reserved).toBe(0)
    expect(parsed.type).toBe(1)
    expect(parsed.entries.map(({ png: _png, ...entry }) => entry)).toEqual([
      { width: 2, height: 2, colours: 0, reserved: 0, planes: 1, bitCount: 32, bytes: small.length, offset: 6 + 2 * 16 },
      { width: 256, height: 256, colours: 0, reserved: 0, planes: 1, bitCount: 32, bytes: large.length, offset: 6 + 2 * 16 + small.length },
    ])
    // 256 is stored as 0: a byte cannot hold it.
    expect(ico[6 + 16]).toBe(0)
    expect(parsed.entries[0]!.png.equals(small)).toBe(true)
    expect(parsed.entries[1]!.png.equals(large)).toBe(true)
    expect(ico.length).toBe(6 + 2 * 16 + small.length + large.length)
  })

  it('refuses images that do not match their size, are not PNGs, or are missing', () => {
    expect(() => encodeIco([{ size: 16, png: blank(32) }])).toThrow(/32x32, expected a square of 16/)
    expect(() => encodeIco([{ size: 512, png: blank(512) }])).toThrow(/1 to 256/)
    expect(() => encodeIco([{ size: 16, png: Buffer.from('not a png at all, really not') }])).toThrow(/Not a PNG/)
    expect(() => encodeIco([])).toThrow(/1 to 65535 images/)
  })
})

describe('scripts/windows/ash-log.ico', () => {
  const stale = 'run npx tsx scripts/desktop/make-icons.ts --ico'

  it('is committed, with an RGBA PNG for every size', () => {
    expect(existsSync(ICO_FILE), `ash-log.ico missing: ${stale}`).toBe(true)
    const ico = readFileSync(ICO_FILE)
    const { reserved, type, entries } = parseIco(ico)
    expect({ reserved, type }).toEqual({ reserved: 0, type: 1 })
    expect(entries.map((e) => e.width)).toEqual([...ICO_SIZES])
    let end = 6 + entries.length * 16
    for (const entry of entries) {
      expect(entry).toMatchObject({ height: entry.width, colours: 0, reserved: 0, planes: 1, bitCount: 32, offset: end })
      expect(pngSize(entry.png)).toEqual({ width: entry.width, height: entry.width })
      end += entry.bytes
    }
    expect(end).toBe(ico.length)
  })

  it('shows the rounded tile: transparent corners, a solid middle', () => {
    expect(ICO_SOURCE).toBe('icon-small')
    for (const entry of parseIco(readFileSync(ICO_FILE)).entries) {
      const { size, pixels } = decodeRgba(entry.png)
      const alpha = (x: number, y: number) => pixels[(y * size + x) * 4 + 3]
      if (size >= 32) {
        expect(alpha(0, 0), `${size} px corner`).toBe(0)
        expect(alpha(size - 1, size - 1), `${size} px corner`).toBe(0)
      }
      expect(alpha(size >> 1, size >> 1), `${size} px middle`).toBe(255)
    }
  })

  it('matches its source', { timeout: 30_000 }, () => {
    const committed = parseIco(readFileSync(ICO_FILE)).entries
    const fresh = renderIcoImages()
    expect(fresh.map((image) => image.size)).toEqual([...ICO_SIZES])
    fresh.forEach((image, i) => {
      // Pixels, not bytes: another zlib may compress the same pixels differently, and a rounding
      // step in the rasteriser may differ by a level between CPUs.
      const a = decodeRgba(committed[i]!.png).pixels
      const b = decodeRgba(image.png).pixels
      expect(a.length).toBe(b.length)
      // Premultiplied, so a faint edge pixel whose alpha differs by one does not count as a new colour.
      let worst = 0
      for (let p = 0; p < a.length; p += 4) {
        const alphaA = a[p + 3]!
        const alphaB = b[p + 3]!
        worst = Math.max(worst, Math.abs(alphaA - alphaB))
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a[p + c]! * alphaA - b[p + c]! * alphaB) / 255)
      }
      expect(worst, `${image.size} px entry is stale: ${stale}`).toBeLessThanOrEqual(2)
    })
  })
})
