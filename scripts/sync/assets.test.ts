// syncAssets against a real WikiClient with a fake fetch and temp dirs. Never hits the network.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_NATIVE_ZOOM, MIN_NATIVE_ZOOM, tilesPerSide } from '../../src/lib/projection'
import type { SyncWarning } from '../../src/lib/types'
import { ICON_WIDTH, isSafeFileName, syncAssets, upstreamTileUrl } from './assets'
import { createContext, warnCollector, type SyncContext } from './context'
import { WikiClient } from './wiki'

const UA = 'AshLog-test/0.1 (test@ash-log.test)'
const IMAGE_BASE = 'https://dragonwilds.runescape.wiki/images/'

interface FakeServer {
  /** Canonical file titles ('File:Gold Ore.png') that exist on the fake wiki. */
  files: Set<string>
  /** URLs that answer 404. */
  notFound: Set<string>
  /** URLs that answer 500 (retried, then given up). */
  broken: Set<string>
  /**
   * Thumbnail URL per canonical file title, for files wider than the requested iiurlwidth.
   * Other files answer with their original URL as thumburl, like MediaWiki does for small images.
   */
  thumbs: Map<string, string>
  /** Canonical file titles that answer without any thumburl. */
  noThumb: Set<string>
}

let dir: string
let dirs: { icons: string; tiles: string }
let requested: string[]
let warnings: SyncWarning[]
let logs: string[]
let server: FakeServer

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ashenfall-assets-'))
  dirs = { icons: join(dir, 'icons'), tiles: join(dir, 'tiles') }
  requested = []
  warnings = []
  logs = []
  server = { files: new Set(), notFound: new Set(), broken: new Set(), thumbs: new Map(), noThumb: new Set() }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** MediaWiki formatversion=2 answer for prop=imageinfo, with `normalized` like the real API. */
function imageInfoResponse(url: URL): Response {
  const titles = (url.searchParams.get('titles') ?? '').split('|')
  const normalized: { fromencoded: boolean; from: string; to: string }[] = []
  const pages = titles.map((requestedTitle) => {
    const title = requestedTitle.replace(/_/g, ' ')
    if (title !== requestedTitle) normalized.push({ fromencoded: false, from: requestedTitle, to: title })
    if (!server.files.has(title)) return { ns: 6, title, missing: true, known: false }
    const file = title.slice('File:'.length).replace(/ /g, '_')
    const info: Record<string, unknown> = { url: `${IMAGE_BASE}${file}?7c1a2`, descriptionurl: '', descriptionshorturl: '' }
    if (url.searchParams.has('iiurlwidth') && !server.noThumb.has(title)) info.thumburl = server.thumbs.get(title) ?? info.url
    return { ns: 6, title, imagerepository: 'local', imageinfo: [info] }
  })
  return Response.json({ batchcomplete: true, query: { ...(normalized.length ? { normalized } : {}), pages } })
}

function context(maxRetries = 5): SyncContext {
  const fetchImpl = (async (input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requested.push(href)
    const url = new URL(href)
    if (url.pathname === '/api.php') return imageInfoResponse(url)
    if (server.notFound.has(href)) return new Response('not found', { status: 404 })
    if (server.broken.has(href)) return new Response('oops', { status: 500, headers: { 'Retry-After': '0' } })
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } })
  }) as typeof fetch
  const wiki = new WikiClient({ userAgent: UA, delayMs: 0, maxRetries, fetchImpl })
  return createContext(wiki, (m) => logs.push(m), false)
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

describe('syncAssets: icons', () => {
  it('downloads missing icons under their local name and skips existing ones', async () => {
    server.files = new Set(['File:Gold Ore.png', 'File:Silver ore.png', 'File:Existing.png'])
    await mkdir(dirs.icons, { recursive: true })
    await writeFile(join(dirs.icons, 'Existing.png'), 'old')

    const result = await syncAssets(
      context(),
      // 'gold_Ore.png' and 'Gold_Ore.png' are the same file after iconFileName().
      { icons: ['Gold_Ore.png', 'gold_Ore.png', 'File:Silver ore.png', 'Existing.png', ''], tiles: false, dirs },
      warnCollector(warnings, 'assets'),
    )

    expect(result).toMatchObject({ iconsDownloaded: 2, iconsExisting: 1, iconsMissing: [], tilesDownloaded: 0, failed: 0 })
    expect(warnings).toEqual([])
    expect(await readFile(join(dirs.icons, 'Existing.png'), 'utf8')).toBe('old')
    expect(await exists(join(dirs.icons, 'Gold_Ore.png'))).toBe(true)
    expect(await exists(join(dirs.icons, 'Silver_ore.png'))).toBe(true)

    // One imageinfo request, only for the missing icons, then one download each.
    const api = requested.filter((u) => u.includes('/api.php'))
    expect(api).toHaveLength(1)
    const apiUrl = new URL(api[0]!)
    expect(apiUrl.searchParams.get('prop')).toBe('imageinfo')
    expect(apiUrl.searchParams.get('iiprop')).toBe('url')
    expect(apiUrl.searchParams.get('titles')).toBe('File:Gold_Ore.png|File:Silver_ore.png')
    expect(requested.filter((u) => u.startsWith(IMAGE_BASE))).toEqual([
      `${IMAGE_BASE}Gold_Ore.png?7c1a2`,
      `${IMAGE_BASE}Silver_ore.png?7c1a2`,
    ])
  })

  it('downloads thumbnails of at most ICON_WIDTH wide, and the original URL when there is no thumbnail', async () => {
    server.files = new Set(['File:Goblin Warrior.png', 'File:Small.png', 'File:Odd.png', 'File:Air Rune.svg'])
    server.thumbs.set('File:Goblin Warrior.png', `${IMAGE_BASE}thumb/Goblin_Warrior.png/64px-Goblin_Warrior.png?5d1e3`)
    // A PNG rendering of an SVG would land in 'Air_Rune.svg': the original is taken instead.
    server.thumbs.set('File:Air Rune.svg', `${IMAGE_BASE}thumb/Air_Rune.svg/64px-Air_Rune.svg.png?7c1a2`)
    server.noThumb.add('File:Odd.png')

    const result = await syncAssets(
      context(),
      { icons: ['Goblin_Warrior.png', 'Small.png', 'Odd.png', 'Air_Rune.svg'], tiles: false, dirs },
      warnCollector(warnings, 'assets'),
    )

    expect(result).toMatchObject({ iconsDownloaded: 4, iconsMissing: [], failed: 0 })
    expect(warnings).toEqual([])
    expect(ICON_WIDTH).toBe(64)
    const api = requested.filter((u) => u.includes('/api.php'))
    expect(api).toHaveLength(1)
    const apiUrl = new URL(api[0]!)
    expect(apiUrl.searchParams.get('iiprop')).toBe('url')
    expect(apiUrl.searchParams.get('iiurlwidth')).toBe('64')
    expect(requested.filter((u) => u.startsWith(IMAGE_BASE))).toEqual([
      `${IMAGE_BASE}Air_Rune.svg?7c1a2`,
      `${IMAGE_BASE}thumb/Goblin_Warrior.png/64px-Goblin_Warrior.png?5d1e3`,
      `${IMAGE_BASE}Odd.png?7c1a2`,
      `${IMAGE_BASE}Small.png?7c1a2`,
    ])
    // Stored under the local name of the file, never under the name of the thumbnail.
    expect(await exists(join(dirs.icons, 'Goblin_Warrior.png'))).toBe(true)
    expect(await exists(join(dirs.icons, '64px-Goblin_Warrior.png'))).toBe(false)
  })

  it('makes no request when every icon is already there', async () => {
    await mkdir(dirs.icons, { recursive: true })
    await writeFile(join(dirs.icons, 'Gold_Ore.png'), 'png')
    const result = await syncAssets(context(), { icons: ['Gold Ore.png'], tiles: false, dirs }, warnCollector(warnings, 'assets'))
    expect(result.iconsExisting).toBe(1)
    expect(requested).toEqual([])
  })

  it('downloads an empty (interrupted) icon file again', async () => {
    server.files = new Set(['File:Gold Ore.png'])
    await mkdir(dirs.icons, { recursive: true })
    await writeFile(join(dirs.icons, 'Gold_Ore.png'), '')
    const result = await syncAssets(context(), { icons: ['Gold_Ore.png'], tiles: false, dirs }, warnCollector(warnings, 'assets'))
    expect(result.iconsDownloaded).toBe(1)
    expect((await stat(join(dirs.icons, 'Gold_Ore.png'))).size).toBeGreaterThan(0)
  })

  it('warns once per icon without a URL when there are only a few', async () => {
    server.files = new Set(['File:Gold Ore.png'])
    const result = await syncAssets(context(), { icons: ['Gold_Ore.png', 'Nope.png'], tiles: false, dirs }, warnCollector(warnings, 'assets'))
    expect(result.iconsDownloaded).toBe(1)
    expect(result.iconsMissing).toEqual(['Nope.png'])
    expect(warnings).toEqual([{ source: 'assets', page: 'File:Nope.png', message: 'No image found for icon Nope.png' }])
    expect(await exists(join(dirs.icons, 'Nope.png'))).toBe(false)
  })

  it('lists many missing icons in a single warning', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `Missing_${i}.png`)
    const result = await syncAssets(context(), { icons: names, tiles: false, dirs }, warnCollector(warnings, 'assets'))
    expect(result.iconsMissing).toHaveLength(8)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain('8 icons')
    expect(warnings[0]!.message).toContain('Missing_0.png')
    expect(warnings[0]!.message).toContain('Missing_7.png')
  })

  it('treats a 404 on the image URL as a missing icon', async () => {
    server.files = new Set(['File:Gold Ore.png'])
    server.notFound.add(`${IMAGE_BASE}Gold_Ore.png?7c1a2`)
    const result = await syncAssets(context(), { icons: ['Gold_Ore.png'], tiles: false, dirs }, warnCollector(warnings, 'assets'))
    expect(result.iconsDownloaded).toBe(0)
    expect(result.iconsMissing).toEqual(['Gold_Ore.png'])
    expect(warnings).toHaveLength(1)
  })

  it('never writes outside the icons dir', async () => {
    const result = await syncAssets(context(), { icons: ['../evil.png', 'a/b.png'], tiles: false, dirs }, warnCollector(warnings, 'assets'))
    expect(result.iconsDownloaded).toBe(0)
    expect(requested).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain('../evil.png')
  })

  it('reports failed downloads as one warning and keeps going', async () => {
    server.files = new Set(['File:A.png', 'File:B.png'])
    server.broken.add(`${IMAGE_BASE}A.png?7c1a2`)
    const result = await syncAssets(context(0), { icons: ['A.png', 'B.png'], tiles: false, dirs }, warnCollector(warnings, 'assets'))
    expect(result.iconsDownloaded).toBe(1)
    expect(result.failed).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain('1 icon failed to download')
    expect(warnings[0]!.message).toContain('HTTP 500')
  })
})

describe('syncAssets: tiles', () => {
  const allTiles = () => {
    const out: { z: number; x: number; y: number }[] = []
    for (let z = MIN_NATIVE_ZOOM; z <= MAX_NATIVE_ZOOM; z++) {
      const n = tilesPerSide(z)
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) out.push({ z, x, y })
    }
    return out
  }

  it('builds upstream tile URLs from the template', () => {
    expect(upstreamTileUrl(4, 1, 16)).toBe('https://maps.runescape.wiki/dw/tiles/4/1_16.png')
  })

  it('downloads every missing tile of zoom 0 to 4, skips existing ones and counts 404s', async () => {
    const tiles = allTiles()
    expect(tiles).toHaveLength(4 + 9 + 36 + 144 + 576)

    await mkdir(join(dirs.tiles, '0'), { recursive: true })
    await writeFile(join(dirs.tiles, '0', '0_0.png'), 'png')
    // The last column of zoom 4 does not exist upstream.
    const edge = tiles.filter((t) => t.z === 4 && t.x === tilesPerSide(4) - 1)
    for (const t of edge) server.notFound.add(upstreamTileUrl(t.z, t.x, t.y))

    const result = await syncAssets(context(), { icons: [], tiles: true, dirs }, warnCollector(warnings, 'assets'))

    expect(result.tilesExisting).toBe(1)
    expect(result.tilesNotFound).toBe(edge.length)
    expect(result.tilesDownloaded).toBe(tiles.length - 1 - edge.length)
    expect(result.failed).toBe(0)
    expect(warnings).toEqual([])

    // Exactly one request per missing tile, never for the existing one, no API calls.
    expect(requested).toHaveLength(tiles.length - 1)
    expect(requested).not.toContain('https://maps.runescape.wiki/dw/tiles/0/0_0.png')
    expect(requested).toContain('https://maps.runescape.wiki/dw/tiles/0/1_1.png')
    expect(requested).toContain('https://maps.runescape.wiki/dw/tiles/4/1_16.png')
    expect(requested.every((u) => /^https:\/\/maps\.runescape\.wiki\/dw\/tiles\/[0-4]\/\d+_\d+\.png$/.test(u))).toBe(true)

    expect(await exists(join(dirs.tiles, '4', '1_16.png'))).toBe(true)
    expect(await exists(join(dirs.tiles, '4', `${tilesPerSide(4) - 1}_0.png`))).toBe(false)

    // Progress every 100 tiles, plus a note about the 404s.
    expect(logs.filter((l) => l.includes('tiles: '))).toHaveLength(Math.floor((tiles.length - 1) / 100))
    expect(logs.some((l) => l.includes(`${edge.length} tiles don't exist`))).toBe(true)
  })

  it('does nothing with tiles when tiles is false', async () => {
    const result = await syncAssets(context(), { icons: [], tiles: false, dirs }, warnCollector(warnings, 'assets'))
    expect(result.tilesDownloaded).toBe(0)
    expect(requested).toEqual([])
  })

  it('stops after three failures in a row with one warning', async () => {
    for (const t of allTiles()) server.broken.add(upstreamTileUrl(t.z, t.x, t.y))
    const result = await syncAssets(context(0), { icons: [], tiles: true, dirs }, warnCollector(warnings, 'assets'))
    expect(requested).toHaveLength(3)
    expect(result.tilesDownloaded).toBe(0)
    expect(result.failed).toBe(allTiles().length)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain('Stopped after 3 failed downloads in a row')
  })
})

describe('isSafeFileName', () => {
  it('accepts plain wiki file names everywhere', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const name of ['Gold_Ore.png', 'Bittercap_Mushroom_(Map_Icon).png', "Dragon's_Tooth.png", 'Éclair.webp', 'Console.png', 'Null_rune.png']) {
        expect(isSafeFileName(name, platform), `${platform} ${name}`).toBe(true)
      }
    }
  })

  it('refuses paths and control characters everywhere', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const name of ['', '.', '..', 'a/b.png', 'a\\b.png', '..\\x.png', 'a\u0000.png', 'a\nb.png']) {
        expect(isSafeFileName(name, platform), `${platform} ${JSON.stringify(name)}`).toBe(false)
      }
    }
  })

  it('refuses names Windows cannot store, only on Windows', () => {
    for (const name of ['What?.png', 'A:B.png', 'Say_"hi".png', 'Star*.png', 'a<b>.png', 'Pipe|.png', 'Trailing.', 'Trailing ', 'CON', 'nul.png', 'Com1.png', 'LPT9.gif', 'aux.tar.gz']) {
      expect(isSafeFileName(name, 'win32'), name).toBe(false)
    }
    expect(isSafeFileName('What?.png', 'darwin')).toBe(true)
    expect(isSafeFileName('nul.png', 'linux')).toBe(true)
  })
})
