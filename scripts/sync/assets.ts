// Downloads icons (via prop=imageinfo, as thumbnails of at most ICON_WIDTH pixels wide)
// and map tiles once into /public/wiki-img. Existing files are never downloaded again.
// Every download goes through the polite WikiClient (own User-Agent, one request at a time).
//
// Images are not wiki data: a failed download becomes one warning and never
// blocks writing the parsed data.

import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { iconFileName } from '../../src/lib/ids'
import { MAX_NATIVE_ZOOM, MIN_NATIVE_ZOOM, UPSTREAM_TILE_URL, tilesPerSide } from '../../src/lib/projection'
import type { SyncContext, Warn } from './context'
import { ICONS_DIR, TILES_DIR } from './paths'

export interface AssetOptions {
  /** Wiki file names of icons, e.g. 'Gold_Ore.png'. Stored under ICONS_DIR as iconFileName(name). */
  icons: string[]
  /** Download missing map tiles (zoom 0 to 4). */
  tiles: boolean
  /** Target directories, for tests. Defaults to ICONS_DIR and TILES_DIR. */
  dirs?: { icons: string; tiles: string }
}

export interface AssetResult {
  iconsDownloaded: number
  /** Icons already on disk (skipped). */
  iconsExisting: number
  /** Local icon file names the wiki has no image for (no URL, or the URL gave a 404). */
  iconsMissing: string[]
  tilesDownloaded: number
  /** Tiles already on disk (skipped). */
  tilesExisting: number
  /** Tiles the tile server answered with 404. Expected at the edges, never a warning. */
  tilesNotFound: number
  /** Downloads that failed for another reason (network, HTTP error); reported as a warning. */
  failed: number
}

/** Stop a batch after this many failed downloads in a row (server down, no network). */
const MAX_FAILURE_STREAK = 3
/** Up to this many missing icons get one warning each; more are listed in a single warning. */
const MISSING_ICONS_ONE_BY_ONE = 5
const PROGRESS_EVERY = 100
/**
 * Icons are shown at 20 to 28 px; a 64 px wide thumbnail stays sharp on high-density screens
 * and keeps big renders (full-size item and creature pictures) small on disk.
 */
export const ICON_WIDTH = 64

export async function syncAssets(ctx: SyncContext, opts: AssetOptions, warn: Warn): Promise<AssetResult> {
  const dirs = opts.dirs ?? { icons: ICONS_DIR, tiles: TILES_DIR }
  const result: AssetResult = {
    iconsDownloaded: 0,
    iconsExisting: 0,
    iconsMissing: [],
    tilesDownloaded: 0,
    tilesExisting: 0,
    tilesNotFound: 0,
    failed: 0,
  }
  await syncIcons(ctx, opts.icons, dirs.icons, warn, result)
  if (opts.tiles) await syncTiles(ctx, dirs.tiles, warn, result)
  return result
}

/** Upstream URL of one map tile. */
export function upstreamTileUrl(z: number, x: number, y: number): string {
  return UPSTREAM_TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}

async function syncIcons(ctx: SyncContext, names: string[], dir: string, warn: Warn, result: AssetResult): Promise<void> {
  const wanted = new Set<string>()
  const invalid: string[] = []
  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) continue
    const local = iconFileName(name)
    if (isSafeFileName(local)) wanted.add(local)
    else invalid.push(name)
  }
  if (invalid.length) warn(`Ongeldige icoonnamen overgeslagen: ${listNames(invalid)}`)

  const todo: string[] = []
  for (const local of [...wanted].sort()) {
    if (await fileExists(join(dir, local))) result.iconsExisting++
    else todo.push(local)
  }
  if (!todo.length) return
  ctx.log(`  ${todo.length} iconen ophalen (${result.iconsExisting} al aanwezig)`)

  let urls: Map<string, string>
  try {
    urls = await ctx.wiki.imageUrls(todo, { width: ICON_WIDTH })
  } catch (err) {
    result.failed += todo.length
    warn(`Adressen van ${todo.length} iconen ophalen mislukt, iconen overgeslagen: ${(err as Error).message}`)
    return
  }

  const missing: string[] = []
  const failures = newFailures()
  let skipped = 0
  for (const local of todo) {
    const url = urls.get(local)
    if (!url) {
      missing.push(local)
      continue
    }
    if (failures.streak >= MAX_FAILURE_STREAK) {
      skipped++
      continue
    }
    const outcome = await tryDownload(ctx, url, join(dir, local), failures)
    if (outcome === 'ok') result.iconsDownloaded++
    else if (outcome === 'not-found') missing.push(local)
  }

  result.iconsMissing = missing
  if (missing.length > MISSING_ICONS_ONE_BY_ONE) {
    warn(`Geen afbeelding gevonden voor ${missing.length} iconen: ${listNames(missing)}`)
  } else {
    for (const local of missing) warn(`Geen afbeelding gevonden voor icoon ${local}`, `File:${local}`)
  }
  result.failed += failures.count + skipped
  reportFailures(warn, 'iconen', failures, skipped)
}

async function syncTiles(ctx: SyncContext, dir: string, warn: Warn, result: AssetResult): Promise<void> {
  const todo: { url: string; dest: string }[] = []
  for (let z = MIN_NATIVE_ZOOM; z <= MAX_NATIVE_ZOOM; z++) {
    const n = tilesPerSide(z)
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const dest = join(dir, String(z), `${x}_${y}.png`)
        if (await fileExists(dest)) result.tilesExisting++
        else todo.push({ url: upstreamTileUrl(z, x, y), dest })
      }
    }
  }
  if (!todo.length) return
  ctx.log(`  ${todo.length} kaarttegels ophalen (${result.tilesExisting} al aanwezig)`)

  const failures = newFailures()
  let skipped = 0
  for (let i = 0; i < todo.length; i++) {
    if (failures.streak >= MAX_FAILURE_STREAK) {
      skipped = todo.length - i
      break
    }
    const tile = todo[i]!
    const outcome = await tryDownload(ctx, tile.url, tile.dest, failures)
    if (outcome === 'ok') result.tilesDownloaded++
    else if (outcome === 'not-found') result.tilesNotFound++
    if ((i + 1) % PROGRESS_EVERY === 0) ctx.log(`  tegels: ${i + 1} van ${todo.length}`)
  }
  if (result.tilesNotFound) ctx.log(`  ${result.tilesNotFound} tegels bestaan niet op de server (404), overgeslagen`)
  result.failed += failures.count + skipped
  reportFailures(warn, 'kaarttegels', failures, skipped)
}

interface Failures {
  count: number
  streak: number
  first?: string
}

function newFailures(): Failures {
  return { count: 0, streak: 0 }
}

/** One download; errors are counted instead of thrown so one bad file never stops the sync. */
async function tryDownload(ctx: SyncContext, url: string, dest: string, f: Failures): Promise<'ok' | 'not-found' | 'failed'> {
  try {
    const ok = await ctx.wiki.download(url, dest)
    f.streak = 0
    return ok ? 'ok' : 'not-found'
  } catch (err) {
    f.count++
    f.streak++
    f.first ??= `${url}: ${(err as Error).message}`
    return 'failed'
  }
}

/** One warning per batch, never one per file. */
function reportFailures(warn: Warn, what: string, f: Failures, skipped: number): void {
  if (!f.count) return
  const stop = skipped ? ` Gestopt na ${MAX_FAILURE_STREAK} mislukte downloads op rij, ${skipped} ${what} overgeslagen.` : ''
  warn(`${f.count} ${what} downloaden mislukt.${stop} Eerste fout: ${f.first}. Een volgende sync probeert het opnieuw.`)
}

/** A zero-byte file counts as missing (interrupted download). */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

/** Characters Windows does not allow in a file name (':' would even write to a hidden stream). */
const WINDOWS_BAD_CHARS = /[<>:"|?*]/
/** Device names Windows reserves, with or without an extension (nul.png is the null device). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i

/**
 * Plain file name only: no directories, no '..', no control characters. On Windows also none
 * of the names it cannot store (such as 'What?.png'); those icons are skipped with a warning.
 */
export function isSafeFileName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!name || name !== basename(name) || name === '.' || name === '..' || name.includes('\\') || name.includes('/') || /[\x00-\x1f]/.test(name)) return false
  if (platform === 'win32' && (WINDOWS_BAD_CHARS.test(name) || /[. ]$/.test(name) || WINDOWS_RESERVED.test(name))) return false
  return true
}

function listNames(names: string[], max = 20): string {
  const shown = names.slice(0, max).join(', ')
  return names.length > max ? `${shown} en ${names.length - max} meer` : shown
}
